/**
 * HTTP + WebSocket integration against the built Nitro server (mock providers,
 * no keys, no network). Requires `npm run build` first (see vitest.globalSetup).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT, sleep } from './helpers'

const PORT = 18000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
const ORIGIN = { origin: BASE }
let proc: ChildProcess
let dataDir: string

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = ORIGIN) {
  const h: Record<string, string> = { ...headers }
  let payload: string | undefined
  if (body !== undefined) {
    h['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const r = await fetch(BASE + p, { method, headers: h, body: payload })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers }
}

async function waitJob(id: string, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const j = (await req('GET', `/api/jobs/${id}`)).json
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(j.status)) return j
    await sleep(50)
  }
  throw new Error('job timeout')
}

async function voice() {
  const vo = (await req('GET', '/api/config')).json.voice_options
  return { provider: vo.providers[0], model: vo.models[0], voice: vo.voices[0], speed: 1.0, style_id: 'polite' }
}

async function prepareReady() {
  const g = await req('POST', '/api/scenarios/generate', { instruction: '問い合わせ受付' })
  expect(g.status, g.text).toBe(200)
  const j = await waitJob(g.json.job_id)
  expect(j.status).toBe('succeeded')
  const sid = j.result.scenario_id
  const a = await req('POST', `/api/scenarios/${sid}/versions/1/approve`, { voice: await voice(), confirm_reviewed: true })
  expect(a.status, a.text).toBe(200)
  const j2 = await waitJob(a.json.job_id)
  expect(j2.status, JSON.stringify(j2)).toBe('succeeded')
  return sid as string
}

class WsClient {
  ws: WebSocket
  all: any[] = []
  private cursor = 0
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (d) => this.all.push(JSON.parse(d.toString())))
  }
  open() { return new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); this.ws.once('unexpected-response', (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`))) }) }
  /** Scans forward from the last match; returns the match and everything seen since the previous match. */
  async until(pred: (m: any) => boolean, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs
    const from = this.cursor
    for (;;) {
      for (; this.cursor < this.all.length; this.cursor++) {
        if (pred(this.all[this.cursor])) {
          const m = this.all[this.cursor]
          const seen = this.all.slice(from, this.cursor + 1)
          this.cursor++
          return { m, seen }
        }
      }
      if (Date.now() > end) throw new Error('ws timeout; seen ' + JSON.stringify(this.all.slice(from)).slice(0, 1500))
      await sleep(5)
    }
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)) }
  sendAudio(frames: number) { for (let i = 0; i < frames; i++) { const f = new Uint8Array(961); f[0] = 0x01; this.ws.send(f) } }
  ack(m: any) { this.send({ type: 'playback_started', playback_id: m.playback_id }); this.send({ type: 'playback_ended', playback_id: m.playback_id }) }
  close() { this.ws.close() }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbmvp-app-'))
  proc = spawn('node', [path.join(ROOT, '.output/server/index.mjs')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, SCENARIO_PROVIDER: 'mock', TTS_PROVIDER: 'mock', REALTIME_PROVIDER: 'mock', NITRO_PORT: String(PORT), NITRO_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  proc.stdout?.on('data', (d) => (out += d))
  proc.stderr?.on('data', (d) => (out += d))
  const end = Date.now() + 20000
  while (Date.now() < end) {
    try {
      const r = await fetch(BASE + '/api/config')
      if (r.ok) return
    } catch { /* not up yet */ }
    await sleep(200)
  }
  throw new Error('server did not start: ' + out)
}, 30000)

afterAll(() => { proc?.kill() })

