import { defineEventHandler } from 'h3'
import { httpError, idParam, parseBody, versionOr404, versionView } from '../../../../lib/api'
import { services } from '../../../../lib/services'
import { EditBody, parseEdit } from '../edit'

export default defineEventHandler(async (event) => {
  const svc = services()
  const sid = idParam(event, 'sid')
  const body = await parseBody(event, EditBody)
  const base = versionOr404(svc, sid, body.base_version)
  const newVer = svc.store.nextVersion(sid)
  const [sc, v] = parseEdit(sid, base, body.scenario, newVer)
  if (!sc) throw httpError(422, { message: 'スキーマ不一致のため保存できません', validation: v })
  svc.store.insertVersion(sc, v, 'edit', base.version)
  return versionView(svc.store.getVersion(sid, newVer)!)
})
