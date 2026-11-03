/** Engine on the STT + judge backend (mock STT, mock judge; no network) and the built-in VAD. */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SttJudgeBackend } from '../server/core/sttJudgeBackend'
import { MockJudge } from '../server/core/judge/mock'
import { MockStt } from '../server/core/stt/mock'
import { EnergyVad } from '../server/core/vad'
import { backendMissing, describeBackendOptions } from '../server/core/backendFactory'
import { loadSettings } from '../server/lib/config'
import { ConversationEngine, defaultRuntime, type RuntimeSettings } from '../server/lib/realtimeSession'
import { SessionMetrics } from '../server/lib/metrics'
import { CTRL_UNCLEAR } from '../server/lib/scenarioSchema'
import { makeStores, readyManifest, sampleScenario, sleep, tmpSettings } from './helpers'

function harness(o: { rs?: Partial<RuntimeSettings>; backend?: Partial<ConstructorParameters<typeof SttJudgeBackend>[0]> } = {}) {
  const s = tmpSettings()
  const { audio } = makeStores(s)
  const scenario = sampleScenario()
  const manifest = readyManifest(scenario, audio)
  const stt = new MockStt()
  const judge = new MockJudge(20)
  const backend = new SttJudgeBackend({ stt, judge, finalWaitMs: 150, ...(o.backend ?? {}) })
  const rs = defaultRuntime({ final_grace_ms: 30, preview_min_audio_ms: 300, preview_interval_ms: 300, item_wait_timeout_ms: 1000, ...(o.rs ?? {}) })
  const metrics = new SessionMetrics(path.join(s.dataDir, 'logs'), 'sess_stt' + Math.random().toString(16).slice(2, 8))
  const browser: Record<string, any>[] = []
  const engine = new ConversationEngine({
    sessionId: 'sess_0123456789abcdef', scenario, manifest, audio, backend, settings: rs, metrics,
    sendBrowser: (m) => {
      browser.push(m)
      if (m.type === 'play') {
        const pid = m.playback_id
        setTimeout(() => engine.pushBrowserJson({ type: 'playback_started', playback_id: pid }), 0)
        setTimeout(() => engine.pushBrowserJson({ type: 'playback_ended', playback_id: pid }), 10)
      }
    },
  })
  const until = async (cond: () => boolean, timeoutMs = 3000) => {
    const end = Date.now() + timeoutMs
    while (!cond()) { if (Date.now() > end) throw new Error(`timeout; phase=${engine.phase} browser=${browser.map((m) => m.type).slice(-12).join(',')}`); await sleep(3) }
  }
  const plays = () => browser.filter((m) => m.type === 'play').map((m) => m.utterance_key as string)
  const msgs = (t: string) => browser.filter((m) => m.type === t)
  const feed = async (ms: number) => { for (let i = 0; i < Math.floor(ms / 20); i++) engine.pushBrowserAudio(new Uint8Array(960)); await sleep(10) }
  const run = engine.run()
  return { engine, backend, stt, judge, browser, metrics, run, until, plays, msgs, feed, rs }
}

