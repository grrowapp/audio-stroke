import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildManifest, cacheKey } from '../server/lib/audioStore'
import { JobManager } from '../server/lib/jobs'
import { BundledLexiconSource, JsonFileLexiconSource, applyReadings, configureLexicon, emptyLexicon, getLexicon, lexiconSummary, loadLexicon, misreadGuidance, scanMisreads, type Lexicon } from '../server/lib/lexicon'
import { MockScenarioGenerator, buildSystemPrompt, defaultRequest } from '../server/lib/scenarioGenerator'
import { GeneratedScenarioSchema, makeScenario } from '../server/lib/scenarioSchema'
import { READY } from '../server/lib/scenarioStore'
import { validateScenario } from '../server/lib/scenarioValidator'
import { MockSpeechSynthesizer } from '../server/lib/tts'
import { MOCK_VOICE, makeStores, sampleBody, tmpSettings } from './helpers'

const lex = (entries: { surface: string; reading: string; category?: 'reading' | 'misread' }[]): Lexicon =>
  loadLexicon([{ name: 'test', load: () => entries.map((e) => ({ category: 'misread' as const, ...e })) }])

describe('reading lexicon (読み替え辞書)', () => {
  it('bundled dictionary loads, is sorted longest-first and unique by surface', () => {
    const l = loadLexicon([new BundledLexiconSource()])
    expect(l.sources).toEqual(['bundled:ja'])
    expect(l.entries.map((e) => e.surface)).toContain('承っ')
    for (let i = 1; i < l.entries.length; i++) expect(l.entries[i - 1]!.surface.length).toBeGreaterThanOrEqual(l.entries[i]!.surface.length)
    expect(new Set(l.entries.map((e) => e.surface)).size).toBe(l.entries.length)
    expect(getLexicon().entries.length).toBeGreaterThan(0)
    expect(lexiconSummary(l)).toMatchObject({ schema_version: 1, entries: l.entries.length })
  })

  it('a user file merges over the bundled one (later source wins by surface) and is validated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-'))
    const p = path.join(dir, 'extra.json')
    fs.writeFileSync(p, JSON.stringify({ schema_version: 1, locale: 'ja-JP', entries: [{ surface: '承っ', reading: 'うけたまわっ（上書き）' }, { surface: '何卒', reading: 'なにとぞ', category: 'reading' }] }))
    const l = configureLexicon({ extraPath: p })
    expect(l.sources).toEqual(['bundled:ja', `file:${p}`])
    expect(l.entries.find((e) => e.surface === '承っ')).toMatchObject({ reading: 'うけたまわっ（上書き）', source: `file:${p}` })
    expect(l.entries.find((e) => e.surface === '何卒')).toMatchObject({ category: 'reading' })
    fs.writeFileSync(p, JSON.stringify({ schema_version: 2, locale: 'ja-JP', entries: [] }))
    expect(() => new JsonFileLexiconSource(p).load()).toThrow()
    configureLexicon() // restore bundled-only for the other tests
  })

  it('applies readings longest-first, every occurrence, without re-matching inside a replacement', () => {
    const l = lex([{ surface: '承', reading: 'うけたまわ' }, { surface: '承っ', reading: 'うけたまわっ' }, { surface: 'うけ', reading: 'ウケ' }])
    const r = applyReadings('ご用件を承っております。承ります。', l)
    expect(r.text).toBe('ご用件をうけたまわっております。うけたまわります。')
    expect(r.applied).toEqual([{ surface: '承っ', reading: 'うけたまわっ', count: 1 }, { surface: '承', reading: 'うけたまわ', count: 1 }])
    expect(applyReadings('変更なし', l)).toEqual({ text: '変更なし', applied: [] })
    expect(applyReadings('承っ', emptyLexicon()).text).toBe('承っ')
    expect(scanMisreads('承っております', l).map((e) => e.surface)).toEqual(['承っ', '承'])
  })

  it('misread guidance lists only misread entries and reaches the generation prompt', () => {
    const l = lex([{ surface: '承っ', reading: 'うけたまわっ' }, { surface: '何卒', reading: 'なにとぞ', category: 'reading' }])
    const g = misreadGuidance(l)
    expect(g).toContain('承っ→うけたまわっ'); expect(g).not.toContain('何卒')
    expect(misreadGuidance(emptyLexicon())).toBe('')
    expect(buildSystemPrompt(defaultRequest({ instruction: 'x' }), l)).toContain('承っ→うけたまわっ')
    expect(buildSystemPrompt(defaultRequest({ instruction: 'x' }))).toContain('ひらがなで書く')
  })

  it('validator warns the reviewer; manifest keys the cache by the rewritten text; the TTS receives it', async () => {
    const body = sampleBody()
    body.nodes[0].assistant_text = 'ご用件を承っております。'
    const sc = makeScenario(GeneratedScenarioSchema.parse(body), { scenario_id: 'scn_lexicon000000000', version: 1 })
    const v = validateScenario(sc)
    expect(v.ok).toBe(true)
    expect(v.warnings.find((w) => w.code === 'misread_risk')).toMatchObject({ path: `nodes.${sc.nodes[0]!.id}` })

    const s = tmpSettings()
    const { store, audio } = makeStores(s)
    const m = buildManifest(sc, MOCK_VOICE, audio)
    const e = m.entries[`node:${sc.nodes[0]!.id}`]!
    expect(e.text).toBe('ご用件を承っております。'); expect(e.tts_text).toBe('ご用件をうけたまわっております。')
    expect(e.audio_id).toBe(cacheKey(MOCK_VOICE, e.tts_text)); expect(e.audio_id).not.toBe(cacheKey(MOCK_VOICE, e.text))
    const untouched = Object.values(m.entries).find((x) => x.utterance_key !== e.utterance_key)!
    expect(untouched.tts_text).toBe(untouched.text)

    store.insertVersion(sc, v, 'mock', null)
    store.approveVersion(sc.scenario_id, 1, MOCK_VOICE, m)
    const synth = new MockSpeechSynthesizer({}, 0)
    const jm = new JobManager(s, store, audio, new MockScenarioGenerator(s, null, 0), synth)
    jm.sleepFn = async () => {}
    await jm.wait(jm.startAudio(sc, MOCK_VOICE, {}))
    expect(store.getVersion(sc.scenario_id, 1)!.status).toBe(READY)
    expect(synth.calls).toContain('ご用件をうけたまわっております。'); expect(synth.calls).not.toContain('ご用件を承っております。')
  })
})
