import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AudioStore, buildManifest, type Manifest } from '../server/lib/audioStore'
import { ensureDirs, loadSettings, type Settings } from '../server/lib/config'
import { SessionMetrics } from '../server/lib/metrics'
import { ConversationEngine, defaultRuntime, type RealtimeTransport, type RtEvent, type RuntimeSettings, TransportClosed } from '../server/lib/realtimeSession'
import { GeneratedScenarioSchema, makeScenario, type GeneratedScenario, type Scenario } from '../server/lib/scenarioSchema'
import { Store } from '../server/lib/scenarioStore'
import { voiceSettings, type VoiceSettings } from '../server/lib/tts'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SAMPLE = path.join(ROOT, 'fixtures', 'sample_scenario.json')

export const sampleBody = (): any => JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'))

export function sampleScenario(overrides: Partial<GeneratedScenario> = {}): Scenario {
  const body = GeneratedScenarioSchema.parse({ ...sampleBody(), ...overrides })
  return makeScenario(body, { scenario_id: 'scn_0123456789abcdef', version: 1 })
}

export function tinyWav(ms = 200): Uint8Array {
  const n = 24 * ms
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true)
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, 1, true)
  return new Uint8Array(buf)
}

export const MOCK_VOICE: VoiceSettings = voiceSettings({ provider: 'mock', model: 'mock-tone', voice: 'mock', format: 'wav', speed: 1.0, style_id: 'polite', style_text: '丁寧' })

export function tmpSettings(over: Partial<Settings> = {}): Settings {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbmvp-'))
  const s = loadSettings({ dataDir: path.join(dir, 'data'), scenarioProvider: 'mock', ttsProvider: 'mock', realtimeProvider: 'mock', ...over })
  ensureDirs(s)
  return s
}

export function makeStores(s: Settings) {
  const store = new Store(path.join(s.dataDir, 'mvp.sqlite3'))
  const audio = new AudioStore(path.join(s.dataDir, 'audio'), store)
  return { store, audio }
}