describe('STT + judge backend', () => {
  it('E2E: entry → final decision from transcript → next node → terminal; metrics use the backend name', async () => {
    const h = harness()
    await h.until(() => h.engine.phase === 'LISTENING')
    expect(h.plays()).toEqual(['node:select_need'])
    expect(h.msgs('state')[0]!.backend).toBe('stt_judge:mock+mock')
    h.judge.finalChoice = 'demo'
    await h.feed(200)
    await h.stt.say('デモを見たい')
    await h.until(() => h.engine.phase === 'LISTENING' && h.engine.nodeId === 'confirm_demo')
    expect(h.plays().at(-1)).toBe('node:confirm_demo')
    expect(h.judge.calls.at(-1)!.state.utterance).toBe('デモを見たい')
    expect(Object.keys(h.judge.calls.at(-1)!.criteria)).toEqual(expect.arrayContaining(['pricing', 'demo', 'support', CTRL_UNCLEAR, 'ctrl_end_request']))
    h.judge.finalChoice = 'yes'
    await h.stt.say('はい')
    await h.run
    expect(h.engine.phase).toBe('FINISHED')
    const lines = fs.readFileSync(h.metrics.path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const turn = lines.find((l) => l.event === 'turn')
    expect(turn.source).toBe('stt_judge:mock+mock')
    expect(turn.branch_id).toBe('demo')
    const names = new Set(lines.filter((l) => l.event === 'latency').map((l) => l.name))
    for (const n of ['vad_event_to_branch_ms', 'request_to_branch_ms', 'speech_start_to_next_playback_ms']) expect(names).toContain(n)
  })

  it('low judge confidence becomes ctrl_unclear (fallback prompt), high confidence does not', async () => {
    const h = harness({ backend: { unclearThreshold: 0.5 } })
    await h.until(() => h.engine.phase === 'LISTENING')
    h.judge.finalChoice = 'pricing'
    h.judge.confidence = 0.2
    await h.stt.say('前の話に戻って')
    await h.until(() => h.plays().length === 2)
    expect(h.plays().at(-1)).toBe('control:clarify_need')
    expect(h.msgs('final').at(-1)!.branch_id).toBe(CTRL_UNCLEAR)
    expect(h.msgs('final').at(-1)!.reason).toContain('低確信度')
    h.judge.confidence = 0.9
    await h.until(() => h.engine.phase === 'LISTENING')
    await h.stt.say('料金を知りたい')
    await h.until(() => h.plays().length === 3)
    expect(h.plays().at(-1)).toBe('node:confirm_pricing')
    h.engine.pushBrowserJson({ type: 'stop' })
    await h.run
  })

  it('preview uses the running partial transcript; final decides', async () => {
    const h = harness()
    await h.until(() => h.engine.phase === 'LISTENING')
    h.judge.previewChoice = 'pricing'
    h.judge.finalChoice = 'demo'
    await h.stt.control({ action: 'start', partial: '料金' })
    await h.feed(400)
    await h.until(() => h.msgs('preview').length > 0)
    expect(h.msgs('preview')[0]!.branch_id).toBe('pricing')
    expect(h.judge.calls[0]!.state.utterance).toBe('料金')
    expect(h.judge.calls[0]!.state.note).toBeTruthy()
    expect(h.plays()).toEqual(['node:select_need'])
    await h.stt.control({ action: 'stop', text: '料金、ではなくデモです' })
    await h.until(() => h.plays().length === 2)
    expect(h.plays().at(-1)).toBe('node:confirm_demo')
    const fin = h.judge.calls.find((c) => c.state.note === undefined)!
    expect(fin.state.utterance).toBe('料金、ではなくデモです')
    h.engine.pushBrowserJson({ type: 'stop' })
    await h.run
  })

  it('no final transcript in time → utterance is finalized from the last partial', async () => {
    const h = harness({ backend: { finalWaitMs: 60 } })
    await h.until(() => h.engine.phase === 'LISTENING')
    h.stt.finalDelayMs = 5000 // the provider's final never arrives in time
    h.judge.finalChoice = 'support'
    await h.stt.control({ action: 'start', partial: '使い方が分からない' })
    await h.stt.control({ action: 'stop' })
    await h.until(() => h.plays().length === 2)
    expect(h.judge.calls.at(-1)!.state.utterance).toBe('使い方が分からない')
    expect(h.plays().at(-1)).toBe('node:confirm_support')
    h.engine.pushBrowserJson({ type: 'stop' })
    await h.run
  })

  it('judge failure on the final request → ctrl_unclear via the error path, session continues', async () => {
    const h = harness()
    await h.until(() => h.engine.phase === 'LISTENING')
    h.judge.decide = async () => { throw new Error('boom') }
    await h.stt.say('料金')
    await h.until(() => h.plays().length === 2)
    expect(h.msgs('final').at(-1)!.fallback_reason).toBe('realtime_error')
    expect(h.plays().at(-1)).toBe('control:clarify_need')
    h.engine.pushBrowserJson({ type: 'stop' })
    await h.run
  })

  it('empty transcript → ctrl_unclear without calling the judge', async () => {
    const h = harness()
    await h.until(() => h.engine.phase === 'LISTENING')
    h.judge.finalChoice = 'pricing'
    await h.stt.say('')
    await h.until(() => h.plays().length === 2)
    expect(h.judge.calls).toHaveLength(0)
    expect(h.msgs('final').at(-1)!.branch_id).toBe(CTRL_UNCLEAR)
    h.engine.pushBrowserJson({ type: 'stop' })
    await h.run
  })
})

describe('backend choice availability', () => {
  it('lists the env vars each backend lacks; the session choice overrides DECISION_BACKEND', () => {
    const s = loadSettings({ dataDir: '/tmp/x', decisionBackend: 'mock', realtimeProvider: 'openai', realtimeModel: '', openaiApiKey: '', sttProvider: 'revai', judgeProvider: 'clef', revaiAccessToken: '', cfAccountId: 'acc', cfApiToken: '' })
    expect(backendMissing(s)).toEqual([])
    expect(backendMissing({ ...s, decisionBackend: 'realtime' })).toEqual(['REALTIME_MODEL', 'OPENAI_API_KEY'])
    expect(backendMissing({ ...s, decisionBackend: 'stt_judge' })).toEqual(['REVAI_ACCESS_TOKEN', 'CF_API_TOKEN'])
    expect(backendMissing({ ...s, decisionBackend: 'stt_judge', revaiAccessToken: 't', cfApiToken: 'k' })).toEqual([])
    const opts = describeBackendOptions(s)
    expect(opts.default).toBe('mock')
    expect(opts.options.find((o) => o.id === 'stt_judge')!.detail).toContain('revai + clef')
  })
})

describe('energy VAD', () => {
  const frame = (ms: number, amp: number) => { const n = 24 * ms; const b = new Uint8Array(n * 2); const dv = new DataView(b.buffer); for (let i = 0; i < n; i++) dv.setInt16(i * 2, i % 2 ? amp : -amp, true); return b }
  it('reports start after min speech and stop after the silence window, on the audio timeline', () => {
    const v = new EnergyVad({ sampleRate: 24000, rmsThreshold: 500, minSpeechMs: 60, silenceMs: 200, prefixMs: 100 })
    const evs: any[] = []
    for (let i = 0; i < 10; i++) evs.push(...v.push(frame(20, 50))) // 200 ms of silence
    for (let i = 0; i < 10; i++) evs.push(...v.push(frame(20, 3000))) // 200 ms of speech
    for (let i = 0; i < 15; i++) evs.push(...v.push(frame(20, 50))) // 300 ms of silence
    expect(evs.map((e) => e.type)).toEqual(['speech_started', 'speech_stopped'])
    expect(evs[0].atMs).toBeCloseTo(200 - 100, 0) // detected at 260 ms, run 60 ms, prefix 100 ms → 100 ms
    expect(evs[1].atMs).toBeCloseTo(400, 0)
  })
  it('reset after a clear never reports speech before the clear point', () => {
    const v = new EnergyVad({ sampleRate: 24000, rmsThreshold: 500, minSpeechMs: 40, silenceMs: 100, prefixMs: 500 })
    for (let i = 0; i < 10; i++) v.push(frame(20, 50))
    v.reset()
    const evs: any[] = []
    for (let i = 0; i < 5; i++) evs.push(...v.push(frame(20, 3000)))
    expect(evs[0].type).toBe('speech_started')
    expect(evs[0].atMs).toBeGreaterThanOrEqual(200)
  })
})
