/**
 * OpenAI-compatible chat-completions judge for local LLMs (vLLM, llama.cpp server, Ollama …).
 * The branch id is forced through a JSON-schema response format with an enum, so the model can only
 * answer with one of the allowed ids. No probabilities are available: confidence is 1 unless the
 * model also returns a numeric `confidence` field.
 */
import type { JudgeInput, JudgeProvider, JudgeResult } from './types'

export interface OpenAICompatOptions {
  baseUrl: string // e.g. http://127.0.0.1:8000/v1
  model: string
  apiKey?: string
  fetchFn?: typeof fetch
}

export class OpenAICompatJudge implements JudgeProvider {
  readonly name = 'openai_compat'
  readonly isMock = false
  private fetchFn: typeof fetch
  constructor(private o: OpenAICompatOptions) {
    this.fetchFn = o.fetchFn ?? fetch
    if (!o.baseUrl) throw new Error('openai_compat: JUDGE_URL が未設定です')
    if (!o.model) throw new Error('openai_compat: JUDGE_MODEL が未設定です')
  }

  async decide(input: JudgeInput): Promise<JudgeResult> {
    const ids = Object.keys(input.criteria)
    const system = input.instructions + '\n必ず JSON で {"branch_id": <選択肢の id>, "confidence": 0〜1} だけを返す。'
    const user = ['# 選択肢', ...ids.map((id) => `- ${id}: ${input.criteria[id]}`), '', '# 状況', JSON.stringify(input.state, null, 1)].join('\n')
    const body = {
      model: this.o.model, temperature: 0, max_tokens: 64,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'branch', strict: true, schema: { type: 'object', properties: { branch_id: { type: 'string', enum: ids }, confidence: { type: 'number' } }, required: ['branch_id'], additionalProperties: false } } },
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), input.timeoutMs)
    const onAbort = () => ctrl.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`
      const res = await this.fetchFn(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
      const j: any = await res.json().catch(() => ({}))
      const content: string = j?.choices?.[0]?.message?.content ?? ''
      let parsed: any
      try { parsed = JSON.parse(content) } catch { throw new Error(`openai_compat: JSON ではない応答 ${content.slice(0, 80)}`) }
      if (!res.ok || typeof parsed?.branch_id !== 'string') throw new Error(`openai_compat: HTTP ${res.status} ${JSON.stringify(j?.error ?? '').slice(0, 200)}`)
      const conf = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 1
      return { choice: parsed.branch_id, confidence: conf, probabilities: { [parsed.branch_id]: conf }, usage: j.usage ?? null, model: j.model }
    } finally {
      clearTimeout(t)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }
}
