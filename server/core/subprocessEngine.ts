/**
 * Out-of-process engine adapter: runs the latency-critical core as a separate
 * executable (e.g. a native Rust/C++ build) and speaks the wire protocol in
 * docs/CORE_PROTOCOL.md over its stdin/stdout. The Nitro host stays unchanged.
 *
 * Framing (both directions): 4-byte big-endian length + 1 tag byte + payload.
 *   tag 0x00 = JSON (UTF-8)   tag 0x01 = PCM16 frame (browser → core only)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Manifest } from '../lib/audioStore'
import type { Scenario } from '../lib/scenarioSchema'
import type { RuntimeSettings } from './runtime'
import type { BrowserSend, BrowserToCore, Engine, MetricsSink, Phase } from './types'

export const TAG_JSON = 0x00
export const TAG_PCM = 0x01

export function frame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length + 1)
  out[4] = tag
  out.set(payload, 5)
  return out
}

/** Incremental parser for the length-prefixed framing. */
export class FrameParser {
  private buf = new Uint8Array(0)
  push(chunk: Uint8Array): { tag: number; payload: Uint8Array }[] {
    const joined = new Uint8Array(this.buf.length + chunk.length)
    joined.set(this.buf)
    joined.set(chunk, this.buf.length)
    this.buf = joined
    const out: { tag: number; payload: Uint8Array }[] = []
    for (;;) {
      if (this.buf.length < 5) break
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0)
      if (this.buf.length < 4 + len) break
      out.push({ tag: this.buf[4]!, payload: this.buf.slice(5, 4 + len) })
      this.buf = this.buf.slice(4 + len)
    }
    return out
  }
}

export interface SubprocessEngineOptions {
  command: string
  args?: string[]
  sessionId: string
  scenario: Scenario
  manifest: Manifest
  settings: RuntimeSettings
  sendBrowser: BrowserSend
  metrics: MetricsSink
  /** Realtime connection parameters the core needs (the core owns the socket). */
  realtime: { url: string; model: string; apiKey: string; mock: boolean; previewAudioMode: 'inline' | 'item' }
  /** Resolves audio ids to absolute paths so the core can verify readiness itself. */
  audioPaths: Record<string, string>
  startTimeoutMs?: number
}

export class SubprocessEngine implements Engine {
  phase: Phase = 'CONNECTING'
  endReason = ''
  done = false
  private proc: ChildProcess | null = null
  private parser = new FrameParser()
  private resolveRun!: (reason: string) => void
  private runP = new Promise<string>((r) => (this.resolveRun = r))

  constructor(private o: SubprocessEngineOptions) {}

  pushBrowserJson(msg: BrowserToCore) {
    this.write(TAG_JSON, new TextEncoder().encode(JSON.stringify({ channel: 'browser', msg })))
  }

  pushBrowserAudio(pcm: Uint8Array) {
    this.write(TAG_PCM, pcm)
  }

  private write(tag: number, payload: Uint8Array) {
    if (!this.proc?.stdin || this.done) return
    this.proc.stdin.write(frame(tag, payload))
  }

  async run(): Promise<string> {
    const o = this.o
    this.proc = spawn(o.command, o.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d))
    this.proc.stderr!.on('data', (d: Buffer) => o.metrics.event('core_stderr', { text: d.toString().slice(0, 500) }))
    this.proc.on('exit', (code) => this.finish(this.endReason || `core_exit_${code}`, this.done ? this.phase : 'ERROR'))
    this.proc.on('error', (e) => this.finish(`core_spawn_failed:${e.message}`, 'ERROR'))
    // session bootstrap: everything the core needs to run without calling back into the host
    this.write(TAG_JSON, new TextEncoder().encode(JSON.stringify({
      channel: 'init', session_id: o.sessionId, scenario: o.scenario, manifest: o.manifest, runtime: o.settings,
      realtime: o.realtime, audio_paths: o.audioPaths,
    })))
    const startTimer = setTimeout(() => { if (this.phase === 'CONNECTING' && !this.done) this.kill('core_start_timeout') }, o.startTimeoutMs ?? 15000)
    const reason = await this.runP
    clearTimeout(startTimer)
    return reason
  }

  private onData(d: Buffer) {
    for (const { tag, payload } of this.parser.push(d)) {
      if (tag !== TAG_JSON) continue
      let m: any
      try { m = JSON.parse(new TextDecoder().decode(payload)) } catch { continue }
      if (m.channel === 'browser') {
        const msg = m.msg
        if (msg?.type === 'state') this.phase = msg.phase
        if (msg?.type === 'finished') { this.phase = msg.phase; this.endReason = msg.reason }
        void this.o.sendBrowser(msg)
      } else if (m.channel === 'metrics') {
        if (m.kind === 'inc') this.o.metrics.inc(m.name, m.n ?? 1)
        else if (m.kind === 'event') this.o.metrics.event(m.name, m.fields ?? {})
        else if (m.kind === 'usage') this.o.metrics.addUsage(m.usage)
      } else if (m.channel === 'exit') {
        this.finish(m.reason ?? 'core_exit', m.phase ?? this.phase)
      }
    }
  }

  private kill(reason: string) {
    this.finish(reason, 'ERROR')
    this.proc?.kill()
  }

  private finish(reason: string, phase: Phase) {
    if (this.done) return
    this.done = true
    this.phase = phase
    this.endReason = reason
    try { this.proc?.stdin?.end() } catch { /* ignore */ }
    this.o.metrics.close({ end_reason: reason, final_phase: phase, impl: 'subprocess' })
    this.resolveRun(reason)
  }
}
