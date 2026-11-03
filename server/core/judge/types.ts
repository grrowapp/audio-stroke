/**
 * Decision-model ("judge") provider contract used by SttJudgeBackend: given the transcript and the
 * per-turn options, pick one option with a probability. The same shape is served by Cloudflare Clef
 * and TypeSafe Jev (System One API), by an OpenAI-compatible local LLM with a constrained JSON
 * schema, and by a scripted mock.
 */
export interface JudgeInput {
  /** What the model should decide (one paragraph). */
  instructions: string
  /** Context for the decision: scenario title, current node, last prompt, history, transcript. */
  state: Record<string, unknown>
  /** option id → description. 2..255 entries. */
  criteria: Record<string, string>
  /** Request budget; providers should abort after this. */
  timeoutMs: number
  signal?: AbortSignal
}

export interface JudgeResult {
  choice: string
  /** 0..1; providers without probabilities return 1. */
  confidence: number
  probabilities: Record<string, number>
  usage?: Record<string, unknown> | null
  /** Provider request id / model, for logs. */
  model?: string
}

export interface JudgeProvider {
  readonly name: string
  readonly isMock: boolean
  decide(input: JudgeInput): Promise<JudgeResult>
  /** Mock: UI / test control. */
  control?(msg: Record<string, unknown>): Promise<void>
}
