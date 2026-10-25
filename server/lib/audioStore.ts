/**
 * Content-addressed audio cache + per-version manifests.
 * Cache key = sha256 over (cache spec version, provider, model, voice, format,
 * speed, style id + text, API settings, exact utterance text). Node ids are not
 * part of the key, so identical text+settings share one file.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { applyReadings, getLexicon, type Lexicon } from './lexicon'
import type { Scenario } from './scenarioSchema'
import type { AssetRow, Store } from './scenarioStore'
import { reachableUtterances } from './scenarioValidator'
import { CACHE_SPEC_VERSION, type VoiceSettings } from './tts'

export const AUDIO_ID_RE = /^[0-9a-f]{64}$/
const EXT: Record<string, string> = { 'audio/mpeg': '.mp3', 'audio/wav': '.wav' }

const stableJson = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))))

export function cacheKey(vs: VoiceSettings, text: string): string {
  const payload = {
    cache_spec: CACHE_SPEC_VERSION, provider: vs.provider, model: vs.model, voice: vs.voice, format: vs.format,
    speed: Math.round(vs.speed * 1000) / 1000, style_id: vs.style_id, style_text: vs.style_text, api: vs.api, text,
  }
  return createHash('sha256').update(stableJson(payload), 'utf-8').digest('hex')
}

export interface ManifestEntry {
  utterance_key: string
  kind: 'node' | 'control'
  /** Displayed / logged text (what the reviewer approved). */
  text: string
  /** Text actually sent to the TTS after the reading lexicon; equals `text` when nothing applied. The cache key is derived from this. */
  tts_text: string
  audio_id: string
  status: 'ready' | 'pending' | 'generating' | 'failed'
  cache_hit: boolean
  mime: string | null
  byte_length: number | null
  content_sha256: string | null
  duration_ms: number | null
  error: string | null
}

export interface Manifest {
  scenario_id: string
  version: number
  voice: VoiceSettings
  entries: Record<string, ManifestEntry>
}

export class AudioStore {
  constructor(public root: string, public store: Store) {
    fs.mkdirSync(root, { recursive: true })
  }

  private pathFor(audioId: string, mime: string) {
    if (!AUDIO_ID_RE.test(audioId)) throw new Error('bad audio id')
    return path.join(this.root, `${audioId}${EXT[mime]}`)
  }

  readyAsset(audioId: string): AssetRow | null {
    if (!AUDIO_ID_RE.test(audioId ?? '')) return null
    const a = this.store.getAsset(audioId)
    if (!a) return null
    try {
      if (path.resolve(path.dirname(a.path)) !== path.resolve(this.root)) return null
      const st = fs.statSync(a.path)
      if (!st.isFile() || st.size !== a.byte_length) return null
    } catch {
      return null
    }
    return a
  }

  isReady = (audioId: string) => this.readyAsset(audioId) !== null

  verifyContent(audioId: string): boolean {
    const a = this.readyAsset(audioId)
    if (!a) return false
    return createHash('sha256').update(fs.readFileSync(a.path)).digest('hex') === a.content_sha256
  }

  /** Atomic: write temp file in the same dir, fsync, rename, then publish DB row. */
  write(audioId: string, data: Uint8Array, mime: string, durationMs: number | null, settings: Record<string, unknown>) {
    const final = this.pathFor(audioId, mime)
    const tmp = path.join(this.root, `.partial-${randomBytes(6).toString('hex')}.tmp`)
    try {
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, data)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, final)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      throw e
    }
    const sha = createHash('sha256').update(data).digest('hex')
    this.store.putAsset(audioId, final, mime, data.length, sha, durationMs, settings)
    return { content_sha256: sha, byte_length: data.length, mime, duration_ms: durationMs }
  }

  cleanupPartials(): number {
    let n = 0
    for (const f of fs.readdirSync(this.root)) {
      if (f.startsWith('.partial-')) {
        try { fs.unlinkSync(path.join(this.root, f)); n++ } catch { /* ignore */ }
      }
    }
    return n
  }
}

export function buildManifest(scenario: Scenario, vs: VoiceSettings, audio: AudioStore, lexicon: Lexicon = getLexicon()): Manifest {
  const entries: Record<string, ManifestEntry> = {}
  for (const { key, kind, text } of reachableUtterances(scenario)) {
    const ttsText = applyReadings(text, lexicon).text
    const aid = cacheKey(vs, ttsText)
    const a = audio.readyAsset(aid)
    entries[key] = {
      utterance_key: key, kind, text, tts_text: ttsText, audio_id: aid, status: a ? 'ready' : 'pending', cache_hit: !!a,
      mime: a?.mime ?? null, byte_length: a?.byte_length ?? null, content_sha256: a?.content_sha256 ?? null,
      duration_ms: a?.duration_ms ?? null, error: null,
    }
  }
  return { scenario_id: scenario.scenario_id, version: scenario.version, voice: vs, entries }
}

export function manifestSummary(m: Manifest | null | undefined) {
  if (!m) return { total: 0, ready: 0, failed: 0, pending: 0, cache_hits: 0, chars: 0, chars_to_generate: 0 }
  const es = Object.values(m.entries)
  return {
    total: es.length,
    ready: es.filter((e) => e.status === 'ready').length,
    failed: es.filter((e) => e.status === 'failed').length,
    pending: es.filter((e) => e.status === 'pending' || e.status === 'generating').length,
    cache_hits: es.filter((e) => e.cache_hit).length,
    chars: es.reduce((a, e) => a + e.text.length, 0),
    chars_to_generate: es.filter((e) => !e.cache_hit).reduce((a, e) => a + e.text.length, 0),
  }
}

/** Keys that are not playable right now. Empty == every required audio is ready. */
export function manifestMissing(m: Manifest | null | undefined, audio: AudioStore, scenario: Scenario): string[] {
  if (!m) return ['<no manifest>']
  const required = reachableUtterances(scenario)
  const missing: string[] = []
  for (const { key, text } of required.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const e = m.entries[key]
    if (!e || e.status !== 'ready' || !audio.isReady(e.audio_id) || e.text !== text) missing.push(key)
  }
  return missing
}
