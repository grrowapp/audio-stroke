/**
 * Realtime transports. `RealtimeTransport` is the seam between the engine and
 * the OpenAI Realtime WebSocket; a native core would implement the same
 * event-in / event-out contract.
 */
import { randomBytes } from 'node:crypto'
import * as router from '../lib/router'
import { CTRL_UNCLEAR } from '../lib/scenarioSchema'
import { BYTES_PER_SAMPLE, SAMPLES_PER_MS } from './pcmRing'

const hex = (n: number) => randomBytes(n).toString('hex')

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

