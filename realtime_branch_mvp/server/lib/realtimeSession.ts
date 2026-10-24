/**
 * Realtime conversation engine: VAD, streaming preview / final classification,
 * cancellation, stale-result rejection, playback with acks, optional barge-in.
 *
 * The engine never calls Claude or TTS. Every spoken utterance comes from the
 * pre-generated manifest; a cache miss stops the session safely.
 *
 * All state changes are serialized through one queue (browser messages,
 * browser audio, Realtime server events, timers), so ordering is deterministic.
 */
import { randomBytes } from 'node:crypto'
import type { AudioStore, Manifest } from './audioStore'
import type { SessionMetrics } from './metrics'
import * as router from './router'
import { CTRL_END_REQUEST, CTRL_UNCLEAR, findControl, findNode, type Node, type Scenario } from './scenarioSchema'

export const SAMPLE_RATE = 24000
export const BYTES_PER_SAMPLE = 2
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000

export type Phase = 'CONNECTING' | 'PLAYING' | 'LISTENING' | 'DECIDING' | 'PLAYBACK_ERROR' | 'FINISHED' | 'STOPPED' | 'ERROR'

const hex = (n: number) => randomBytes(n).toString('hex')

// ---------------------------------------------------------------------------
// runtime settings (per session, UI-selectable within bounds)
// ---------------------------------------------------------------------------

export interface RuntimeSettings {
  silence_duration_ms: number
  prefix_padding_ms: number
  vad_threshold: number
  preview_enabled: boolean
  preview_min_audio_ms: number
  preview_interval_ms: number
  preview_max_per_utterance: number
  preview_timeout_ms: number
  final_grace_ms: number
  final_timeout_ms: number
  item_wait_timeout_ms: number
  playback_start_timeout_ms: number
  playback_end_slack_ms: number
  session_ready_timeout_ms: number
  max_utterance_ms: number
  max_classification_requests: number
  ring_seconds: number
  /** Full-duplex: keep streaming the mic while the assistant speaks and stop playback on confirmed user speech. */
  barge_in_enabled: boolean
  /** Speech must last this long after speech_started before playback is stopped (echo / noise guard). */
  barge_in_confirm_ms: number
  /** Assumption (verify against the live API): audio_start_ms is measured from the start of all audio
   * written during the session and does not reset on clear. */
  vad_timeline_resets_on_clear: boolean
}

export const RUNTIME_BOUNDS: Record<string, [number, number]> = {
  silence_duration_ms: [200, 2000], prefix_padding_ms: [0, 1000], vad_threshold: [0.1, 0.95],
  preview_min_audio_ms: [300, 3000], preview_interval_ms: [300, 3000], preview_max_per_utterance: [0, 5],
  final_grace_ms: [0, 1500], final_timeout_ms: [2000, 20000], max_utterance_ms: [3000, 30000],
  barge_in_confirm_ms: [0, 1500],
}
const RUNTIME_BOOLS = ['preview_enabled', 'barge_in_enabled'] as const

export const defaultRuntime = (o: Partial<RuntimeSettings> = {}): RuntimeSettings => ({
  silence_duration_ms: 600, prefix_padding_ms: 300, vad_threshold: 0.5, preview_enabled: true, preview_min_audio_ms: 800,
  preview_interval_ms: 800, preview_max_per_utterance: 3, preview_timeout_ms: 5000, final_grace_ms: 200, final_timeout_ms: 8000,
  item_wait_timeout_ms: 4000, playback_start_timeout_ms: 6000, playback_end_slack_ms: 8000, session_ready_timeout_ms: 10000,
  max_utterance_ms: 20000, max_classification_requests: 150, ring_seconds: 40, barge_in_enabled: false, barge_in_confirm_ms: 250,
  vad_timeline_resets_on_clear: false, ...o,
})

export function runtimeFromUser(data: Record<string, unknown> | null | undefined): RuntimeSettings {
  const rs = defaultRuntime()
  if (!data) return rs
  for (const [k, [lo, hi]] of Object.entries(RUNTIME_BOUNDS)) {
    if (!(k in data)) continue
    const v = Number(data[k])
    if (!Number.isFinite(v)) throw new Error(`${k} が数値ではありません`)
    if (v < lo || v > hi) throw new Error(`${k} は ${lo}〜${hi} の範囲で指定してください`)
    ;(rs as any)[k] = Number.isInteger(rs[k as keyof RuntimeSettings]) ? Math.round(v) : v
  }
  for (const k of RUNTIME_BOOLS) if (k in data) rs[k] = !!data[k]
  return rs
}

// ---------------------------------------------------------------------------
// PCM ring buffer (memory only, discarded at session end)
// ---------------------------------------------------------------------------

/** Keeps the most recent `capacity` samples of PCM16 sent to Realtime, addressed by absolute sample index. */
export class PcmRing {
  chunks: { start: number; data: Uint8Array }[] = []
  total = 0 // absolute samples appended so far
  retainedStart = 0 // first absolute sample still retained
  constructor(public capacity: number) {}

  append(pcm: Uint8Array): number {
    if (pcm.length % BYTES_PER_SAMPLE) throw new Error('PCM16 frame must have an even number of bytes')
    const start = this.total
    this.chunks.push({ start, data: new Uint8Array(pcm) })
    this.total += pcm.length / BYTES_PER_SAMPLE
    while (this.chunks.length && this.total - this.chunks[0]!.start - this.chunks[0]!.data.length / BYTES_PER_SAMPLE >= this.capacity) {
      const c = this.chunks.shift()!
      this.retainedStart = c.start + c.data.length / BYTES_PER_SAMPLE
    }
    return start
  }

  /** Bytes for samples [start, end). null if any part is no longer retained. */
  slice(start: number, end: number): Uint8Array | null {
    if (start < this.retainedStart || end > this.total || start > end) return null
    const out = new Uint8Array((end - start) * BYTES_PER_SAMPLE)
    let off = 0
    for (const { start: s, data } of this.chunks) {
      const n = data.length / BYTES_PER_SAMPLE
      const e = s + n
      if (e <= start || s >= end) continue
      const lo = Math.max(start, s) - s
      const hi = Math.min(end, e) - s
      out.set(data.subarray(lo * BYTES_PER_SAMPLE, hi * BYTES_PER_SAMPLE), off)
      off += (hi - lo) * BYTES_PER_SAMPLE
    }
    return out
  }