describe('HTTP API', () => {
  it('config reports mock providers and no secrets', async () => {
    const c = (await req('GET', '/api/config')).json
    expect(c.providers.scenario.mock && c.providers.tts.mock && c.providers.realtime.mock).toBe(true)
    expect(c.metric_definitions).toHaveProperty('barge_in_speech_start_to_playback_stop_ms')
    expect(JSON.stringify(c)).not.toMatch(/ANTHROPIC|sk-/)
  })

  it('origin / host / content-type / size guards', async () => {
    expect((await req('POST', '/api/scenarios/generate', { instruction: 'x' }, {})).status).toBe(403)
    expect((await req('POST', '/api/scenarios/generate', { instruction: 'x' }, { origin: 'http://evil.example' })).status).toBe(403)
    const r = await fetch(BASE + '/api/scenarios/generate', { method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'instruction=x' })
    expect(r.status).toBe(415)
    // fetch refuses to override Host; use a raw request for the Host-header check
    const hostStatus = await new Promise<number>((res, rej) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/config', method: 'GET', headers: { host: 'evil.example' } }, (resp) => { resp.resume(); res(resp.statusCode ?? 0) })
      r.on('error', rej); r.end()
    })
    expect(hostStatus).toBe(421)
    expect((await req('POST', '/api/scenarios/generate', { instruction: 'x'.repeat(600_000) })).status).toBe(413)
    expect((await req('POST', '/api/scenarios/generate', { instruction: 'x'.repeat(4001) })).status).toBe(422)
    expect((await req('POST', '/api/scenarios/generate', { instruction: 'x', max_nodes: 999 })).status).toBe(422)
    expect((await req('POST', '/api/scenarios/generate', { instruction: 'x', evil: 1 })).status).toBe(422)
  })

  it('audio path traversal rejected', async () => {
    for (const p of ['/api/audio/..%2F..%2Fetc%2Fpasswd', '/api/audio/' + 'a'.repeat(63), '/api/audio/' + 'g'.repeat(64), '/api/audio/' + '0'.repeat(64)]) {
      expect((await req('GET', p)).status).toBe(404)
    }
    expect((await req('GET', '/api/sessions/..%2F..%2Fx/log.jsonl')).status).toBe(404)
  })

  it('full flow: generate → review → edit (new version) → approve → READY → session', async () => {
    const g = await req('POST', '/api/scenarios/generate', { instruction: '問い合わせ受付', first_utterance: 'お電話ありがとうございます。料金、デモ、操作サポートのどれをご希望ですか。' })
    const j = await waitJob(g.json.job_id)
    const sid = j.result.scenario_id
    const row = (await req('GET', `/api/scenarios/${sid}/versions/1`)).json
    expect(row.status).toBe('REVIEW'); expect(row.is_mock_generated).toBe(true)
    expect((await req('POST', '/api/sessions', { scenario_id: sid, version: 1 })).status).toBe(409)
    expect((await req('POST', `/api/scenarios/${sid}/versions/1/approve`, { voice: await voice() })).status).toBe(400)
    expect((await req('POST', `/api/scenarios/${sid}/versions/1/approve`, { voice: { ...(await voice()), voice: 'alloy' }, confirm_reviewed: true })).status).toBe(400)

    const sc = row.scenario
    const body: any = Object.fromEntries(['title', 'entry_node_id', 'nodes', 'control_nodes', 'policy', 'design_notes'].map((k) => [k, sc[k]]))
    body.nodes[1].assistant_text = '料金のご案内ですね。月額3,000円です。'
    const v2 = await req('POST', `/api/scenarios/${sid}/versions`, { base_version: 1, scenario: body })
    expect(v2.status).toBe(200); expect(v2.json.version).toBe(2); expect(v2.json.validation.ok).toBe(false)
    expect((await req('POST', `/api/scenarios/${sid}/versions/2/approve`, { voice: await voice(), confirm_reviewed: true })).status).toBe(422)
    const body2 = structuredClone(body); body2.nodes[0].evil = '<script>'
    expect((await req('POST', `/api/scenarios/${sid}/versions`, { base_version: 1, scenario: body2 })).status).toBe(422)

    const a = await req('POST', `/api/scenarios/${sid}/versions/1/approve`, { voice: await voice(), confirm_reviewed: true })
    const j2 = await waitJob(a.json.job_id)
    expect(j2.status).toBe('succeeded'); expect(j2.version_status).toBe('READY')
    const m = (await req('GET', `/api/scenarios/${sid}/versions/1/manifest`)).json
    expect(m.summary.ready).toBe(13); expect(m.summary.total).toBe(13); expect(m.mock_audio).toBe(true)
    const aid = (Object.values(m.entries)[0] as any).audio_id
    const au = await fetch(`${BASE}/api/audio/${aid}`)
    expect(au.status).toBe(200); expect(au.headers.get('content-type')).toBe('audio/wav')
    expect(new TextDecoder().decode((await au.arrayBuffer()).slice(0, 4))).toBe('RIFF')

    const s1 = (await req('POST', '/api/sessions', { scenario_id: sid, version: 1, request_id: 'abc123' })).json
    const s2 = (await req('POST', '/api/sessions', { scenario_id: sid, version: 1, request_id: 'abc123' })).json
    expect(s1.session_id).toBe(s2.session_id); expect(s2.created).toBe(false)
    expect((await req('POST', '/api/sessions', { scenario_id: sid, version: 1, runtime: { silence_duration_ms: 5 } })).status).toBe(400)
  })

  it('session blocked when audio is missing', async () => {
    const sid = await prepareReady()
    const m = (await req('GET', `/api/scenarios/${sid}/versions/1/manifest`)).json
    const victim = m.entries['control:end_request'].audio_id
    for (const f of fs.readdirSync(path.join(dataDir, 'audio'))) if (f.startsWith(victim)) fs.unlinkSync(path.join(dataDir, 'audio', f))
    const r = await req('POST', '/api/sessions', { scenario_id: sid, version: 1 })
    expect(r.status).toBe(409); expect(r.text).toContain('control:end_request')
  })
})

