/**
 * Built-in energy VAD for STT providers without speech-boundary events.
 * PCM16 frames in, speech_started / speech_stopped out on the audio timeline (ms pushed so far).
 * Deliberately simple (RMS + hangover); echo rejection stays with the engine's barge-in confirm window.
 */
export interface VadOptions {
  sampleRate: number
  /** RMS (int16 scale) above which a frame counts as speech. */
  rmsThreshold: number
  /** Speech must persist this long before speech_started. */
  minSpeechMs: number
  /** Silence that ends the utterance. */
  silenceMs: number
  /** Audio kept before the detected start (reported start = detected start - prefixMs). */
  prefixMs: number
}

export type VadEvent = { type: 'speech_started'; atMs: number } | { type: 'speech_stopped'; atMs: number }

export class EnergyVad {
  private samples = 0
  private inSpeech = false
  private speechRunMs = 0
  private silenceRunMs = 0
  private floorMs = 0
  constructor(private o: VadOptions) {}

  get ms() { return (this.samples * 1000) / this.o.sampleRate }

  /** Nothing before this point may be reported as speech (after an input clear). */
  reset() { this.inSpeech = false; this.speechRunMs = 0; this.silenceRunMs = 0; this.floorMs = this.ms }

  push(pcm: Uint8Array): VadEvent[] {
    const n = pcm.length >> 1
    if (!n) return []
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    let acc = 0
    for (let i = 0; i < n; i++) { const v = dv.getInt16(i * 2, true); acc += v * v }
    const rms = Math.sqrt(acc / n)
    const frameMs = (n * 1000) / this.o.sampleRate
    this.samples += n
    const out: VadEvent[] = []
    if (rms >= this.o.rmsThreshold) {
      this.speechRunMs += frameMs
      this.silenceRunMs = 0
      if (!this.inSpeech && this.speechRunMs >= this.o.minSpeechMs) {
        this.inSpeech = true
        out.push({ type: 'speech_started', atMs: Math.max(this.floorMs, this.ms - this.speechRunMs - this.o.prefixMs) })
      }
    } else {
      this.silenceRunMs += frameMs
      this.speechRunMs = 0
      if (this.inSpeech && this.silenceRunMs >= this.o.silenceMs) {
        this.inSpeech = false
        out.push({ type: 'speech_stopped', atMs: this.ms - this.silenceRunMs })
      }
    }
    return out
  }
}