  dropAll() {
    this.chunks = []
    this.retainedStart = this.total
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export class TransportClosed extends Error {}

export type RtEvent = Record<string, any>

export interface RealtimeTransport {
  isMock: boolean
  connect(): Promise<void>
  send(event: RtEvent): Promise<void>
  /** Resolves with the next server event; rejects with TransportClosed when the socket closes. */
  recv(): Promise<RtEvent>
  close(): Promise<void>
  bufferedBytes(): number
  control?(msg: Record<string, unknown>): Promise<void>
}

/** Raw GA WebSocket: wss://api.openai.com/v1/realtime?model=… with Bearer auth. */
export class OpenAIRealtimeTransport implements RealtimeTransport {
  isMock = false
  private ws: import('ws').WebSocket | null = null
  private inbox: RtEvent[] = []
  private waiters: { res: (e: RtEvent) => void; rej: (e: Error) => void }[] = []
  private closedErr: Error | null = null
  url: string

  constructor(url: string, model: string, private apiKey: string) {
    if (!model) throw new Error('REALTIME_MODEL が未設定です')
    if (!apiKey) throw new Error('OPENAI_API_KEY が未設定です')
    this.url = `${url}?model=${encodeURIComponent(model)}`
  }

  async connect() {
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.apiKey}` }, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10000 })
    this.ws = ws
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res())
      ws.once('error', (e) => rej(e))
    })
    ws.on('message', (data) => this.push(JSON.parse(data.toString())))
    ws.on('close', (code, reason) => this.fail(new TransportClosed(`closed ${code} ${reason}`)))
    ws.on('error', (e) => this.fail(new TransportClosed(String(e))))
  }

  private push(ev: RtEvent) {
    const w = this.waiters.shift()
    if (w) w.res(ev)
    else this.inbox.push(ev)
  }

  private fail(err: Error) {
    if (this.closedErr) return
    this.closedErr = err
    for (const w of this.waiters.splice(0)) w.rej(err)
  }

  async send(event: RtEvent) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) throw new TransportClosed('not open')
    this.ws.send(JSON.stringify(event))
  }

  recv(): Promise<RtEvent> {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift()!)
    if (this.closedErr) return Promise.reject(this.closedErr)
    return new Promise((res, rej) => this.waiters.push({ res, rej }))
  }

  async close() {
    this.ws?.close()
  }

  bufferedBytes() {
    return this.ws?.bufferedAmount ?? 0
  }
}

/**
 * Local stand-in for the Realtime API (no network, no model). VAD boundaries and
 * the branch it "classifies" are chosen manually from the UI (or by tests). It
 * exists so the end-to-end playback / state machine can be demoed; it does not
 * understand audio.
 */
export class MockRealtimeTransport implements RealtimeTransport {
  isMock = true
  private inbox: RtEvent[] = []
  private waiters: ((e: RtEvent | null) => void)[] = []
  appendedSamples = 0
  sent: RtEvent[] = []
  previewChoice: string | null = null
  finalChoice: string | null = null
  private speechItem: string | null = null
  private responses = new Map<string, NodeJS.Timeout>()
  closed = false
  constructor(public responseDelayMs = 150) {}

  async connect() {}

  private emit(ev: RtEvent | null) {
    const w = this.waiters.shift()
    if (w) w(ev)
    else this.inbox.push(ev as RtEvent)
  }

  async send(event: RtEvent) {
    if (this.closed) throw new TransportClosed('mock closed')
    const t = event.type
    if (t === 'input_audio_buffer.append') {
      const n = Buffer.from(event.audio, 'base64').length / BYTES_PER_SAMPLE
      this.appendedSamples += n
      this.sent.push({ type: t, samples: n })
    } else {
      this.sent.push({ ...event })
    }
    if (t === 'session.update') this.emit({ type: 'session.updated', session: event.session ?? {} })
    else if (t === 'input_audio_buffer.clear') this.emit({ type: 'input_audio_buffer.cleared' })
    else if (t === 'conversation.item.create') {
      const item = { id: 'item_' + hex(4), ...event.item, content: [] }
      this.emit({ type: 'conversation.item.added', item })
      this.emit({ type: 'conversation.item.done', item })
    } else if (t === 'conversation.item.delete') this.emit({ type: 'conversation.item.deleted', item_id: event.item_id })
    else if (t === 'response.create') {
      const rid = 'resp_' + hex(4)
      const md = event.response?.metadata ?? {}
      this.emit({ type: 'response.created', response: { id: rid, metadata: md, status: 'in_progress' } })
      const timer = setTimeout(() => {
        this.responses.delete(rid)
        const choice = (md.phase === 'preview' ? this.previewChoice : this.finalChoice) ?? CTRL_UNCLEAR
        this.emit({ type: 'response.done', response: { id: rid, metadata: md, status: 'completed', output: [{ type: 'function_call', name: router.TOOL_NAME, call_id: 'call_' + rid, status: 'completed', arguments: JSON.stringify({ branch_id: choice, reason: 'MOCK: 手動選択' }) }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })
      }, this.responseDelayMs)
      this.responses.set(rid, timer)
    } else if (t === 'response.cancel') {
      const timer = this.responses.get(event.response_id)
      if (timer) {
        clearTimeout(timer)
        this.responses.delete(event.response_id)
        this.emit({ type: 'response.done', response: { id: event.response_id, status: 'cancelled', status_details: { reason: 'client_cancelled' }, output: [] } })
      }
    }
  }

  async control(msg: Record<string, unknown>) {
    if ('preview_branch' in msg) this.previewChoice = (msg.preview_branch as string) || null
    if ('final_branch' in msg) this.finalChoice = (msg.final_branch as string) || null
    const ms = Math.floor(this.appendedSamples / SAMPLES_PER_MS)
    if (msg.action === 'start' && !this.speechItem) {
      this.speechItem = 'item_' + hex(4)
      this.emit({ type: 'input_audio_buffer.speech_started', item_id: this.speechItem, audio_start_ms: Math.max(0, ms - 300) })
    } else if (msg.action === 'stop' && this.speechItem) {
      const iid = this.speechItem
      this.speechItem = null
      this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: iid, audio_end_ms: ms })
      this.emit({ type: 'input_audio_buffer.committed', item_id: iid })
      const item = { id: iid, type: 'message', role: 'user', status: 'completed', content: [] }
      this.emit({ type: 'conversation.item.added', item })
      this.emit({ type: 'conversation.item.done', item })
    }
  }

  recv(): Promise<RtEvent> {
    const take = (ev: RtEvent | null) => { if (ev === null) throw new TransportClosed('mock closed'); return ev }
    if (this.inbox.length) return Promise.resolve(take(this.inbox.shift()!))
    return new Promise((res, rej) => this.waiters.push((ev) => { try { res(take(ev)) } catch (e) { rej(e) } }))
  }

  async close() {
    this.closed = true
    for (const t of this.responses.values()) clearTimeout(t)
    this.emit(null)
  }

  bufferedBytes() { return 0 }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface Utterance {
  itemId: string
  startSample: number
  tStarted: number
  stopped: boolean
  tStopped: number | null
  committed: boolean
  itemDone: boolean
  previewsSent: number
  lastPreviewT: number
}
const utteranceReady = (u: Utterance) => u.stopped && u.committed && u.itemDone

interface Pending {
  key: string
  phase: 'preview' | 'final'
  turnId: number
  generation: number
  nodeId: string
  sentAt: number
  allowed: string[]
  references: string[]
  tempItemId: string | null
  responseId: string | null
  awaitingItem: boolean
  stale: boolean
  done: boolean
}

interface Playback {
  playbackId: string
  utteranceKey: string
  text: string
  after: 'listen' | 'finish' | 'goto'
  nextNodeId: string
  reason: string
  durationMs: number | null
  turnId: number
  generation: number
  started: boolean
  sentAt: number
  interruptible: boolean
}

interface Decision {
  branchId: string
  generation: number
  reason: string
  fallbackReason: string | null
  source: string
}

export class EngineFatal extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

type QueueItem = ['browser', Record<string, any>] | ['audio', Uint8Array] | ['rt', RtEvent] | ['rt_closed', string] | ['timer', [string, number]]

class AsyncQueue<T> {
  private items: T[] = []
  private waiters: ((v: T) => void)[] = []
  push(v: T) {
    const w = this.waiters.shift()
    if (w) w(v)
    else this.items.push(v)
  }
  pop(): Promise<T> {
    if (this.items.length) return Promise.resolve(this.items.shift()!)
    return new Promise((res) => this.waiters.push(res))
  }
}

export type BrowserSend = (msg: Record<string, unknown>) => Promise<void> | void

export interface EngineOptions {
  sessionId: string
  scenario: Scenario
  manifest: Manifest
  audio: AudioStore
  transport: RealtimeTransport
  sendBrowser: BrowserSend
  settings: RuntimeSettings
  metrics: SessionMetrics
  previewAudioMode?: 'inline' | 'item'
  maxFrameBytes?: number
  maxSendBuffer?: number
  clock?: () => number
}

export class ConversationEngine {
  sessionId: string
  scenario: Scenario // frozen for the session
  manifest: Manifest // private immutable copy
  audio: AudioStore
  transport: RealtimeTransport
  sendBrowserFn: BrowserSend
  rs: RuntimeSettings
  metrics: SessionMetrics
  previewMode: 'inline' | 'item'
  maxFrameBytes: number
  maxSendBuffer: number
  clock: () => number

  queue = new AsyncQueue<QueueItem>()
  phase: Phase = 'CONNECTING'
  micEnabled = false
  nodeId: string
  lastPromptText = ''
  turnId = 0
  generation = 0
  counters = router.newCounters()
  history: [string, string][] = []

  ring: PcmRing
  vadBaseSample = 0
  listenStartSample = 0
  utterances: Utterance[] = []
  active: Utterance | null = null
  pending = new Map<string, Pending>()
  respToKey = new Map<string, string>()
  decision: Decision | null = null
  finalIssuedGeneration: number | null = null
  lastPreviewBranch: string | null = null
  firstPreviewLogged = false
  itemsToDelete: string[] = []
  requestsSent = 0
  playback: Playback | null = null
  /** playback stopped by barge-in; its late `playback_canceled` ack is still accepted for position logging */
  interruptedPlayback: Playback | null = null
  bargeCandidate: { itemId: string; audioStartMs: number; t: number } | null = null
  lastSpeechStartedT: number | null = null
  interrupted: Record<string, unknown>[] = []
  endReason = ''
  endDetail = ''
  private timers = new Map<string, number>()
  private timerHandles = new Map<string, NodeJS.Timeout>()
  private reader: Promise<void> | null = null
  done = false
  private finished!: () => void
  private finishedP = new Promise<void>((r) => (this.finished = r))

  constructor(o: EngineOptions) {
    this.sessionId = o.sessionId
    this.scenario = o.scenario
    this.manifest = JSON.parse(JSON.stringify(o.manifest))
    this.audio = o.audio
    this.transport = o.transport
    this.sendBrowserFn = o.sendBrowser
    this.rs = o.settings
    this.metrics = o.metrics
    this.previewMode = o.previewAudioMode ?? 'inline'
    this.maxFrameBytes = o.maxFrameBytes ?? 24000
    this.maxSendBuffer = o.maxSendBuffer ?? 4_000_000
    this.clock = o.clock ?? (() => performance.now())
    this.nodeId = o.scenario.entry_node_id
    this.ring = new PcmRing(this.rs.ring_seconds * SAMPLE_RATE)
  }

  // ------------------------------------------------------------------ public
  pushBrowserJson(msg: Record<string, any>) { this.queue.push(['browser', msg]) }
  pushBrowserAudio(data: Uint8Array) { this.queue.push(['audio', data]) }

  async run(): Promise<string> {
    this.metrics.event('session_start', { scenario_id: this.scenario.scenario_id, version: this.scenario.version, runtime: this.rs, mock_realtime: this.transport.isMock, preview_mode: this.previewMode })
    try {
      try {
        await this.transport.connect()
      } catch (e: any) {
        throw new EngineFatal('realtime_connect_failed', `Realtime API に接続できません: ${e?.constructor?.name ?? e}`)
      }
      this.reader = this.readTransport()
      await this.sendRt(this.sessionUpdate())
      this.setTimer('session_ready', this.rs.session_ready_timeout_ms)
      await this.emitState()
      while (!this.done) {
        const [kind, payload] = await this.queue.pop()
        try {
          await this.dispatch(kind, payload)
        } catch (e) {
          if (e instanceof EngineFatal) throw e
          if (e instanceof TransportClosed) throw new EngineFatal('realtime_disconnected', this.disconnectMessage())
          throw e
        }
      }
    } catch (e: any) {
      if (e instanceof EngineFatal) await this.finish('ERROR', e.code, e.message)
      else {
        console.error('engine crashed', e)
        await this.finish('ERROR', 'internal_error', `内部エラー: ${e?.message ?? e}`)
      }
    } finally {
      for (const h of this.timerHandles.values()) clearTimeout(h)
      try { await this.transport.close() } catch { /* ignore */ }
      this.ring.dropAll()
      this.metrics.close({ end_reason: this.endReason, final_phase: this.phase, node_id: this.nodeId, interrupted: this.interrupted })
      this.finished()
    }
    return this.endReason
  }

  // ------------------------------------------------------------------ plumbing
  private async readTransport() {
    try {
      for (;;) {
        const ev = await this.transport.recv()
        this.queue.push(['rt', ev])
      }
    } catch (e: any) {
      this.queue.push(['rt_closed', String(e?.message ?? e)])
    }
  }

  setTimer(name: string, ms: number) {
    this.cancelTimer(name)
    const token = (this.timers.get(name) ?? 0) + 1
    this.timers.set(name, token)
    this.timerHandles.set(name, setTimeout(() => this.queue.push(['timer', [name, token]]), ms))
  }

  private cancelTimer(name: string) {
    const h = this.timerHandles.get(name)
    if (h) clearTimeout(h)
    this.timerHandles.delete(name)
    this.timers.set(name, (this.timers.get(name) ?? 0) + 1) // invalidates any queued fire
  }

  private async sendRt(ev: RtEvent) {
    if (this.transport.bufferedBytes() > this.maxSendBuffer) throw new EngineFatal('send_buffer_overflow', 'Realtime への送信が詰まっています（過負荷）。安全のため停止しました。')
    await this.transport.send(ev)
  }

  private async latency(name: string, valueMs: number, extra: Record<string, unknown> = {}) {
    const v = Math.round(valueMs * 10) / 10
    this.metrics.event('latency', { name, value_ms: v, clock: 'server', ...extra })
    await this.sendBrowser({ type: 'metric', name, value_ms: v })
  }

  private async sendBrowser(msg: Record<string, unknown>) {
    try {
      await this.sendBrowserFn(msg)
    } catch { /* browser gone; the app pushes a disconnect message */ }
  }

  private sessionUpdate(): RtEvent {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['text'],
        instructions: router.SESSION_INSTRUCTIONS,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            turn_detection: {
              type: 'server_vad', threshold: this.rs.vad_threshold, prefix_padding_ms: this.rs.prefix_padding_ms,
              silence_duration_ms: this.rs.silence_duration_ms, create_response: false, interrupt_response: false,
            },
          },
        },
        tools: [],
        tool_choice: 'none',
      },
    }
  }

  private disconnectMessage(): string {
    if (this.phase === 'PLAYING' && this.playback) {
      return `音声再生中（${this.playback.utteranceKey}）に Realtime 接続が切断されました。次のノードへは自動で進みません。新しいセッションで再開始してください。`
    }
    return 'Realtime 接続が切断されました。新しいセッションで再開始してください。'
  }

  // ------------------------------------------------------------------ dispatch
  private async dispatch(kind: QueueItem[0], payload: any) {
    if (this.done) return
    if (kind === 'audio') await this.onAudio(payload)
    else if (kind === 'browser') await this.onBrowser(payload)
    else if (kind === 'rt') await this.onRt(payload)
    else if (kind === 'rt_closed') throw new EngineFatal('realtime_disconnected', this.disconnectMessage())
    else if (kind === 'timer') {
      const [name, token] = payload as [string, number]
      if (this.timers.get(name) === token) {
        this.timerHandles.delete(name)
        await this.onTimer(name)
      }
    }
  }

  // ------------------------------------------------------------------ audio in
  private async onAudio(data: Uint8Array) {
    if (!this.micEnabled) {
      // Half-duplex: audio arriving while the assistant is playing is not an answer; counted, not silently dropped.
      this.metrics.inc('dropped_frames_while_playing')
      return
    }
    if (data.length > this.maxFrameBytes || data.length % BYTES_PER_SAMPLE) throw new EngineFatal('bad_audio_frame', '不正な音声フレームを受信しました。')
    this.ring.append(data)
    await this.sendRt({ type: 'input_audio_buffer.append', audio: Buffer.from(data).toString('base64') })
    const u = this.active
    if (u && !u.stopped) {
      if (this.ring.total - u.startSample > this.rs.max_utterance_ms * SAMPLES_PER_MS) throw new EngineFatal('utterance_too_long', `1回の発話が上限 ${this.rs.max_utterance_ms}ms を超えました。安全のため停止しました。`)
      await this.maybePreview(u)
    }
  }

  // ------------------------------------------------------------------ browser
  private async onBrowser(msg: Record<string, any>) {
    const t = msg.type
    if (t === 'stop') await this.finish('STOPPED', 'user_stop', '利用者が停止しました。')
    else if (t === '_disconnect') {
      const where = this.phase === 'PLAYING' && this.playback ? `（再生中: ${this.playback.utteranceKey}）` : ''
      await this.finish('STOPPED', 'browser_disconnected', `ブラウザが切断されました${where}。再開は新しいセッションで行ってください。`)
    } else if (t === 'playback_started' || t === 'playback_ended' || t === 'playback_failed' || t === 'playback_canceled') await this.onPlaybackAck(t, msg)
    else if (t === 'playback_retry') {
      if (this.phase === 'PLAYBACK_ERROR' && this.playback) {
        const pb = this.playback
        await this.play(pb.utteranceKey, pb.text, pb.after, pb.nextNodeId, pb.reason)
      }
    } else if (t === 'client_metric') {
      const name = String(msg.name ?? '').slice(0, 80)
      const val = msg.value_ms
      if (typeof val === 'number') this.metrics.event('client_metric', { clock: 'browser', name, value_ms: Math.round(val * 10) / 10, playback_id: String(msg.playback_id ?? '').slice(0, 40), turn_id: msg.turn_id })
    } else if (t === 'mock_vad') {
      if (this.transport.isMock && this.transport.control) await this.transport.control(msg)
    } else this.metrics.event('unknown_browser_message', { type: String(t).slice(0, 40) })
  }

  // ------------------------------------------------------------------ playback
  private async play(key: string, text: string, after: 'listen' | 'finish' | 'goto', nextNodeId: string, reason: string) {
    const entry = this.manifest.entries[key]
    if (!entry || entry.status !== 'ready' || !this.audio.isReady(entry.audio_id)) {
      this.metrics.inc('audio_cache_miss')
      // never synthesize on the conversation path
      throw new EngineFatal('audio_cache_miss', `事前生成音声がありません（${key}）。準備不備のため安全に停止しました。`)
    }
    this.metrics.inc('audio_cache_hit')
    const interruptible = this.rs.barge_in_enabled && after === 'listen'
    if (after === 'listen') {
      // the node being answered next is fixed as soon as its prompt starts
      this.nodeId = nextNodeId
      this.lastPromptText = text
    }
    this.phase = 'PLAYING'
    this.bargeCandidate = null
    if (interruptible) {
      // Full-duplex: the mic stays open during playback. Nothing is referenced any more (previous
      // turn's items were released at commit), so the buffer can be cleared before the prompt starts.
      await this.sendRt({ type: 'input_audio_buffer.clear' })
      this.ring.dropAll()
      this.listenStartSample = this.ring.total
      if (this.rs.vad_timeline_resets_on_clear) this.vadBaseSample = this.ring.total
      this.micEnabled = true
    } else {
      this.micEnabled = false
    }
    const pb: Playback = {
      playbackId: 'pb_' + hex(5), utteranceKey: key, text, after, nextNodeId, reason, durationMs: entry.duration_ms,
      turnId: this.turnId, generation: this.generation, started: false, sentAt: this.clock(), interruptible,
    }
    this.playback = pb
    if (this.lastSpeechStartedT !== null && !['entry', 'goto', 'retry'].includes(reason)) {
      await this.latency('speech_start_to_next_playback_ms', (pb.sentAt - this.lastSpeechStartedT), { note: "includes the user's own speaking time" })
    }
    await this.sendBrowser({
      type: 'play', playback_id: pb.playbackId, turn_id: pb.turnId, decision_generation: pb.generation, utterance_key: key, text,
      audio_id: entry.audio_id, url: `/api/audio/${entry.audio_id}`, mime: entry.mime, terminal_after: after === 'finish', interruptible,
    })
    this.setTimer('playback_start', this.rs.playback_start_timeout_ms)
    await this.emitState()
  }

  private async onPlaybackAck(t: string, msg: Record<string, any>) {
    const pid = msg.playback_id
    const ipb = this.interruptedPlayback
    if (ipb && pid === ipb.playbackId) {
      // late ack for a playback stopped by barge-in: record the position, never transition
      if (t === 'playback_canceled' || t === 'playback_ended') {
        const pos = typeof msg.position_ms === 'number' ? msg.position_ms : null
        const rec = this.interrupted[this.interrupted.length - 1]
        if (rec && rec.playback_id === pid) {
          rec.position_ms = pos
          rec.remaining_ms = pos !== null && ipb.durationMs !== null ? Math.max(0, ipb.durationMs - pos) : null
          this.metrics.event('playback_interrupted_position', { playback_id: pid, position_ms: pos, remaining_ms: rec.remaining_ms })
          await this.sendBrowser({ type: 'interrupted', playback_id: pid, utterance_key: ipb.utteranceKey, text: ipb.text, position_ms: pos, remaining_ms: rec.remaining_ms })
        }
        this.interruptedPlayback = null
      }
      return
    }
    const pb = this.playback
    if (!pb || pid !== pb.playbackId || !(this.phase === 'PLAYING' || this.phase === 'PLAYBACK_ERROR')) {
      this.metrics.inc('stale_ignored')
      this.metrics.event('stale_playback_ack', { ack: t, playback_id: String(pid).slice(0, 40) })
      return
    }
    if (t === 'playback_started') {
      if (pb.started) return
      pb.started = true
      this.cancelTimer('playback_start')
      this.setTimer('playback_end', (pb.durationMs ?? 60000) + this.rs.playback_end_slack_ms)
    } else if (t === 'playback_failed') {
      this.cancelTimer('playback_start')
      this.cancelTimer('playback_end')
      this.metrics.inc('playback_failed')
      this.metrics.event('playback_failed', { playback_id: pid, utterance_key: pb.utteranceKey, error: String(msg.error ?? '').slice(0, 200) })
      this.phase = 'PLAYBACK_ERROR'
      this.micEnabled = false
      await this.sendBrowser({ type: 'playback_error', playback_id: pid, utterance_key: pb.utteranceKey, message: '音声を再生できませんでした。再試行するか、停止してください。' })
      await this.emitState()
    } else {
      this.cancelTimer('playback_start')
      this.cancelTimer('playback_end')
      if (t === 'playback_canceled') {
        const rec = { playback_id: pid, utterance_key: pb.utteranceKey, node_id: this.nodeId, position_ms: msg.position_ms ?? null, turn_id: this.turnId, reason: String(msg.reason ?? 'user_skip').slice(0, 40) }
        this.interrupted.push(rec)
        this.metrics.event('playback_interrupted', rec)
      }
      await this.afterPlayback(pb)
    }
  }

  private async afterPlayback(pb: Playback) {
    this.playback = null
    if (pb.after === 'finish') {
      await this.finish('FINISHED', 'completed', '会話が終了しました。')
      return
    }
    if (pb.after === 'goto') {
      const step = router.nodeStep(this.scenario, pb.nextNodeId, 'goto')
      await this.play(step.playKey, step.playText, step.after, step.nextNodeId, 'goto')
      return
    }
    // listen: answer pb.nextNodeId (fallback returns here without re-speaking)
    if (pb.interruptible && this.bargeCandidate) {
      // speech began just before the prompt ended: keep it, it is the answer
      const c = this.bargeCandidate
      this.bargeCandidate = null
      this.cancelTimer('barge_confirm')
      await this.startListening(false)
      await this.beginUtterance(c.itemId, c.audioStartMs, c.t)
      return
    }
    await this.startListening(!pb.interruptible)
  }

  // ------------------------------------------------------------------ listening
  private async startListening(clearBuffer: boolean) {
    this.turnId += 1
    this.metrics.inc('turns')
    this.utterances = []
    this.active = null
    this.decision = null
    this.finalIssuedGeneration = null
    this.lastPreviewBranch = null
    this.firstPreviewLogged = false
    if (clearBuffer) {
      // Mic was off during playback, nothing is being spoken or referenced → safe to clear.
      await this.sendRt({ type: 'input_audio_buffer.clear' })
      this.ring.dropAll()
      this.listenStartSample = this.ring.total
      if (this.rs.vad_timeline_resets_on_clear) this.vadBaseSample = this.ring.total
    }
    this.phase = 'LISTENING'
    this.micEnabled = true
    const node = findNode(this.scenario, this.nodeId)!
    this.setTimer('no_input', this.scenario.policy.no_input_timeout_ms)
    await this.sendBrowser({ type: 'prefetch', audio_ids: this.candidateAudioIds(node, null) })
    await this.emitState()
    await this.gcItems()
  }

  private candidateAudioIds(node: Node, preferred: string | null): string[] {
    const keys: string[] = []
    const order = [...node.edges]
    if (preferred) order.sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0))
    for (const e of order) keys.push(`node:${e.target_node_id}`)
    for (const cid of [node.fallback_node_id, node.no_input_node_id, this.scenario.policy.end_request_node_id, this.scenario.policy.limit_node_id]) if (cid) keys.push(`control:${cid}`)
    const out: string[] = []
    for (const k of keys) {
      const e = this.manifest.entries[k]
      if (e && !out.includes(e.audio_id)) out.push(e.audio_id)
    }
    return out
  }

  // ------------------------------------------------------------------ realtime events
  private async onRt(ev: RtEvent) {
    const t = ev.type ?? ''
    if (t === 'session.updated') {
      if (this.phase === 'CONNECTING') {
        this.cancelTimer('session_ready')
        const step = router.entryStep(this.scenario)
        await this.play(step.playKey, step.playText, step.after, step.nextNodeId, 'entry')
      }
    } else if (t === 'input_audio_buffer.speech_started') await this.onSpeechStarted(ev)
    else if (t === 'input_audio_buffer.speech_stopped') await this.onSpeechStopped(ev)
    else if (t === 'input_audio_buffer.committed') {
      const u = this.utt(ev.item_id)
      if (u) {
        u.committed = true
        await this.maybeFinal()
      }
    } else if (t === 'conversation.item.done' || t === 'conversation.item.added') {
      const iid = ev.item?.id
      const u = this.utt(iid)
      if (u && t === 'conversation.item.done') {
        u.itemDone = true
        await this.maybeFinal()
      } else await this.onTempItemReady(iid, t)
    } else if (t === 'response.created') {
      const resp = ev.response ?? {}
      const key = resp.metadata?.request_key
      const p = key ? this.pending.get(key) : undefined
      if (p && resp.id) {
        p.responseId = resp.id
        this.respToKey.set(resp.id, key)
        if (p.stale) await this.cancelResponse(p)
      }
    } else if (t === 'response.done') await this.onResponseDone(ev.response ?? {})
    else if (t === 'error') await this.onRtError(ev.error ?? {})
  }

  private utt(itemId: string | undefined): Utterance | undefined {
    return this.utterances.find((u) => u.itemId === itemId)
  }

  private async onSpeechStarted(ev: RtEvent) {
    if (!this.micEnabled) {
      this.metrics.event('speech_started_ignored', { phase: this.phase })
      return
    }
    const startMs = Number(ev.audio_start_ms ?? 0)
    const now = this.clock()
    const itemId: string = ev.item_id ?? `unknown_${this.utterances.length}`
    if (this.phase === 'PLAYING') {
      const pb = this.playback
      if (!pb || !pb.interruptible || this.bargeCandidate) {
        this.metrics.event('speech_started_ignored', { phase: this.phase })
        return
      }
      // barge-in candidate: wait for the confirm window before stopping playback (echo / noise guard)
      this.bargeCandidate = { itemId, audioStartMs: startMs, t: now }
      this.metrics.event('barge_in_candidate', { item_id: itemId, playback_id: pb.playbackId })
      if (this.rs.barge_in_confirm_ms <= 0) await this.confirmBargeIn()
      else this.setTimer('barge_confirm', this.rs.barge_in_confirm_ms)
      return
    }
    if (this.phase !== 'LISTENING' && this.phase !== 'DECIDING') {
      this.metrics.event('speech_started_ignored', { phase: this.phase })
      return
    }
    await this.beginUtterance(itemId, startMs, now)
  }

  private async confirmBargeIn() {
    const c = this.bargeCandidate
    const pb = this.playback
    if (!c || !pb || this.phase !== 'PLAYING') return
    this.bargeCandidate = null
    this.cancelTimer('playback_start')
    this.cancelTimer('playback_end')
    this.metrics.inc('barge_in')
    const rec: Record<string, unknown> = { playback_id: pb.playbackId, utterance_key: pb.utteranceKey, node_id: this.nodeId, position_ms: null, remaining_ms: null, turn_id: this.turnId + 1, reason: 'barge_in' }
    this.interrupted.push(rec)
    this.metrics.event('playback_interrupted', rec)
    await this.latency('barge_in_speech_start_to_playback_stop_ms', this.clock() - c.t)
    this.interruptedPlayback = pb
    this.playback = null
    await this.sendBrowser({ type: 'playback_stop', playback_id: pb.playbackId, reason: 'barge_in' })
    // the interrupted prompt's node is the one being answered; the buffer already holds the speech
    await this.startListening(false)
    await this.beginUtterance(c.itemId, c.audioStartMs, c.t)
  }

  private async rejectBargeIn(itemId: string) {
    this.bargeCandidate = null
    this.cancelTimer('barge_confirm')
    this.metrics.inc('barge_in_rejected')
    this.metrics.event('barge_in_rejected', { item_id: itemId })
    this.itemsToDelete.push(itemId) // the short item is created by VAD; drop it once it exists
  }

  private async beginUtterance(itemId: string, startMs: number, now: number) {
    this.cancelTimer('no_input')
    this.lastSpeechStartedT = now
    if (this.finalIssuedGeneration !== null || this.decision !== null) {
      // user resumed speaking before the decided audio started → old decision is stale
      await this.invalidateFinal('re_utterance')
    }
    let start = this.vadBaseSample + startMs * SAMPLES_PER_MS
    start = Math.max(start, this.listenStartSample) // never include previous turns / assistant time
    const u: Utterance = { itemId, startSample: start, tStarted: now, stopped: false, tStopped: null, committed: false, itemDone: false, previewsSent: 0, lastPreviewT: 0 }
    this.utterances.push(u)
    this.active = u
    this.phase = 'LISTENING'
    this.metrics.event('speech_started', { turn_id: this.turnId, item_id: u.itemId, audio_start_ms: startMs, utterance_index: this.utterances.length })
    const node = findNode(this.scenario, this.nodeId)!
    await this.sendBrowser({ type: 'speech_started', turn_id: this.turnId })
    await this.sendBrowser({ type: 'prefetch', audio_ids: this.candidateAudioIds(node, this.lastPreviewBranch) })
    await this.emitState()
  }

  private async onSpeechStopped(ev: RtEvent) {
    if (this.bargeCandidate && ev.item_id === this.bargeCandidate.itemId) {
      await this.rejectBargeIn(ev.item_id)
      return
    }
    const u = this.utt(ev.item_id) ?? this.active
    if (!u || u.stopped) return
    u.stopped = true
    u.tStopped = this.clock()
    if (this.active === u) this.active = null
    this.phase = 'DECIDING'
    this.metrics.event('speech_stopped', { turn_id: this.turnId, item_id: u.itemId, audio_end_ms: ev.audio_end_ms })
    await this.sendBrowser({ type: 'speech_stopped', turn_id: this.turnId })
    this.setTimer('item_wait', this.rs.item_wait_timeout_ms)
    await this.emitState()
    await this.maybeFinal()
  }

  // ------------------------------------------------------------------ preview
  private live(phase: 'preview' | 'final'): Pending[] {
    return [...this.pending.values()].filter((p) => p.phase === phase && !p.done && !p.stale)
  }

  private async maybePreview(u: Utterance) {
    const rs = this.rs
    if (!rs.preview_enabled || u.previewsSent >= rs.preview_max_per_utterance) return
    if (this.live('preview').length || this.live('final').length || this.decision !== null) return
    const now = this.clock()
    if (u.previewsSent && now - u.lastPreviewT < rs.preview_interval_ms) return
    if (this.ring.total - u.startSample < rs.preview_min_audio_ms * SAMPLES_PER_MS) return
    if (this.requestsSent >= rs.max_classification_requests) throw new EngineFatal('too_many_requests', '分類リクエスト数の上限に達しました。安全のため停止しました。')
    const prefix = this.ring.slice(u.startSample, this.ring.total)
    if (!prefix) {
      u.previewsSent = rs.preview_max_per_utterance
      this.metrics.event('preview_skipped', { reason: 'prefix_unavailable' })
      return
    }
    u.previewsSent++
    u.lastPreviewT = now
    const refs = this.utterances.filter((x) => x !== u && utteranceReady(x)).map((x) => x.itemId)
    const node = findNode(this.scenario, this.nodeId)!
    const audioMsg = { type: 'message', role: 'user', content: [{ type: 'input_audio', audio: Buffer.from(prefix).toString('base64') }] }
    const p = this.newPending('preview', node, refs)
    if (this.previewMode === 'item') {
      p.tempItemId = 'pv_' + hex(6)
      p.awaitingItem = true
      await this.sendRt({ type: 'conversation.item.create', event_id: 'evt_i_' + p.key, item: { id: p.tempItemId, ...audioMsg } })
    } else {
      await this.sendRequest(p, [...refsOf(refs), audioMsg])
    }
    this.metrics.inc('preview_requests')
    this.metrics.event('preview_request', { turn_id: this.turnId, generation: this.generation, prefix_ms: Math.floor(prefix.length / BYTES_PER_SAMPLE / SAMPLES_PER_MS), index: u.previewsSent, mode: this.previewMode })
    this.setTimer('preview_timeout', rs.preview_timeout_ms)
  }

  private async onTempItemReady(iid: string | undefined, t: string) {
    if (t !== 'conversation.item.done' || !iid) return
    const p = [...this.pending.values()].find((x) => x.tempItemId === iid && x.awaitingItem)
    if (!p) return
    p.awaitingItem = false
    if (p.stale) {
      p.done = true
      this.itemsToDelete.push(iid)
      await this.gcItems()
      return
    }
    await this.sendRequest(p, [...refsOf(p.references), { type: 'item_reference', id: iid }])
  }

  private newPending(phase: 'preview' | 'final', node: Node, refs: string[]): Pending {
    const p: Pending = { key: hex(8), phase, turnId: this.turnId, generation: this.generation, nodeId: node.id, sentAt: this.clock(), allowed: router.allowedBranchIds(node), references: [...refs], tempItemId: null, responseId: null, awaitingItem: false, stale: false, done: false }
    this.pending.set(p.key, p)
    return p
  }

  private async sendRequest(p: Pending, inputItems: Record<string, unknown>[]) {
    const node = findNode(this.scenario, p.nodeId)!
    const metadata = { session_id: this.sessionId, scenario_version: String(this.scenario.version), node_id: p.nodeId, turn_id: String(p.turnId), decision_generation: String(p.generation), phase: p.phase, request_key: p.key }
    const ev = router.responseEvent({ scenario: this.scenario, node, inputItems, metadata, lastPromptText: this.lastPromptText, history: this.history, phase: p.phase, eventId: 'evt_r_' + p.key })
    p.sentAt = this.clock()
    if (p.tempItemId) p.references = [...p.references, p.tempItemId]
    this.requestsSent++
    await this.sendRt(ev)
  }

  // ------------------------------------------------------------------ final
  private async maybeFinal() {
    if (this.phase !== 'DECIDING' || this.active !== null || !this.utterances.length) return
    if (!this.utterances.every(utteranceReady)) return
    if (this.finalIssuedGeneration === this.generation && this.live('final').length) return
    if (this.decision !== null) return
    this.cancelTimer('item_wait')
    for (const p of this.live('preview')) {
      p.stale = true
      this.metrics.inc('preview_invalidated')
      await this.cancelResponse(p)
    }
    this.cancelTimer('preview_timeout')
    if (this.requestsSent >= this.rs.max_classification_requests) throw new EngineFatal('too_many_requests', '分類リクエスト数の上限に達しました。安全のため停止しました。')
    this.generation++
    const node = findNode(this.scenario, this.nodeId)!
    const refs = this.utterances.map((u) => u.itemId)
    const p = this.newPending('final', node, refs)
    await this.sendRequest(p, refsOf(refs))
    this.finalIssuedGeneration = this.generation
    this.metrics.inc('final_requests')
    this.metrics.event('final_request', { turn_id: this.turnId, generation: this.generation, items: refs.length })
    this.setTimer('final_timeout', this.rs.final_timeout_ms)
    await this.emitState()
  }

  private async invalidateFinal(why: string) {
    for (const p of this.live('final')) {
      p.stale = true
      await this.cancelResponse(p)
    }
    this.cancelTimer('final_timeout')
    this.cancelTimer('grace')
    this.decision = null
    this.finalIssuedGeneration = null
    this.generation++
    this.metrics.inc('final_invalidated')
    this.metrics.event('final_invalidated', { reason: why, turn_id: this.turnId, generation: this.generation })
    await this.sendBrowser({ type: 'final_invalidated', reason: why, turn_id: this.turnId })
  }

  private async cancelResponse(p: Pending) {
    if (p.responseId && !p.done) {
      try { await this.sendRt({ type: 'response.cancel', response_id: p.responseId }) } catch (e) { if (!(e instanceof TransportClosed)) throw e }
    }
  }

  private async onResponseDone(resp: RtEvent) {
    const md = resp.metadata ?? {}
    const key = md.request_key ?? this.respToKey.get(resp.id ?? '')
    const p = key ? this.pending.get(key) : undefined
    if (!p || p.done) {
      this.metrics.inc('stale_ignored')
      this.metrics.event('response_ignored', { reason: 'unknown_or_duplicate', response_id: String(resp.id ?? '').slice(0, 40) })
      return
    }
    p.done = true
    this.metrics.addUsage(resp.usage)
    if (p.tempItemId) this.itemsToDelete.push(p.tempItemId)
    await this.gcItems()
    const expected: Record<string, string> = { session_id: this.sessionId, scenario_version: String(this.scenario.version), node_id: p.nodeId, turn_id: String(p.turnId), decision_generation: String(p.generation), phase: p.phase }
    const current = p.turnId === this.turnId && p.nodeId === this.nodeId && p.generation === this.generation && (this.phase === 'LISTENING' || this.phase === 'DECIDING')
    if (Object.keys(md).length && Object.entries(expected).some(([k, v]) => md[k] !== v)) {
      this.metrics.inc('stale_ignored')
      this.metrics.event('response_ignored', { reason: 'metadata_mismatch', phase: p.phase })
      if (p.phase === 'final' && !p.stale && current) {
        this.cancelTimer('final_timeout')
        await this.onFinal(p, CTRL_UNCLEAR, '', 'metadata_mismatch', 'invalid_output')
      }
      return
    }
    if (p.stale || !current) {
      this.metrics.inc('stale_ignored')
      if (p.phase === 'preview') this.metrics.inc('preview_invalidated')
      this.metrics.event('response_ignored', { reason: 'stale', phase: p.phase, turn_id: p.turnId, generation: p.generation, current_generation: this.generation })
      return
    }
    const parsed = router.parseResponse(resp, p.allowed)
    if (p.phase === 'preview') {
      this.cancelTimer('preview_timeout')
      if (this.decision !== null || this.finalIssuedGeneration !== null) {
        this.metrics.inc('preview_invalidated')
        return
      }
      if (!parsed.ok) {
        this.metrics.event('preview_invalid', { error: parsed.error })
        return
      }
      await this.onPreview(parsed)
    } else {
      this.cancelTimer('final_timeout')
      if (parsed.ok) await this.onFinal(p, parsed.branchId!, parsed.reason, null, 'realtime')
      else await this.onFinal(p, CTRL_UNCLEAR, '', parsed.error, 'invalid_output')
    }
  }

  private async onPreview(parsed: router.ParsedBranch) {
    this.metrics.inc('preview_results')
    if (this.lastPreviewBranch && this.lastPreviewBranch !== parsed.branchId) this.metrics.inc('preview_changes')
    this.lastPreviewBranch = parsed.branchId!
    const first = this.utterances[0]
    if (!this.firstPreviewLogged && first) {
      this.firstPreviewLogged = true
      await this.latency('speech_start_event_to_first_preview_ms', this.clock() - first.tStarted, { turn_id: this.turnId })
    }
    const node = findNode(this.scenario, this.nodeId)!
    const info = this.branchInfo(node, parsed.branchId!)
    this.metrics.event('preview', { turn_id: this.turnId, branch_id: parsed.branchId })
    await this.sendBrowser({ type: 'preview', turn_id: this.turnId, branch_id: parsed.branchId, label: info.label, next_text: info.nextText, reason: parsed.reason, provisional: true })
    await this.sendBrowser({ type: 'prefetch', audio_ids: this.candidateAudioIds(node, parsed.branchId!) })
  }

  private branchInfo(node: Node, branchId: string): { label: string; nextText: string } {
    if (branchId === CTRL_UNCLEAR) {
      const c = findControl(this.scenario, node.fallback_node_id ?? '')
      return { label: '聞き返し（不明・想定外）', nextText: c?.assistant_text ?? '' }
    }
    if (branchId === CTRL_END_REQUEST) {
      const c = findControl(this.scenario, this.scenario.policy.end_request_node_id)
      return { label: '終了希望', nextText: c?.assistant_text ?? '' }
    }
    const e = node.edges.find((x) => x.id === branchId)
    const tgt = e ? findNode(this.scenario, e.target_node_id) : undefined
    return { label: e?.label ?? branchId, nextText: tgt?.assistant_text ?? '' }
  }

  private async onFinal(p: Pending | null, branchId: string, reason: string, fallbackReason: string | null, source: string) {
    const now = this.clock()
    const lastStop = Math.max(-Infinity, ...this.utterances.filter((u) => u.tStopped !== null).map((u) => u.tStopped!))
    if (p && source === 'realtime') await this.latency('request_to_branch_ms', now - p.sentAt, { turn_id: this.turnId })
    if (Number.isFinite(lastStop) && source === 'realtime') await this.latency('vad_event_to_branch_ms', now - lastStop, { turn_id: this.turnId })
    this.decision = { branchId, generation: this.generation, reason, fallbackReason, source }
    const node = findNode(this.scenario, this.nodeId)!
    const info = this.branchInfo(node, branchId)
    await this.sendBrowser({ type: 'final', turn_id: this.turnId, branch_id: branchId, label: info.label, next_text: info.nextText, reason, fallback_reason: fallbackReason, grace_ms: this.rs.final_grace_ms })
    // short re-utterance grace before committing (counted in latency, not hidden)
    this.setTimer('grace', this.rs.final_grace_ms)
  }

  private async commitDecision() {
    const d = this.decision
    if (!d || d.generation !== this.generation || this.active !== null) return
    this.decision = null
    this.finalIssuedGeneration = null
    const node = findNode(this.scenario, this.nodeId)!
    const step = router.transition(this.scenario, this.nodeId, d.branchId, this.counters)
    if (d.branchId === CTRL_UNCLEAR) this.metrics.inc('fallbacks')
    const label = this.branchInfo(node, d.branchId).label
    this.history.push([node.label, label])
    this.metrics.event('turn', { turn_id: this.turnId, node_id: node.id, branch_id: d.branchId, source: d.source, fallback_reason: d.fallbackReason, step_reason: step.reason, next_key: step.playKey, preview_last: this.lastPreviewBranch, preview_matched: this.lastPreviewBranch === d.branchId, utterances: this.utterances.length, generation: d.generation })
    this.itemsToDelete.push(...this.utterances.map((u) => u.itemId))
    this.utterances = []
    await this.gcItems()
    await this.play(step.playKey, step.playText, step.after, step.nextNodeId, step.reason)
  }

  /** Delete input items only once no live request references them. */
  private async gcItems() {
    if (!this.itemsToDelete.length) return
    const liveRefs = new Set<string>()
    for (const p of this.pending.values()) {
      if (!p.done) {
        p.references.forEach((r) => liveRefs.add(r))
        if (p.tempItemId) liveRefs.add(p.tempItemId)
      }
    }
    const current = new Set(this.utterances.map((u) => u.itemId))
    if (this.bargeCandidate) current.add(this.bargeCandidate.itemId)
    const keep: string[] = []
    for (const iid of this.itemsToDelete) {
      if (liveRefs.has(iid) || current.has(iid)) {
        keep.push(iid)
        continue
      }
      try { await this.sendRt({ type: 'conversation.item.delete', item_id: iid }) } catch (e) { if (!(e instanceof TransportClosed)) throw e }
    }
    this.itemsToDelete = keep
    for (const [k, p] of [...this.pending]) {
      if (p.done) {
        this.pending.delete(k)
        if (p.responseId) this.respToKey.delete(p.responseId)
      }
    }
  }

  private async onRtError(err: RtEvent) {
    const eid: string = err.event_id ?? ''
    this.metrics.event('realtime_error', { code: String(err.code ?? '').slice(0, 80), err_type: String(err.type ?? '').slice(0, 80), event_id: eid.slice(0, 60), message: String(err.message ?? '').slice(0, 200) })
    const key = eid.startsWith('evt_r_') || eid.startsWith('evt_i_') ? eid.slice(6) : null
    const p = key ? this.pending.get(key) : undefined
    if (p && !p.done) {
      p.done = true
      await this.gcItems()
      if (p.phase === 'final' && !p.stale && p.generation === this.generation && p.turnId === this.turnId) {
        this.cancelTimer('final_timeout')
        await this.onFinal(p, CTRL_UNCLEAR, '', 'realtime_error', 'error')
      }
      return
    }
    if (this.phase === 'CONNECTING') throw new EngineFatal('realtime_session_error', 'Realtime セッション設定でエラーが発生しました（モデル名・設定を確認してください）。')
  }

  // ------------------------------------------------------------------ timers
  private async onTimer(name: string) {
    if (name === 'session_ready') throw new EngineFatal('realtime_timeout', 'Realtime セッションの準備がタイムアウトしました。')
    if (name === 'playback_start') throw new EngineFatal('playback_ack_timeout', 'ブラウザから再生開始の確認がありません。自動では次へ進まず停止しました。')
    if (name === 'playback_end') throw new EngineFatal('playback_ack_timeout', 'ブラウザから再生終了の確認がありません。自動では次へ進まず停止しました。')
    if (name === 'barge_confirm') await this.confirmBargeIn()
    else if (name === 'no_input') {
      if (this.phase === 'LISTENING' && !this.utterances.length) {
        this.metrics.event('no_input', { turn_id: this.turnId, node_id: this.nodeId })
        const step = router.transitionNoInput(this.scenario, this.nodeId, this.counters)
        await this.play(step.playKey, step.playText, step.after, step.nextNodeId, step.reason)
      }
    } else if (name === 'preview_timeout') {
      for (const p of this.live('preview')) {
        p.stale = true
        this.metrics.inc('preview_invalidated')
        await this.cancelResponse(p)
      }
    } else if (name === 'item_wait') {
      if (this.phase === 'DECIDING' && this.active === null && this.decision === null && !this.utterances.every(utteranceReady)) {
        await this.onFinal(null, CTRL_UNCLEAR, '', 'input_item_timeout', 'timeout')
      }
    } else if (name === 'final_timeout') {
      const live = this.live('final')
      for (const p of live) {
        p.stale = true
        await this.cancelResponse(p)
      }
      if (this.phase === 'DECIDING' && this.decision === null && this.active === null) await this.onFinal(live[0] ?? null, CTRL_UNCLEAR, '', 'final_timeout', 'timeout')
    } else if (name === 'grace') await this.commitDecision()
  }

  // ------------------------------------------------------------------ state / end
  private async emitState() {
    const node = findNode(this.scenario, this.nodeId)
    await this.sendBrowser({
      type: 'state', phase: this.phase, mic_enabled: this.micEnabled, speaking: this.active !== null, node_id: this.nodeId,
      node_label: node?.label ?? '', node_text: node?.assistant_text ?? '', turn_id: this.turnId, decision_generation: this.generation,
      scenario_id: this.scenario.scenario_id, scenario_version: this.scenario.version, playing_key: this.playback?.utteranceKey ?? null,
      interruptible: this.playback?.interruptible ?? false, barge_in_enabled: this.rs.barge_in_enabled,
      counters: this.metrics.counters, mock_realtime: this.transport.isMock,
    })
  }

  async finish(phase: Phase, reason: string, message: string) {
    if (this.done) return
    this.done = true
    this.phase = phase
    this.micEnabled = false
    this.endReason = reason
    this.endDetail = message
    for (const p of this.pending.values()) {
      if (!p.done) {
        p.stale = true
        await this.cancelResponse(p)
      }
    }
    this.metrics.event('session_end', { phase, reason, node_id: this.nodeId })
    await this.emitState()
    await this.sendBrowser({ type: 'finished', phase, reason, message, counters: this.metrics.counters, realtime_usage: this.metrics.realtimeUsage })
    this.queue.push(['browser', { type: '_wake' }]) // unblock the loop so run() can return
  }

  /** Resolves when run() has fully shut down. */
  untilDone = () => this.finishedP
}

const refsOf = (ids: string[]) => ids.map((id) => ({ type: 'item_reference', id }))
