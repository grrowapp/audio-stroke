/**
 * SttJudgeBackend: DecisionBackend built from a streaming STT provider + a decision-model provider.
 *   audio ──▶ SttProvider ──partial/final (+ timestamps)──▶ per-utterance transcript
 *   speech boundaries: the provider's own VAD when it has one, else the built-in energy VAD
 *   classify ──▶ transcript of the referenced utterances ──▶ JudgeProvider ──▶ decision
 * The engine keeps all turn / stale / playback logic; this class only maps text to utterances and
 * answers requests. Confidence below `unclearThreshold` becomes ctrl_unclear (the judge models tend
 * to pick an option with low confidence for off-topic speech).
 */
import { CTRL_UNCLEAR } from '../lib/scenarioSchema'
import { BackendClosed, EventQueue, type BackendStart, type ClassifyRequest, type DecisionBackend, type DecisionEvent } from './decision'
import { buildJudgeInput } from './judge/prompt'
import type { JudgeProvider } from './judge/types'
import { SAMPLE_RATE } from './pcmRing'
import type { SttEvent, SttProvider } from './stt/types'
import { AudioClock } from './stt/types'
import { EnergyVad } from './vad'

export interface SttJudgeOptions {
  stt: SttProvider
  judge: JudgeProvider
  language?: string
  /** judge confidence below this → ctrl_unclear (0 disables) */
  unclearThreshold?: number
  /** after speech_stopped, how long to wait for the provider's final transcript before using the last partial */
  finalWaitMs?: number
  /** judge request budget */
  judgeTimeoutMs?: number
  /** built-in VAD (used only when the provider has no VAD) */
  vadRms?: number
  vadMinSpeechMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

interface Utt {
  id: string
  startMs: number
  stopMs: number | null
  finals: string[]
  lastFinalEndMs: number | null
  partial: string | null
  ready: boolean
  readyTimer: unknown | null
}

export class SttJudgeBackend implements DecisionBackend {
  readonly name: string
  readonly isMock: boolean
  private q = new EventQueue()
  private stt: SttProvider
  private judge: JudgeProvider
  private clock = new AudioClock(SAMPLE_RATE)
  private vad: EnergyVad | null = null
  private utts = new Map<string, Utt>()
  private order: string[] = []
  private active: string | null = null
  private seq = 0
  private inflight = new Map<string, AbortController>()
  private closed = false
  private o: Required<Pick<SttJudgeOptions, 'language' | 'unclearThreshold' | 'finalWaitMs' | 'judgeTimeoutMs' | 'vadRms' | 'vadMinSpeechMs' | 'setTimer' | 'clearTimer'>>

