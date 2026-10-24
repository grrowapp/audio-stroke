import { defineEventHandler } from 'h3'
import { httpError, idParam, intParam, limitsOfRow, versionOr404 } from '../../../../../../lib/api'
import { AUDIO_FAILED, AUDIO_PREPARING, READY } from '../../../../../../lib/scenarioStore'
import { services } from '../../../../../../lib/services'
import type { VoiceSettings } from '../../../../../../lib/tts'

export default defineEventHandler((event) => {
  const svc = services()
  const sid = idParam(event, 'sid')
  const ver = intParam(event, 'ver')
  const row = versionOr404(svc, sid, ver)
  if (!(row.status === AUDIO_FAILED || row.status === READY) || !row.voice) throw httpError(409, '再試行できる状態ではありません（承認済みで失敗した版のみ）')
  svc.store.setVersionStatus(sid, ver, AUDIO_PREPARING)
  try {
    return { job_id: svc.jobs.startAudio(row.scenario, row.voice as VoiceSettings, limitsOfRow(row), true) }
  } catch (e: any) {
    throw httpError(409, e.message)
  }
})
