/**
 * Optional, PAID evaluation of Realtime branch classification on real audio.
 *   npm run eval:realtime -- --i-understand-this-costs-money [--only tts|human|noise]
 * tts cases are synthesized with the configured OpenAI TTS (response_format=pcm, assumed 24 kHz/16-bit/mono —
 * verify against the current docs); human cases are read from fixtures/human/<case_id>.wav (24 kHz mono PCM16).
 * Synthetic and human results are reported separately; synthetic accuracy does not imply microphone accuracy.
 * The same out-of-band response.create + select_branch request as the app's final decision is used (manual commit, VAD off).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDotenv, loadSettings } from '../lib/config'
import { OpenAIRealtimeTransport, type RtEvent } from '../lib/realtimeSession'
import * as router from '../lib/router'
import { GeneratedScenarioSchema, findNode, makeScenario } from '../lib/scenarioSchema'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (!args.includes('--i-understand-this-costs-money')) {
  console.error('有料API（TTS と Realtime）を呼びます。--i-understand-this-costs-money を付けて実行してください。')
  process.exit(2)
}
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
loadDotenv(path.join(ROOT, '.env'))
const s = loadSettings()
for (const k of ['openaiApiKey', 'realtimeModel', 'ttsModel', 'ttsVoice'] as const) if (!s[k]) { console.error(`${k} が未設定です`); process.exit(2) }

const sc = makeScenario(GeneratedScenarioSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/sample_scenario.json'), 'utf-8'))), { scenario_id: 'scn_eval000000000000', version: 1 })
const cases: any[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/eval_ja.json'), 'utf-8')).cases

async function ttsPcm(text: string): Promise<Uint8Array> {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey: s.openaiApiKey })
  const r = await client.audio.speech.create({ model: s.ttsModel, voice: s.ttsVoice as any, input: text, response_format: 'pcm' })
  return new Uint8Array(await r.arrayBuffer())
}

function readWav(p: string): Uint8Array {
  const b = fs.readFileSync(p)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(24, true) !== 24000 || dv.getUint16(22, true) !== 1 || dv.getUint16(34, true) !== 16) throw new Error(`${p}: 24kHz mono PCM16 が必要です`)
  return new Uint8Array(b.buffer, b.byteOffset + 44, b.byteLength - 44)
}

async function waitFor(t: OpenAIRealtimeTransport, pred: (e: RtEvent) => boolean, timeoutMs = 15000): Promise<RtEvent> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const ev = await Promise.race([t.recv(), new Promise<RtEvent>((_, rej) => setTimeout(() => rej(new Error('timeout')), end - Date.now()))])
    if (ev.type === 'error') console.error('  realtime error:', ev.error?.message)
    if (pred(ev)) return ev
  }
  throw new Error('timeout')
}

async function classify(t: OpenAIRealtimeTransport, nodeId: string, pcm: Uint8Array, caseId: string) {
  await t.send({ type: 'input_audio_buffer.clear' })
  for (let i = 0; i < pcm.length; i += 4800) await t.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm.subarray(i, i + 4800)).toString('base64') })
  await t.send({ type: 'input_audio_buffer.commit' })
  const committed = await waitFor(t, (e) => e.type === 'input_audio_buffer.committed')
  const iid = committed.item_id
  await waitFor(t, (e) => e.type === 'conversation.item.done' && e.item?.id === iid)
  const node = findNode(sc, nodeId)!
  const md = { phase: 'final', request_key: caseId.slice(0, 60) }
  const ev = router.responseEvent({ scenario: sc, node, inputItems: [{ type: 'item_reference', id: iid }], metadata: md, lastPromptText: node.assistant_text, history: [], phase: 'final', eventId: 'evt_' + caseId.slice(0, 40) })
  const t0 = performance.now()
  await t.send(ev)
  const done = await waitFor(t, (e) => e.type === 'response.done' && e.response?.metadata?.request_key === md.request_key)
  const ms = performance.now() - t0
  const parsed = router.parseResponse(done.response, router.allowedBranchIds(node))
  await t.send({ type: 'conversation.item.delete', item_id: iid })
  return { got: parsed.ok ? parsed.branchId! : `INVALID:${parsed.error}`, ms, usage: JSON.stringify(done.response.usage ?? {}) }
}

const t = new OpenAIRealtimeTransport(s.realtimeUrl, s.realtimeModel, s.openaiApiKey)
await t.connect()
await t.send({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'], instructions: router.SESSION_INSTRUCTIONS, audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null } } } })
await waitFor(t, (e) => e.type === 'session.updated')
const results: any[] = []
for (const c of cases) {
  const sources: [string, Uint8Array][] = []
  if (c.audio === 'tts' && (!only || only === 'tts')) {
    let pcm = await ttsPcm(c.utterance)
    if (c.pre_silence_ms) { const sil = new Uint8Array(48 * c.pre_silence_ms); const j = new Uint8Array(sil.length + pcm.length); j.set(sil); j.set(pcm, sil.length); pcm = j }
    sources.push(['synthetic_tts', pcm])
  }
  if (c.audio === 'noise' && (!only || only === 'noise')) {
    const n = new Uint8Array(48000); let seed = 1
    for (let i = 0; i < n.length; i += 2) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const v = (seed % 6000) - 3000; n[i] = v & 0xff; n[i + 1] = (v >> 8) & 0xff }
    sources.push(['noise', n])
  }
  const hp = path.join(ROOT, 'fixtures/human', `${c.id}.wav`)
  if (fs.existsSync(hp) && (!only || only === 'human')) sources.push(['human_mic', readWav(hp)])
  if (c.audio === 'silence') { console.log(`- ${c.id}: 無音は no-input タイマーの対象（分類しない）`); continue }
  for (const [src, pcm] of sources) {
    const r = await classify(t, c.node_id, pcm, c.id)
    const ok = c.expected.includes(r.got)
    results.push({ id: c.id, source: src, expected: c.expected, got: r.got, ok, ms: Math.round(r.ms) })
    console.log(`${ok ? 'OK ' : 'NG '} ${src.padEnd(13)} ${c.id.padEnd(18)} expected=${JSON.stringify(c.expected)} got=${r.got} ${r.ms.toFixed(0)}ms usage=${r.usage}`)
  }
}
await t.close()
for (const src of [...new Set(results.map((r) => r.source))].sort()) {
  const rs = results.filter((r) => r.source === src)
  console.log(`[${src}] accuracy ${rs.filter((r) => r.ok).length}/${rs.length}`)
}
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
const out = path.join(ROOT, 'data', `eval_${Date.now()}.json`)
fs.writeFileSync(out, JSON.stringify(results, null, 1))
console.log('saved', out)
