/**
 * Server-side settings. Secrets come from environment variables only.
 * Values here are hard upper bounds enforced by the server; the UI may only
 * pick values inside them. Single-process local MVP.
 */
import fs from 'node:fs'
import path from 'node:path'

const env = (name: string, def = ''): string => (process.env[name] ?? def).trim()
const envInt = (name: string, def: number): number => (env(name) ? Number.parseInt(env(name), 10) : def)
const envFloat = (name: string, def: number): number => (env(name) ? Number.parseFloat(env(name)) : def)
const envList = (name: string, def: string[]): string[] =>
  env(name) ? env(name).split(',').map((s) => s.trim()).filter(Boolean) : [...def]

/** Minimal KEY=VALUE loader; existing environment variables win. */
export function loadDotenv(file: string): void {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).split(' #', 1)[0]!.trim()
    if (!(k in process.env)) process.env[k] = v
  }
}

/** Style presets: the UI chooses an id; only server-defined text reaches TTS. */
export const STYLE_PRESETS: Record<string, string> = {
  polite: '丁寧で落ち着いたビジネス口調の日本語で、はっきりと話してください。',
  bright: '明るく親しみやすい口調の日本語で、聞き取りやすく話してください。',
  calm: 'ゆっくりと穏やかな口調の日本語で話してください。',
  none: '',
}

export const SAMPLE_INSTRUCTION =
  '問い合わせ受付として、料金案内・デモ相談・操作サポートの希望を確認し、選択後に内容を確認して終了してください。' +
  '料金の具体額や予約完了は断言せず、曖昧なら聞き返してください。'

/** Fixed rules always appended to the user's prohibitions. */
export const FIXED_RULES = [
  '価格・金額・割引・契約条件を捏造しない。資料に無い具体額を発話しない。',
  '予約完了・申込完了・契約成立などを断言しない。',
  '顧客名・日付・金額などの動的な値を発話文に埋め込まない（プレースホルダ禁止）。',
]

