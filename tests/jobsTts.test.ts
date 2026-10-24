import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildManifest, cacheKey, manifestMissing } from '../server/lib/audioStore'
import { JobManager } from '../server/lib/jobs'
import { defaultRequest, MockScenarioGenerator } from '../server/lib/scenarioGenerator'
import { GeneratedScenarioSchema, makeScenario } from '../server/lib/scenarioSchema'
import { AUDIO_FAILED, INTERRUPTED, READY, REVIEW } from '../server/lib/scenarioStore'
import { validateScenario } from '../server/lib/scenarioValidator'
import { InvalidAudio, MockSpeechSynthesizer, mockToneWav, TTSTransientError, validateAudio, voiceSettings } from '../server/lib/tts'
import { MOCK_VOICE, makeStores, sampleBody, sampleScenario, sleep, tinyWav, tmpSettings } from './helpers'

function setup(over: Partial<ReturnType<typeof tmpSettings>> = {}) {
  const s = tmpSettings(over)
  const { store, audio } = makeStores(s)
  const synth = new MockSpeechSynthesizer({}, 0)
  const jm = new JobManager(s, store, audio, new MockScenarioGenerator(s, null, 0), synth)
  jm.sleepFn = async () => {}
  return { s, store, audio, synth, jm }
}
const insert = (store: any, sc: any) => store.insertVersion(sc, validateScenario(sc), 'mock', null)

describe('cache keys and audio validation', () => {
  it('cache key changes with every setting and text', () => {
    const base = cacheKey(MOCK_VOICE, 'こんにちは')
    expect(cacheKey(MOCK_VOICE, 'こんにちは')).toBe(base)
    const variants = [
      { voice: 'other' }, { speed: 1.1 }, { style_id: 'calm', style_text: 'ゆっくり' }, { model: 'm2' }, { format: 'mp3' as const }, { provider: 'openai' },
    ].map((o) => cacheKey(voiceSettings({ ...MOCK_VOICE, ...o }), 'こんにちは'))
    const keys = new Set([...variants, cacheKey(MOCK_VOICE, 'こんにちは。')])
    expect(keys.has(base)).toBe(false); expect(keys.size).toBe(7)
  })

  it('same text shares audio across nodes', () => {
    const { audio } = setup()
    const body = sampleBody()
    body.nodes[6].assistant_text = body.nodes[5].assistant_text
    const sc2 = makeScenario(GeneratedScenarioSchema.parse(body), { scenario_id: 'scn_0123456789abcdef', version: 2 })
    const m = buildManifest(sc2, MOCK_VOICE, audio)
    expect(m.entries['node:end_demo']!.audio_id).toBe(m.entries['node:end_support']!.audio_id)
  })

  it('rejects HTML / JSON / garbage; parses WAV and MP3 frames', () => {
    const enc = (s: string) => new TextEncoder().encode(s + ' '.repeat(100))
    expect(() => validateAudio(enc('<html><body>error</body></html>'), 'mp3')).toThrow(InvalidAudio)
    expect(() => validateAudio(enc('{"error": "x"}'), 'wav')).toThrow(InvalidAudio)
    const rnd = new Uint8Array(500); for (let i = 0; i < 500; i++) rnd[i] = (i * 7919) % 251
    expect(() => validateAudio(rnd, 'mp3')).toThrow(InvalidAudio)
    expect(validateAudio(tinyWav(300), 'wav')).toEqual(['audio/wav', 300])
    const hdr = [0xff, 0xfb, 0x90, 0x00] // MPEG1 L3 128 kbps 44.1 kHz → 417-byte frames
    const frame = new Uint8Array(417); frame.set(hdr)
    const mp3 = new Uint8Array(10 + 417 * 10); mp3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]); for (let i = 0; i < 10; i++) mp3.set(frame, 10 + i * 417)
    const [mime, dur] = validateAudio(mp3, 'mp3')
    expect(mime).toBe('audio/mpeg'); expect(dur).toBeGreaterThanOrEqual(250); expect(dur).toBeLessThanOrEqual(270)
    expect(validateAudio(mockToneWav('テスト'), 'wav')[1]).toBeGreaterThanOrEqual(600)
  })

  it('atomic write, partial cleanup, tamper detection', () => {
    const { s, audio } = setup()
    fs.writeFileSync(path.join(s.dataDir, 'audio', '.partial-abc.tmp'), 'half')
    expect(audio.cleanupPartials()).toBe(1)
    const aid = cacheKey(MOCK_VOICE, 'x')
    expect(audio.isReady(aid)).toBe(false)
    audio.write(aid, tinyWav(), 'audio/wav', 200, {})
    expect(audio.isReady(aid)).toBe(true); expect(audio.verifyContent(aid)).toBe(true)
    const p = audio.store.getAsset(aid)!.path
    const tampered = tinyWav(); tampered.set(new TextEncoder().encode('tampered'), 0)
    fs.writeFileSync(p, tampered)
    expect(audio.verifyContent(aid)).toBe(false)
    fs.unlinkSync(p)
    expect(audio.isReady(aid)).toBe(false)
  })
})

