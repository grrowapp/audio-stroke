import { defineEventHandler } from 'h3'
import { idParam, intParam, versionOr404 } from '../../../../../lib/api'
import { manifestSummary, type Manifest } from '../../../../../lib/audioStore'
import { services } from '../../../../../lib/services'

export default defineEventHandler((event) => {
  const row = versionOr404(services(), idParam(event, 'sid'), intParam(event, 'ver'))
  const m = row.manifest as Manifest | null
  if (!m) return { entries: {}, summary: manifestSummary(null), status: row.status }
  return { entries: m.entries, voice: m.voice, summary: manifestSummary(m), status: row.status, mock_audio: m.voice.provider === 'mock' }
})
