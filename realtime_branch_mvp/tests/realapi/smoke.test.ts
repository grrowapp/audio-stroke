/**
 * Optional smoke tests against the real, PAID APIs. Run only after explicit approval of the cost:
 *   RUN_REAL_API=1 npx vitest run tests/realapi
 */
import { describe, expect, it } from 'vitest'
import { loadDotenv, loadSettings, SAMPLE_INSTRUCTION } from '../../server/lib/config'
import { OpenAIRealtimeTransport } from '../../server/lib/realtimeSession'
import { ClaudeScenarioGenerator, defaultRequest } from '../../server/lib/scenarioGenerator'
import { OpenAISpeechSynthesizer, validateAudio, voiceSettings } from '../../server/lib/tts'

loadDotenv('.env')
const run = process.env.RUN_REAL_API === '1'

describe.skipIf(!run)('real API smoke (paid)', () => {
  it('Claude generates a valid graph', async () => {
    const s = loadSettings()
    const out = await new ClaudeScenarioGenerator(s).generate(defaultRequest({ instruction: SAMPLE_INSTRUCTION }))
    expect(out.validation.ok).toBe(true)
  }, 300000)

  it('OpenAI TTS returns decodable audio', async () => {
    const s = loadSettings()
    const vs = voiceSettings({ provider: 'openai', model: s.ttsModel, voice: s.ttsVoice, format: s.ttsFormat, speed: 1.0, style_id: 'polite', style_text: '丁寧に' })
    const data = await new OpenAISpeechSynthesizer(s).synthesize('お問い合わせありがとうございます。', vs)
    validateAudio(data, s.ttsFormat)
  }, 60000)

  it('Realtime accepts session.update', async () => {
    const s = loadSettings()
    const t = new OpenAIRealtimeTransport(s.realtimeUrl, s.realtimeModel, s.openaiApiKey)
    await t.connect()
    await t.send({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'] } })
    for (let i = 0; i < 10; i++) {
      const ev = await t.recv()
      expect(ev.type).not.toBe('error')
      if (ev.type === 'session.updated') break
    }
    await t.close()
  }, 30000)
})
