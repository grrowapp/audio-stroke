/**
 * Streaming speech-to-text provider contract used by SttJudgeBackend.
 * Audio in: PCM16 mono 24 kHz, pushed continuously. Text out: partial / final segments with
 * positions on the audio timeline (ms of audio pushed since start) when the provider gives them.
 * Providers that detect speech boundaries themselves set `hasVad` and emit speech_* events;
 * otherwise the backend's built-in energy VAD is used.
 */
export type SttEvent =
  | { type: 'ready' }
  | { type: 'partial'; text: string; startMs: number | null; endMs: number | null }
  | { type: 'final'; text: string; startMs: number | null; endMs: number | null }
  | { type: 'speech_started'; atMs: number }
  | { type: 'speech_stopped'; atMs: number }
  | { type: 'error'; message: string }
  | { type: 'closed'; message: string }

export interface SttStart {
  sampleRate: number
  language: string
  /** Silence that ends an utterance (providers with their own endpointing use it as a hint). */
  silenceMs: number
  onEvent: (ev: SttEvent) => void
}

export interface SttProvider {
  readonly name: string
  readonly hasVad: boolean
  readonly isMock: boolean
  start(o: SttStart): Promise<void>
  sendAudio(pcm: Uint8Array): void
  close(): Promise<void>
  bufferedBytes(): number
  /** Mock: UI / test control. */
  control?(msg: Record<string, unknown>): Promise<void>
}

/** Audio timeline helper shared by providers: ms of PCM16 24 kHz pushed so far. */
export class AudioClock {
  samples = 0
  constructor(private sampleRate: number) {}
  add(pcmBytes: number) { this.samples += pcmBytes / 2 }
  get ms() { return (this.samples * 1000) / this.sampleRate }
}
