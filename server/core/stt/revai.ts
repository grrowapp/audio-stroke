/**
 * Rev.ai streaming STT (wss://api.rev.ai/speechtotext/v1/stream). Raw S16LE audio in, JSON
 * {type:'connected'|'partial'|'final', ts, end_ts, elements:[{value}]} out. No VAD events: the
 * backend's energy VAD provides speech boundaries; partial/final timestamps (seconds on the audio
 * timeline) are used to attribute text to utterances. Finals arrive ~0.5 s after speech ends.
 */
import { AudioClock, type SttEvent, type SttProvider, type SttStart } from './types'

export class RevAiStt implements SttProvider {
  readonly name = 'revai'
  readonly hasVad = false
  readonly isMock = false
  private ws: import('ws').WebSocket | null = null
  private clock = new AudioClock(24000)
  private onEvent: (ev: SttEvent) => void = () => {}
  private closed = false
  constructor(private accessToken: string, private language = 'ja') {
    if (!accessToken) throw new Error('REVAI_ACCESS_TOKEN が未設定です')
  }

  async start(o: SttStart) {
    this.onEvent = o.onEvent
    this.clock = new AudioClock(o.sampleRate)
    const { WebSocket } = await import('ws')
    const ct = `audio/x-raw;layout=interleaved;rate=${o.sampleRate};format=S16LE;channels=1`
    const url = `wss://api.rev.ai/speechtotext/v1/stream?access_token=${encodeURIComponent(this.accessToken)}&content_type=${encodeURIComponent(ct)}&language=${encodeURIComponent(this.language)}&delete_after_seconds=0`
    const ws = new WebSocket(url, { handshakeTimeout: 10000 })
    this.ws = ws
    await new Promise<void>((res, rej) => {
      ws.once('error', rej)
      ws.on('message', (data) => {
        let m: any
        try { m = JSON.parse(data.toString()) } catch { return }
        if (m.type === 'connected') { res(); this.onEvent({ type: 'ready' }); return }
        const text = m.type === 'final' ? (m.elements ?? []).map((e: any) => e.value ?? '').join('') : ''
        const s = typeof m.ts === 'number' ? m.ts * 1000 : null, e = typeof m.end_ts === 'number' ? m.end_ts * 1000 : null
        if (m.type === 'partial') this.onEvent({ type: 'partial', text: (m.elements ?? []).map((x: any) => x.value ?? '').join(''), startMs: s, endMs: e })
        else if (m.type === 'final' && text) this.onEvent({ type: 'final', text, startMs: s, endMs: e })
      })
      ws.on('close', (code, reason) => { if (!this.closed) this.onEvent({ type: 'closed', message: `revai closed ${code} ${reason}` }) })
      ws.on('error', (e) => this.onEvent({ type: 'error', message: String(e) }))
    })
  }

  sendAudio(pcm: Uint8Array) {
    this.clock.add(pcm.length)
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(pcm)
  }

  async close() {
    this.closed = true
    const ws = this.ws
    if (!ws) return
    try { if (ws.readyState === ws.OPEN) ws.send('EOS') } catch { /* ignore */ }
    await new Promise<void>((res) => { ws.once('close', () => res()); setTimeout(() => { try { ws.terminate() } catch { /* ignore */ } res() }, 1500) })
  }

  bufferedBytes() { return this.ws?.bufferedAmount ?? 0 }
}
