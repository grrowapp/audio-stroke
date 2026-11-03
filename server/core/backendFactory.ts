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

/** Human-readable description for /api/config and badges. */
export function describeBackend(s: Settings): { name: string; mock: boolean; detail: string } {
  if (s.decisionBackend === 'stt_judge') {
    const mock = s.sttProvider === 'mock' && s.judgeProvider === 'mock'
    return { name: 'stt_judge', mock, detail: `${s.sttProvider} + ${s.judgeProvider}${s.judgeProvider === 'mock' ? '' : ` ${s.judgeModel}`} (unclear<${s.judgeUnclearThreshold})` }
  }
  const mock = s.decisionBackend === 'mock' || s.realtimeProvider !== 'openai'
  return { name: 'realtime', mock, detail: mock ? 'MOCK' : `${s.realtimeModel} / preview:${s.previewAudioMode}` }
}
