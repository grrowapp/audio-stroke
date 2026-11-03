/**
 * RealtimeBackend: DecisionBackend over the OpenAI Realtime WebSocket (or a mock / scripted transport).
 * Translates the Realtime event protocol (session.update, input_audio_buffer.*, conversation.item.*,
 * response.create / cancel / done, metadata echo) into the engine-facing contract in ./decision.ts.
 * Wire shape is unchanged from the pre-boundary engine, so the scripted-transport tests still apply.
 */
import * as router from '../lib/router'
import { findNode } from '../lib/scenarioSchema'
import { BackendClosed, EventQueue, type BackendStart, type ClassifyRequest, type DecisionBackend, type DecisionEvent } from './decision'
import { SAMPLE_RATE } from './pcmRing'
import { TransportClosed, type RealtimeTransport, type RtEvent } from './transports'
import type { EngineHost } from './types'

interface Req {
  key: string
  phase: 'preview' | 'final'
  metadata: Record<string, string>
  /** item ids the response references (utterances + temp preview item) */
  references: string[]
  tempItemId: string | null
  awaitingItem: boolean
  responseId: string | null
  cancelled: boolean
  done: boolean
  /** request to send once the temp item is acknowledged */
  pendingInput: Record<string, unknown>[] | null
  req: ClassifyRequest
}

const refsOf = (ids: string[]) => ids.map((id) => ({ type: 'item_reference', id }))

export class RealtimeBackend implements DecisionBackend {
  readonly name = 'realtime'
  readonly isMock: boolean
  private q = new EventQueue()
  private reqs = new Map<string, Req>()
  private respToKey = new Map<string, string>()
  private itemsToDelete: string[] = []
  private reader: Promise<void> | null = null
  private closed = false

  constructor(public transport: RealtimeTransport, private host: EngineHost, private previewMode: 'inline' | 'item' = 'inline') {
    this.isMock = transport.isMock
  }

