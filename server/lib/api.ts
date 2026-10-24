/** Shared helpers for the Nitro HTTP handlers. */
import { createError, getRouterParam, readBody, type H3Event } from 'h3'
import { z } from 'zod'
import { manifestSummary } from './audioStore'
import { STYLE_PRESETS, effectiveTtsFormat, effectiveTtsModels, effectiveTtsVoices } from './config'
import { ID_RE, type VersionRow } from './scenarioStore'
import { defaultLimits, type Limits } from './scenarioValidator'
import { voiceSettings, type VoiceSettings } from './tts'
import { services, type Services } from './services'

export const httpError = (statusCode: number, data: unknown) =>
  createError({ statusCode, statusMessage: typeof data === 'string' ? data : 'error', data })

export async function parseBody<T extends z.ZodType>(event: H3Event, schema: T): Promise<z.infer<T>> {
  const raw = await readBody(event)
  const r = schema.safeParse(raw)
  if (!r.success) throw httpError(422, { message: 'リクエストが不正です', issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  return r.data
}

export function idParam(event: H3Event, name: string, re: RegExp = ID_RE): string {
  const v = getRouterParam(event, name) ?? ''
  if (!re.test(v)) throw httpError(404, 'not found')
  return v
}

export function intParam(event: H3Event, name: string): number {
  const v = Number(getRouterParam(event, name))
  if (!Number.isInteger(v) || v < 1) throw httpError(404, 'not found')
  return v
}

export function versionOr404(svc: Services, sid: string, ver: number): VersionRow {
  const row = svc.store.getVersion(sid, ver)
  if (!row) throw httpError(404, 'version not found')
  return row
}

export const limitsOfRow = (row: VersionRow): Partial<Limits> => (row.validation?.limits as Limits) ?? defaultLimits()

export const VoiceBody = z.object({ provider: z.string(), model: z.string(), voice: z.string(), speed: z.number().default(1.0), style_id: z.string().default('polite') }).strict()

export function voiceFrom(svc: Services, body: z.infer<typeof VoiceBody>): VoiceSettings {
  const s = svc.settings
  if (body.provider !== s.ttsProvider) throw httpError(400, `provider は ${s.ttsProvider} のみ利用できます`)
  const models = effectiveTtsModels(s)
  const voices = effectiveTtsVoices(s)
  if (!models.length || !voices.length) throw httpError(400, 'TTS_MODEL / TTS_VOICE が未設定です。.env で利用可能な値を設定してください。')
  if (!models.includes(body.model)) throw httpError(400, '許可されていない TTS モデルです')
  if (!voices.includes(body.voice)) throw httpError(400, '許可されていない声です')
  if (!(s.speedMin <= body.speed && body.speed <= s.speedMax)) throw httpError(400, `速度は ${s.speedMin}〜${s.speedMax} で指定してください`)
  if (!(body.style_id in STYLE_PRESETS)) throw httpError(400, '許可されていない発話スタイルです')
  return voiceSettings({ provider: body.provider, model: body.model, voice: body.voice, format: effectiveTtsFormat(s), speed: Math.round(body.speed * 100) / 100, style_id: body.style_id, style_text: STYLE_PRESETS[body.style_id]! })
}

export function versionView(row: VersionRow) {
  const { manifest, ...rest } = row
  return { ...rest, is_mock_generated: row.generator === 'mock', audio_summary: manifestSummary(manifest as any) }
}

export const svc = services
