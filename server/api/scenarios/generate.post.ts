import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { httpError, parseBody } from '../../lib/api'
import { defaultRequest } from '../../lib/scenarioGenerator'
import { CALL_DIRECTION_LABELS, CallDirection, DEFAULT_CALL_DIRECTION, IMPLEMENTED_CALL_DIRECTIONS } from '../../lib/scenarioSchema'
import { services } from '../../lib/services'

const Body = z.object({
  call_direction: CallDirection.default(DEFAULT_CALL_DIRECTION),
  instruction: z.string().min(1).max(4000),
  facts: z.string().max(8000).default(''),
  prohibitions: z.string().max(2000).default(''),
  first_utterance: z.string().max(300).default(''),
  max_depth: z.number().int().min(1).max(6).default(4),
  max_nodes: z.number().int().min(4).max(30).default(20),
  max_branches: z.number().int().min(1).max(6).default(4),
}).strict()

export default defineEventHandler(async (event) => {
  const svc = services()
  const body = await parseBody(event, Body)
  const s = svc.settings
  if (!IMPLEMENTED_CALL_DIRECTIONS.includes(body.call_direction)) throw httpError(400, `通話方向 ${body.call_direction}（${CALL_DIRECTION_LABELS[body.call_direction]}）は未実装です。MVP では inbound のみ使えます`)
  if (body.max_depth > s.maxDepthLimit || body.max_nodes > s.maxNodesLimit || body.max_branches > s.maxBranchesLimit) throw httpError(400, '上限値がサーバー設定を超えています')
  const jobId = svc.jobs.startGeneration(defaultRequest(body), body)
  return { job_id: jobId, mock: svc.generator.isMock }
})