  async start(o: BackendStart) {
    try {
      await this.transport.connect()
    } catch (e: any) {
      throw new Error(`Realtime API に接続できません: ${e?.constructor?.name ?? e}`)
    }
    this.reader = this.read()
    const rs = o.runtime
    await this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['text'],
        instructions: router.SESSION_INSTRUCTIONS,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            turn_detection: {
              type: 'server_vad', threshold: rs.vad_threshold, prefix_padding_ms: rs.prefix_padding_ms,
              silence_duration_ms: rs.silence_duration_ms, create_response: false, interrupt_response: false,
            },
          },
        },
        tools: [],
        tool_choice: 'none',
      },
    })
  }

  private async read() {
    try {
      for (;;) {
        const ev = await this.transport.recv()
        await this.onRt(ev)
      }
    } catch (e: any) {
      this.q.fail(new BackendClosed(String(e?.message ?? e)))
    }
  }

  private async send(ev: RtEvent) {
    try {
      await this.transport.send(ev)
    } catch (e) {
      if (e instanceof TransportClosed) throw new BackendClosed(e.message)
      throw e
    }
  }

  recv(): Promise<DecisionEvent> { return this.q.recv() }
  bufferedBytes() { return this.transport.bufferedBytes() }
  async control(msg: Record<string, unknown>) { if (this.transport.control) await this.transport.control(msg) }

  async pushAudio(pcm: Uint8Array) {
    await this.send({ type: 'input_audio_buffer.append', audio: this.host.base64(pcm) })
  }

  async clearInput() {
    await this.send({ type: 'input_audio_buffer.clear' })
  }

  async classify(r: ClassifyRequest) {
    const q: Req = { key: r.key, phase: r.phase, metadata: r.metadata, references: [...r.utteranceIds], tempItemId: null, awaitingItem: false, responseId: null, cancelled: false, done: false, pendingInput: null, req: r }
    this.reqs.set(r.key, q)
    if (r.phase === 'preview' && r.prefixPcm) {
      const audioMsg = { type: 'message', role: 'user', content: [{ type: 'input_audio', audio: this.host.base64(r.prefixPcm) }] }
      if (this.previewMode === 'item') {
        q.tempItemId = 'pv_' + this.host.newId(6)
        q.awaitingItem = true
        q.pendingInput = [...refsOf(r.utteranceIds), { type: 'item_reference', id: q.tempItemId }]
        await this.send({ type: 'conversation.item.create', event_id: 'evt_i_' + q.key, item: { id: q.tempItemId, ...audioMsg } })
        return
      }
      await this.sendRequest(q, [...refsOf(r.utteranceIds), audioMsg])
      return
    }
    await this.sendRequest(q, refsOf(r.utteranceIds))
  }

  private async sendRequest(q: Req, inputItems: Record<string, unknown>[]) {
    const r = q.req
    const node = findNode(r.scenario, r.node.id) ?? r.node
    const ev = router.responseEvent({ scenario: r.scenario, node, inputItems, metadata: q.metadata, lastPromptText: r.lastPromptText, history: r.history, phase: q.phase, eventId: 'evt_r_' + q.key })
    if (q.tempItemId) q.references = [...q.references, q.tempItemId]
    await this.send(ev)
  }

  async cancel(key: string) {
    const q = this.reqs.get(key)
    if (!q || q.done) return
    q.cancelled = true
    if (q.responseId) await this.cancelOnWire(q)
    // a cancelled preview whose temp item is still pending will be dropped in onTempItemReady
  }

  private async cancelOnWire(q: Req) {
    try { await this.send({ type: 'response.cancel', response_id: q.responseId }) } catch (e) { if (!(e instanceof BackendClosed)) throw e }
  }

  async release(utteranceIds: string[]) {
    this.itemsToDelete.push(...utteranceIds)
    await this.gc()
  }

  /** Delete input items only once no live request references them. */
  private async gc() {
    if (!this.itemsToDelete.length) return
    const live = new Set<string>()
    for (const q of this.reqs.values()) if (!q.done) { q.references.forEach((x) => live.add(x)); if (q.tempItemId) live.add(q.tempItemId) }
    const keep: string[] = []
    for (const iid of this.itemsToDelete) {
      if (live.has(iid)) { keep.push(iid); continue }
      try { await this.send({ type: 'conversation.item.delete', item_id: iid }) } catch (e) { if (!(e instanceof BackendClosed)) throw e }
    }
    this.itemsToDelete = keep
    for (const [k, q] of [...this.reqs]) if (q.done) { this.reqs.delete(k); if (q.responseId) this.respToKey.delete(q.responseId) }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const q of this.reqs.values()) if (!q.done && q.responseId) { try { await this.cancelOnWire(q) } catch { /* closing */ } }
    try { await this.transport.close() } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ Realtime → contract
  private async onRt(ev: RtEvent) {
    const t = ev.type ?? ''
    if (t === 'session.updated') this.q.push({ type: 'ready' })
    else if (t === 'input_audio_buffer.speech_started') this.q.push({ type: 'speech_started', utterance_id: ev.item_id ?? `unknown_${this.host.newId(3)}`, audio_start_ms: Number(ev.audio_start_ms ?? 0) })
    else if (t === 'input_audio_buffer.speech_stopped') this.q.push({ type: 'speech_stopped', utterance_id: ev.item_id, audio_end_ms: ev.audio_end_ms ?? null })
    else if (t === 'input_audio_buffer.committed') this.committed.add(ev.item_id)
    else if (t === 'conversation.item.done' || t === 'conversation.item.added') {
      const iid = ev.item?.id
      const q = [...this.reqs.values()].find((x) => x.tempItemId === iid && x.awaitingItem)
      if (q) { if (t === 'conversation.item.done') await this.onTempItemReady(q) }
      else if (t === 'conversation.item.done' && iid) {
        this.itemDone.add(iid)
        if (this.committed.has(iid)) this.q.push({ type: 'utterance_ready', utterance_id: iid })
      }
    } else if (t === 'response.created') {
      const resp = ev.response ?? {}
      const key = resp.metadata?.request_key
      const q = key ? this.reqs.get(key) : undefined
      if (q && resp.id) {
        q.responseId = resp.id
        this.respToKey.set(resp.id, key)
        if (q.cancelled) await this.cancelOnWire(q)
      }
    } else if (t === 'response.done') await this.onResponseDone(ev.response ?? {})
    else if (t === 'error') await this.onError(ev.error ?? {})
  }
  private committed = new Set<string>()
  private itemDone = new Set<string>()

  private async onTempItemReady(q: Req) {
    q.awaitingItem = false
    if (q.cancelled) {
      q.done = true
      if (q.tempItemId) this.itemsToDelete.push(q.tempItemId)
      await this.gc()
      return
    }
    await this.sendRequest(q, q.pendingInput ?? [])
    q.pendingInput = null
  }

  private async onResponseDone(resp: RtEvent) {
    const md = resp.metadata ?? {}
    const key = md.request_key ?? this.respToKey.get(resp.id ?? '')
    const q = key ? this.reqs.get(key) : undefined
    if (!q || q.done) {
      this.q.push({ type: 'decision', key: String(key ?? resp.id ?? ''), ok: false, reason: '', metadata_ok: true, error: 'unknown_or_duplicate', usage: resp.usage ?? null })
      return
    }
    q.done = true
    if (q.tempItemId) this.itemsToDelete.push(q.tempItemId)
    await this.gc()
    const metadataOk = !Object.keys(md).length || Object.entries(q.metadata).every(([k, v]) => k === 'request_key' || md[k] === v)
    const parsed = router.parseResponse(resp, q.req.allowed)
    this.q.push({ type: 'decision', key: q.key, ok: parsed.ok && metadataOk, branch_id: parsed.branchId, reason: parsed.reason, confidence: null, metadata_ok: metadataOk, error: parsed.ok ? undefined : parsed.error, usage: resp.usage ?? null })
  }

  private async onError(err: RtEvent) {
    const eid: string = err.event_id ?? ''
    const key = eid.startsWith('evt_r_') || eid.startsWith('evt_i_') ? eid.slice(6) : undefined
    const q = key ? this.reqs.get(key) : undefined
    if (q && !q.done) {
      q.done = true
      await this.gc()
    }
    this.q.push({ type: 'error', key: q ? key : undefined, code: String(err.code ?? '').slice(0, 80), message: String(err.message ?? '').slice(0, 200) })
  }
}
