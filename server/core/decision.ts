/**
 * DecisionBackend: the seam between the conversation engine and whatever
 * "listens and decides" during a call. The engine owns every state change
 * (turns, playback, limits, stale rejection); a backend only
 *   - takes the caller's PCM and reports speech boundaries (VAD),
 *   - answers classification requests with one branch id from the allowed set.
 *
 * Implementations:
 *   RealtimeBackend  (./realtimeBackend.ts)  OpenAI Realtime: VAD + audio classification in one WebSocket
 *   SttJudgeBackend  (./sttJudgeBackend.ts)  streaming STT (Rev.ai / Deepgram / Google / local) + decision model
 *                                            (Clef / Jev / OpenAI-compatible local LLM); VAD from the STT or built in
 *
 * Utterance ids and request keys are opaque strings chosen by the backend / engine respectively.
 * Events are consumed with `recv()` exactly like a transport; `BackendClosed` ends the session.
 */
import type { Node, Scenario } from '../lib/scenarioSchema'
import type { RuntimeSettings } from './runtime'

export class BackendClosed extends Error {}

export type DecisionEvent =
  | { type: 'ready' }
  /** The caller started speaking. `audio_start_ms` is on the backend's audio timeline (ms of audio pushed since start). */
  | { type: 'speech_started'; utterance_id: string; audio_start_ms: number }
  | { type: 'speech_stopped'; utterance_id: string; audio_end_ms: number | null }
  /** The utterance is captured and can be referenced by `classify` (Realtime: committed + item done; STT: transcript available). */
  | { type: 'utterance_ready'; utterance_id: string }
  | {
      type: 'decision'
      key: string
      ok: boolean
      branch_id?: string
      reason: string
      confidence?: number | null
      /** false when the backend could not tie the answer to the request it sent (Realtime metadata echo mismatch). */
      metadata_ok: boolean
      error?: string
      usage?: Record<string, unknown> | null
    }
  /** Backend error. With `key`, it belongs to that request (the engine fails that request only). */
  | { type: 'error'; key?: string; code: string; message: string }

export interface ClassifyRequest {
  key: string
  phase: 'preview' | 'final'
  scenario: Scenario
  node: Node
  allowed: string[]
  lastPromptText: string
  history: [string, string][]
  /** Utterances of this turn that are already `utterance_ready`, in order. */
  utteranceIds: string[]
  /** Preview only: the utterance still being spoken, plus the PCM captured so far for it. */
  activeUtteranceId: string | null
  prefixPcm: Uint8Array | null
  /** Echoed back by backends that support it; the engine uses it for stale rejection. */
  metadata: Record<string, string>
}

export interface BackendStart {
  sessionId: string
  runtime: RuntimeSettings
}

export interface DecisionBackend {
  /** 'realtime' | 'stt_judge' | 'mock' … (recorded in metrics as the decision source). */
  readonly name: string
  readonly isMock: boolean
  /** Connect and configure; emits `ready` when the backend accepts audio. */
  start(o: BackendStart): Promise<void>
  pushAudio(pcm: Uint8Array): Promise<void>
  /** Drop everything captured so far (only called when nothing is referenced). */
  clearInput(): Promise<void>
  classify(req: ClassifyRequest): Promise<void>
  cancel(key: string): Promise<void>
  /** The engine no longer references these utterances; the backend may free them. */
  release(utteranceIds: string[]): Promise<void>
  /** Next event; rejects with BackendClosed when the backend is gone. */
  recv(): Promise<DecisionEvent>
  close(): Promise<void>
  /** Bytes queued towards the provider (overload guard). */
  bufferedBytes(): number
  /** Mock backends: UI / test control (`mock_vad`). */
  control?(msg: Record<string, unknown>): Promise<void>
}

/** Small FIFO used by backends to hand events to the engine. */
export class EventQueue {
  private items: (DecisionEvent | null)[] = []
  private waiters: ((e: DecisionEvent | null) => void)[] = []
  private closedErr: Error | null = null
  push(ev: DecisionEvent) {
    const w = this.waiters.shift()
    if (w) w(ev)
    else this.items.push(ev)
  }
  fail(err: Error) {
    if (this.closedErr) return
    this.closedErr = err
    for (const w of this.waiters.splice(0)) w(null)
  }
  recv(): Promise<DecisionEvent> {
    if (this.items.length) return Promise.resolve(this.items.shift()!)
    if (this.closedErr) return Promise.reject(this.closedErr)
    return new Promise((res, rej) => this.waiters.push((ev) => (ev === null ? rej(this.closedErr ?? new BackendClosed('closed')) : res(ev))))
  }
}
