/**
 * Semantic graph validation. Errors block approval / audio generation /
 * conversation start. Warnings must be shown to the reviewer; they never make
 * a scenario "safe" by themselves: factual correctness of free text cannot be
 * guaranteed by code, so human review is always required.
 */
import { CONTROL_BRANCH_PREFIX, type GeneratedScenario, type Scenario } from './scenarioSchema'

export interface Limits {
  max_depth: number
  max_nodes: number // main + control nodes
  max_branches: number // edges per node
  max_total_edges: number
  max_total_text_chars: number
  max_condition_chars_per_node: number
}

export const defaultLimits = (o: Partial<Limits> = {}): Limits => ({
  max_depth: 4,
  max_nodes: 20,
  max_branches: 4,
  max_total_edges: 80,
  max_total_text_chars: 6000,
  max_condition_chars_per_node: 2500,
  ...o,
})

export interface Issue {
  code: string
  message: string
  path: string
}

export interface ValidationResult {
  ok: boolean
  errors: Issue[]
  warnings: Issue[]
  stats: Record<string, number>
  limits?: Limits
}

// Dynamic slots / placeholders are forbidden in spoken text.
const SLOT_RE = /\{[^}]*\}|\[[^\]]*\]|［[^］]*］|〇〇|○○|◯◯|ＸＸ|XX|xx|＿＿|__|<[^>]+>|＜[^＞]+＞/
// Money amounts (1,000円 / ¥500 / 3万円 / 20%) must appear in source facts.
const MONEY_RE = /(?:[¥￥]\s?[0-9０-９][0-9０-９,，]*|[0-9０-９][0-9０-９,，.]*\s?(?:万|千|百)?\s?円|[0-9０-９]+(?:\.[0-9]+)?\s?[%％])/g
const PROMISE_WORDS = ['予約が完了', '予約完了', '申込が完了', '申し込みが完了', '契約が成立', '確定しました', '必ず', '保証します', '無料です']

const FULL = '０１２３４５６７８９，％￥'
const HALF = '0123456789,%¥'
function normNum(s: string): string {
  let out = ''
  for (const ch of s) {
    const i = FULL.indexOf(ch)
    out += i >= 0 ? HALF[i] : ch
  }
  return out.replace(/[\s,]/g, '')
}

