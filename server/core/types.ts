/**
 * Core boundary: everything on the latency-critical path (audio ingest, PCM
 * ring buffer, Realtime transport, preview/final/barge-in decisions, playback
 * commands) lives behind these interfaces so it can be re-implemented natively
 * (Rust/C++ process or addon) without touching the Nitro host, the stores or
 * the Vue UI. The wire contract is documented in docs/CORE_PROTOCOL.md.
 */

export type Phase = 'CONNECTING' | 'PLAYING' | 'LISTENING' | 'DECIDING' | 'PLAYBACK_ERROR' | 'FINISHED' | 'STOPPED' | 'ERROR'

/** Messages the core sends to the browser (JSON). */
export type CoreToBrowser = Record<string, unknown> & { type: string }
/** Messages the browser sends to the core (JSON). Binary PCM frames are passed separately. */
export type BrowserToCore = Record<string, unknown> & { type: string }

/** What the host (Nitro WebSocket route) needs from any engine implementation. */
export interface Engine {
  /** Current conversation phase (read after `run()` settles for the session record). */
  readonly phase: Phase
  readonly endReason: string
  readonly done: boolean
  pushBrowserJson(msg: BrowserToCore): void
  /** Raw PCM16 mono 24 kHz, without the wire tag byte. */
  pushBrowserAudio(pcm: Uint8Array): void
  /** Runs until the session ends; resolves with the end reason. */
  run(): Promise<string>
}

/** Monotonic clock in milliseconds. */
export type Clock = () => number

/** Timer facility the engine schedules through (a native core would own its own loop). */
export interface Scheduler {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** Host services injected into the in-process engine; all are trivially replaceable. */
export interface EngineHost extends Scheduler {
  clock: Clock
  /** Random hex id of `bytes` bytes (2*bytes hex chars). */
  newId(bytes: number): string
  /** Base64 for PCM payloads sent to Realtime. */
  base64(data: Uint8Array): string
  /** Byte length of a base64 payload (mock transport only). */
  base64Length(b64: string): number
  log(level: 'error' | 'warn' | 'info', msg: string, detail?: unknown): void
}

/** The only thing the engine needs from the audio store: "is this pre-generated audio playable right now". */
export interface AudioReadiness {
  isReady(audioId: string): boolean
}

/** Metrics sink: counters + JSONL events + provider usage. */
export interface MetricsSink {
  counters: Record<string, number>
  realtimeUsage: { responses: number; input_tokens: number; output_tokens: number; total_tokens: number }
  inc(name: string, n?: number): void
  event(kind: string, fields?: Record<string, unknown>): unknown
  addUsage(usage: Record<string, unknown> | null | undefined): void
  close(summary?: Record<string, unknown>): void
}

export type BrowserSend = (msg: CoreToBrowser) => Promise<void> | void

/** Default Node host. */
export function nodeHost(): EngineHost {
  return {
    clock: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    newId: (n) => {
      const b = new Uint8Array(n)
      globalThis.crypto.getRandomValues(b)
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    },
    base64: (d) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('base64'),
    base64Length: (s) => Buffer.from(s, 'base64').length,
    log: (level, msg, detail) => (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(msg, detail ?? ''),
  }
}
