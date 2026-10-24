// shared by validate.post.ts and versions/index.post.ts
import { z } from 'zod'
import { limitsOfRow } from '../../../lib/api'
import { GeneratedScenarioSchema, makeScenario, type Scenario } from '../../../lib/scenarioSchema'
import type { VersionRow } from '../../../lib/scenarioStore'
import { defaultLimits, validateScenario, type ValidationResult } from '../../../lib/scenarioValidator'

export const EditBody = z.object({ base_version: z.number().int().min(1), scenario: z.record(z.string(), z.unknown()) }).strict()

export function parseEdit(sid: string, base: VersionRow, data: unknown, newVersion: number): [Scenario | null, ValidationResult] {
  const r = GeneratedScenarioSchema.safeParse(data)
  if (!r.success) {
    return [null, { ok: false, errors: r.error.issues.map((i) => ({ code: 'schema', message: `${i.path.join('.')}: ${i.message}`, path: i.path.join('.') })), warnings: [], stats: {} }]
  }
  const sc = makeScenario(r.data, { scenario_id: sid, version: newVersion, source_instruction: base.scenario.source_instruction, source_facts: base.scenario.source_facts, constraints: base.scenario.constraints })
  const v = validateScenario(sc, limitsOfRow(base))
  v.limits = defaultLimits(limitsOfRow(base))
  return [sc, v]
}