describe('WebSocket E2E (mock Realtime)', () => {
  it('rejects bad origin; half-duplex flow: preview=pricing, final=demo → demo audio; single-use; log export', async () => {
    const sid = await prepareReady()
    const sess = (await req('POST', '/api/sessions', { scenario_id: sid, version: 1, runtime: { final_grace_ms: 50, preview_min_audio_ms: 300, preview_interval_ms: 300 } })).json
    const url = `ws://127.0.0.1:${PORT}/ws?session_id=${sess.session_id}`
    await expect(new WsClient(url, { origin: 'http://evil.example' }).open()).rejects.toThrow()
    const ws = new WsClient(url, ORIGIN)
    await ws.open()
    const { m: play } = await ws.until((m) => m.type === 'play')
    expect(play.utterance_key).toBe('node:select_need'); expect(play.interruptible).toBe(false)
    ws.ack(play)
    await ws.until((m) => m.type === 'state' && m.phase === 'LISTENING')
    ws.send({ type: 'mock_vad', action: 'start', preview_branch: 'pricing', final_branch: 'demo' })
    ws.sendAudio(25)
    const { m: prev } = await ws.until((m) => m.type === 'preview')
    expect(prev.branch_id).toBe('pricing'); expect(prev.provisional).toBe(true)
    ws.send({ type: 'mock_vad', action: 'stop' })
    const { m: fin, seen } = await ws.until((m) => m.type === 'final')
    expect(fin.branch_id).toBe('demo')
    const { m: play2, seen: seen2 } = await ws.until((m) => m.type === 'play')
    expect(play2.utterance_key).toBe('node:confirm_demo')
    expect([...seen, ...seen2].some((m) => m.type === 'play' && m.utterance_key === 'node:confirm_pricing')).toBe(false)
    ws.ack(play2)
    await ws.until((m) => m.type === 'state' && m.phase === 'LISTENING')
    ws.send({ type: 'mock_vad', action: 'start', final_branch: 'yes' })
    ws.sendAudio(5)
    ws.send({ type: 'mock_vad', action: 'stop' })
    const { m: play3 } = await ws.until((m) => m.type === 'play')
    expect(play3.utterance_key).toBe('node:end_demo'); expect(play3.terminal_after).toBe(true)
    ws.ack(play3)
    const { m: done } = await ws.until((m) => m.type === 'finished')
    expect(done.phase).toBe('FINISHED')
    ws.close()
    const ws2 = new WsClient(url, ORIGIN)
    await ws2.open()
    const { m: used } = await ws2.until((m) => m.type === 'finished')
    expect(used.reason).toBe('session_used')
    const log = await req('GET', `/api/sessions/${sess.session_id}/log.jsonl`)
    expect(log.status).toBe(200)
    const lines = log.text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const kinds = new Set(lines.map((l) => l.event))
    for (const k of ['session_start', 'preview', 'turn', 'summary']) expect(kinds).toContain(k)
    expect(log.text).not.toContain('AAAA'); expect(log.text).not.toContain('"audio":')
    const summary = lines.find((l) => l.event === 'summary')
    expect(summary.counters.preview_results).toBeGreaterThanOrEqual(1); expect(summary.counters.turns).toBe(2)
  })

  it('barge-in over the wire: mic streams during the prompt, speech stops playback, answer is classified', async () => {
    const sid = await prepareReady()
    const sess = (await req('POST', '/api/sessions', { scenario_id: sid, version: 1, runtime: { final_grace_ms: 20, preview_enabled: false, barge_in_enabled: true, barge_in_confirm_ms: 100 } })).json
    expect(sess.barge_in_enabled).toBe(true)
    const ws = new WsClient(`ws://127.0.0.1:${PORT}/ws?session_id=${sess.session_id}`, ORIGIN)
    await ws.open()
    const { m: play } = await ws.until((m) => m.type === 'play')
    expect(play.interruptible).toBe(true)
    const { m: st } = await ws.until((m) => m.type === 'state' && m.phase === 'PLAYING')
    expect(st.mic_enabled).toBe(true)
    ws.send({ type: 'playback_started', playback_id: play.playback_id })
    ws.sendAudio(10)
    ws.send({ type: 'mock_vad', action: 'start', final_branch: 'support' })
    ws.sendAudio(10)
    const { m: stop } = await ws.until((m) => m.type === 'playback_stop')
    expect(stop.playback_id).toBe(play.playback_id)
    ws.send({ type: 'playback_canceled', playback_id: play.playback_id, position_ms: 800, reason: 'barge_in' })
    const { m: intr } = await ws.until((m) => m.type === 'interrupted')
    expect(intr.utterance_key).toBe('node:select_need'); expect(intr.position_ms).toBe(800)
    ws.send({ type: 'mock_vad', action: 'stop' })
    const { m: fin } = await ws.until((m) => m.type === 'final')
    expect(fin.branch_id).toBe('support')
    const { m: play2 } = await ws.until((m) => m.type === 'play')
    expect(play2.utterance_key).toBe('node:confirm_support')
    ws.send({ type: 'stop' })
    const { m: done } = await ws.until((m) => m.type === 'finished')
    expect(done.phase).toBe('STOPPED')
    ws.close()
  })

  it('only MAX_CONCURRENT_SESSIONS live conversations', async () => {
    const sid = await prepareReady()
    const a = (await req('POST', '/api/sessions', { scenario_id: sid, version: 1 })).json
    const b = (await req('POST', '/api/sessions', { scenario_id: sid, version: 1 })).json
    const w1 = new WsClient(`ws://127.0.0.1:${PORT}/ws?session_id=${a.session_id}`, ORIGIN)
    await w1.open()
    await w1.until((m) => m.type === 'play')
    const w2 = new WsClient(`ws://127.0.0.1:${PORT}/ws?session_id=${b.session_id}`, ORIGIN)
    await w2.open()
    const { m } = await w2.until((m) => m.type === 'finished')
    expect(m.reason).toBe('busy')
    w1.send({ type: 'stop' })
    await w1.until((m) => m.type === 'finished')
    w1.close(); w2.close()
  })

  it('stop during playback', async () => {
    const sid = await prepareReady()
    const sess = (await req('POST', '/api/sessions', { scenario_id: sid, version: 1 })).json
    const ws = new WsClient(`ws://127.0.0.1:${PORT}/ws?session_id=${sess.session_id}`, ORIGIN)
    await ws.open()
    await ws.until((m) => m.type === 'play')
    ws.send({ type: 'stop' })
    const { m: done } = await ws.until((m) => m.type === 'finished')
    expect(done.phase).toBe('STOPPED'); expect(done.reason).toBe('user_stop')
    ws.close()
  })
})
