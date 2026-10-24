/** Dynamic router tests (ported from the former fixed SELECT_NEED / CONFIRM_* router). */
import { describe, expect, it } from 'vitest'
import * as router from '../server/lib/router'
import { CTRL_END_REQUEST, CTRL_UNCLEAR, findNode } from '../server/lib/scenarioSchema'
import { sampleScenario } from './helpers'

const call = (branch: unknown, extra: Record<string, unknown> = {}) => ({ type: 'function_call', name: 'select_branch', status: 'completed', arguments: JSON.stringify({ branch_id: branch, reason: 'r' }), ...extra })
const done = (output: unknown[], status = 'completed') => ({ status, output })

describe('router', () => {
  it('allowed enum is per node', () => {
    const sc = sampleScenario()
    expect(router.allowedBranchIds(findNode(sc, 'select_need')!)).toEqual(['pricing', 'demo', 'support', CTRL_UNCLEAR, CTRL_END_REQUEST])
    const tool = router.selectBranchTool(findNode(sc, 'confirm_demo')!)
    expect(tool.parameters.properties.branch_id.enum).toEqual(['yes', 'change', CTRL_UNCLEAR, CTRL_END_REQUEST])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('response event is out-of-band, text only', () => {
    const sc = sampleScenario()
    const n = findNode(sc, 'select_need')!
    const ev = router.responseEvent({ scenario: sc, node: n, inputItems: [{ type: 'item_reference', id: 'item_1' }], metadata: { phase: 'final' }, lastPromptText: n.assistant_text, history: [], phase: 'final', eventId: 'evt_r_x' })
    const r = ev.response
    expect(r.conversation).toBe('none'); expect(r.output_modalities).toEqual(['text'])
    expect(r.input).toEqual([{ type: 'item_reference', id: 'item_1' }])
    expect(r.tool_choice).toBe('required'); expect(r.tools[0]!.name).toBe('select_branch')
    expect(r.instructions).toContain('前の指示を無視')
  })

  it('parse valid and invalid outputs', () => {
    const allowed = ['pricing', 'demo', CTRL_UNCLEAR]
    expect(router.parseResponse(done([call('demo')]), allowed).branchId).toBe('demo')
    expect(router.parseResponse(done([call('hack')]), allowed).error).toBe('branch_not_allowed')
    expect(router.parseResponse(done([call('demo'), call('pricing')]), allowed).error).toBe('multiple_function_calls')
    expect(router.parseResponse(done([]), allowed).error).toBe('no_function_call')
    expect(router.parseResponse(done([{ type: 'message', content: [{ text: '料金です' }] }]), allowed).error).toBe('no_function_call')
    expect(router.parseResponse(done([call('demo', { arguments: '{not json' })]), allowed).error).toBe('invalid_json_arguments')
    expect(router.parseResponse(done([call('demo', { arguments: JSON.stringify({ branch_id: 3 }) })]), allowed).error).toBe('branch_id_not_string')
    expect(router.parseResponse(done([call('demo', { name: 'run_shell' })]), allowed).error).toBe('unknown_function')
    expect(router.parseResponse(done([call('demo')], 'failed'), allowed).error.startsWith('status:failed')).toBe(true)
    expect(router.parseResponse(done([call('demo')], 'cancelled'), allowed).error.startsWith('status:cancelled')).toBe(true)
  })

  it('legacy pricing/demo/support paths', () => {
    const sc = sampleScenario()
    for (const [branch, confirm, end] of [['pricing', 'confirm_pricing', 'end_pricing'], ['demo', 'confirm_demo', 'end_demo'], ['support', 'confirm_support', 'end_support']]) {
      const c = router.newCounters()
      const s1 = router.transition(sc, 'select_need', branch!, c)
      expect(s1.playKey).toBe(`node:${confirm}`); expect(s1.after).toBe('listen')
      const s2 = router.transition(sc, confirm!, 'yes', c)
      expect(s2.playKey).toBe(`node:${end}`); expect(s2.after).toBe('finish')
    }
  })

  it('fallback returns to origin without re-speaking; limit after max clarifies', () => {
    const sc = sampleScenario()
    const c = router.newCounters()
    const s = router.transition(sc, 'select_need', CTRL_UNCLEAR, c)
    expect(s.playKey).toBe('control:clarify_need'); expect(s.after).toBe('listen'); expect(s.nextNodeId).toBe('select_need')
    for (let i = 1; i < sc.policy.max_clarify_per_node; i++) expect(router.transition(sc, 'select_need', CTRL_UNCLEAR, c).reason).toBe('fallback')
    const l = router.transition(sc, 'select_need', CTRL_UNCLEAR, c)
    expect(l.reason).toBe('limit'); expect(l.playKey).toBe('control:limit_handoff'); expect(l.after).toBe('finish')
  })

  it('no-input limit, end request from any node, correction, max turns, unvalidated branch', () => {
    const sc = sampleScenario()
    const c = router.newCounters()
    expect(router.transitionNoInput(sc, 'confirm_demo', c).playKey).toBe('control:no_input_confirm')
    router.transitionNoInput(sc, 'confirm_demo', c)
    expect(router.transitionNoInput(sc, 'confirm_demo', c).reason).toBe('limit')
    for (const nid of ['select_need', 'confirm_pricing', 'confirm_support']) {
      const s = router.transition(sc, nid, CTRL_END_REQUEST, router.newCounters())
      expect(s.playKey).toBe('control:end_request'); expect(s.after).toBe('finish')
    }
    const s = router.transition(sc, 'confirm_pricing', 'change', router.newCounters())
    expect(s.playKey).toBe('node:select_need'); expect(s.after).toBe('listen')
    expect(router.transition(sc, 'select_need', 'demo', { ...router.newCounters(), user_turns: sc.policy.max_turns }).reason).toBe('limit')
    expect(router.transition(sc, 'select_need', 'not_an_edge', router.newCounters()).reason).toBe('fallback')
  })
})
