/**
 * Process-wide service container (single process). Handlers call `services()`.
 * Tests build their own container via `createServices` with mock providers.
 */
import path from 'node:path'
import { AudioStore } from './audioStore'
import { ensureDirs, dbPath, loadDotenv, loadSettings, type Settings } from './config'
import { JobManager } from './jobs'
import type { Engine } from '../core/types'
import type { RealtimeTransport } from './realtimeSession'
import { MockRealtimeTransport, OpenAIRealtimeTransport } from './realtimeSession'
import { makeGenerator, type BaseGenerator } from './scenarioGenerator'
import { Store } from './scenarioStore'
import { makeSynthesizer, type SpeechSynthesizer } from './tts'

export interface Services {
  settings: Settings
  store: Store
  audio: AudioStore
  jobs: JobManager
  generator: BaseGenerator
  synthesizer: SpeechSynthesizer
  transportFactory: () => RealtimeTransport
  engines: Map<string, Engine>
  recovered: { jobs: number; versions: number; sessions: number }
  allowedHosts: Set<string>
  allowedOrigins: Set<string>
}

export interface ServiceOverrides {
  settings?: Partial<Settings>
  generator?: BaseGenerator
  synthesizer?: SpeechSynthesizer
  transportFactory?: () => RealtimeTransport
  extraAllowedHosts?: string[]
}

export function createServices(o: ServiceOverrides = {}): Services {
  const settings = loadSettings(o.settings)
  ensureDirs(settings)
  const store = new Store(dbPath(settings))
  const recovered = store.recoverAfterRestart()
  const audio = new AudioStore(path.join(settings.dataDir, 'audio'), store)
  audio.cleanupPartials()
  const generator = o.generator ?? makeGenerator(settings)
  const synthesizer = o.synthesizer ?? makeSynthesizer(settings)
  const jobs = new JobManager(settings, store, audio, generator, synthesizer)
  const transportFactory = o.transportFactory ?? (() =>
    settings.realtimeProvider === 'openai'
      ? new OpenAIRealtimeTransport(settings.realtimeUrl, settings.realtimeModel, settings.openaiApiKey)
      : new MockRealtimeTransport())
  const hosts = new Set([`127.0.0.1:${settings.port}`, `localhost:${settings.port}`, ...(o.extraAllowedHosts ?? [])])
  const origins = new Set([...hosts].map((h) => `http://${h}`))
  return { settings, store, audio, jobs, generator, synthesizer, transportFactory, engines: new Map(), recovered, allowedHosts: hosts, allowedOrigins: origins }
}

let instance: Services | null = null

/** Lazily built from the environment (+ .env) on first use. */
export function services(): Services {
  if (!instance) {
    loadDotenv(path.resolve(process.cwd(), '.env'))
    instance = createServices({ extraAllowedHosts: (process.env.EXTRA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean) })
  }
  return instance
}

export function setServices(s: Services | null) {
  instance = s
}
