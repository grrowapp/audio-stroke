/**
 * Picks the engine implementation. The host (ws route) only ever sees `Engine`.
 *   ENGINE_IMPL=inprocess  (default) TypeScript engine in this process
 *   ENGINE_IMPL=subprocess ENGINE_CMD=/path/to/native-core [ENGINE_ARGS=...]
 */
import path from 'node:path'
import type { AudioStore, Manifest } from '../lib/audioStore'
import type { Settings } from '../lib/config'
import type { Scenario } from '../lib/scenarioSchema'
import { ConversationEngine } from './engine'
import type { RuntimeSettings } from './runtime'
import type { RealtimeTransport } from './transports'
import { SubprocessEngine } from './subprocessEngine'
import type { BrowserSend, Engine, MetricsSink } from './types'

export interface EngineFactoryArgs {
  sessionId: string
  scenario: Scenario
  manifest: Manifest
  settings: RuntimeSettings
  sendBrowser: BrowserSend
  metrics: MetricsSink
  audio: AudioStore
  transportFactory: () => RealtimeTransport
  app: Settings
}

export function createEngine(a: EngineFactoryArgs): Engine {
  const impl = process.env.ENGINE_IMPL ?? 'inprocess'
  if (impl === 'subprocess') {
    const command = process.env.ENGINE_CMD
    if (!command) throw new Error('ENGINE_IMPL=subprocess には ENGINE_CMD が必要です')
    const audioPaths: Record<string, string> = {}
    for (const e of Object.values(a.manifest.entries)) {
      const asset = a.audio.readyAsset(e.audio_id)
      if (asset) audioPaths[e.audio_id] = path.resolve(asset.path)
    }
    return new SubprocessEngine({
      command, args: (process.env.ENGINE_ARGS ?? '').split(' ').filter(Boolean),
      sessionId: a.sessionId, scenario: a.scenario, manifest: a.manifest, settings: a.settings, sendBrowser: a.sendBrowser, metrics: a.metrics,
      realtime: { url: a.app.realtimeUrl, model: a.app.realtimeModel, apiKey: a.app.openaiApiKey, mock: a.app.realtimeProvider !== 'openai', previewAudioMode: a.app.previewAudioMode },
      audioPaths,
    })
  }
  return new ConversationEngine({
    sessionId: a.sessionId, scenario: a.scenario, manifest: a.manifest, audio: a.audio, transport: a.transportFactory(),
    sendBrowser: a.sendBrowser, settings: a.settings, metrics: a.metrics, previewAudioMode: a.app.previewAudioMode,
    maxFrameBytes: a.app.maxWsAudioFrameBytes, maxSendBuffer: a.app.maxOpenaiSendBufferBytes,
  })
}