export function readyManifest(scenario: Scenario, audio: AudioStore): Manifest {
  const m = buildManifest(scenario, MOCK_VOICE, audio)
  for (const e of Object.values(m.entries)) {
    if (e.status !== 'ready') {
      const meta = audio.write(e.audio_id, tinyWav(), 'audio/wav', 200, MOCK_VOICE as any)
      Object.assign(e, { status: 'ready', ...meta })
    }
  }
  return m
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Scripted Realtime transport + engine harness
// ---------------------------------------------------------------------------

export class ScriptedTransport implements RealtimeTransport {
  isMock = false
  sent: RtEvent[] = []
  closed = false
  private inbox: (RtEvent | null)[] = []
  private waiters: ((e: RtEvent | null) => void)[] = []
  private n = 0

  async connect() {}
  async send(event: RtEvent) {
    if (this.closed) throw new TransportClosed('closed')
    if (event.type === 'input_audio_buffer.append') this.sent.push({ type: event.type, len: event.audio.length })
    else this.sent.push(event)
  }
  recv(): Promise<RtEvent> {
    const take = (ev: RtEvent | null) => { if (ev === null) throw new TransportClosed('server closed'); return ev }
    if (this.inbox.length) return Promise.resolve(take(this.inbox.shift()!))
    return new Promise((res, rej) => this.waiters.push((ev) => { try { res(take(ev)) } catch (e) { rej(e) } }))
  }
  async close() { this.closed = true }
  bufferedBytes() { return 0 }

  push(ev: RtEvent | null) {
    const w = this.waiters.shift()
    if (w) w(ev)
    else this.inbox.push(ev)
  }
  types() { return this.sent.map((e) => e.type) }
  requests(phase?: 'preview' | 'final') {
    return this.sent.filter((e) => e.type === 'response.create' && (!phase || e.response.metadata.phase === phase))
  }
  newId(p = 'resp') { return `${p}_${++this.n}` }
  respond(req: RtEvent, branchId: string | null, o: { status?: string; output?: unknown[]; metadata?: Record<string, string>; created?: boolean; rid?: string } = {}) {
    const md = o.metadata ?? { ...req.response.metadata }
    const rid = o.rid ?? this.newId()
    if (o.created !== false) this.push({ type: 'response.created', response: { id: rid, metadata: md } })
    const output = o.output ?? [{ type: 'function_call', name: 'select_branch', status: 'completed', arguments: JSON.stringify({ branch_id: branchId, reason: 'test' }) }]
    this.push({ type: 'response.done', response: { id: rid, metadata: md, status: o.status ?? 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
    return rid
  }
}

export interface HarnessOptions {
  scenario?: Scenario
  rs?: Partial<RuntimeSettings>
  mode?: 'inline' | 'item'
  autoPlay?: boolean
  playMs?: number
}

export class Harness {
  scenario: Scenario
  manifest: Manifest
  transport = new ScriptedTransport()
  browser: Record<string, any>[] = []
  rs: RuntimeSettings
  metrics: SessionMetrics
  engine: ConversationEngine
  run: Promise<string> | null = null
  autoPlay: boolean
  playMs: number
  private item = 0

  constructor(public audio: AudioStore, logDir: string, o: HarnessOptions = {}) {
    this.scenario = o.scenario ?? sampleScenario()
    this.manifest = readyManifest(this.scenario, audio)
    this.autoPlay = o.autoPlay ?? true
    this.playMs = o.playMs ?? 10
    this.rs = defaultRuntime({ final_grace_ms: 30, preview_min_audio_ms: 300, preview_interval_ms: 300, ...(o.rs ?? {}) })
    this.metrics = new SessionMetrics(logDir, 'sess_test' + Math.random().toString(16).slice(2, 8))
    this.engine = new ConversationEngine({
      sessionId: 'sess_0123456789abcdef', scenario: this.scenario, manifest: this.manifest, audio, transport: this.transport,
      sendBrowser: (m) => this.onBrowser(m), settings: this.rs, metrics: this.metrics, previewAudioMode: o.mode ?? 'inline',
    })
  }

  private onBrowser(msg: Record<string, any>) {
    this.browser.push(msg)
    if (msg.type === 'play' && this.autoPlay) {
      const pid = msg.playback_id
      setTimeout(() => this.engine.pushBrowserJson({ type: 'playback_started', playback_id: pid }), 0)
      setTimeout(() => this.engine.pushBrowserJson({ type: 'playback_ended', playback_id: pid }), this.playMs)
    }
  }

  async start() {
    this.run = this.engine.run()
    this.transport.push({ type: 'session.updated', session: {} })
    await this.until(() => this.engine.phase === 'LISTENING')
  }

  async until(cond: () => boolean, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timeout; phase=${this.engine.phase} browser=${this.browser.map((m) => m.type).slice(-15).join(',')}`)
      await sleep(3)
    }
  }

  plays() { return this.browser.filter((m) => m.type === 'play').map((m) => m.utterance_key as string) }
  msgs(t: string) { return this.browser.filter((m) => m.type === t) }

  async feed(ms: number) {
    for (let i = 0; i < Math.floor(ms / 20); i++) this.engine.pushBrowserAudio(new Uint8Array(960))
    await sleep(10)
  }

  speechStart(audioStartMs?: number) {
    const iid = `item_u${++this.item}`
    this.transport.push({ type: 'input_audio_buffer.speech_started', item_id: iid, audio_start_ms: audioStartMs ?? Math.floor(this.engine.ring.total / 24) })
    return iid
  }

  speechStop(iid: string, commit = true) {
    this.transport.push({ type: 'input_audio_buffer.speech_stopped', item_id: iid, audio_end_ms: 0 })
    if (commit) {
      this.transport.push({ type: 'input_audio_buffer.committed', item_id: iid })
      this.transport.push({ type: 'conversation.item.added', item: { id: iid } })
      this.transport.push({ type: 'conversation.item.done', item: { id: iid } })
    }
  }

  /** Full turn: speech → stop → final response with `branch`. */
  async answer(branch: string, speakMs = 400) {
    const nFinal = this.transport.requests('final').length
    const iid = this.speechStart()
    await sleep(10)
    await this.feed(speakMs)
    this.speechStop(iid)
    await this.until(() => this.transport.requests('final').length > nFinal)
    const req = this.transport.requests('final').at(-1)!
    this.transport.respond(req, branch)
    return req
  }

  async stop() {
    if (this.run && !this.engine.done) {
      this.engine.pushBrowserJson({ type: 'stop' })
    }
    await this.run
  }
}

export function harnessFactory() {
  const s = tmpSettings()
  const { audio } = makeStores(s)
  const logDir = path.join(s.dataDir, 'logs')
  return (o: HarnessOptions = {}) => new Harness(audio, logDir, o)
}
