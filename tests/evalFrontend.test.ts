import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as router from '../server/lib/router'
import { findNode } from '../server/lib/scenarioSchema'
import { ROOT, sampleScenario } from './helpers'

const REQUIRED = ['料金を知りたい', 'デモを見たい', '使い方が分からない', '料金、ではなくデモです', 'それは結構です', '大丈夫です', 'はい、でもちょっと待って', '前の話に戻って', '終了してください']

describe('eval fixture and frontend safety', () => {
  it('eval fixture is well formed and node-specific', () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/eval_ja.json'), 'utf-8'))
    const sc = sampleScenario()
    const utt = data.cases.map((c: any) => c.utterance).filter(Boolean)
    for (const p of REQUIRED) expect(utt).toContain(p)
    const kinds = new Set(data.cases.map((c: any) => c.audio))
    for (const k of ['tts', 'noise', 'silence']) expect(kinds).toContain(k)
    expect(data.cases.some((c: any) => c.pre_silence_ms)).toBe(true)
    const ids = new Set<string>()
    for (const c of data.cases) {
      expect(ids.has(c.id)).toBe(false); ids.add(c.id)
      const node = findNode(sc, c.node_id)!
      expect(node && !node.terminal).toBe(true)
      const allowed = new Set([...router.allowedBranchIds(node), '__no_input__'])
      for (const e of c.expected) expect(allowed).toContain(e)
    }
    const by = Object.fromEntries(data.cases.map((c: any) => [`${c.node_id}|${c.utterance}`, c.expected]))
    expect(by['select_need|大丈夫です']).not.toEqual(by['confirm_pricing|大丈夫です'])
  })

  it('frontend never uses v-html / innerHTML / eval', () => {
    const files = [...walk(path.join(ROOT, 'app')), path.join(ROOT, 'public/worklet.js')]
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf-8')
      for (const bad of ['v-html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) expect(t, `${f} contains ${bad}`).not.toContain(bad)
    }
  })

  it('no secrets in frontend / metrics code; .env.example has empty keys', () => {
    for (const f of [...walk(path.join(ROOT, 'app')), path.join(ROOT, 'server/lib/metrics.ts')]) {
      const t = fs.readFileSync(f, 'utf-8')
      expect(t).not.toContain('OPENAI_API_KEY'); expect(t).not.toContain('ANTHROPIC_API_KEY')
      expect(t).not.toMatch(/sk-[A-Za-z0-9]{10,}/)
    }
    const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8')
    expect(env).toMatch(/^OPENAI_API_KEY=$/m); expect(env).toMatch(/^ANTHROPIC_API_KEY=$/m)
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
