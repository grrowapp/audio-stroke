/**
 * Strict server-side scenario schema (zod).
 *
 * The same schema produces (1) the JSON Schema given to Claude and (2) the
 * validation of everything Claude returns or the user edits. Structural
 * validity says nothing about semantic correctness: see scenarioValidator and
 * keep human review mandatory.
 *
 * Playback / transition conventions (router.ts depends on them):
 * - Entering a node plays that node's assistant_text once. Edges carry no reply
 *   text, so nothing is ever spoken twice.
 * - A fallback (unclear) plays the control node's text and then waits for an
 *   answer to the same node without re-speaking it.
 * - Control node targets come only from enum actions; return targets are held
 *   by the app, never generated as free node ids.
 */
import { z } from 'zod'

export const SCHEMA_VERSION = '1'
export const ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
export const CONTROL_BRANCH_PREFIX = 'ctrl_'
export const CTRL_UNCLEAR = 'ctrl_unclear'
export const CTRL_END_REQUEST = 'ctrl_end_request'

const MAX_TEXT = 300
const MAX_LABEL = 40
const MAX_DESC = 300

const id = z.string().regex(ID_PATTERN)
const trimmed = (max: number, min = 1) => z.string().trim().min(min).max(max)

export const EdgeKind = z.enum(['normal', 'confirm', 'deny', 'correction'])
export const ControlKind = z.enum(['clarify', 'no_input', 'limit', 'end_request'])
export const ControlAction = z.enum(['RETURN_TO_ORIGIN', 'END', 'GOTO_FIXED_NODE'])

export const EdgeSchema = z
  .object({
    id: id.describe('ノード内で一意。ctrl_ で始めない'),
    label: trimmed(MAX_LABEL),
    intent_description: trimmed(MAX_DESC).describe('この分岐を選ぶべき意図の説明'),
    match_conditions: z.array(z.string().trim().max(200)).max(6).describe('判断条件（自然文）'),
    positive_examples: z.array(z.string().trim().max(80)).min(1).max(12).describe('想定返答・言い換えの例（完全一致用ではない）'),
    negative_examples: z.array(z.string().trim().max(80)).max(12).describe('この分岐に入れてはいけない例'),
    target_node_id: id,
    kind: EdgeKind,
  })
  .strict()

export const NodeSchema = z
  .object({
    id,
    label: trimmed(MAX_LABEL),
    assistant_text: trimmed(MAX_TEXT).describe('このノードに入った時に一度だけ読み上げる文そのもの'),
    terminal: z.boolean(),
    edges: z.array(EdgeSchema).max(8),
    fallback_node_id: id.nullable().describe('clarify 種別の control node id'),
    no_input_node_id: id.nullable().describe('no_input 種別の control node id'),
  })
  .strict()

export const ControlNodeSchema = z
  .object({
    id,
    label: trimmed(MAX_LABEL),
    kind: ControlKind,
    assistant_text: trimmed(MAX_TEXT),
    action: ControlAction,
    goto_node_id: id.nullable().describe('action が GOTO_FIXED_NODE の時だけ指定'),
  })
  .strict()

export const PolicySchema = z
  .object({
    max_turns: z.number().int().min(1).max(50),
    max_clarify_per_node: z.number().int().min(0).max(5),
    max_no_input_per_node: z.number().int().min(0).max(5),
    no_input_timeout_ms: z.number().int().min(2000).max(30000),
    limit_node_id: id.describe('上限到達時の control node (action=END)'),
    end_request_node_id: id.describe('終了希望時の control node (action=END)'),
  })
  .strict()

/** Exactly what Claude is asked to produce. */
export const GeneratedScenarioSchema = z
  .object({
    title: trimmed(80),
    entry_node_id: id,
    nodes: z.array(NodeSchema).min(1).max(40),
    control_nodes: z.array(ControlNodeSchema).min(1).max(12),
    policy: PolicySchema,
    design_notes: z.string().trim().max(600).describe('簡潔な設計説明（推論全文は不要）'),
  })
  .strict()

/** Stored scenario: generated body + app-owned metadata (audio manifest is attached separately). */
export const ScenarioSchema = GeneratedScenarioSchema.extend({
  schema_version: z.literal(SCHEMA_VERSION),
  scenario_id: z.string(),
  version: z.number().int().min(1),
  locale: z.literal('ja-JP'),
  source_instruction: z.string().max(4000),
  source_facts: z.string().max(8000),
  constraints: z.array(z.string()).max(30),
}).strict()

export type Edge = z.infer<typeof EdgeSchema>
export type Node = z.infer<typeof NodeSchema>
export type ControlNode = z.infer<typeof ControlNodeSchema>
export type Policy = z.infer<typeof PolicySchema>
export type GeneratedScenario = z.infer<typeof GeneratedScenarioSchema>
export type Scenario = z.infer<typeof ScenarioSchema>

export const GENERATED_KEYS = ['title', 'entry_node_id', 'nodes', 'control_nodes', 'policy', 'design_notes'] as const

export function makeScenario(body: GeneratedScenario, meta: { scenario_id: string; version: number; source_instruction?: string; source_facts?: string; constraints?: string[] }): Scenario {
  return ScenarioSchema.parse({
    ...body,
    schema_version: SCHEMA_VERSION,
    locale: 'ja-JP',
    scenario_id: meta.scenario_id,
    version: meta.version,
    source_instruction: meta.source_instruction ?? '',
    source_facts: meta.source_facts ?? '',
    constraints: meta.constraints ?? [],
  })
}

export function bodyOf(s: Scenario): GeneratedScenario {
  const out: Record<string, unknown> = {}
  for (const k of GENERATED_KEYS) out[k] = s[k]
  return out as GeneratedScenario
}

export const findNode = (s: GeneratedScenario, nodeId: string): Node | undefined => s.nodes.find((n) => n.id === nodeId)
export const findControl = (s: GeneratedScenario, nodeId: string): ControlNode | undefined => s.control_nodes.find((c) => c.id === nodeId)
export const utteranceKey = (kind: 'node' | 'control', nodeId: string) => `${kind}:${nodeId}`

// ---------------------------------------------------------------------------
// JSON Schema for Claude
// ---------------------------------------------------------------------------

const UNSUPPORTED_KEYS = new Set([
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'default', 'title', '$schema',
])

/** Drop keywords structured outputs may not accept; the server re-validates with the full zod schema. */
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYS.has(k)) continue
      if (k === 'properties') {
        out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, sanitize(pv)]))
      } else {
        out[k] = sanitize(v)
      }
    }
    if (out.type === 'object') {
      out.additionalProperties = false
      out.required = Object.keys((out.properties as Record<string, unknown>) ?? {})
    }
    return out
  }
  return node
}

export function generationJsonSchema(sanitized = true): Record<string, unknown> {
  const raw = z.toJSONSchema(GeneratedScenarioSchema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>
  return (sanitized ? sanitize(raw) : raw) as Record<string, unknown>
}

/** Human-readable schema (with limits) included in the system prompt. */
export const fullJsonSchemaText = () => JSON.stringify(generationJsonSchema(false))