export function validateScenario(scenario: GeneratedScenario | Scenario, limitsIn?: Partial<Limits>, sourceFactsIn = ''): ValidationResult {
  const limits = defaultLimits(limitsIn)
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const stats: Record<string, number> = {}
  const err = (code: string, message: string, path = '') => errors.push({ code, message, path })
  const warn = (code: string, message: string, path = '') => warnings.push({ code, message, path })
  const sourceFacts = sourceFactsIn || ('source_facts' in scenario ? (scenario as Scenario).source_facts : '')

  const mainIds = scenario.nodes.map((n) => n.id)
  const ctrlIds = scenario.control_nodes.map((c) => c.id)
  const allIds = [...mainIds, ...ctrlIds]

  // ---- ids
  const seen = new Set<string>()
  allIds.forEach((nid, i) => {
    if (seen.has(nid)) err('duplicate_id', `ノードIDが重複しています: ${nid}`, `nodes[${i}]`)
    seen.add(nid)
    if (nid.startsWith(CONTROL_BRANCH_PREFIX)) err('reserved_prefix', `ノードIDに予約接頭辞 ctrl_ は使えません: ${nid}`)
  })
  const nodes = new Map(scenario.nodes.map((n) => [n.id, n]))
  const ctrls = new Map(scenario.control_nodes.map((c) => [c.id, c]))

  if (!nodes.has(scenario.entry_node_id)) err('bad_entry', `入口ノードが主会話ノードに存在しません: ${scenario.entry_node_id}`, 'entry_node_id')

  // ---- size limits
  if (allIds.length > limits.max_nodes) err('too_many_nodes', `ノード数 ${allIds.length} が上限 ${limits.max_nodes} を超えています（control node を含む）`)
  const totalEdges = scenario.nodes.reduce((a, n) => a + n.edges.length, 0)
  if (totalEdges > limits.max_total_edges) err('too_many_edges', `辺数 ${totalEdges} が上限 ${limits.max_total_edges} を超えています`)
  const totalText = scenario.nodes.reduce((a, n) => a + n.assistant_text.length, 0) + scenario.control_nodes.reduce((a, c) => a + c.assistant_text.length, 0)
  if (totalText > limits.max_total_text_chars) err('too_much_text', `発話文の合計 ${totalText} 文字が上限 ${limits.max_total_text_chars} を超えています`)

  // ---- per node
  for (const n of scenario.nodes) {
    const p = `nodes.${n.id}`
    if (n.terminal) {
      if (n.edges.length) err('terminal_has_edges', `終端ノード ${n.id} に分岐があります`, p)
    } else {
      if (!n.edges.length) err('dead_end', `非終端ノード ${n.id} に進行先がありません`, p)
      if (n.edges.length > limits.max_branches) err('too_many_branches', `ノード ${n.id} の分岐数 ${n.edges.length} が上限 ${limits.max_branches} を超えています`, p)
      if (n.edges.length && !n.edges.some((e) => e.kind !== 'correction')) err('only_correction', `ノード ${n.id} に前進する分岐がありません（訂正のみ）`, p)
      const fb = ctrls.get(n.fallback_node_id ?? '')
      if (!fb) err('missing_fallback', `ノード ${n.id} の fallback_node_id が未設定か参照切れです`, p)
      else if (fb.kind !== 'clarify') err('bad_fallback_kind', `ノード ${n.id} の fallback は clarify 種別である必要があります`, p)
      const ni = ctrls.get(n.no_input_node_id ?? '')
      if (!ni) err('missing_no_input', `ノード ${n.id} の no_input_node_id が未設定か参照切れです`, p)
      else if (ni.kind !== 'no_input') err('bad_no_input_kind', `ノード ${n.id} の no_input は no_input 種別である必要があります`, p)
    }
    const edgeIds = new Set<string>()
    let condChars = 0
    for (const e of n.edges) {
      const ep = `${p}.edges.${e.id}`
      if (edgeIds.has(e.id)) err('duplicate_edge', `ノード ${n.id} 内で分岐IDが重複: ${e.id}`, ep)
      edgeIds.add(e.id)
      if (e.id.startsWith(CONTROL_BRANCH_PREFIX)) err('reserved_prefix', `分岐IDに予約接頭辞 ctrl_ は使えません: ${e.id}`, ep)
      if (!nodes.has(e.target_node_id)) err('broken_ref', `分岐 ${n.id}.${e.id} の遷移先 ${e.target_node_id} が主会話ノードに存在しません`, ep)
      condChars += e.intent_description.length
      for (const x of [...e.match_conditions, ...e.positive_examples, ...e.negative_examples]) condChars += x.length
    }
    if (condChars > limits.max_condition_chars_per_node) err('conditions_too_long', `ノード ${n.id} の条件文が合計 ${condChars} 文字で上限を超えています`, p)
  }

  // ---- control nodes
  for (const c of scenario.control_nodes) {
    const p = `control_nodes.${c.id}`
    if (c.action === 'GOTO_FIXED_NODE') {
      if (!c.goto_node_id || !nodes.has(c.goto_node_id)) err('broken_ref', `control ${c.id} の goto_node_id が主会話ノードに存在しません`, p)
    } else if (c.goto_node_id) {
      err('unexpected_goto', `control ${c.id} は GOTO_FIXED_NODE 以外なので goto_node_id を指定できません`, p)
    }
    if ((c.kind === 'limit' || c.kind === 'end_request') && c.action !== 'END') err('control_must_end', `control ${c.id}（${c.kind}）の action は END である必要があります`, p)
    if ((c.kind === 'clarify' || c.kind === 'no_input') && c.action === 'END') warn('clarify_ends', `control ${c.id} は聞き返し/無応答ですが会話を終了します`, p)
  }
  const pol = scenario.policy
  for (const [attr, kind] of [['limit_node_id', 'limit'], ['end_request_node_id', 'end_request']] as const) {
    const c = ctrls.get(pol[attr])
    if (!c) err('broken_ref', `policy.${attr} が control node に存在しません: ${pol[attr]}`, `policy.${attr}`)
    else if (c.kind !== kind || c.action !== 'END') err('bad_policy_ref', `policy.${attr} は ${kind} 種別かつ END の control node が必要です`, `policy.${attr}`)
  }

  // ---- reachability / DAG / depth
  if (nodes.has(scenario.entry_node_id)) {
    const forward = new Map<string, string[]>()
    for (const n of scenario.nodes) forward.set(n.id, n.edges.filter((e) => e.kind !== 'correction' && nodes.has(e.target_node_id)).map((e) => e.target_node_id))
    const color = new Map<string, number>()
    const cycleNodes = new Set<string>()
    const dfs = (u: string, stack: string[]) => {
      color.set(u, 1)
      stack.push(u)
      for (const v of forward.get(u) ?? []) {
        if (color.get(v) === 1) stack.slice(stack.indexOf(v)).forEach((x) => cycleNodes.add(x))
        else if (!color.has(v)) dfs(v, stack)
      }
      stack.pop()
      color.set(u, 2)
    }
    for (const nid of nodes.keys()) if (!color.has(nid)) dfs(nid, [])
    if (cycleNodes.size) err('illegal_loop', `通常分岐に循環があります（訂正以外のループは不可）: ${[...cycleNodes].sort().join(', ')}`)

    const depth = new Map<string, number>([[scenario.entry_node_id, 0]])
    if (!cycleNodes.size) {
      const order: string[] = []
      const seen2 = new Set<string>()
      const topo = (u: string) => {
        seen2.add(u)
        for (const v of forward.get(u) ?? []) if (!seen2.has(v)) topo(v)
        order.push(u)
      }
      topo(scenario.entry_node_id)
      for (const u of [...order].reverse()) for (const v of forward.get(u) ?? []) depth.set(v, Math.max(depth.get(v) ?? 0, depth.get(u)! + 1))
      const maxD = Math.max(0, ...depth.values())
      stats.max_depth = maxD
      if (maxD > limits.max_depth) err('too_deep', `主会話の深さ ${maxD} が上限 ${limits.max_depth} を超えています`)
    }

    const reach = new Set<string>()
    const q = [scenario.entry_node_id]
    while (q.length) {
      const u = q.shift()!
      if (reach.has(u)) continue
      reach.add(u)
      const n = nodes.get(u)!
      for (const e of n.edges) if (nodes.has(e.target_node_id)) q.push(e.target_node_id)
      for (const cid of [n.fallback_node_id, n.no_input_node_id]) {
        const c = ctrls.get(cid ?? '')
        if (c && c.action === 'GOTO_FIXED_NODE' && c.goto_node_id && nodes.has(c.goto_node_id)) q.push(c.goto_node_id)
      }
    }
    const unreachable = [...nodes.keys()].filter((nid) => !reach.has(nid))
    if (unreachable.length) err('unreachable', `入口から到達できないノードがあります: ${unreachable.join(', ')}`)

    if (!cycleNodes.size) {
      const onlyBack = [...reach].filter((nid) => !depth.has(nid))
      if (onlyBack.length) err('bad_correction', `通常分岐では到達できず訂正分岐でしか入れないノードがあります: ${onlyBack.join(', ')}`)
    }
    for (const n of scenario.nodes) for (const e of n.edges) {
      if (e.kind === 'correction' && depth.has(e.target_node_id) && depth.has(n.id) && depth.get(e.target_node_id)! >= depth.get(n.id)!) {
        err('bad_correction', `訂正分岐 ${n.id}.${e.id} は前のノードへ戻る必要があります`, `nodes.${n.id}.edges.${e.id}`)
      }
    }
    if (!scenario.nodes.some((n) => n.terminal && reach.has(n.id))) err('no_terminal', '到達可能な終端ノードがありません')

    const referenced = new Set<string>([pol.limit_node_id, pol.end_request_node_id])
    for (const n of scenario.nodes) for (const x of [n.fallback_node_id, n.no_input_node_id]) if (x) referenced.add(x)
    for (const cid of ctrls.keys()) if (!referenced.has(cid)) warn('unused_control', `どこからも参照されない control node: ${cid}`)
  }

  // ---- content checks
  const factsNorm = normNum(sourceFacts)
  const texts: [string, string][] = [
    ...scenario.nodes.map((n): [string, string] => [`nodes.${n.id}`, n.assistant_text]),
    ...scenario.control_nodes.map((c): [string, string] => [`control_nodes.${c.id}`, c.assistant_text]),
  ]
  for (const [p, text] of texts) {
    if (SLOT_RE.test(text)) err('dynamic_slot', `発話文に動的スロット/プレースホルダがあります: 「${text.slice(0, 40)}」`, p)
    for (const m of text.matchAll(MONEY_RE)) if (!factsNorm.includes(normNum(m[0]))) err('unsourced_amount', `資料に無い金額・割合が発話文にあります: ${m[0]}`, p)
    for (const w of PROMISE_WORDS) if (text.includes(w)) warn('possible_promise', `断言・約束の可能性がある表現「${w}」を確認してください`, p)
  }

  stats.nodes = mainIds.length
  stats.control_nodes = ctrlIds.length
  stats.edges = totalEdges
  stats.text_chars = totalText
  warn('human_review_required', '自由文の事実性はコードで保証できません。発話文・分岐条件を必ず人が確認してください。')
  return { ok: errors.length === 0, errors, warnings, stats, limits }
}

/** [utterance_key, kind, text] for every reachable main node and every control node. */
export function reachableUtterances(s: GeneratedScenario): { key: string; kind: 'node' | 'control'; text: string }[] {
  const nodes = new Map(s.nodes.map((n) => [n.id, n]))
  const reach: string[] = []
  const seen = new Set<string>()
  const q = [s.entry_node_id]
  while (q.length) {
    const u = q.shift()!
    if (seen.has(u) || !nodes.has(u)) continue
    seen.add(u)
    reach.push(u)
    for (const e of nodes.get(u)!.edges) q.push(e.target_node_id)
  }
  for (const c of s.control_nodes) if (c.action === 'GOTO_FIXED_NODE' && c.goto_node_id && nodes.has(c.goto_node_id) && !seen.has(c.goto_node_id)) { reach.push(c.goto_node_id); seen.add(c.goto_node_id) }
  return [
    ...reach.map((nid) => ({ key: `node:${nid}`, kind: 'node' as const, text: nodes.get(nid)!.assistant_text })),
    ...s.control_nodes.map((c) => ({ key: `control:${c.id}`, kind: 'control' as const, text: c.assistant_text })),
  ]
}
