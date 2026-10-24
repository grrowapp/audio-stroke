import { defineEventHandler } from 'h3'
import { idParam, parseBody, versionOr404 } from '../../../lib/api'
import { services } from '../../../lib/services'
import { EditBody, parseEdit } from './edit'

export default defineEventHandler(async (event) => {
  const svc = services()
  const sid = idParam(event, 'sid')
  const body = await parseBody(event, EditBody)
  const base = versionOr404(svc, sid, body.base_version)
  const [, v] = parseEdit(sid, base, body.scenario, base.version)
  return v
})