export interface Settings {
  dataDir: string
  host: string
  port: number
  // Claude (scenario generation, before the conversation only)
  scenarioProvider: 'mock' | 'claude'
  anthropicApiKey: string
  claudeModel: string
  claudeEffort: string
  claudeOutputMode: 'structured' | 'tool'
  claudeRefusalFallback: 'off' | 'default'
  claudeTimeoutMs: number
  claudeMaxAttempts: number
  claudeMaxRepairs: number
  claudeMaxTokens: number
  claudeMaxResponseChars: number
  // TTS (before the conversation only)
  ttsProvider: 'mock' | 'openai'
  openaiApiKey: string
  ttsModel: string
  ttsVoice: string
  ttsFormat: 'mp3' | 'wav'
  ttsAllowedModels: string[]
  ttsAllowedVoices: string[]
  ttsConcurrency: number
  ttsMaxAttempts: number
  ttsTimeoutMs: number
  ttsMaxCharsPerItem: number
  ttsMaxItems: number
  ttsMaxTotalChars: number
  ttsMaxAudioBytes: number
  speedMin: number
  speedMax: number
  // Realtime (classification during the conversation)
  realtimeProvider: 'mock' | 'openai'
  realtimeModel: string
  realtimeUrl: string
  previewAudioMode: 'inline' | 'item'
  // generation limits
  maxInstructionChars: number
  maxFactsChars: number
  maxProhibitionsChars: number
  maxFirstUtteranceChars: number
  maxDepthLimit: number
  maxNodesLimit: number
  maxBranchesLimit: number
  // transport limits
  maxHttpBodyBytes: number
  maxWsTextBytes: number
  maxWsAudioFrameBytes: number
  maxOpenaiSendBufferBytes: number
  /** Local MVP cost guard: concurrent live conversations. */
  maxConcurrentSessions: number
  /** Optional Basic auth gate for hosted verification (both must be set to enable). */
  basicAuthUser: string
  basicAuthPassword: string
}

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const s: Settings = {
    dataDir: env('DATA_DIR') || path.resolve(process.cwd(), 'data'),
    host: env('HOST', '127.0.0.1'),
    port: envInt('PORT', 8000),
    scenarioProvider: env('SCENARIO_PROVIDER', 'mock') === 'claude' ? 'claude' : 'mock',
    anthropicApiKey: env('ANTHROPIC_API_KEY'),
    claudeModel: env('CLAUDE_SCENARIO_MODEL'),
    claudeEffort: env('CLAUDE_EFFORT'),
    claudeOutputMode: env('CLAUDE_OUTPUT_MODE', 'structured') === 'tool' ? 'tool' : 'structured',
    claudeRefusalFallback: env('CLAUDE_REFUSAL_FALLBACK', 'off') === 'default' ? 'default' : 'off',
    claudeTimeoutMs: envFloat('CLAUDE_TIMEOUT_S', 180) * 1000,
    claudeMaxAttempts: envInt('CLAUDE_MAX_ATTEMPTS', 3),
    claudeMaxRepairs: 2, // fixed by spec
    claudeMaxTokens: envInt('CLAUDE_MAX_TOKENS', 32000),
    claudeMaxResponseChars: 200_000,
    ttsProvider: env('TTS_PROVIDER', 'mock') === 'openai' ? 'openai' : 'mock',
    openaiApiKey: env('OPENAI_API_KEY'),
    ttsModel: env('TTS_MODEL'),
    ttsVoice: env('TTS_VOICE'),
    ttsFormat: env('TTS_FORMAT', 'mp3') === 'wav' ? 'wav' : 'mp3',
    ttsAllowedModels: envList('TTS_ALLOWED_MODELS', []),
    ttsAllowedVoices: envList('TTS_ALLOWED_VOICES', []),
    ttsConcurrency: envInt('TTS_CONCURRENCY', 2),
    ttsMaxAttempts: envInt('TTS_MAX_ATTEMPTS', 3),
    ttsTimeoutMs: envFloat('TTS_TIMEOUT_S', 60) * 1000,
    ttsMaxCharsPerItem: 400,
    ttsMaxItems: 80,
    ttsMaxTotalChars: 12_000,
    ttsMaxAudioBytes: 5_000_000,
    speedMin: 0.7,
    speedMax: 1.5,
    realtimeProvider: env('REALTIME_PROVIDER', 'mock') === 'openai' ? 'openai' : 'mock',
    realtimeModel: env('REALTIME_MODEL'),
    realtimeUrl: env('REALTIME_URL', 'wss://api.openai.com/v1/realtime'),
    previewAudioMode: env('PREVIEW_AUDIO_MODE', 'inline') === 'item' ? 'item' : 'inline',
    maxInstructionChars: 4000,
    maxFactsChars: 8000,
    maxProhibitionsChars: 2000,
    maxFirstUtteranceChars: 300,
    maxDepthLimit: 6,
    maxNodesLimit: 30,
    maxBranchesLimit: 6,
    maxHttpBodyBytes: 512_000,
    maxWsTextBytes: 16_000,
    maxWsAudioFrameBytes: 24_000, // 500 ms of PCM16 @ 24 kHz
    maxOpenaiSendBufferBytes: 4_000_000,
    maxConcurrentSessions: envInt('MAX_CONCURRENT_SESSIONS', 1),
    basicAuthUser: env('BASIC_AUTH_USER'),
    basicAuthPassword: env('BASIC_AUTH_PASSWORD'),
    ...overrides,
  }
  return s
}

export function ensureDirs(s: Settings): void {
  fs.mkdirSync(path.join(s.dataDir, 'audio'), { recursive: true })
  fs.mkdirSync(path.join(s.dataDir, 'logs'), { recursive: true })
}

export const dbPath = (s: Settings) => path.join(s.dataDir, 'mvp.sqlite3')

export function effectiveTtsModels(s: Settings): string[] {
  if (s.ttsProvider === 'mock') return ['mock-tone']
  const models = [...s.ttsAllowedModels]
  if (s.ttsModel && !models.includes(s.ttsModel)) models.unshift(s.ttsModel)
  return models
}

export function effectiveTtsVoices(s: Settings): string[] {
  if (s.ttsProvider === 'mock') return ['mock']
  const voices = [...s.ttsAllowedVoices]
  if (s.ttsVoice && !voices.includes(s.ttsVoice)) voices.unshift(s.ttsVoice)
  return voices
}

export const effectiveTtsFormat = (s: Settings): 'mp3' | 'wav' => (s.ttsProvider === 'mock' ? 'wav' : s.ttsFormat)
