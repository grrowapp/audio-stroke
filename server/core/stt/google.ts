/**
 * Google Cloud Speech-to-Text v2 streaming (chirp_3 etc.) via @google-cloud/speech.
 * Emits voice-activity events (SPEECH_ACTIVITY_BEGIN / END) as VAD and final results with
 * resultEndOffset; interim results only when the model supports them.
 * Auth: GOOGLE_APPLICATION_CREDENTIALS (service-account JSON) + project id.
 */
import { AudioClock, type SttEvent, type SttProvider, type SttStart } from './types'

export interface GoogleSttOptions {
  projectId: string
  location?: string // chirp_3 streaming: 'us' | 'eu'
  model?: string
  language?: string
}

export class GoogleStt implements SttProvider {
  readonly name = 'google'
  readonly hasVad = true
  readonly isMock = false
  private client: any = null
  private stream: any = null
  private clock = new AudioClock(24000)
  private onEvent: (ev: SttEvent) => void = () => {}
  private closed = false
  private inSpeech = false
  private pending = 0
  constructor(private o: GoogleSttOptions) {
    if (!o.projectId) throw new Error('GOOGLE_PROJECT_ID が未設定です')
  }

  async start(s: SttStart) {
    this.onEvent = s.onEvent
    this.clock = new AudioClock(s.sampleRate)
    const location = this.o.location ?? 'us'
    const { v2 } = await import('@google-cloud/speech')
    this.client = new v2.SpeechClient({ apiEndpoint: `${location}-speech.googleapis.com` })
    const stream = this.client._streamingRecognize()
    this.stream = stream
    stream.on('error', (e: any) => { if (!this.closed) this.onEvent({ type: 'error', message: String(e?.message ?? e) }) })
    stream.on('end', () => { if (!this.closed) this.onEvent({ type: 'closed', message: 'google stream ended' }) })
    stream.on('data', (resp: any) => {
      const off = resp.speechEventOffset ? Number(resp.speechEventOffset.seconds ?? 0) * 1000 + Number(resp.speechEventOffset.nanos ?? 0) / 1e6 : this.clock.ms
      if (resp.speechEventType === 'SPEECH_ACTIVITY_BEGIN' && !this.inSpeech) { this.inSpeech = true; this.onEvent({ type: 'speech_started', atMs: off }) }
      else if (resp.speechEventType === 'SPEECH_ACTIVITY_END' && this.inSpeech) { this.inSpeech = false; this.onEvent({ type: 'speech_stopped', atMs: off }) }
      for (const r of resp.results ?? []) {
        const text: string = r.alternatives?.[0]?.transcript ?? ''
        if (!text) continue
        const end = r.resultEndOffset ? Number(r.resultEndOffset.seconds ?? 0) * 1000 + Number(r.resultEndOffset.nanos ?? 0) / 1e6 : null
        this.onEvent({ type: r.isFinal ? 'final' : 'partial', text, startMs: null, endMs: end })
      }
    })
    stream.write({
      recognizer: `projects/${this.o.projectId}/locations/${location}/recognizers/_`,
      streamingConfig: {
        config: { explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: s.sampleRate, audioChannelCount: 1 }, languageCodes: [this.o.language ?? 'ja-JP'], model: this.o.model ?? 'chirp_3' },
        streamingFeatures: { interimResults: true, enableVoiceActivityEvents: true },
      },
    })
    this.onEvent({ type: 'ready' })
  }

  sendAudio(pcm: Uint8Array) {
    this.clock.add(pcm.length)
    if (this.stream && !this.stream.destroyed) {
      this.pending += pcm.length
      this.stream.write({ audio: Buffer.from(pcm) }, () => { this.pending -= pcm.length })
    }
  }

  async close() {
    this.closed = true
    try { if (this.stream && !this.stream.destroyed) this.stream.end() } catch { /* ignore */ }
    try { await this.client?.close() } catch { /* ignore */ }
  }

  bufferedBytes() { return Math.max(0, this.pending) }
}