  constructor(opts: SttJudgeOptions) {
    this.stt = opts.stt
    this.judge = opts.judge
    this.name = `stt_judge:${opts.stt.name}+${opts.judge.name}`
    this.isMock = opts.stt.isMock && opts.judge.isMock
    this.o = {
      language: opts.language ?? 'ja', unclearThreshold: opts.unclearThreshold ?? 0.5, finalWaitMs: opts.finalWaitMs ?? 1200,
      judgeTimeoutMs: opts.judgeTimeoutMs ?? 6000, vadRms: opts.vadRms ?? 500, vadMinSpeechMs: opts.vadMinSpeechMs ?? 80,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)), clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
    }
  }

  async start(s: BackendStart) {
    const rs = s.runtime
    if (!this.stt.hasVad) this.vad = new EnergyVad({ sampleRate: SAMPLE_RATE, rmsThreshold: this.o.vadRms, minSpeechMs: this.o.vadMinSpeechMs, silenceMs: rs.silence_duration_ms, prefixMs: rs.prefix_padding_ms })
    await this.stt.start({ sampleRate: SAMPLE_RATE, language: this.o.language, silenceMs: rs.silence_duration_ms, onEvent: (ev) => this.onStt(ev) })
  }

  recv(): Promise<DecisionEvent> { return this.q.recv() }
  bufferedBytes() { return this.stt.bufferedBytes() }

  async control(msg: Record<string, unknown>) {
    if (this.stt.control) await this.stt.control(msg)
    if (this.judge.control) await this.judge.control(msg)
  }

  async pushAudio(pcm: Uint8Array) {
    if (this.closed) throw new BackendClosed('closed')
    this.clock.add(pcm.length)
    this.stt.sendAudio(pcm)
    if (this.vad) for (const ev of this.vad.push(pcm)) ev.type === 'speech_started' ? this.speechStarted(ev.atMs) : this.speechStopped(ev.atMs)
  }

  async clearInput() {
    // only called when nothing is referenced: forget captured text, keep the timeline
    this.vad?.reset()
    for (const u of this.utts.values()) if (u.readyTimer) this.o.clearTimer(u.readyTimer)
    this.utts.clear()
    this.order = []
    this.active = null
  }

  // ------------------------------------------------------------------ STT events
  private onStt(ev: SttEvent) {
    if (this.closed) return
    if (ev.type === 'ready') this.q.push({ type: 'ready' })
    else if (ev.type === 'speech_started') this.speechStarted(ev.atMs)
    else if (ev.type === 'speech_stopped') this.speechStopped(ev.atMs)
    else if (ev.type === 'partial' || ev.type === 'final') this.onText(ev)
    else if (ev.type === 'error') this.q.push({ type: 'error', code: 'stt_error', message: ev.message.slice(0, 200) })
    else if (ev.type === 'closed') this.q.fail(new BackendClosed(ev.message))
  }

  private speechStarted(atMs: number) {
    if (this.active) return
    const u: Utt = { id: `u_${++this.seq}`, startMs: atMs, stopMs: null, finals: [], lastFinalEndMs: null, partial: null, ready: false, readyTimer: null }
    this.utts.set(u.id, u)
    this.order.push(u.id)
    this.active = u.id
    this.q.push({ type: 'speech_started', utterance_id: u.id, audio_start_ms: Math.round(atMs) })
  }

  private speechStopped(atMs: number) {
    const u = this.active ? this.utts.get(this.active) : undefined
    this.active = null
    if (!u) return
    u.stopMs = atMs
    this.q.push({ type: 'speech_stopped', utterance_id: u.id, audio_end_ms: Math.round(atMs) })
    if (u.lastFinalEndMs !== null && u.lastFinalEndMs >= atMs - 400) this.markReady(u)
    else u.readyTimer = this.o.setTimer(() => { u.readyTimer = null; this.markReady(u) }, this.o.finalWaitMs)
  }

  private markReady(u: Utt) {
    if (u.ready) return
    if (u.readyTimer) { this.o.clearTimer(u.readyTimer); u.readyTimer = null }
    u.ready = true
    this.q.push({ type: 'utterance_ready', utterance_id: u.id })
  }

  /** Attribute a text segment to an utterance: by timestamps when the provider gives them, else to the active / latest one. */
  private pick(startMs: number | null, endMs: number | null): Utt | undefined {
    if (!this.order.length) return undefined
    if (startMs !== null || endMs !== null) {
      const mid = startMs !== null && endMs !== null ? (startMs + endMs) / 2 : (endMs ?? startMs)!
      for (let i = this.order.length - 1; i >= 0; i--) {
        const u = this.utts.get(this.order[i]!)!
        const hi = u.stopMs === null ? Infinity : u.stopMs + 600
        if (mid >= u.startMs - 300 && mid <= hi) return u
      }
    }
    if (this.active) return this.utts.get(this.active)
    for (let i = this.order.length - 1; i >= 0; i--) { const u = this.utts.get(this.order[i]!)!; if (!u.ready) return u }
    return this.utts.get(this.order[this.order.length - 1]!)
  }

  private onText(ev: Extract<SttEvent, { type: 'partial' | 'final' }>) {
    const u = this.pick(ev.startMs, ev.endMs)
    if (!u) return
    if (ev.type === 'partial') { u.partial = ev.text; return }
    u.finals.push(ev.text)
    u.partial = null
    u.lastFinalEndMs = ev.endMs ?? this.clock.ms
    if (u.stopMs !== null && !u.ready) this.markReady(u)
  }

  private textOf(u: Utt | undefined, includePartial: boolean): string {
    if (!u) return ''
    const t = u.finals.join('')
    return includePartial && u.partial ? t + u.partial : t || (u.partial ?? '')
  }

  // ------------------------------------------------------------------ classification
  async classify(r: ClassifyRequest) {
    if (this.closed) throw new BackendClosed('closed')
    const parts = r.utteranceIds.map((id) => this.textOf(this.utts.get(id), true))
    if (r.activeUtteranceId) parts.push(this.textOf(this.utts.get(r.activeUtteranceId), true))
    const transcript = parts.filter(Boolean).join(' ')
    if (!transcript.trim()) {
      this.q.push({ type: 'decision', key: r.key, ok: true, branch_id: CTRL_UNCLEAR, reason: 'no_transcript', confidence: 0, metadata_ok: true, usage: null })
      return
    }
    const ctrl = new AbortController()
    this.inflight.set(r.key, ctrl)
    const input = buildJudgeInput({ scenario: r.scenario, node: r.node, lastPromptText: r.lastPromptText, history: r.history, transcript, phase: r.phase, timeoutMs: this.o.judgeTimeoutMs, signal: ctrl.signal })
    // keep only allowed options (the node's edges + the two control ids)
    for (const k of Object.keys(input.criteria)) if (!r.allowed.includes(k)) delete input.criteria[k]
    void this.judge.decide(input).then((res) => {
      if (this.closed || ctrl.signal.aborted) return
      this.inflight.delete(r.key)
      const low = this.o.unclearThreshold > 0 && res.confidence < this.o.unclearThreshold
      const branch = low ? CTRL_UNCLEAR : res.choice
      const ok = r.allowed.includes(branch)
      const reason = `${this.judge.name}: ${res.choice} conf=${res.confidence.toFixed(2)}${low ? ' → ctrl_unclear（低確信度）' : ''} chars=${transcript.length}`
      this.q.push({ type: 'decision', key: r.key, ok, branch_id: ok ? branch : undefined, reason, confidence: res.confidence, metadata_ok: true, error: ok ? undefined : 'branch_not_allowed', usage: res.usage ?? null })
    }, (e) => {
      if (this.closed || ctrl.signal.aborted) return
      this.inflight.delete(r.key)
      this.q.push({ type: 'error', key: r.key, code: 'judge_error', message: String(e?.message ?? e).slice(0, 200) })
    })
  }

  async cancel(key: string) {
    const c = this.inflight.get(key)
    if (c) { this.inflight.delete(key); c.abort() }
  }

  async release(ids: string[]) {
    for (const id of ids) {
      const u = this.utts.get(id)
      if (u?.readyTimer) this.o.clearTimer(u.readyTimer)
      this.utts.delete(id)
    }
    this.order = this.order.filter((id) => this.utts.has(id))
    if (this.active && !this.utts.has(this.active)) this.active = null
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const c of this.inflight.values()) c.abort()
    this.inflight.clear()
    for (const u of this.utts.values()) if (u.readyTimer) this.o.clearTimer(u.readyTimer)
    try { await this.stt.close() } catch { /* ignore */ }
    this.q.fail(new BackendClosed('closed'))
  }
}
