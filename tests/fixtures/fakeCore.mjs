// Minimal stand-in for a native core speaking docs/CORE_PROTOCOL.md over stdio.
// It plays the entry prompt, waits for the playback ack, echoes one audio frame count,
// then ends the session when it receives `stop`.
import process from 'node:process'

let buf = new Uint8Array(0)
let audioFrames = 0
let init = null
const enc = (o) => new TextEncoder().encode(JSON.stringify(o))

function send(tag, payload) {
  const out = new Uint8Array(5 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length + 1)
  out[4] = tag
  out.set(payload, 5)
  process.stdout.write(out)
}
const toBrowser = (msg) => send(0, enc({ channel: 'browser', msg }))

process.stdin.on('data', (chunk) => {
  const joined = new Uint8Array(buf.length + chunk.length)
  joined.set(buf); joined.set(chunk, buf.length)
  buf = joined
  for (;;) {
    if (buf.length < 5) break
    const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0)
    if (buf.length < 4 + len) break
    const tag = buf[4]
    const payload = buf.slice(5, 4 + len)
    buf = buf.slice(4 + len)
    if (tag === 1) { audioFrames++; continue }
    const m = JSON.parse(new TextDecoder().decode(payload))
    if (m.channel === 'init') {
      init = m
      const entry = init.manifest.entries[`node:${init.scenario.entry_node_id}`]
      toBrowser({ type: 'state', phase: 'PLAYING', mic_enabled: !!init.runtime.barge_in_enabled, node_id: init.scenario.entry_node_id })
      toBrowser({ type: 'play', playback_id: 'pb_fake1', turn_id: 0, decision_generation: 0, utterance_key: entry.utterance_key, audio_id: entry.audio_id, url: `/api/audio/${entry.audio_id}`, text: entry.text, terminal_after: false, interruptible: !!init.runtime.barge_in_enabled })
      send(0, enc({ channel: 'metrics', kind: 'inc', name: 'audio_cache_hit' }))
    } else if (m.channel === 'browser') {
      const msg = m.msg
      if (msg.type === 'playback_ended') {
        send(0, enc({ channel: 'metrics', kind: 'event', name: 'turn_opened', fields: { has_audio_path: !!init.audio_paths[Object.values(init.manifest.entries)[0].audio_id] } }))
        toBrowser({ type: 'state', phase: 'LISTENING', mic_enabled: true, node_id: init.scenario.entry_node_id })
      } else if (msg.type === 'stop' || msg.type === '_disconnect') {
        toBrowser({ type: 'finished', phase: 'STOPPED', reason: 'user_stop', message: `stopped after ${audioFrames} frames`, counters: {}, realtime_usage: {} })
        send(0, enc({ channel: 'exit', reason: 'user_stop', phase: 'STOPPED' }))
        setTimeout(() => process.exit(0), 20)
      }
    }
  }
})
