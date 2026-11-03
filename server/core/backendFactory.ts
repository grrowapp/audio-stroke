/**
 * Builds the configured DecisionBackend (docs/DECISION_BACKEND.md). Fails fast at session start
 * when a provider's key is missing, so a misconfiguration never reaches the caller as silence.
 */
import type { Settings } from '../lib/config'
import type { DecisionBackend } from './decision'
import { MockJudge } from './judge/mock'
import { OpenAICompatJudge } from './judge/openaiCompat'
import { clefJudge, jevJudge } from './judge/systemOne'
import type { JudgeProvider } from './judge/types'
import { RealtimeBackend } from './realtimeBackend'
import { DeepgramStt } from './stt/deepgram'
import { GoogleStt } from './stt/google'
import { MockStt } from './stt/mock'
import { RevAiStt } from './stt/revai'
import type { SttProvider } from './stt/types'
import { SttJudgeBackend } from './sttJudgeBackend'
import { MockRealtimeTransport, OpenAIRealtimeTransport, type RealtimeTransport } from './transports'
import { nodeHost } from './types'

export function makeSttProvider(s: Settings): SttProvider {
  switch (s.sttProvider) {
    case 'revai': return new RevAiStt(s.revaiAccessToken, 'ja')
    case 'deepgram': return new DeepgramStt(s.deepgramApiKey, 'ja')
    case 'google': return new GoogleStt({ projectId: s.googleProjectId, location: s.googleSttLocation, model: s.googleSttModel, language: 'ja-JP' })
    default: return new MockStt()
  }
}

export function makeJudgeProvider(s: Settings): JudgeProvider {
  switch (s.judgeProvider) {
    case 'clef': return clefJudge({ accountId: s.cfAccountId, token: s.cfApiToken, model: s.judgeModel || 'clef-flash' })
    case 'jev': return jevJudge({ token: s.typesafeApiKey, model: s.judgeModel || 'jev-latest' })
    case 'openai_compat': return new OpenAICompatJudge({ baseUrl: s.judgeUrl, model: s.judgeModel, apiKey: s.judgeApiKey || undefined })
    default: return new MockJudge()
  }
}

export function makeRealtimeTransport(s: Settings): RealtimeTransport {
  return s.realtimeProvider === 'openai' ? new OpenAIRealtimeTransport(s.realtimeUrl, s.realtimeModel, s.openaiApiKey) : new MockRealtimeTransport()
}

export function makeBackend(s: Settings, transportFactory: () => RealtimeTransport = () => makeRealtimeTransport(s)): DecisionBackend {
  if (s.decisionBackend === 'stt_judge') {
    return new SttJudgeBackend({ stt: makeSttProvider(s), judge: makeJudgeProvider(s), unclearThreshold: s.judgeUnclearThreshold, finalWaitMs: s.sttFinalWaitMs, vadRms: s.sttVadRms })
  }
  // 'realtime' and 'mock' both ride the Realtime transport (mock = MockRealtimeTransport)
  const t = s.decisionBackend === 'mock' ? new MockRealtimeTransport() : transportFactory()
  return new RealtimeBackend(t, nodeHost(), s.previewAudioMode)
}

/** Environment variables a backend needs and lacks (empty = usable). */
export function backendMissing(s: Settings): string[] {
  const m: string[] = []
  if (s.decisionBackend === 'realtime') {
    if (s.realtimeProvider === 'openai') { if (!s.realtimeModel) m.push('REALTIME_MODEL'); if (!s.openaiApiKey) m.push('OPENAI_API_KEY') }
  } else if (s.decisionBackend === 'stt_judge') {
    if (s.sttProvider === 'revai' && !s.revaiAccessToken) m.push('REVAI_ACCESS_TOKEN')
    if (s.sttProvider === 'deepgram' && !s.deepgramApiKey) m.push('DEEPGRAM_API_KEY')
    if (s.sttProvider === 'google' && !s.googleProjectId) m.push('GOOGLE_PROJECT_ID')
    if (s.judgeProvider === 'clef') { if (!s.cfAccountId) m.push('CF_ACCOUNT_ID'); if (!s.cfApiToken) m.push('CF_API_TOKEN') }
    if (s.judgeProvider === 'jev' && !s.typesafeApiKey) m.push('TYPESAFE_API_KEY')
    if (s.judgeProvider === 'openai_compat' && !s.judgeUrl) m.push('JUDGE_URL')
  }
  return m
}

/** Per-session choices for the UI: each backend as it would run with the current environment. */
export function describeBackendOptions(s: Settings): { default: Settings['decisionBackend']; options: { id: Settings['decisionBackend']; name: string; mock: boolean; detail: string; missing: string[] }[] } {
  const options = (['realtime', 'stt_judge', 'mock'] as const).map((id) => {
    const eff = { ...s, decisionBackend: id }
    return { id, ...describeBackend(eff), missing: backendMissing(eff) }
  })
  return { default: s.decisionBackend, options }
}

/** Human-readable description for /api/config and badges. */
export function describeBackend(s: Settings): { name: string; mock: boolean; detail: string } {
  if (s.decisionBackend === 'stt_judge') {
    const mock = s.sttProvider === 'mock' && s.judgeProvider === 'mock'
    return { name: 'stt_judge', mock, detail: `${s.sttProvider} + ${s.judgeProvider}${s.judgeProvider === 'mock' ? '' : ` ${s.judgeModel}`} (unclear<${s.judgeUnclearThreshold})` }
  }
  const mock = s.decisionBackend === 'mock' || s.realtimeProvider !== 'openai'
  return { name: 'realtime', mock, detail: mock ? 'MOCK' : `${s.realtimeModel} / preview:${s.previewAudioMode}` }
}
