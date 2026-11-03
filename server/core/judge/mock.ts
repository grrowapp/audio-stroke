/** Scripted judge for tests and the UI mock: the choice is set from outside (mock_vad control). */
import { CTRL_UNCLEAR } from '../../lib/scenarioSchema'
import type { JudgeInput, JudgeProvider, JudgeResult } from './types'

export class MockJudge implements JudgeProvider {
  readonly name = 'mock'
  readonly isMock = true
  previewChoice: string | null = null
  finalChoice: string | null = null
  confidence = 0.9
  calls: JudgeInput[] = []
  constructor(public delayMs = 30) {}

  async control(msg: Record<string, unknown>) {
    if ('preview_branch' in msg) this.previewChoice = (msg.preview_branch as string) || null
    if ('final_branch' in msg) this.finalChoice = (msg.final_branch as string) || null
    if (typeof msg.confidence === 'number') this.confidence = msg.confidence
  }

  async decide(input: JudgeInput): Promise<JudgeResult> {
    this.calls.push(input)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, this.delayMs)
      input.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) }, { once: true })
    })
    const preview = (input.state as any)?.note !== undefined
    const choice = (preview ? this.previewChoice : this.finalChoice) ?? CTRL_UNCLEAR
    return { choice, confidence: this.confidence, probabilities: { [choice]: this.confidence }, usage: { input_tokens: 0, output_tokens: 0 }, model: 'mock' }
  }
}