describe('jobs', () => {
  it('generation job creates a REVIEW version; cancel works', async () => {
    const { store, jm } = setup()
    const jid = jm.startGeneration(defaultRequest({ instruction: 'x' }), { instruction: 'x' })
    await jm.wait(jid)
    const j = store.getJob(jid)!
    expect(j.status).toBe('succeeded')
    const row = store.getVersion(j.result!.scenario_id, 1)!
    expect(row.status).toBe(REVIEW); expect(row.generator).toBe('mock'); expect(row.validation.ok).toBe(true)
    expect(row.validation.limits.max_nodes).toBe(20)

    const { s: s2, store: st2, audio: a2 } = setup()
    const jm2 = new JobManager(s2, st2, a2, new MockScenarioGenerator(s2, null, 5000), new MockSpeechSynthesizer({}, 0))
    const jid2 = jm2.startGeneration(defaultRequest({ instruction: 'x' }), {})
    await sleep(30)
    expect(jm2.cancel(jid2)).toBe(true)
    await jm2.wait(jid2)
    expect(st2.getJob(jid2)!.status).toBe('canceled')
  })

  it('audio job → READY; edits reuse cache; text/voice changes miss', async () => {
    const { store, audio, synth, jm } = setup()
    const sc = sampleScenario()
    insert(store, sc)
    store.approveVersion(sc.scenario_id, 1, MOCK_VOICE, buildManifest(sc, MOCK_VOICE, audio))
    const jid = jm.startAudio(sc, MOCK_VOICE, {})
    await jm.wait(jid)
    const row = store.getVersion(sc.scenario_id, 1)!
    expect(row.status, JSON.stringify(store.getJob(jid))).toBe(READY)
    expect(synth.calls).toHaveLength(13)
    expect(manifestMissing(row.manifest as any, audio, sc)).toEqual([])

    const body = sampleBody()
    body.nodes[0].edges[0].positive_examples.push('値段は？')
    const sc2 = makeScenario(GeneratedScenarioSchema.parse(body), { scenario_id: sc.scenario_id, version: 2 })
    insert(store, sc2)
    const m2 = buildManifest(sc2, MOCK_VOICE, audio)
    expect(Object.values(m2.entries).every((e) => e.cache_hit)).toBe(true)
    store.approveVersion(sc.scenario_id, 2, MOCK_VOICE, m2)
    await jm.wait(jm.startAudio(sc2, MOCK_VOICE, {}))
    expect(synth.calls).toHaveLength(13)
    expect(store.getVersion(sc.scenario_id, 2)!.status).toBe(READY)

    body.nodes[0].assistant_text = 'お電話ありがとうございます。ご用件をお聞かせください。'
    const sc3 = makeScenario(GeneratedScenarioSchema.parse(body), { scenario_id: sc.scenario_id, version: 3 })
    expect(Object.values(buildManifest(sc3, MOCK_VOICE, audio).entries).filter((e) => !e.cache_hit)).toHaveLength(1)
    const other = voiceSettings({ ...MOCK_VOICE, style_id: 'calm', style_text: 'ゆっくり' })
    expect(Object.values(buildManifest(sc3, other, audio).entries).some((e) => e.cache_hit)).toBe(false)
    expect(store.getVersion(sc.scenario_id, 1)!.scenario.nodes[0]!.assistant_text).toBe(sc.nodes[0]!.assistant_text)
  })

  it('partial failure → AUDIO_FAILED; retry only the failed ones; invalid audio retried never stored', async () => {
    const { s, store, audio, synth, jm } = setup()
    const sc = sampleScenario()
    insert(store, sc)
    const badText = sc.control_nodes.find((c) => c.id === 'end_request')!.assistant_text
    const garbage = sc.control_nodes.find((c) => c.id === 'limit_handoff')!.assistant_text
    synth.failTexts = { [badText]: [new Error('401 auth')] }
    synth.garbageTexts = new Set([garbage])
    store.approveVersion(sc.scenario_id, 1, MOCK_VOICE, buildManifest(sc, MOCK_VOICE, audio))
    await jm.wait(jm.startAudio(sc, MOCK_VOICE, {}))
    const row = store.getVersion(sc.scenario_id, 1)!
    expect(row.status).toBe(AUDIO_FAILED)
    const failed = Object.entries(row.manifest!.entries).filter(([, e]: any) => e.status === 'failed').map(([k]) => k).sort()
    expect(failed).toEqual(['control:end_request', 'control:limit_handoff'])
    expect(synth.calls.filter((t) => t === garbage)).toHaveLength(s.ttsMaxAttempts)
    expect(audio.isReady(row.manifest!.entries['control:limit_handoff'].audio_id)).toBe(false)
    expect(manifestMissing(row.manifest as any, audio, sc).sort()).toEqual(failed)

    synth.garbageTexts.clear()
    const before = synth.calls.length
    await jm.wait(jm.startAudio(sc, MOCK_VOICE, {}, true))
    expect(synth.calls.length - before).toBe(2)
    expect(store.getVersion(sc.scenario_id, 1)!.status).toBe(READY)
  })

  it('transient TTS errors are retried; cancel leaves nothing "generating"; limits enforced', async () => {
    const { store, audio, synth, jm } = setup()
    const sc = sampleScenario()
    insert(store, sc)
    const t = sc.nodes[0]!.assistant_text
    synth.failTexts = { [t]: [new TTSTransientError('429'), new TTSTransientError('503')] }
    store.approveVersion(sc.scenario_id, 1, MOCK_VOICE, buildManifest(sc, MOCK_VOICE, audio))
    await jm.wait(jm.startAudio(sc, MOCK_VOICE, {}))
    expect(store.getVersion(sc.scenario_id, 1)!.status).toBe(READY)
    expect(synth.calls.filter((x) => x === t)).toHaveLength(3)

    const { store: st2, audio: a2, jm: jm2, synth: sy2 } = setup()
    sy2.delayMs = 500
    insert(st2, sc)
    st2.approveVersion(sc.scenario_id, 1, MOCK_VOICE, buildManifest(sc, MOCK_VOICE, a2))
    const jid = jm2.startAudio(sc, MOCK_VOICE, {})
    await sleep(50)
    jm2.cancel(jid)
    await jm2.wait(jid)
    const row = st2.getVersion(sc.scenario_id, 1)!
    expect(st2.getJob(jid)!.status).toBe('canceled'); expect(row.status).toBe(AUDIO_FAILED)
    expect(manifestMissing(row.manifest as any, a2, sc).length).toBeGreaterThan(0)
    expect(Object.values(row.manifest!.entries).some((e: any) => e.status === 'generating')).toBe(false)

    const { s: s3, store: st3, jm: jm3 } = setup()
    s3.ttsMaxTotalChars = 50
    insert(st3, sc)
    const jid3 = jm3.startAudio(sc, MOCK_VOICE, {})
    await jm3.wait(jid3)
    expect(st3.getJob(jid3)!.error).toContain('too_many_chars')
  })

  it('restart recovery; immutable versions; single-use sessions', () => {
    const { store } = setup()
    const sc = sampleScenario()
    insert(store, sc)
    store.approveVersion(sc.scenario_id, 1, {}, { entries: {} })
    const jid = store.createJob('audio', {})
    store.updateJob(jid, { status: 'running' })
    const [sid] = store.createSession(sc.scenario_id, 1, {}, null)
    expect(store.recoverAfterRestart()).toEqual({ jobs: 1, versions: 1, sessions: 1 })
    expect(store.getJob(jid)!.status).toBe(INTERRUPTED)
    expect(store.getVersion(sc.scenario_id, 1)!.status).toBe(AUDIO_FAILED)
    expect(store.getSession(sid)!.status).toBe('aborted')

    const [a, created] = store.createSession(sc.scenario_id, 1, {}, 'req1')
    const [b, created2] = store.createSession(sc.scenario_id, 1, {}, 'req1')
    expect(created).toBe(true); expect(created2).toBe(false); expect(a).toBe(b)
    expect(store.claimSession(a)).toBe(true); expect(store.claimSession(a)).toBe(false)
    expect(store.nextVersion(sc.scenario_id)).toBe(2)
  })
})
