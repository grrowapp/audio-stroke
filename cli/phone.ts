/**
 * Terminal "phone": a conversation client that speaks the same WebSocket contract as the browser
 * (docs/API_EVENTS.md) but takes the microphone and speaker from SoX (`rec` / `play`), so it runs
 * against any server over plain http — no secure context, no browser.
 *
 *   npm run phone -- --server http://192.168.1.206:8000 --list
 *   npm run phone -- --server http://192.168.1.206:8000 --scenario <id> --backend stt_judge
 *
 * Keys while connected: s = skip playback (answer now), q = stop. Half-duplex by default; there is
 * no echo cancellation here, so use a headset if you enable --barge-in.
 * Requires `brew install sox`. The server must allow this client's Host/Origin (EXTRA_ALLOWED_HOSTS).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'
import WebSocket from 'ws'

const AUDIO_TAG = 0x01
const SAMPLE_RATE = 24000
const FRAME_BYTES = (SAMPLE_RATE / 50) * 2 // 20 ms of PCM16 mono

interface Args { server: string; scenario?: string; version?: number; backend?: string; runtime: Record<string, unknown>; list: boolean; json: boolean; log?: string; auth?: string; help: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { server: 'http://127.0.0.1:8000', runtime: {}, list: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!
    const v = () => argv[++i] ?? ''
    if (k === '--server') a.server = v().replace(/\/$/, '')
    else if (k === '--scenario') a.scenario = v()
    else if (k === '--version') a.version = Number(v())
    else if (k === '--backend') a.backend = v()
    else if (k === '--runtime') a.runtime = { ...a.runtime, ...JSON.parse(v()) }
    else if (k === '--barge-in') a.runtime.barge_in_enabled = true
    else if (k === '--no-preview') a.runtime.preview_enabled = false
    else if (k === '--log') a.log = v()
    else if (k === '--auth') a.auth = v()
    else if (k === '--list') a.list = true
    else if (k === '--json') a.json = true
    else if (k === '-h' || k === '--help') a.help = true
    else throw new Error(`unknown argument: ${k}`)
  }
  if (a.backend) a.runtime.decision_backend = a.backend
  return a
}

const USAGE = `usage: npm run phone -- [--server URL] (--list [--json] | --scenario ID [--version N]) [--backend realtime|stt_judge|mock]
                        [--runtime '{"silence_duration_ms":600}'] [--barge-in] [--no-preview] [--log out.jsonl] [--auth user:pass]`

const ts = () => new Date().toISOString().slice(11, 23)
const say = (s: string) => process.stdout.write(`${ts()} ${s}\n`)

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (a.help) { console.log(USAGE); return }
  const origin = new URL(a.server).origin
  const headers: Record<string, string> = { Origin: origin }
  if (a.auth) headers.Authorization = 'Basic ' + Buffer.from(a.auth).toString('base64')
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(a.server + p, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    if (!r.ok) throw new Error(`${method} ${p} → HTTP ${r.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }

  const cfg = await api('GET', '/api/config')
  const scenarios: any[] = (await api('GET', '/api/scenarios')).scenarios
  if (a.list || !a.scenario) {
    if (a.json) {
      const out = { server: a.server, default: cfg.decision_backends.default, backends: cfg.decision_backends.options, scenarios: [] as unknown[] }
      for (const s of scenarios) {
        const versions: any[] = (await api('GET', `/api/scenarios/${s.scenario_id}/versions`)).versions
        const ready = versions.filter((v) => v.status === 'READY').map((v) => Number(v.version))
        let title = '', first = ''
        if (ready.length) {
          const row = await api('GET', `/api/scenarios/${s.scenario_id}/versions/${Math.max(...ready)}`)
          title = row.scenario?.title ?? ''
          first = row.scenario?.nodes?.find((n: any) => n.id === row.scenario.entry_node_id)?.assistant_text ?? ''
        }
        out.scenarios.push({ scenario_id: s.scenario_id, latest: s.latest, ready, title, first_utterance: first })
      }
      console.log(JSON.stringify(out))
      return
    }
    console.log(`server ${a.server}: decision default=${cfg.decision_backends.default}`)
    for (const o of cfg.decision_backends.options) console.log(`  backend ${o.id.padEnd(10)} ${o.detail}${o.missing.length ? '  (missing: ' + o.missing.join(', ') + ')' : ''}`)
    for (const s of scenarios) {
      const versions: any[] = (await api('GET', `/api/scenarios/${s.scenario_id}/versions`)).versions
      const ready = versions.filter((v) => v.status === 'READY').map((v) => Number(v.version))
      const row = ready.length ? await api('GET', `/api/scenarios/${s.scenario_id}/versions/${Math.max(...ready)}`) : null
      console.log(`  scenario ${s.scenario_id}  latest=v${s.latest}  READY: ${ready.map((v) => 'v' + v).join(' ') || '-'}  ${row?.scenario?.title ?? ''}`)
    }
    if (!a.scenario) console.log(USAGE)
    return
  }

  for (const bin of ['rec', 'play']) {
    if (spawnSync('which', [bin]).status !== 0) throw new Error(`${bin} not found: brew install sox`)
  }
  const versions: any[] = (await api('GET', `/api/scenarios/${a.scenario}/versions`)).versions
  const ready = versions.filter((v) => v.status === 'READY').map((v) => Number(v.version))
  const version = a.version ?? Math.max(...ready)
  if (!ready.includes(version)) throw new Error(`no READY version (${a.scenario}: ${ready.join(', ') || 'none'})`)

  const sess = await api('POST', '/api/sessions', { scenario_id: a.scenario, version, request_id: 'cli' + Date.now().toString(36), runtime: a.runtime })
  say(`session ${sess.session_id} v${sess.version} backend=${sess.backend}${sess.mock_realtime ? ' (MOCK: audio not understood)' : ''} barge_in=${sess.barge_in_enabled}`)
  const manifest: Record<string, { audio_id: string; text: string }> = sess.manifest
  const mock = !!sess.mock_realtime

  // ---- audio cache (fetch on demand + prefetch hints)
  const cache = new Map<string, Promise<Buffer>>()
  const fetchAudio = (id: string) => {
    if (!cache.has(id)) {
      const p = fetch(`${a.server}/api/audio/${id}`, { headers }).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()) })
      p.catch(() => cache.delete(id))
      cache.set(id, p)
    }
    return cache.get(id)!
  }
  await fetchAudio(sess.entry_audio_id)

  // ---- WebSocket
  const wsUrl = `${a.server.replace(/^http/, 'ws')}/ws?session_id=${encodeURIComponent(sess.session_id)}`
  const ws = new WebSocket(wsUrl, { headers })
  const send = (o: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)) }
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_r, resp) => rej(new Error(`WS upgrade HTTP ${resp.statusCode} (is ${new URL(a.server).host} in EXTRA_ALLOWED_HOSTS?)`))) })
  say('connected')

  // ---- microphone (SoX rec → 20 ms PCM16 frames), gated by the server's mic_enabled
  let micEnabled = false
  let rec: ChildProcess | null = null
  let pending: Buffer = Buffer.alloc(0)
  if (!mock) {
    rec = spawn('rec', ['-q', '--buffer', String(FRAME_BYTES), '-t', 'raw', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    rec.stderr!.on('data', (d) => say(`rec: ${String(d).trim()}`))
    rec.on('exit', (code) => say(`rec exited (${code})`))
    rec.stdout!.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= FRAME_BYTES) {
        const frame = pending.subarray(0, FRAME_BYTES)
        pending = pending.subarray(FRAME_BYTES)
        if (!micEnabled || ws.readyState !== WebSocket.OPEN) continue
        if (ws.bufferedAmount > SAMPLE_RATE * 2) { say('audio backlog > 1 s, stopping'); send({ type: 'stop' }); return }
        ws.send(Buffer.concat([Buffer.from([AUDIO_TAG]), frame]))
      }
    })
  } else {
    setInterval(() => { if (micEnabled && ws.readyState === WebSocket.OPEN) ws.send(Buffer.concat([Buffer.from([AUDIO_TAG]), Buffer.alloc(FRAME_BYTES)])) }, 20)
  }

  // ---- playback (SoX play), with the same acks as the browser
  let playback: { id: string; proc: ChildProcess | null; startedAt: number; canceled: boolean } | null = null
  let tPlayMsg = 0
  let tSpeechStopped: number | null = null
  const audioType = (b: Buffer) => (b.subarray(0, 4).toString('latin1') === 'RIFF' ? 'wav' : 'mp3')
  function stopCurrent(onlyId: string | null, reason: string | null) {
    const pb = playback
    if (!pb || (onlyId && pb.id !== onlyId)) return
    pb.canceled = true
    try { pb.proc?.kill('SIGKILL') } catch { /* already gone */ }
    if (reason) send({ type: 'playback_canceled', playback_id: pb.id, reason, position_ms: Math.round(performance.now() - pb.startedAt) })
    playback = null
  }
  async function playAudio(m: any) {
    tPlayMsg = performance.now()
    stopCurrent(null, null)
    const pb = { id: m.playback_id as string, proc: null as ChildProcess | null, startedAt: 0, canceled: false }
    playback = pb
    say(`▶ ${m.utterance_key}${m.interruptible ? ' (interruptible)' : ''}: 「${m.text}」`)
    let buf: Buffer
    try { buf = await fetchAudio(m.audio_id) } catch (e: any) {
      if (playback !== pb) return
      send({ type: 'playback_failed', playback_id: pb.id, error: 'load: ' + e.message })
      return
    }
    if (playback !== pb) return
    const proc = spawn('play', ['-q', '-t', audioType(buf), '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    pb.proc = proc
    pb.startedAt = performance.now()
    let err = ''
    proc.stderr!.on('data', (d) => { err += String(d) })
    proc.on('error', (e) => { if (playback === pb) { playback = null; send({ type: 'playback_failed', playback_id: pb.id, error: 'play: ' + e.message }) } })
    proc.on('exit', (code) => {
      if (playback !== pb || pb.canceled) return
      playback = null
      if (code === 0) send({ type: 'playback_ended', playback_id: pb.id })
      else send({ type: 'playback_failed', playback_id: pb.id, error: `play exit ${code}: ${err.trim().slice(0, 200)}` })
    })
    proc.stdin!.on('error', () => { /* killed mid-write */ })
    proc.stdin!.end(buf)
    send({ type: 'playback_started', playback_id: pb.id })
    const v = Math.round(pb.startedAt - tPlayMsg)
    send({ type: 'client_metric', name: 'decision_message_to_playback_started_ms', value_ms: v, playback_id: pb.id, turn_id: m.turn_id })
    if (tSpeechStopped !== null) {
      send({ type: 'client_metric', name: 'client_notification_speech_stopped_to_playback_started_ms', value_ms: Math.round(pb.startedAt - tSpeechStopped), playback_id: pb.id, turn_id: m.turn_id })
      tSpeechStopped = null
    }
  }

  // ---- server events
  let lastPhase = ''
  const metrics: Record<string, number> = {}
  let done = false
  ws.on('message', (d) => {
    let m: any
    try { m = JSON.parse(d.toString()) } catch { return }
    switch (m.type) {
      case 'state': {
        micEnabled = !!m.mic_enabled
        const line = `${m.phase}${m.speaking ? '(speaking)' : ''} node=${m.node_id} turn=${m.turn_id} mic=${micEnabled ? 'ON' : 'off'} backend=${m.backend}`
        if (line !== lastPhase) { say(`state ${line}`); lastPhase = line }
        break
      }
      case 'prefetch': for (const id of m.audio_ids ?? []) fetchAudio(id).catch(() => {}); break
      case 'play': void playAudio(m); break
      case 'playback_stop': stopCurrent(m.playback_id, 'barge_in'); say('playback_stop (barge-in)'); break
      case 'interrupted': say(`interrupted: 「${m.text}」 at ${m.position_ms} ms (remaining ${m.remaining_ms} ms)`); break
      case 'speech_started': say('… speech_started'); break
      case 'speech_stopped': tSpeechStopped = performance.now(); say('… speech_stopped'); break
      case 'preview': say(`preview ${m.branch_id} (${m.label})`); break
      case 'final': say(`FINAL ${m.branch_id} (${m.label})${m.fallback_reason ? ' fallback:' + m.fallback_reason : ''}${m.reason ? '  ' + m.reason : ''}`); break
      case 'final_invalidated': say(`final invalidated: ${m.reason}`); break
      case 'metric': metrics[m.name] = m.value_ms; say(`metric ${m.name}=${m.value_ms}`); break
      case 'playback_error': say(`playback_error: ${m.message}`); break
      case 'realtime_error': say(`backend error: ${m.code} ${m.message}`); break
      case 'finished':
        done = true
        say(`finished ${m.phase} ${m.reason}${m.message ? ' ' + m.message : ''}`)
        if (m.realtime_usage) say(`usage ${JSON.stringify(m.realtime_usage)}`)
        break
      default: say(`? ${m.type}`)
    }
  })

  // ---- keys
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.on('keypress', (_s, key) => {
      if (key.name === 's') { say('skip'); stopCurrent(null, 'user_skip') }
      else if (key.name === 'q' || (key.ctrl && key.name === 'c')) { say('stop'); send({ type: 'stop' }); stopCurrent(null, null); setTimeout(() => ws.close(), 500) }
    })
    say('keys: s = skip playback, q = stop')
  }

  await new Promise<void>((res) => ws.once('close', () => res()))
  stopCurrent(null, null)
  rec?.kill('SIGKILL')
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  say(`closed${done ? '' : ' (connection dropped)'}; metrics ${JSON.stringify(metrics)}`)
  if (a.log) {
    const r = await fetch(`${a.server}/api/sessions/${sess.session_id}/log.jsonl`, { headers })
    fs.writeFileSync(a.log, await r.text())
    say(`log saved: ${a.log}`)
  }
  process.exit(0)
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1) })
