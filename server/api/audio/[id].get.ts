import fs from 'node:fs'
import { defineEventHandler, sendStream, setResponseHeader } from 'h3'
import { httpError, idParam } from '../../lib/api'
import { AUDIO_ID_RE } from '../../lib/audioStore'
import { services } from '../../lib/services'

export default defineEventHandler((event) => {
  const svc = services()
  const id = idParam(event, 'id', AUDIO_ID_RE)
  const a = svc.audio.readyAsset(id)
  if (!a) throw httpError(404, 'not found')
  setResponseHeader(event, 'Content-Type', a.mime)
  setResponseHeader(event, 'Content-Length', a.byte_length)
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600')
  return sendStream(event, fs.createReadStream(a.path))
})
