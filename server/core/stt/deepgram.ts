/**
 * Deepgram live STT (wss://api.deepgram.com/v1/listen, nova-3). Has its own endpointing:
 * SpeechStarted (vad_events) and Results.speech_final / UtteranceEnd, so `hasVad` is true.
 * Results carry start + duration (seconds) on the audio timeline.
 */
import { AudioClock, type SttEvent, type SttProvider, type SttStart } from './types'

export class DeepgramStt implements SttProvider {
  readonly name = 'deepgram'
  readonly hasVad = true
  readonly isMock = false
  private ws: import('ws').WebSocket | null = null
  private clock = new AudioClock(24000)
  private onEvent: (ev: SttEvent) => void = () => {}
  private closed = false
  private inSpeech = false
  constructor(private apiKey: string, private language = 'ja', private model = 'nova-3') {
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY が未設定です')
  }

  async start(o: SttStart) {
    this.onEvent = o.onEvent
    this.clock = new AudioClock(o.sampleRate)
    const { WebSocket } = await import('ws')
    const q = new URLSearchParams({ model: this.model, language: this.language, encoding: 'linear16', sample_rate: String(o.sampleRate), channels: '1', interim_results: 'true', endpointing: String(Math.max(10, o.silenceMs)), utterance_end_ms: String(Math.max(1000, o.silenceMs * 2)), vad_events: 'true', smart_format: 'false' })
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${q}`, { headers: { Authorization: `Token ${this.apiKey}` }, handshakeTimeout: 10000 })
    this.ws = ws
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
    this.onEvent({ type: 'ready' })
    ws.on('message', (data) => {
      let m: any
      try { m = JSON.parse(data.toString()) } catch { return }
      if (m.type === 'SpeechStarted') {
        if (!this.inSpeech) { this.inSpeech = true; this.onEvent({ type: 'speech_started', atMs: Number(m.timestamp ?? 0) * 1000 }) }
      } else if (m.type === 'Results') {
        const text: string = m.channel?.alternatives?.[0]?.transcript ?? ''
        const s = typeof m.start === 'number' ? m.start * 1000 : null
        const e = s !== null && typeof m.duration === 'number' ? s + m.duration * 1000 : null
        if (text) this.onEvent({ type: m.is_final ? 'final' : 'partial', text, startMs: s, endMs: e })
        if (m.speech_final && this.inSpeech) { this.inSpeech = false; this.onEvent({ type: 'speech_stopped', atMs: e ?? this.clock.ms }) }
      } else if (m.type === 'UtteranceEnd') {
        if (this.inSpeech) { this.inSpeech = false; this.onEvent({ type: 'speech_stopped', atMs: Number(m.last_word_end ?? 0) * 1000 || this.clock.ms }) }
      } else if (m.type === 'Error') this.onEvent({ type: 'error', message: JSON.stringify(m).slice(0, 200) })
    })
    ws.on('close', (code, reason) => { if (!this.closed) this.onEvent({ type: 'closed', message: `deepgram closed ${code} ${reason}` }) })
    ws.on('error', (e) => this.onEvent({ type: 'error', message: String(e) }))
  }

  sendAudio(pcm: Uint8Array) {
    this.clock.add(pcm.length)
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(pcm)
  }

  async close() {
    this.closed = true
    const ws = this.ws
    if (!ws) return
    try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })) } catch { /* ignore */ }
    await new Promise<void>((res) => { ws.once('close', () => res()); setTimeout(() => { try { ws.terminate() } catch { /* ignore */ } res() }, 1500) })
  }

  bufferedBytes() { return this.ws?.bufferedAmount ?? 0 }
}
