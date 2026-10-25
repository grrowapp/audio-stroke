/**
 * In-process background jobs (single process). Progress and failures are
 * persisted; jobs running at shutdown are recovered as `interrupted`.
 */
import { AudioStore, buildManifest, manifestMissing, manifestSummary, type Manifest, type ManifestEntry } from './audioStore'
import type { Settings } from './config'
import { BaseGenerator, GenerationError, limitsOf, type GenerationRequest } from './scenarioGenerator'
import { makeScenario, type Scenario } from './scenarioSchema'
import { AUDIO_FAILED, CANCELED, FAILED, READY, RUNNING, SUCCEEDED, Store, newId } from './scenarioStore'
import { validateScenario, type Limits } from './scenarioValidator'
import { InvalidAudio, TTSTransientError, validateAudio, type SpeechSynthesizer, type VoiceSettings } from './tts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class JobManager {
  private tasks = new Map<string, { ac: AbortController; done: Promise<void> }>()
  private audioJobForVersion = new Map<string, string>()
  /** test hook: replace backoff sleep */
  sleepFn: (ms: number) => Promise<unknown> = sleep

  constructor(public settings: Settings, public store: Store, public audio: AudioStore, public generator: BaseGenerator, public synthesizer: SpeechSynthesizer) {}

  cancel(jobId: string): boolean {
    const t = this.tasks.get(jobId)
    if (!t) return false
    t.ac.abort()
    return true
  }

  async wait(jobId: string) {
    await this.tasks.get(jobId)?.done
  }

  private spawn(jobId: string, fn: (signal: AbortSignal) => Promise<void>) {
    const ac = new AbortController()
    const done = (async () => {
      try {
        await fn(ac.signal)
      } catch (e: any) {
        if (ac.signal.aborted || e?.name === 'AbortError') {
          this.store.updateJob(jobId, { status: CANCELED, error: '利用者により取り消されました' })
        } else if (e instanceof GenerationError) {
          this.store.updateJob(jobId, { status: FAILED, error: `${e.code}: ${e.message}`, result: { usage: e.usage, details: e.details } })
        } else {
          console.error(`job ${jobId} failed`, e)
          this.store.updateJob(jobId, { status: FAILED, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}`, result: { trace: String(e?.stack ?? '').slice(-2000) } })
        }
      } finally {
        this.tasks.delete(jobId)
      }
    })()
    this.tasks.set(jobId, { ac, done })
  }

  // ------------------------------------------------------------------
  startGeneration(req: GenerationRequest, source: Record<string, unknown>): string {
    const jobId = this.store.createJob('generate', { request: source, provider: this.generator.name })
    this.spawn(jobId, (signal) => this.runGeneration(jobId, req, signal))
    return jobId
  }

  private async runGeneration(jobId: string, req: GenerationRequest, signal: AbortSignal) {
    const progress: Record<string, unknown> = { stage: 'starting', provider: this.generator.name, mock: this.generator.isMock }
    this.store.updateJob(jobId, { status: RUNNING, progress })
    const outcome = await this.generator.generate(req, (p) => { Object.assign(progress, p); this.store.updateJob(jobId, { progress }) }, signal)
    const scenarioId = newId('scn')
    const constraints = req.prohibitions.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20)
    const scenario = makeScenario(outcome.scenario, { scenario_id: scenarioId, version: 1, source_instruction: req.instruction, source_facts: req.facts, constraints })
    const validation = validateScenario(scenario, limitsOf(req))
    if (!validation.ok) throw new GenerationError('invalid', '生成結果の検証に失敗しました', outcome.usage, validation.errors.map((i) => i.message))
    this.store.insertVersion(scenario, validation, this.generator.name, null)
    this.store.updateJob(jobId, {
      status: SUCCEEDED, progress: { ...progress, stage: 'done' },
      result: { scenario_id: scenarioId, version: 1, usage: outcome.usage, attempts: outcome.attempts, repairs: outcome.repairs, provider: outcome.provider, model: outcome.model, mock: this.generator.isMock },
    })
  }

  // ------------------------------------------------------------------
  startAudio(scenario: Scenario, voice: VoiceSettings, limits: Partial<Limits>, onlyFailed = false): string {
    const key = `${scenario.scenario_id}:${scenario.version}`
    const prev = this.audioJobForVersion.get(key)
    if (prev && this.tasks.has(prev)) throw new Error('この版の音声生成ジョブは既に実行中です')
    const jobId = this.store.createJob('audio', { scenario_id: scenario.scenario_id, version: scenario.version, voice, only_failed: onlyFailed })
    this.audioJobForVersion.set(key, jobId)
    this.spawn(jobId, (signal) => this.runAudio(jobId, scenario, voice, limits, onlyFailed, signal))
    return jobId
  }

  private async runAudio(jobId: string, scenario: Scenario, voice: VoiceSettings, limits: Partial<Limits>, onlyFailed: boolean, signal: AbortSignal) {
    const s = this.settings
    const sid = scenario.scenario_id, ver = scenario.version
    const row = this.store.getVersion(sid, ver)
    const old = onlyFailed ? (row?.manifest as Manifest | null) : null
    const manifest = buildManifest(scenario, voice, this.audio)
    if (old && JSON.stringify(old.voice) === JSON.stringify(voice)) {
      for (const [k, e] of Object.entries(manifest.entries)) if (e.status !== 'ready' && old.entries[k]?.status === 'ready') e.status = 'pending' // file vanished; regenerate
    }
    const todo = Object.values(manifest.entries).filter((e) => e.status !== 'ready')
    const chars = todo.reduce((a, e) => a + (e.tts_text ?? e.text).length, 0)
    const total = Object.keys(manifest.entries).length
    if (total > s.ttsMaxItems) throw new GenerationError('too_many_items', `音声数 ${total} が上限 ${s.ttsMaxItems} を超えています`)
    if (chars > s.ttsMaxTotalChars) throw new GenerationError('too_many_chars', `生成文字数 ${chars} が上限 ${s.ttsMaxTotalChars} を超えています`)
    for (const e of todo) if ((e.tts_text ?? e.text).length > s.ttsMaxCharsPerItem) throw new GenerationError('item_too_long', `${e.utterance_key} の文字数が上限を超えています`)

    const progress = {
      total, done: total - todo.length, failed: 0,
      cache_hits: Object.values(manifest.entries).filter((e) => e.cache_hit).length,
      chars_to_generate: chars, mock: this.synthesizer.isMock, provider: this.synthesizer.name,
    }
    this.store.saveManifest(sid, ver, manifest)
    this.store.updateJob(jobId, { status: RUNNING, progress })

    const one = async (entry: ManifestEntry) => {
      entry.status = 'generating'
      let attempt = 0, delay = 1000, err: string | null = null
      while (attempt < s.ttsMaxAttempts) {
        attempt++
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
        try {
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), s.ttsTimeoutMs)
          const onAbort = () => ac.abort()
          signal.addEventListener('abort', onAbort, { once: true })
          let data: Uint8Array
          try {
            data = await this.synthesizer.synthesize(entry.tts_text ?? entry.text, voice, ac.signal)
          } finally {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
          }
          if (signal.aborted) throw new DOMException('aborted', 'AbortError')
          if (ac.signal.aborted) throw new TTSTransientError('timeout')
          if (data.length > s.ttsMaxAudioBytes) throw new InvalidAudio('audio too large')
          const [mime, dur] = validateAudio(data, voice.format)
          const meta = this.audio.write(entry.audio_id, data, mime, dur, voice as unknown as Record<string, unknown>)
          Object.assign(entry, { status: 'ready', error: null, ...meta })
          err = null
          break
        } catch (e: any) {
          if (e?.name === 'AbortError') throw e
          err = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
          const retryable = e instanceof TTSTransientError || e instanceof InvalidAudio
          if (!retryable) break
          if (attempt < s.ttsMaxAttempts) {
            await this.sleepFn(delay + Math.random() * delay / 4)
            delay *= 2
          }
        }
      }
      if (err) {
        entry.status = 'failed'
        entry.error = err
        progress.failed++
      } else {
        progress.done++
      }
      this.store.saveManifest(sid, ver, manifest)
      this.store.updateJob(jobId, { progress })
    }

    // bounded concurrency
    const queue = [...todo]
    const workers = Array.from({ length: Math.max(1, s.ttsConcurrency) }, async () => {
      while (queue.length) {
        const e = queue.shift()!
        await one(e)
      }
    })
    try {
      await Promise.all(workers)
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        for (const en of Object.values(manifest.entries)) if (en.status === 'generating') en.status = 'pending'
        this.store.saveManifest(sid, ver, manifest)
        this.store.setVersionStatus(sid, ver, AUDIO_FAILED)
        this.audio.cleanupPartials()
      }
      throw e
    }
    const missing = manifestMissing(manifest, this.audio, scenario)
    const validation = validateScenario(scenario, limits)
    const finalStatus = !missing.length && validation.ok ? READY : AUDIO_FAILED
    this.store.setVersionStatus(sid, ver, finalStatus)
    this.store.updateJob(jobId, {
      status: finalStatus === READY ? SUCCEEDED : FAILED, progress,
      result: { version_status: finalStatus, missing, summary: manifestSummary(manifest), tts_chars_generated: chars },
      error: finalStatus === READY ? null : `${missing.length}件の音声が未完了です`,
    })
  }
}
