/**
 * "System One" decision API providers: Cloudflare Clef (Workers AI) and TypeSafe Jev.
 * Both take {model, state, questions:{id:{type:'choice', instructions, criteria}}} and answer
 * {answers:{id:{choice, probabilities, confidence}}, usage}. Workers AI wraps the body in {result}.
 */
import type { JudgeInput, JudgeProvider, JudgeResult } from './types'

export interface SystemOneOptions {
  /** 'clef' | 'jev' (for logs) */
  name: string
  url: string
  token: string
  model: string
  /** Workers AI returns {result, success, errors}; TypeSafe returns the body directly. */
  wrapped: boolean
  fetchFn?: typeof fetch
}

export class SystemOneJudge implements JudgeProvider {
  readonly name: string
  readonly isMock = false
  private fetchFn: typeof fetch
  constructor(private o: SystemOneOptions) {
    this.name = o.name
    this.fetchFn = o.fetchFn ?? fetch
    if (!o.url) throw new Error(`${o.name}: URL が未設定です`)
    if (!o.token) throw new Error(`${o.name}: API トークンが未設定です`)
    if (!o.model) throw new Error(`${o.name}: モデル名が未設定です`)
  }

  async decide(input: JudgeInput): Promise<JudgeResult> {
    const body = { model: this.o.model, state: input.state, questions: { branch: { type: 'choice', instructions: input.instructions, criteria: input.criteria } } }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), input.timeoutMs)
    const onAbort = () => ctrl.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.fetchFn(this.o.url, { method: 'POST', headers: { Authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
      const j: any = await res.json().catch(() => ({}))
      const r = this.o.wrapped ? j?.result : j
      const a = r?.answers?.branch
      if (!res.ok || !a || typeof a.choice !== 'string') throw new Error(`${this.name}: HTTP ${res.status} ${JSON.stringify(j?.errors ?? j?.error ?? '').slice(0, 200)}`)
      return { choice: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : 1, probabilities: a.probabilities ?? {}, usage: r.usage ?? null, model: r.model }
    } finally {
      clearTimeout(t)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export const clefJudge = (o: { accountId: string; token: string; model: string; fetchFn?: typeof fetch }) =>
  new SystemOneJudge({ name: 'clef', url: `https://api.cloudflare.com/client/v4/accounts/${o.accountId}/ai/run/@cf/cloudflare/${o.model}`, token: o.token, model: o.model, wrapped: true, fetchFn: o.fetchFn })

export const jevJudge = (o: { token: string; model: string; fetchFn?: typeof fetch }) =>
  new SystemOneJudge({ name: 'jev', url: 'https://api.typesafe.ai/v1/systemone', token: o.token, model: o.model, wrapped: false, fetchFn: o.fetchFn })
