import { describe, expect, it } from 'vitest'
import { GeneratedScenarioSchema, generationJsonSchema } from '../server/lib/scenarioSchema'
import { reachableUtterances, validateScenario, type Limits } from '../server/lib/scenarioValidator'
import { sampleBody, sampleScenario } from './helpers'

const v = (body: any, limits?: Partial<Limits>, facts = '') => validateScenario(GeneratedScenarioSchema.parse(body), limits, facts)
const codes = (r: ReturnType<typeof validateScenario>) => new Set(r.errors.map((e) => e.code))

describe('schema + validator', () => {
  it('sample graph is valid', () => {
    const r = v(sampleBody())
    expect(r.ok, JSON.stringify(r.errors)).toBe(true)
    expect(r.stats.max_depth).toBe(2)
    expect(r.warnings.some((w) => w.code === 'human_review_required')).toBe(true)
  })

  it('rejects extra fields and bad ids at the schema level', () => {
    const b = sampleBody(); b.nodes[0].reply_text = '二重発話'
    expect(GeneratedScenarioSchema.safeParse(b).success).toBe(false)
    const b2 = sampleBody(); b2.audio_manifest = {}
    expect(GeneratedScenarioSchema.safeParse(b2).success).toBe(false)
    const b3 = sampleBody(); b3.nodes[0].edges[0].id = '../etc'
    expect(GeneratedScenarioSchema.safeParse(b3).success).toBe(false)
  })

  it('duplicate ids / edges', () => {
    const b = sampleBody(); b.control_nodes[0].id = 'select_need'
    expect(codes(v(b))).toContain('duplicate_id')
    const b2 = sampleBody(); b2.nodes[0].edges[1].id = 'pricing'
    expect(codes(v(b2))).toContain('duplicate_edge')
  })

  it('broken refs and entry', () => {
    const b = sampleBody(); b.nodes[0].edges[0].target_node_id = 'nowhere'
    expect(codes(v(b))).toContain('broken_ref')
    const b2 = sampleBody(); b2.entry_node_id = 'clarify_need'
    expect(codes(v(b2))).toContain('bad_entry')
  })

  it('illegal loop on normal edges; corrections must go back', () => {
    const b = sampleBody(); b.nodes[1].edges[1].kind = 'normal'
    expect(codes(v(b))).toContain('illegal_loop')
    const b2 = sampleBody(); b2.nodes[0].edges[0].kind = 'correction'
    expect(codes(v(b2))).toContain('bad_correction')
  })

  it('unreachable node', () => {
    const b = sampleBody()
    b.nodes.push({ id: 'orphan', label: '孤立', assistant_text: '孤立しています。', terminal: true, edges: [], fallback_node_id: null, no_input_node_id: null })
    expect(codes(v(b))).toContain('unreachable')
  })

  it('limits', () => {
    expect(codes(v(sampleBody(), { max_nodes: 5 }))).toContain('too_many_nodes')
    expect(codes(v(sampleBody(), { max_depth: 1 }))).toContain('too_deep')
    expect(codes(v(sampleBody(), { max_branches: 2 }))).toContain('too_many_branches')
  })

  it('fallback / no-input / policy references', () => {
    const b = sampleBody(); b.nodes[0].fallback_node_id = null; b.nodes[1].no_input_node_id = 'clarify_confirm'
    const c = codes(v(b))
    expect(c).toContain('missing_fallback'); expect(c).toContain('bad_no_input_kind')
    const b2 = sampleBody(); b2.policy.end_request_node_id = 'clarify_need'
    expect(codes(v(b2))).toContain('bad_policy_ref')
  })

  it('terminal rules and dead ends', () => {
    const b = sampleBody(); b.nodes[4].edges = structuredClone(b.nodes[1].edges)
    expect(codes(v(b))).toContain('terminal_has_edges')
    const b2 = sampleBody(); b2.nodes[4].terminal = false; b2.nodes[4].fallback_node_id = 'clarify_need'; b2.nodes[4].no_input_node_id = 'no_input_need'
    expect(codes(v(b2))).toContain('dead_end')
  })

  it('dynamic slots, unsourced amounts, promises', () => {
    const b = sampleBody(); b.nodes[0].assistant_text = '{customer_name}様、お問い合わせありがとうございます。'
    expect(codes(v(b))).toContain('dynamic_slot')
    const b2 = sampleBody(); b2.nodes[1].assistant_text = '料金は月額3,000円です。よろしいでしょうか。'
    expect(codes(v(b2))).toContain('unsourced_amount')
    expect(v(b2, undefined, 'ベーシックプランは月額3,000円').ok).toBe(true)
    const b3 = sampleBody(); b3.nodes[5].assistant_text = '予約が完了しました。'
    expect(v(b3).warnings.some((w) => w.code === 'possible_promise')).toBe(true)
  })

  it('control action rules and reserved prefix', () => {
    const b = sampleBody(); b.control_nodes[4].action = 'RETURN_TO_ORIGIN'
    expect(codes(v(b))).toContain('control_must_end')
    const b2 = sampleBody(); b2.control_nodes[0].action = 'GOTO_FIXED_NODE'; b2.control_nodes[0].goto_node_id = 'missing'
    expect(codes(v(b2))).toContain('broken_ref')
    const b3 = sampleBody(); b3.nodes[0].edges[0].id = 'ctrl_unclear'
    expect(codes(v(b3))).toContain('reserved_prefix')
  })

  it('reachable utterances include controls', () => {
    const keys = reachableUtterances(sampleScenario()).map((u) => u.key)
    expect(keys).toContain('node:select_need'); expect(keys).toContain('control:end_request'); expect(keys).toContain('control:limit_handoff')
    expect(keys).toHaveLength(13)
  })

  it('Step1 call direction: defaults to inbound, outbound is rejected as not implemented', () => {
    const noDir = sampleBody(); delete noDir.call_direction
    expect(GeneratedScenarioSchema.parse(noDir).call_direction).toBe('inbound')
    expect(v(sampleBody()).ok).toBe(true)
    const r = v({ ...sampleBody(), call_direction: 'outbound' })
    expect(r.ok).toBe(false); expect(codes(r)).toEqual(new Set(['direction_not_implemented']))
    expect(() => GeneratedScenarioSchema.parse({ ...sampleBody(), call_direction: 'sideways' })).toThrow()
    const s = generationJsonSchema() as any
    expect(s.properties.call_direction.enum).toEqual(['inbound', 'outbound']); expect(s.required).toContain('call_direction')
  })

  it('generation schema is strict and inlined', () => {
    const s = generationJsonSchema() as any
    const txt = JSON.stringify(s)
    expect(txt).not.toContain('$ref'); expect(txt).not.toContain('maxLength')
    expect(s.additionalProperties).toBe(false)
    const node = s.properties.nodes.items
    expect(node.additionalProperties).toBe(false); expect(node.required).toContain('assistant_text')
  })
})
