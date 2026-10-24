/** The out-of-process adapter drives a fake "native" core over stdio using docs/CORE_PROTOCOL.md. */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../server/core/factory'
import { FrameParser, SubprocessEngine, frame } from '../server/core/subprocessEngine'
import { defaultRuntime } from '../server/core/runtime'
import { SessionMetrics } from '../server/lib/metrics'
import { ROOT, makeStores, readyManifest, sampleScenario, sleep, tmpSettings } from './helpers'

const FAKE = path.join(ROOT, 'tests/fixtures/fakeCore.mjs')

describe('subprocess engine adapter', () => {
  it('frames round-trip through the incremental parser, including split chunks', () => {
    const a = frame(0x00, new TextEncoder().encode('{"a":1}'))
    const b = frame(0x01, new Uint8Array([1, 2, 3, 4]))
    const all = new Uint8Array(a.length + b.length)
    all.set(a); all.set(b, a.length)
    const p = new FrameParser()
    const first = p.push(all.slice(0, 7))
    expect(first).toHaveLength(0)
    const rest = p.push(all.slice(7))
    expect(rest).toHaveLength(2)
    expect(rest[0]!.tag).toBe(0x00); expect(new TextDecoder().decode(rest[0]!.payload)).toBe('{"a":1}')
    expect(rest[1]!.tag).toBe(0x01); expect([...rest[1]!.payload]).toEqual([1, 2, 3, 4])
  })

  it('drives a fake core: init → play → ack → listening → stop → finished, with audio frames and metrics forwarded', async () => {
    const s = tmpSettings()
    const { audio } = makeStores(s)
    const scenario = sampleScenario()
    const manifest = readyManifest(scenario, audio)
    const browser: any[] = []
    const metrics = new SessionMetrics(path.join(s.dataDir, 'logs'), 'sess_sub')
    const eng = new SubprocessEngine({
      command: process.execPath, args: [FAKE], sessionId: 'sess_0123456789abcdef', scenario, manifest, settings: defaultRuntime({ barge_in_enabled: true }),
      sendBrowser: (m) => { browser.push(m) }, metrics,
      realtime: { url: 'wss://example.invalid', model: 'm', apiKey: '', mock: true, previewAudioMode: 'inline' },
      audioPaths: Object.fromEntries(Object.values(manifest.entries).map((e) => [e.audio_id, audio.readyAsset(e.audio_id)!.path])),
    })
    const run = eng.run()
    const until = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await sleep(10); expect(f()).toBe(true) }
    await until(() => browser.some((m) => m.type === 'play'))
    const play = browser.find((m) => m.type === 'play')
    expect(play.utterance_key).toBe('node:select_need'); expect(play.interruptible).toBe(true)
    expect(eng.phase).toBe('PLAYING')
    for (let i = 0; i < 7; i++) eng.pushBrowserAudio(new Uint8Array(960))
    eng.pushBrowserJson({ type: 'playback_started', playback_id: play.playback_id })
    eng.pushBrowserJson({ type: 'playback_ended', playback_id: play.playback_id })
    await until(() => eng.phase === 'LISTENING')
    eng.pushBrowserJson({ type: 'stop' })
    const reason = await run
    expect(reason).toBe('user_stop'); expect(eng.phase).toBe('STOPPED'); expect(eng.done).toBe(true)
    const fin = browser.find((m) => m.type === 'finished')
    expect(fin.message).toBe('stopped after 7 frames')
    expect(metrics.counters.audio_cache_hit).toBe(1)
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(metrics.path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.some((l) => l.event === 'turn_opened' && l.has_audio_path === true)).toBe(true)
    expect(lines.at(-1)!.event).toBe('summary')
  })

  it('a core that dies without `exit` ends the session as ERROR', async () => {
    const s = tmpSettings()
    const { audio } = makeStores(s)
    const scenario = sampleScenario()
    const manifest = readyManifest(scenario, audio)
    const eng = new SubprocessEngine({
      command: process.execPath, args: ['-e', 'process.exit(3)'], sessionId: 'x', scenario, manifest, settings: defaultRuntime(),
      sendBrowser: () => {}, metrics: new SessionMetrics(path.join(s.dataDir, 'logs'), 'sess_die'),
      realtime: { url: '', model: '', apiKey: '', mock: true, previewAudioMode: 'inline' }, audioPaths: {},
    })
    const reason = await eng.run()
    expect(reason).toBe('core_exit_3'); expect(eng.phase).toBe('ERROR')
  })

  it('factory selects the implementation from ENGINE_IMPL', () => {
    const s = tmpSettings()
    const { audio } = makeStores(s)
    const scenario = sampleScenario()
    const manifest = readyManifest(scenario, audio)
    const args = { sessionId: 'x', scenario, manifest, settings: defaultRuntime(), sendBrowser: () => {}, metrics: new SessionMetrics(path.join(s.dataDir, 'logs'), 'sess_f'), audio, transportFactory: () => { throw new Error('not used') }, app: s }
    process.env.ENGINE_IMPL = 'subprocess'
    delete process.env.ENGINE_CMD
    expect(() => createEngine(args)).toThrow(/ENGINE_CMD/)
    process.env.ENGINE_CMD = process.execPath
    expect(createEngine(args)).toBeInstanceOf(SubprocessEngine)
    delete process.env.ENGINE_IMPL
    delete process.env.ENGINE_CMD
  })
})
