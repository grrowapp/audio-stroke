/**
 * Scripted STT for tests and the UI mock. Speech boundaries and text come from `control`
 * ({action:'start'} / {action:'stop', text?}) or from `say(text)` in tests; no audio is understood.
 */
import { AudioClock, type SttEvent, type SttProvider, type SttStart } from './types'

export class MockStt implements SttProvider {
  readonly name = 'mock'
  readonly hasVad = true
  readonly isMock = true
  clock = new AudioClock(24000)
  received = 0
  private onEvent: (ev: SttEvent) => void = () => {}
  private inSpeech = false
  private startMs = 0
  text = 'MOCK 発話'
  /** delay between speech_stopped and the final transcript (simulates the provider's finalization) */
  finalDelayMs = 20

  async start(o: SttStart) {
    this.onEvent = o.onEvent
    this.clock = new AudioClock(o.sampleRate)
    this.onEvent({ type: 'ready' })
  }

  sendAudio(pcm: Uint8Array) { this.clock.add(pcm.length); this.received += pcm.length }

  async control(msg: Record<string, unknown>) {
    if (typeof msg.text === 'string') this.text = msg.text
    if (msg.action === 'start' && !this.inSpeech) {
      this.inSpeech = true
      this.startMs = Math.max(0, this.clock.ms - 300)
      this.onEvent({ type: 'speech_started', atMs: this.startMs })
      if (typeof msg.partial === 'string') this.onEvent({ type: 'partial', text: msg.partial, startMs: this.startMs, endMs: this.clock.ms })
    } else if (msg.action === 'partial' && this.inSpeech) {
      this.onEvent({ type: 'partial', text: String(msg.partial ?? this.text), startMs: this.startMs, endMs: this.clock.ms })
    } else if (msg.action === 'stop' && this.inSpeech) {
      this.inSpeech = false
      const end = this.clock.ms
      this.onEvent({ type: 'speech_stopped', atMs: end })
      const text = this.text
      setTimeout(() => this.onEvent({ type: 'final', text, startMs: this.startMs, endMs: end }), this.finalDelayMs)
    }
  }

  /** Test helper: speech start → final text → speech stop in one go. */
  async say(text: string) {
    await this.control({ action: 'start' })
    await this.control({ action: 'stop', text })
  }

  async close() {}
  bufferedBytes() { return 0 }
}
