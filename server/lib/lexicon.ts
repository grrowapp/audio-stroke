/**
 * Japanese reading lexicon (読み替え辞書) and misread-kanji rules — core feature.
 *
 * One entry = a surface form (漢字表記) and the reading (かな) the TTS must
 * speak. The same data drives three behaviours:
 *   1. TTS text: `applyReadings` rewrites only the string sent to the
 *      synthesizer (the displayed/logged text is untouched; the audio cache
 *      key is computed from the rewritten text so dictionary changes
 *      regenerate audio).
 *   2. Generation: `misreadGuidance` tells Claude to write these words in kana.
 *   3. Review: `scanMisreads` lets the validator warn the reviewer.
 *
 * Sources are pluggable (`LexiconSource`). Today: the bundled JSON plus an
 * optional user file (LEXICON_PATH). Planned: a DB-backed source bootstrapped
 * from the bundled JSON, then a RAG-style store for context-aware readings —
 * see docs/LEXICON.md for the decided roadmap.
 */
import fs from 'node:fs'
import { z } from 'zod'
import bundled from '../lexicon/ja.json'

export const LEXICON_SCHEMA_VERSION = 1

export const LexiconEntrySchema = z.object({
  /** 漢字を含む表記。活用形ごとに 1 件（例: 承っ / 承り / 承る） */
  surface: z.string().trim().min(1).max(40),
  /** TTS に読ませる表記（ひらがな推奨） */
  reading: z.string().trim().min(1).max(80),
  /** reading = 読みの指定のみ, misread = 誤読が確認された語（生成時にかな書きを指示） */
  category: z.enum(['reading', 'misread']).default('misread'),
  note: z.string().max(300).optional(),
}).strict()

export const LexiconFileSchema = z.object({
  schema_version: z.literal(LEXICON_SCHEMA_VERSION),
  locale: z.literal('ja-JP'),
  description: z.string().optional(),
  entries: z.array(LexiconEntrySchema).max(5000),
}).strict()

export type LexiconEntry = z.infer<typeof LexiconEntrySchema> & { source: string }

export interface Lexicon {
  entries: LexiconEntry[] // longest surface first, unique by surface (later sources override earlier ones)
  sources: string[]
}

export interface LexiconSource {
  name: string
  load(): z.infer<typeof LexiconEntrySchema>[]
}

/** The dictionary shipped with the code base (server/lexicon/ja.json). */
export class BundledLexiconSource implements LexiconSource {
  name = 'bundled:ja'
  load() { return LexiconFileSchema.parse(bundled).entries }
}

/** Optional operator additions: a JSON file in the same format (LEXICON_PATH). */
export class JsonFileLexiconSource implements LexiconSource {
  name: string
  constructor(public path: string) { this.name = `file:${path}` }
  load() {
    const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8'))
    return LexiconFileSchema.parse(raw).entries
  }
}

export function loadLexicon(sources: LexiconSource[]): Lexicon {
  const bySurface = new Map<string, LexiconEntry>()
  for (const src of sources) for (const e of src.load()) bySurface.set(e.surface, { ...e, source: src.name })
  const entries = [...bySurface.values()].sort((a, b) => b.surface.length - a.surface.length || a.surface.localeCompare(b.surface, 'ja'))
  return { entries, sources: sources.map((s) => s.name) }
}

export const emptyLexicon = (): Lexicon => ({ entries: [], sources: [] })

// ---------------------------------------------------------------------------
// Process-wide active lexicon (configured once at startup; tests pass explicit ones)
// ---------------------------------------------------------------------------

let active: Lexicon | null = null

export function configureLexicon(opts: { extraPath?: string } = {}): Lexicon {
  const sources: LexiconSource[] = [new BundledLexiconSource()]
  if (opts.extraPath) sources.push(new JsonFileLexiconSource(opts.extraPath))
  active = loadLexicon(sources)
  return active
}

export function getLexicon(): Lexicon {
  return active ?? configureLexicon()
}

// ---------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------

export interface ReadingApplication { surface: string; reading: string; count: number }

/** Rewrite `text` for the TTS: longest surface first, each occurrence once, no re-matching inside replacements. */
export function applyReadings(text: string, lexicon: Lexicon = getLexicon()): { text: string; applied: ReadingApplication[] } {
  if (!lexicon.entries.length || !text) return { text, applied: [] }
  const applied: ReadingApplication[] = []
  // Tokenise into protected segments so an inserted reading is never matched by a later (shorter) surface.
  let segments: { s: string; locked: boolean }[] = [{ s: text, locked: false }]
  for (const e of lexicon.entries) {
    let count = 0
    const next: typeof segments = []
    for (const seg of segments) {
      if (seg.locked || !seg.s.includes(e.surface)) { next.push(seg); continue }
      const parts = seg.s.split(e.surface)
      count += parts.length - 1
      parts.forEach((p, i) => {
        if (p) next.push({ s: p, locked: false })
        if (i < parts.length - 1) next.push({ s: e.reading, locked: true })
      })
    }
    segments = next
    if (count) applied.push({ surface: e.surface, reading: e.reading, count })
  }
  return { text: segments.map((x) => x.s).join(''), applied }
}

/** Surfaces present in `text` (for reviewer warnings). */
export function scanMisreads(text: string, lexicon: Lexicon = getLexicon()): LexiconEntry[] {
  return lexicon.entries.filter((e) => text.includes(e.surface))
}

/** Prompt fragment for Claude: write known-misread words in kana. Empty string when nothing to say. */
export function misreadGuidance(lexicon: Lexicon = getLexicon(), max = 40): string {
  const items = lexicon.entries.filter((e) => e.category === 'misread').slice(0, max)
  if (!items.length) return ''
  const list = items.map((e) => `${e.surface}→${e.reading}`).join('、')
  return `- 音声合成が誤読しやすい語は発話文の中でひらがなで書く（例: ${list}）。`
}

export function lexiconSummary(lexicon: Lexicon = getLexicon()) {
  return { schema_version: LEXICON_SCHEMA_VERSION, entries: lexicon.entries.length, sources: lexicon.sources }
}
