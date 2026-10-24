/**
 * Browser side of the conversation: AudioContext playback with acks, mic capture
 * gated by the server's mic_enabled flag (half-duplex or barge-in), WebSocket.
 * Model-generated text only ever lands in reactive state rendered via {{ }}.
 */
import { reactive } from 'vue'
import { api } from './useApi'

/** Binary audio frames are prefixed with this tag byte so the server can tell them from JSON text. */
const AUDIO_TAG = 0x01
function tagged(pcm: ArrayBuffer): Uint8Array {
  const out = new Uint8Array(pcm.byteLength + 1)
  out[0] = AUDIO_TAG
  out.set(new Uint8Array(pcm), 1)
  return out
}

export interface ConvState {
  phase: string
  micEnabled: boolean
  playing: boolean
  interruptible: boolean
  bargeInEnabled: boolean
  mock: boolean
  nodeLabel: string
  nodeId: string
  turnId: number
  generation: number
  text: string
  preview: string
  final: string
  nextText: string
  cache: string
  error: string
  interruptedInfo: string
  counters: Record<string, number>
  usage: Record<string, number> | null
  metrics: Record<string, number>
  events: string[]
  sessionId: string | null
  versionLabel: string
  branches: Record<string, string[]>
  mockNode: string
  connected: boolean
  finished: boolean
}

