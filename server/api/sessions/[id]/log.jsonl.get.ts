import fs from 'node:fs'
import path from 'node:path'
import { defineEventHandler, sendStream, setResponseHeader } from 'h3'
import { httpError, idParam } from '../../../lib/api'
import { services } from '../../../lib/services'

export default defineEventHandler((event) => {
  const svc = services()
  const id = idParam(event, 'id')
  const p = path.join(svc.settings.dataDir, 'logs', `${id}.jsonl`)
  if (!fs.existsSync(p)) throw httpError(404, 'not found')
  setResponseHeader(event, 'Content-Type', 'application/x-ndjson')
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${id}.jsonl"`)
  return sendStream(event, fs.createReadStream(p))
})
