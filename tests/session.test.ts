/** Conversation engine tests with a scripted Realtime transport (no network). */
import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CTRL_END_REQUEST, CTRL_UNCLEAR } from '../server/lib/scenarioSchema'
import { harnessFactory, sleep } from './helpers'

const make = harnessFactory()
const b64len = (s: string) => Buffer.from(s, 'base64').length

describe('conversation engine', () => {
  it('E2E entry → branch → terminal with latency metrics', async () => {
    const h = make()
    await h.start()
    expect(h.plays()).toEqual(['node:select_need'])
    const su = h.transport.sent[0]!
    expect(su.type).toBe('session.update'); expect(su.session.output_modalities).toEqual(['text'])
    const td = su.session.audio.input.turn_detection
    expect(td.create_response).toBe(false); expect(td.interrupt_response).toBe(false); expect(td.silence_duration_ms).toBe(600)
    await h.answer('demo')
    await h.until(() => h.engine.phase === 'LISTENING' && h.engine.nodeId === 'confirm_demo')
    expect(h.plays().at(-1)).toBe('node:confirm_demo')
    await h.answer('yes')
    await h.run
    expect(h.plays()).toEqual(['node:select_need', 'node:confirm_demo', 'node:end_demo'])
    expect(h.engine.phase).toBe('FINISHED')
    expect(h.msgs('finished').at(-1)!.reason).toBe('completed')
    const fin = h.transport.requests('final')[0]!.response
    expect(fin.input[0].type).toBe('item_reference'); expect(fin.conversation).toBe('none')
    const names = new Set(fs.readFileSync(h.metrics.path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === 'latency').map((l) => l.name))
    for (const n of ['vad_event_to_branch_ms', 'request_to_branch_ms', 'speech_start_to_next_playback_ms']) expect(names).toContain(n)
  })

  it('terminal waits for playback ended; half-duplex drops audio while playing', async () => {
    const h = make({ autoPlay: false })
    h.run = h.engine.run()
    h.transport.push({ type: 'session.updated' })
    await h.until(() => h.msgs('play').length > 0)
    const pid = h.msgs('play')[0]!.playback_id
    expect(h.engine.micEnabled).toBe(false)
    h.engine.pushBrowserAudio(new Uint8Array(960))
    await sleep(20)
    expect(h.transport.types()).not.toContain('input_audio_buffer.append')
    expect(h.metrics.counters.dropped_frames_while_playing).toBe(1)
    h.engine.pushBrowserJson({ type: 'playback_started', playback_id: pid })
    await sleep(20)
    expect(h.engine.phase).toBe('PLAYING')
    h.engine.pushBrowserJson({ type: 'playback_ended', playback_id: pid })
    await h.until(() => h.engine.phase === 'LISTENING')
    expect(h.engine.micEnabled).toBe(true)
    await h.stop()
  })

  it('preview streams a prefix without commit/clear; final wins (preview=pricing, final=demo)', async () => {
    const h = make()
    await h.start()
    const iid = h.speechStart()
    await sleep(10)
    const nClear = h.transport.types().filter((t) => t === 'input_audio_buffer.clear').length
    await h.feed(400)
    await h.until(() => h.transport.requests('preview').length > 0)
    const prev = h.transport.requests('preview')[0]!
    const r = prev.response
    expect(r.conversation).toBe('none')
    const audioItems = r.input.filter((i: any) => i.type === 'message')
    expect(audioItems[0].content[0].type).toBe('input_audio')
    expect(b64len(audioItems[0].content[0].audio)).toBe(2 * 24 * 300) // this utterance's prefix at the 300 ms threshold
    h.transport.respond(prev, 'pricing')
    await h.until(() => h.msgs('preview').length > 0)
    expect(h.msgs('preview')[0]!.branch_id).toBe('pricing')
    expect(h.plays()).toEqual(['node:select_need']) // preview never plays
    await h.feed(400)
    const t = h.transport.types()
    expect(t).not.toContain('input_audio_buffer.commit')
    expect(t.filter((x) => x === 'input_audio_buffer.clear').length).toBe(nClear)
    h.speechStop(iid)
    await h.until(() => h.transport.requests('final').length > 0)
    h.transport.respond(h.transport.requests('final')[0]!, 'demo')
    await h.until(() => h.plays().length === 2)
    expect(h.plays().at(-1)).toBe('node:confirm_demo')
    expect(h.plays()).not.toContain('node:confirm_pricing')
    await h.stop()
  })

  it('preview arriving after final is ignored', async () => {
    const h = make()
    await h.start()
    const iid = h.speechStart()
    await sleep(10)
    await h.feed(400)
    await h.until(() => h.transport.requests('preview').length > 0)
    const prev = h.transport.requests('preview')[0]!
    h.speechStop(iid)
    await h.until(() => h.transport.requests('final').length > 0)
    h.transport.respond(h.transport.requests('final')[0]!, 'support')
    await h.until(() => h.plays().length === 2)
    h.transport.respond(prev, 'pricing')
    await sleep(50)
    expect(h.msgs('preview')).toHaveLength(0)
    expect(h.plays().at(-1)).toBe('node:confirm_support')
    expect(h.metrics.counters.stale_ignored).toBeGreaterThanOrEqual(1)
    await h.stop()
  })

  it('preview scheduling: max per utterance, one in flight', async () => {
    const h = make({ rs: { preview_min_audio_ms: 300, preview_interval_ms: 0, preview_max_per_utterance: 3, final_grace_ms: 10 } })
    await h.start()
    h.speechStart()
    await sleep(10)
    for (let i = 0; i < 6; i++) {
      await h.feed(320)
      const reqs = h.transport.requests('preview')
      if (reqs.length) {
        expect([...h.engine.pending.values()].filter((p) => p.phase === 'preview' && !p.done).length).toBeLessThanOrEqual(1)
        h.transport.respond(reqs.at(-1)!, 'pricing')
        await sleep(20)
      }
    }
    expect(h.transport.requests('preview')).toHaveLength(3)
    await h.stop()
  })

  it('preview item mode: create → ack → item_reference → delete', async () => {
    const h = make({ mode: 'item' })
    await h.start()
    h.speechStart()
    await sleep(10)
    await h.feed(400)
    await h.until(() => h.transport.sent.some((e) => e.type === 'conversation.item.create'))
    const tmp = h.transport.sent.find((e) => e.type === 'conversation.item.create')!.item.id
    expect(h.transport.requests('preview')).toHaveLength(0)
    h.transport.push({ type: 'conversation.item.done', item: { id: tmp } })
    await h.until(() => h.transport.requests('preview').length > 0)
    expect(h.transport.requests('preview')[0]!.response.input.at(-1)).toEqual({ type: 'item_reference', id: tmp })
    h.transport.respond(h.transport.requests('preview')[0]!, 'demo')
    await h.until(() => h.transport.sent.some((e) => e.type === 'conversation.item.delete' && e.item_id === tmp))
    await h.stop()
  })

  it('re-utterance during final invalidates and re-judges the whole answer', async () => {
    const h = make({ rs: { final_grace_ms: 150, preview_enabled: false } })
    await h.start()
    const i1 = h.speechStart()
    await sleep(10)
    await h.feed(300)
    h.speechStop(i1)
    await h.until(() => h.transport.requests('final').length > 0)
    const old = h.transport.requests('final')[0]!
    const i2 = h.speechStart()
    await sleep(20)
    h.transport.respond(old, 'pricing')
    await sleep(50)
    expect(h.plays()).toEqual(['node:select_need'])
    await h.feed(300)
    h.speechStop(i2)
    await h.until(() => h.transport.requests('final').length === 2)
    const nw = h.transport.requests('final')[1]!
    expect(nw.response.input.map((x: any) => x.id)).toEqual([i1, i2])
    expect(Number(nw.response.metadata.decision_generation)).toBeGreaterThan(Number(old.response.metadata.decision_generation))
    h.transport.respond(nw, 'demo')
    await h.until(() => h.plays().length === 2)
    expect(h.plays().at(-1)).toBe('node:confirm_demo')
    expect(h.metrics.counters.final_invalidated).toBe(1)
    await h.stop()
  })

  it('re-utterance in the grace window cancels the decision', async () => {
    const h = make({ rs: { final_grace_ms: 300, preview_enabled: false } })
    await h.start()
    const i1 = h.speechStart()
    await sleep(10)
    await h.feed(200)
    h.speechStop(i1)
    await h.until(() => h.transport.requests('final').length > 0)
    h.transport.respond(h.transport.requests('final')[0]!, 'pricing')
    await h.until(() => h.msgs('final').length > 0)
    h.speechStart()
    await sleep(400)
    expect(h.plays()).toEqual(['node:select_need'])
    expect(h.msgs('final_invalidated').length).toBe(1)
    await h.stop()
  })

  it('items are not deleted while referenced', async () => {
    const h = make({ rs: { final_grace_ms: 10, preview_enabled: false } })
    await h.start()
    const i1 = h.speechStart()
    await sleep(10)
    await h.feed(200)
    h.speechStop(i1)
    await h.until(() => h.transport.requests('final').length > 0)
    const old = h.transport.requests('final')[0]!
    h.speechStart()
    await sleep(30)
    expect(h.transport.sent.some((e) => e.type === 'conversation.item.delete')).toBe(false)
    h.transport.respond(old, 'pricing')
    await sleep(30)
    expect(h.transport.sent.some((e) => e.type === 'conversation.item.delete')).toBe(false)
    await h.stop()
  })

  const bads: [string, Record<string, unknown>][] = [
    ['empty output', { output: [] }],
    ['two calls', { output: [{ type: 'function_call', name: 'select_branch', arguments: '{}' }, { type: 'function_call', name: 'select_branch', arguments: '{}' }] }],
    ['disallowed branch', { output: [{ type: 'function_call', name: 'select_branch', arguments: JSON.stringify({ branch_id: 'hack' }) }] }],
    ['bad json', { output: [{ type: 'function_call', name: 'select_branch', arguments: 'nope' }] }],
    ['failed', { status: 'failed' }],
  ]
  for (const [label, bad] of bads) {
    it(`invalid final output → fallback (${label})`, async () => {
      const h = make({ rs: { final_grace_ms: 10, preview_enabled: false } })
      await h.start()
      const i1 = h.speechStart()
      await sleep(10)
      await h.feed(200)
      h.speechStop(i1)
      await h.until(() => h.transport.requests('final').length > 0)
      h.transport.respond(h.transport.requests('final')[0]!, 'demo', bad as any)
      await h.until(() => h.plays().length === 2)
      expect(h.plays().at(-1)).toBe('control:clarify_need')
      expect(h.msgs('final').at(-1)!.fallback_reason).toBeTruthy()
      await h.until(() => h.engine.phase === 'LISTENING')
      expect(h.engine.nodeId).toBe('select_need')
      expect(h.plays().filter((k) => k === 'node:select_need')).toHaveLength(1)
      await h.stop()
    })
  }

  it('stale / other-version / duplicate responses are rejected', async () => {
    const h = make({ rs: { final_grace_ms: 10, preview_enabled: false } })
    await h.start()
    const i1 = h.speechStart()
    await sleep(10)
    await h.feed(200)
    h.speechStop(i1)
    await h.until(() => h.transport.requests('final').length > 0)
    const req = h.transport.requests('final')[0]!
    const md = { ...req.response.metadata }
    h.transport.respond(req, 'pricing', { metadata: { ...md, request_key: 'deadbeef' }, rid: 'r_unknown' })
    await sleep(50)
    expect(h.plays()).toEqual(['node:select_need'])
    h.transport.respond(req, 'pricing', { metadata: { ...md, scenario_version: '99' }, rid: 'r_ver' })
    await h.until(() => h.plays().length === 2)
    expect(h.plays().at(-1)).toBe('control:clarify_need')
    h.transport.respond(req, 'pricing')
    await sleep(50)
    expect(h.plays()).not.toContain('node:confirm_pricing')
    expect(h.metrics.counters.stale_ignored).toBeGreaterThanOrEqual(3)
    await h.stop()
  })

  it('duplicate done applied once', async () => {
    const h = make({ rs: { final_grace_ms: 10, preview_enabled: false } })
    await h.start()
    await h.answer('pricing')
    await h.until(() => h.plays().length === 2)
    h.transport.respond(h.transport.requests('final')[0]!, 'pricing', { rid: 'dup' })
    await h.until(() => h.engine.phase === 'LISTENING' && h.engine.nodeId === 'confirm_pricing')
    await sleep(50)
    expect(h.plays()).toEqual(['node:select_need', 'node:confirm_pricing'])
    await h.stop()
  })

  it('final timeout → cancel → late final ignored', async () => {
    const h = make({ rs: { final_grace_ms: 10, preview_enabled: false } })
    h.rs.final_timeout_ms = 80
    await h.start()
    const i1 = h.speechStart()
    await sleep(10)
    await h.feed(200)
    h.speechStop(i1)
    await h.until(() => h.transport.requests('final').length > 0)
    const req = h.transport.requests('final')[0]!
    h.transport.push({ type: 'response.created', response: { id: 'r1', metadata: req.response.metadata } })
    await h.until(() => h.plays().length === 2, 2000)
    expect(h.plays().at(-1)).toBe('control:clarify_need')
    expect(h.transport.sent).toContainEqual({ type: 'response.cancel', response_id: 'r1' })
    h.transport.respond(req, 'demo', { rid: 'r1', created: false })
    await sleep(50)
    expect(h.plays()).not.toContain('node:confirm_demo')
    await h.stop()
  })

  it('final timeout without response.created; missing item times out to fallback', async () => {
    const h = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
    h.rs.final_timeout_ms = 60
    await h.start()
    const i1 = h.speechStart()
    await sleep(10)
    await h.feed(200)
    h.speechStop(i1)
    await h.until(() => h.plays().length === 2)
    expect(h.msgs('final').at(-1)!.fallback_reason).toBe('final_timeout')
    await h.stop()

    const h2 = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
    h2.rs.item_wait_timeout_ms = 60
    await h2.start()
    const j1 = h2.speechStart()
    await sleep(10)
    await h2.feed(200)
    h2.speechStop(j1, false)
    await h2.until(() => h2.plays().length === 2)
    expect(h2.msgs('final').at(-1)!.fallback_reason).toBe('input_item_timeout')
    expect(h2.transport.requests('final')).toHaveLength(0)
    await h2.stop()
  })

  it('no-input then limit', async () => {
    const h = make()
    await h.start()
    for (let i = 0; i < 3; i++) {
      await h.until(() => h.engine.phase === 'LISTENING')
      h.engine.setTimer('no_input', 1)
      const n = h.plays().length
      await h.until(() => h.plays().length > n)
    }
    expect(h.plays().slice(1)).toEqual(['control:no_input_need', 'control:no_input_need', 'control:limit_handoff'])
    await h.run
    expect(h.engine.phase).toBe('FINISHED')
  })

  it('clarify limit, end request, correction', async () => {
    const h = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
    await h.start()
    for (let i = 0; i < 2; i++) {
      await h.answer(CTRL_UNCLEAR)
      await h.until(() => h.engine.phase === 'LISTENING' && h.plays().at(-1) === 'control:clarify_need')
    }
    await h.answer(CTRL_UNCLEAR)
    await h.run
    expect(h.plays().at(-1)).toBe('control:limit_handoff')

    const h2 = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
    await h2.start()
    await h2.answer('pricing')
    await h2.until(() => h2.engine.nodeId === 'confirm_pricing' && h2.engine.phase === 'LISTENING')
    await h2.answer(CTRL_END_REQUEST)
    await h2.run
    expect(h2.plays().at(-1)).toBe('control:end_request'); expect(h2.engine.phase).toBe('FINISHED')

    const h3 = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
    await h3.start()
    await h3.answer('pricing')
    await h3.until(() => h3.engine.nodeId === 'confirm_pricing' && h3.engine.phase === 'LISTENING')
    await h3.answer('change')
    await h3.until(() => h3.engine.nodeId === 'select_need' && h3.engine.phase === 'LISTENING')
    expect(h3.plays()).toEqual(['node:select_need', 'node:confirm_pricing', 'node:select_need'])
    await h3.stop()
  })

  it('old playback ended does not open a turn', async () => {
    const h = make({ autoPlay: false })
    h.run = h.engine.run()
    h.transport.push({ type: 'session.updated' })
    await h.until(() => h.msgs('play').length > 0)
    const first = h.msgs('play')[0]!.playback_id
    h.engine.pushBrowserJson({ type: 'playback_ended', playback_id: 'pb_old' })
    await sleep(30)
    expect(h.engine.phase).toBe('PLAYING')
    h.engine.pushBrowserJson({ type: 'playback_started', playback_id: first })
    h.engine.pushBrowserJson({ type: 'playback_ended', playback_id: first })
    await h.until(() => h.engine.phase === 'LISTENING')
    h.engine.pushBrowserJson({ type: 'playback_ended', playback_id: first })
    await sleep(30)
    expect(h.engine.turnId).toBe(1)
    await h.stop()
  })

  it('playback failure → retry; manual interrupt → answer the same node', async () => {
    const h = make({ autoPlay: false })
    h.run = h.engine.run()
    h.transport.push({ type: 'session.updated' })
    await h.until(() => h.msgs('play').length > 0)
    const pid = h.msgs('play')[0]!.playback_id
    h.engine.pushBrowserJson({ type: 'playback_failed', playback_id: pid, error: 'NotAllowedError' })
    await h.until(() => h.engine.phase === 'PLAYBACK_ERROR')
    expect(h.engine.micEnabled).toBe(false)
    h.engine.pushBrowserJson({ type: 'playback_retry' })
    await h.until(() => h.msgs('play').length === 2)
    const pid2 = h.msgs('play')[1]!.playback_id
    expect(pid2).not.toBe(pid)
    h.engine.pushBrowserJson({ type: 'playback_started', playback_id: pid2 })
    h.engine.pushBrowserJson({ type: 'playback_canceled', playback_id: pid2, position_ms: 500 })
    await h.until(() => h.engine.phase === 'LISTENING')
    expect(h.engine.interrupted[0]!.utterance_key).toBe('node:select_need')
    expect(h.engine.nodeId).toBe('select_need')
    await h.stop()
  })

  it('playback ack timeout stops; disconnect during playback does not advance', async () => {
    const h = make({ autoPlay: false })
    h.rs.playback_start_timeout_ms = 50
    h.run = h.engine.run()
    h.transport.push({ type: 'session.updated' })
    await h.run
    expect(h.engine.phase).toBe('ERROR'); expect(h.engine.endReason).toBe('playback_ack_timeout')

    const h2 = make({ autoPlay: false })
    h2.run = h2.engine.run()
    h2.transport.push({ type: 'session.updated' })
    await h2.until(() => h2.msgs('play').length > 0)
    h2.transport.push(null)
    await h2.run
    expect(h2.engine.phase).toBe('ERROR'); expect(h2.engine.endReason).toBe('realtime_disconnected')
    expect(h2.msgs('finished').at(-1)!.message).toContain('次のノードへは自動で進みません')
    expect(h2.engine.turnId).toBe(0)
  })

  it('browser disconnect stops and discards the ring', async () => {
    const h = make()
    await h.start()
    h.speechStart()
    await sleep(10)
    h.engine.pushBrowserJson({ type: '_disconnect' })
    await h.run
    expect(h.engine.phase).toBe('STOPPED'); expect(h.engine.endReason).toBe('browser_disconnected')
    expect(h.engine.ring.chunks).toHaveLength(0)
  })

  it('cache miss stops safely; TTS / Claude are never called on the conversation path', async () => {
    const tts = await import('../server/lib/tts')
    const gen = await import('../server/lib/scenarioGenerator')
    const called: string[] = []
    const s1 = vi.spyOn(tts.MockSpeechSynthesizer.prototype, 'synthesize').mockImplementation(async () => { called.push('tts'); return new Uint8Array() })
    const s2 = vi.spyOn(tts.OpenAISpeechSynthesizer.prototype, 'synthesize').mockImplementation(async () => { called.push('tts'); return new Uint8Array() })
    const s3 = vi.spyOn(gen.MockScenarioGenerator.prototype, 'generate').mockImplementation(async () => { called.push('claude'); throw new Error() })
    try {
      const h = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
      h.engine.manifest.entries['node:confirm_demo']!.status = 'pending'
      await h.start()
      await h.answer('demo')
      await h.run
      expect(h.engine.endReason).toBe('audio_cache_miss')
      expect(called).toEqual([])
    } finally {
      s1.mockRestore(); s2.mockRestore(); s3.mockRestore()
    }
  })

  it('session max duration ends the conversation explicitly; unrelated realtime errors are surfaced', async () => {
    const h = make({ rs: { preview_enabled: false } })
    h.rs.session_max_ms = 150
    await h.start()
    h.transport.push({ type: 'error', error: { code: 'rate_limit', message: 'slow down' } })
    await h.until(() => h.msgs('realtime_error').length === 1)
    expect(h.engine.phase).toBe('LISTENING') // not treated as an unclear utterance
    await h.run
    expect(h.engine.endReason).toBe('session_max'); expect(h.engine.phase).toBe('STOPPED')
  })

  it('final carries the provider usage of the decisive response', async () => {
    const h = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
    await h.start()
    await h.answer('demo')
    await h.until(() => h.msgs('final').length === 1)
    expect(h.msgs('final')[0]!.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
    await h.stop()
  })

  it('utterance too long / send buffer overflow are explicit stops', async () => {
    const h = make({ rs: { max_utterance_ms: 3000, preview_enabled: false } })
    await h.start()
    h.speechStart()
    await sleep(10)
    await h.feed(3200)
    await h.run
    expect(h.engine.endReason).toBe('utterance_too_long')

    const h2 = make()
    await h2.start()
    h2.transport.bufferedBytes = () => 1e9
    await h2.feed(40)
    await h2.run
    expect(h2.engine.endReason).toBe('send_buffer_overflow')
  })

  it('prefix excludes previous-turn audio even with a bogus VAD offset', async () => {
    const h = make({ rs: { final_grace_ms: 5, preview_min_audio_ms: 300, preview_interval_ms: 300 } })
    await h.start()
    await h.answer('pricing', 200)
    await h.until(() => h.engine.nodeId === 'confirm_pricing' && h.engine.phase === 'LISTENING')
    const startSample = h.engine.listenStartSample
    h.speechStart(0)
    await sleep(10)
    await h.feed(400)
    await h.until(() => h.transport.requests('preview').some((p) => p.response.metadata.node_id === 'confirm_pricing'))
    const prev = h.transport.requests('preview').filter((p) => p.response.metadata.node_id === 'confirm_pricing').at(-1)!
    const msg = prev.response.input.find((i: any) => i.type === 'message')
    expect(b64len(msg.content[0].audio)).toBeLessThanOrEqual(2 * 24 * 420)
    expect(h.engine.utterances[0]!.startSample).toBe(startSample)
    await h.stop()
  })

  it('classification enum/history follow the current node', async () => {
    const h = make({ rs: { final_grace_ms: 5, preview_enabled: false } })
    await h.start()
    await h.answer('pricing')
    await h.until(() => h.engine.nodeId === 'confirm_pricing' && h.engine.phase === 'LISTENING')
    await h.answer('yes')
    const req = h.transport.requests('final').at(-1)!.response
    expect(req.tools[0].parameters.properties.branch_id.enum).toEqual(['yes', 'change', CTRL_UNCLEAR, CTRL_END_REQUEST])
    expect(req.instructions).toContain('用件選択 → 料金案内')
    await h.run
  })
})

describe('barge-in (full duplex)', () => {
  const bi = (o: Record<string, unknown> = {}) => make({ autoPlay: false, rs: { barge_in_enabled: true, barge_in_confirm_ms: 60, final_grace_ms: 5, preview_enabled: false, ...o } })

  async function startPlaying(h: ReturnType<typeof make>) {
    h.run = h.engine.run()
    h.transport.push({ type: 'session.updated' })
    await h.until(() => h.msgs('play').length > 0)
    const play = h.msgs('play').at(-1)!
    h.engine.pushBrowserJson({ type: 'playback_started', playback_id: play.playback_id })
    await sleep(10)
    return play
  }

  it('mic streams during an interruptible prompt; confirmed speech stops playback and answers that node', async () => {
    const h = bi()
    const play = await startPlaying(h)
    expect(play.interruptible).toBe(true)
    expect(h.engine.micEnabled).toBe(true)
    expect(h.transport.types()).toContain('input_audio_buffer.clear') // cleared before the prompt, nothing referenced
    await h.feed(200)
    expect(h.transport.types()).toContain('input_audio_buffer.append')
    const iid = h.speechStart()
    await sleep(10)
    expect(h.engine.phase).toBe('PLAYING') // not yet confirmed
    expect(h.msgs('playback_stop')).toHaveLength(0)
    await h.feed(100)
    await h.until(() => h.msgs('playback_stop').length === 1)
    expect(h.msgs('playback_stop')[0]!.playback_id).toBe(play.playback_id)
    expect(h.engine.phase).toBe('LISTENING')
    expect(h.engine.nodeId).toBe('select_need')
    expect(h.engine.turnId).toBe(1)
    expect(h.metrics.counters.barge_in).toBe(1)
    // the browser's cancel ack records the position without opening another turn
    h.engine.pushBrowserJson({ type: 'playback_canceled', playback_id: play.playback_id, position_ms: 700, reason: 'barge_in' })
    await h.until(() => h.msgs('interrupted').length === 1)
    expect(h.msgs('interrupted')[0]!.remaining_ms).toBe(200 - 700 < 0 ? 0 : 200 - 700)
    expect(h.engine.turnId).toBe(1)
    // the speech that interrupted is the answer: the buffer was not cleared after the interrupt
    expect(h.transport.types().filter((t) => t === 'input_audio_buffer.clear')).toHaveLength(1)
    h.speechStop(iid)
    await h.until(() => h.transport.requests('final').length === 1)
    expect(h.transport.requests('final')[0]!.response.input).toEqual([{ type: 'item_reference', id: iid }])
    h.transport.respond(h.transport.requests('final')[0]!, 'demo')
    await h.until(() => h.plays().length === 2)
    expect(h.plays().at(-1)).toBe('node:confirm_demo')
    await h.stop()
  })

  it('short burst (echo/noise) within the confirm window does not stop playback', async () => {
    const h = bi({ barge_in_confirm_ms: 200 })
    const play = await startPlaying(h)
    const iid = h.speechStart()
    await sleep(20)
    h.speechStop(iid) // stopped before confirmation
    await sleep(250)
    expect(h.msgs('playback_stop')).toHaveLength(0)
    expect(h.engine.phase).toBe('PLAYING')
    expect(h.metrics.counters.barge_in_rejected).toBe(1)
    h.engine.pushBrowserJson({ type: 'playback_ended', playback_id: play.playback_id })
    await h.until(() => h.engine.phase === 'LISTENING')
    expect(h.engine.turnId).toBe(1)
    // the rejected VAD item is dropped
    await h.until(() => h.transport.sent.some((e) => e.type === 'conversation.item.delete' && e.item_id === iid))
    await h.stop()
  })

  it('terminal playback is not interruptible; barge-in disabled keeps half-duplex', async () => {
    const h = bi()
    await startPlaying(h)
    h.engine.pushBrowserJson({ type: 'playback_canceled', playback_id: h.msgs('play')[0]!.playback_id, position_ms: 10 })
    await h.until(() => h.engine.phase === 'LISTENING')
    await h.answer(CTRL_END_REQUEST)
    await h.until(() => h.msgs('play').length === 2)
    const last = h.msgs('play').at(-1)!
    expect(last.terminal_after).toBe(true); expect(last.interruptible).toBe(false)
    expect(h.engine.micEnabled).toBe(false)
    h.engine.pushBrowserJson({ type: 'playback_started', playback_id: last.playback_id })
    h.engine.pushBrowserAudio(new Uint8Array(960))
    await sleep(20)
    expect(h.metrics.counters.dropped_frames_while_playing).toBe(1)
    h.engine.pushBrowserJson({ type: 'playback_ended', playback_id: last.playback_id })
    await h.run
    expect(h.engine.phase).toBe('FINISHED')

    const h2 = make({ autoPlay: false, rs: { barge_in_enabled: false } })
    const p2 = await startPlaying(h2)
    expect(p2.interruptible).toBe(false); expect(h2.engine.micEnabled).toBe(false)
    await h2.stop()
  })

  it('speech that starts just before the prompt ends is kept as the answer', async () => {
    const h = bi({ barge_in_confirm_ms: 500 })
    const play = await startPlaying(h)
    await h.feed(100)
    const iid = h.speechStart()
    await sleep(20)
    h.engine.pushBrowserJson({ type: 'playback_ended', playback_id: play.playback_id })
    await h.until(() => h.engine.phase === 'LISTENING')
    expect(h.engine.utterances.map((u) => u.itemId)).toEqual([iid])
    expect(h.transport.types().filter((t) => t === 'input_audio_buffer.clear')).toHaveLength(1)
    h.speechStop(iid)
    await h.until(() => h.transport.requests('final').length === 1)
    await h.stop()
  })

  it('playback generation: a stale playback_stop ack and a second prompt are handled', async () => {
    const h = bi({ barge_in_confirm_ms: 0 })
    const play = await startPlaying(h)
    const iid = h.speechStart()
    await h.until(() => h.msgs('playback_stop').length === 1)
    h.speechStop(iid)
    await h.until(() => h.transport.requests('final').length === 1)
    h.transport.respond(h.transport.requests('final')[0]!, 'pricing')
    await h.until(() => h.msgs('play').length === 2)
    const play2 = h.msgs('play')[1]!
    // late ack for the first (interrupted) playback must not touch the second
    h.engine.pushBrowserJson({ type: 'playback_canceled', playback_id: play.playback_id, position_ms: 300 })
    await sleep(30)
    expect(h.engine.phase).toBe('PLAYING'); expect(h.engine.playback?.playbackId).toBe(play2.playback_id)
    h.engine.pushBrowserJson({ type: 'playback_started', playback_id: play2.playback_id })
    const iid2 = h.speechStart()
    await h.until(() => h.msgs('playback_stop').length === 2)
    expect(h.msgs('playback_stop')[1]!.playback_id).toBe(play2.playback_id)
    expect(h.engine.nodeId).toBe('confirm_pricing')
    h.speechStop(iid2)
    await h.until(() => h.transport.requests('final').length === 2)
    expect(h.transport.requests('final')[1]!.response.metadata.node_id).toBe('confirm_pricing')
    await h.stop()
  })
})
