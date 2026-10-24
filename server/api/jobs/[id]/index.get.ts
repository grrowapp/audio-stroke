import { defineEventHandler } from 'h3'
import { httpError, idParam } from '../../../lib/api'
import { manifestSummary } from '../../../lib/audioStore'
import { services } from '../../../lib/services'

export default defineEventHandler((event) => {
  const svc = services()
  const id = idParam(event, 'id')
  const j = svc.store.getJob(id)
  if (!j) throw httpError(404, 'job not found')
  if (j.result) delete j.result.trace
  const out: Record<string, unknown> = { ...j }
  if (j.kind === 'audio') {
    const row = svc.store.getVersion(j.params.scenario_id, j.params.version)
    if (row) {
      out.audio_summary = manifestSummary(row.manifest as any)
      out.version_status = row.status
    }
  }
  return out
})
