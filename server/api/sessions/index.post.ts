import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { httpError, limitsOfRow, parseBody, versionOr404 } from '../../lib/api'
import { manifestMissing, type Manifest } from '../../lib/audioStore'
import { runtimeFromUser } from '../../lib/realtimeSession'
import { READY } from '../../lib/scenarioStore'
import { validateScenario } from '../../lib/scenarioValidator'
import { services } from '../../lib/services'

const Body = z.object({
  scenario_id: z.string(),
  version: z.number().int().min(1),
  request_id: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  runtime: z.record(z.string(), z.unknown()).default({}),
}).strict()

export default defineEventHandler(async (event) => {
  const svc = services()
  const body = await parseBody(event, Body)
  const row = versionOr404(svc, body.scenario_id, body.version)
  if (row.status !== READY) throw httpError(409, `この版は READY ではありません（${row.status}）`)
  const sc = row.scenario
  if (!validateScenario(sc, limitsOfRow(row)).ok) throw httpError(409, 'グラフ検証に合格していません')
  const manifest = row.manifest as Manifest
  const missing = manifestMissing(manifest, svc.audio, sc)
  if (missing.length) throw httpError(409, { message: '未準備の音声があります', missing })
  const bad = Object.values(manifest.entries).filter((e) => !svc.audio.verifyContent(e.audio_id)).map((e) => e.utterance_key)
  if (bad.length) throw httpError(409, { message: '音声ファイルの内容が manifest と一致しません', missing: bad })
  let rs
  try {
    rs = runtimeFromUser(body.runtime)
  } catch (e: any) {
    throw httpError(400, e.message)
  }
  if (svc.settings.realtimeProvider === 'openai' && (!svc.settings.realtimeModel || !svc.settings.openaiApiKey)) throw httpError(400, 'REALTIME_MODEL / OPENAI_API_KEY が未設定です')
  const [sessionId, created] = svc.store.createSession(body.scenario_id, body.version, rs as any, body.request_id ?? null)
  const s = svc.store.getSession(sessionId)!
  if (!created && (s.scenario_id !== body.scenario_id || s.version !== body.version)) throw httpError(409, 'request_id が別の版で使用済みです')
  return {
    session_id: sessionId, created, status: s.status, scenario_id: body.scenario_id, version: body.version,
    entry_audio_id: manifest.entries[`node:${sc.entry_node_id}`]!.audio_id,
    manifest: Object.fromEntries(Object.entries(manifest.entries).map(([k, e]) => [k, { audio_id: e.audio_id, text: e.text }])),
    branches: Object.fromEntries(sc.nodes.map((n) => [n.id, n.edges.map((e) => e.id)])),
    mock_realtime: svc.settings.realtimeProvider !== 'openai',
    barge_in_enabled: rs.barge_in_enabled,
  }
})