export function useConversation() {
  const st = reactive<ConvState>({
    phase: '', micEnabled: false, playing: false, interruptible: false, bargeInEnabled: false, mock: false, nodeLabel: '', nodeId: '',
    turnId: 0, generation: 0, text: '', preview: '', final: '', nextText: '', cache: '', error: '', interruptedInfo: '', counters: {}, usage: null,
    metrics: {}, events: [], sessionId: null, versionLabel: '', branches: {}, mockNode: '', connected: false, finished: false,
  })

  let ws: WebSocket | null = null
  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let stream: MediaStream | null = null
  let mockTimer: ReturnType<typeof setInterval> | null = null
  let manifest: Record<string, { audio_id: string; text: string }> = {}
  const decoded = new Map<string, Promise<AudioBuffer>>()
  let playback: { id: string; src: AudioBufferSourceNode | null; startedAt: number; canceled: boolean } | null = null
  let tPlayMsg = 0
  let tSpeechStopped: number | null = null

  const log = (t: string) => {
    st.events.unshift(`${new Date().toLocaleTimeString()} ${t}`)
    if (st.events.length > 200) st.events.pop()
  }

  const send = (o: Record<string, unknown>) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o))
  }

  function decodeAudio(audioId: string): Promise<AudioBuffer> {
    if (!/^[0-9a-f]{64}$/.test(audioId)) return Promise.reject(new Error('bad id'))
    if (!decoded.has(audioId)) {
      const p = fetch(`/api/audio/${audioId}`)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
        .then((buf) => ctx!.decodeAudioData(buf))
      p.catch(() => decoded.delete(audioId))
      decoded.set(audioId, p)
    }
    return decoded.get(audioId)!
  }

  /** Mic gate follows the server: half-duplex disables it while playing, barge-in keeps it on. */
  function applyMicGate() {
    const on = st.micEnabled
    node?.port.postMessage({ enabled: on && !st.mock })
    if (st.mock) {
      if (on && !mockTimer) mockTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send(tagged(new Int16Array(480).buffer)) }, 20)
      else if (!on && mockTimer) { clearInterval(mockTimer); mockTimer = null }
    }
  }

  function onServer(m: any) {
    switch (m.type) {
      case 'state':
        st.phase = m.phase + (m.speaking ? '（ユーザー発話中）' : '')
        st.nodeLabel = m.node_label; st.nodeId = m.node_id; st.turnId = m.turn_id; st.generation = m.decision_generation
        st.text = m.playing_key ? manifest[m.playing_key]?.text ?? '' : m.node_text
        st.micEnabled = m.mic_enabled; st.interruptible = m.interruptible; st.bargeInEnabled = m.barge_in_enabled
        st.counters = m.counters
        st.mockNode = m.node_id
        applyMicGate()
        break
      case 'prefetch': {
        const ids: string[] = m.audio_ids ?? []
        let cached = 0
        ids.forEach((id) => { if (decoded.has(id)) cached++; decodeAudio(id).catch(() => {}) })
        st.cache = `候補 ${ids.length} 件（既読込 ${cached}）`
        break
      }
      case 'play': playAudio(m); break
      case 'playback_stop': stopCurrent(m.playback_id, 'barge_in'); log('playback_stop (barge-in)'); break
      case 'interrupted':
        st.interruptedInfo = `中断した発話: 「${m.text}」 再生 ${m.position_ms ?? '?'} ms / 未再生 ${m.remaining_ms ?? '?'} ms`
        break
      case 'speech_started': st.preview = '（発話中…）'; st.final = ''; st.nextText = ''; log('speech_started'); break
      case 'speech_stopped': tSpeechStopped = performance.now(); log('speech_stopped'); break
      case 'preview': st.preview = `${m.label} [${m.branch_id}]（暫定・再生には使いません）`; log(`preview ${m.branch_id}`); break
      case 'final':
        st.final = `${m.label} [${m.branch_id}]${m.fallback_reason ? ' fallback:' + m.fallback_reason : ''}`
        st.nextText = m.next_text
        log(`final ${m.branch_id}${m.fallback_reason ? ' (' + m.fallback_reason + ')' : ''}`)
        break
      case 'final_invalidated': st.final = `（再発話のため無効化: ${m.reason}）`; log('final invalidated'); break
      case 'metric': st.metrics[m.name] = m.value_ms; break
      case 'playback_error': st.error = m.message; log('playback_error'); break
      case 'finished':
        log(`finished ${m.phase} ${m.reason}`)
        st.finished = true
        if (m.phase !== 'FINISHED') st.error = m.message || m.reason
        else st.phase = 'FINISHED'
        if (m.realtime_usage) st.usage = m.realtime_usage
        break
      default: log('? ' + m.type)
    }
  }

  async function playAudio(m: any) {
    tPlayMsg = performance.now()
    stopCurrent(null, null)
    st.playing = true
    const pb = { id: m.playback_id as string, src: null as AudioBufferSourceNode | null, startedAt: 0, canceled: false }
    playback = pb
    st.text = m.text
    log(`play ${m.utterance_key}${m.interruptible ? ' (interruptible)' : ''}`)
    let buf: AudioBuffer
    try {
      buf = await decodeAudio(m.audio_id)
    } catch (e: any) {
      if (playback !== pb) return
      st.playing = false
      send({ type: 'playback_failed', playback_id: pb.id, error: 'decode/load: ' + e.message })
      return
    }
    if (playback !== pb) return // superseded
    try {
      if (ctx!.state !== 'running') await ctx!.resume()
      const src = ctx!.createBufferSource()
      src.buffer = buf
      src.connect(ctx!.destination)
      src.onended = () => {
        if (playback !== pb || pb.canceled) return // stale ended never opens a new turn
        playback = null
        st.playing = false
        send({ type: 'playback_ended', playback_id: pb.id })
      }
      src.start()
      pb.src = src
      pb.startedAt = performance.now()
      send({ type: 'playback_started', playback_id: pb.id })
      const v = Math.round(pb.startedAt - tPlayMsg)
      st.metrics.decision_message_to_playback_started_ms = v
      send({ type: 'client_metric', name: 'decision_message_to_playback_started_ms', value_ms: v, playback_id: pb.id, turn_id: m.turn_id })
      if (tSpeechStopped !== null) {
        const v2 = Math.round(pb.startedAt - tSpeechStopped)
        st.metrics.client_notification_speech_stopped_to_playback_started_ms = v2
        send({ type: 'client_metric', name: 'client_notification_speech_stopped_to_playback_started_ms', value_ms: v2, playback_id: pb.id, turn_id: m.turn_id })
        tSpeechStopped = null
      }
    } catch (e: any) {
      st.playing = false
      send({ type: 'playback_failed', playback_id: pb.id, error: 'play: ' + e.message })
    }
  }

  /** Stop the current source. `reason` null = silent supersede; otherwise report playback_canceled with the position. */
  function stopCurrent(onlyId: string | null, reason: string | null) {
    const pb = playback
    if (!pb || (onlyId && pb.id !== onlyId)) return
    pb.canceled = true
    try { pb.src?.stop() } catch { /* already stopped */ }
    if (reason) send({ type: 'playback_canceled', playback_id: pb.id, reason, position_ms: Math.round(performance.now() - pb.startedAt) })
    playback = null
    st.playing = false
  }

  async function start(opts: { scenarioId: string; version: number; runtime: Record<string, unknown> }) {
    if (ws) return
    st.error = ''; st.events = []; st.metrics = {}; st.usage = null; st.finished = false; st.interruptedInfo = ''
    try {
      // user gesture: create/resume AudioContext first (autoplay policy)
      if (!ctx) ctx = new AudioContext({ sampleRate: 24000 })
      await ctx.resume()
      if (ctx.sampleRate !== 24000) throw new Error(`AudioContext が 24kHz になりません（${ctx.sampleRate}Hz）`)
      const sess = await api('POST', '/api/sessions', { scenario_id: opts.scenarioId, version: opts.version, request_id: crypto.randomUUID().replace(/-/g, ''), runtime: opts.runtime })
      st.sessionId = sess.session_id
      st.mock = sess.mock_realtime
      st.bargeInEnabled = sess.barge_in_enabled
      manifest = sess.manifest
      st.branches = sess.branches
      st.versionLabel = `v${sess.version}（このセッション中は固定）`
      await decodeAudio(sess.entry_audio_id) // decode the first utterance before opening the session
      if (!st.mock) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        await ctx.audioWorklet.addModule('/worklet.js')
        const src = ctx.createMediaStreamSource(stream)
        node = new AudioWorkletNode(ctx, 'pcm-capture')
        node.port.onmessage = (e) => { if (st.micEnabled && ws && ws.readyState === 1) ws.send(tagged(e.data)) }
        src.connect(node)
      }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const sock = new WebSocket(`${proto}://${location.host}/ws?session_id=${encodeURIComponent(sess.session_id)}`)
      sock.binaryType = 'arraybuffer'
      ws = sock
      st.connected = true
      sock.onmessage = (ev) => { try { onServer(JSON.parse(ev.data)) } catch (e) { log('bad message ' + e) } }
      sock.onclose = () => { log('WebSocket closed'); cleanup() }
      log(`session ${sess.session_id} v${sess.version}`)
    } catch (e: any) {
      st.error = '開始できません: ' + e.message
      cleanup()
    }
  }

  function cleanup() {
    stopCurrent(null, null)
    if (mockTimer) { clearInterval(mockTimer); mockTimer = null }
    stream?.getTracks().forEach((t) => t.stop()); stream = null
    node?.disconnect(); node = null
    if (ws && ws.readyState <= 1) ws.close()
    ws = null
    st.micEnabled = false
    st.connected = false
  }

  return {
    st,
    start,
    stop: () => { send({ type: 'stop' }); stopCurrent(null, null) },
    skip: () => stopCurrent(null, 'user_skip'),
    retryPlayback: () => { st.error = ''; send({ type: 'playback_retry' }) },
    mockVad: (action: 'start' | 'stop', preview: string, final: string) => send({ type: 'mock_vad', action, preview_branch: preview, final_branch: final }),
  }
}
