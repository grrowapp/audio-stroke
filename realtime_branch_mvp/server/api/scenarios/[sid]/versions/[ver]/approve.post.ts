import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { VoiceBody, httpError, idParam, intParam, limitsOfRow, parseBody, versionOr404, voiceFrom } from '../../../../../lib/api'
import { buildManifest, manifestSummary } from '../../../../../lib/audioStore'
import { AUDIO_PREPARING } from '../../../../../lib/scenarioStore'
import { validateScenario } from '../../../../../lib/scenarioValidator'
import { services } from '../../../../../lib/services'

const Body = z.object({ voice: VoiceBody, confirm_reviewed: z.boolean().default(false) }).strict()

export default defineEventHandler(async (event) => {
  const svc = services()
  const sid = idParam(event, 'sid')
  const ver = intParam(event, 'ver')
  const body = await parseBody(event, Body)
  const row = versionOr404(svc, sid, ver)
  if (!body.confirm_reviewed) throw httpError(400, '内容を確認したことの明示（confirm_reviewed）が必要です')
  if (row.status === AUDIO_PREPARING) throw httpError(409, 'この版は音声生成中です')
  const v = validateScenario(row.scenario, limitsOfRow(row))
  if (!v.ok) throw httpError(422, { message: '検証エラーがあるため承認できません', validation: v })
  const vs = voiceFrom(svc, body.voice)
  const manifest = buildManifest(row.scenario, vs, svc.audio)
  svc.store.approveVersion(sid, ver, vs as any, manifest as any)
  let jobId: string
  try {
    jobId = svc.jobs.startAudio(row.scenario, vs, limitsOfRow(row))
  } catch (e: any) {
    throw httpError(409, e.message)
  }
  return { job_id: jobId, summary: manifestSummary(manifest), mock: svc.synthesizer.isMock }
})
