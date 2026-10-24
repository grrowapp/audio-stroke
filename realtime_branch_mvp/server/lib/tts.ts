/**
 * Pre-conversation speech synthesis (provider boundary). A separate step from
 * Claude scenario generation: it only voices utterance texts a human already
 * approved, and is never called on the conversation path.
 */
import type { Settings } from './config'

export const CACHE_SPEC_VERSION = '2'

export interface VoiceSettings {
  provider: string
  model: string
  voice: string
  format: 'mp3' | 'wav'
  speed: number
  style_id: string
  style_text: string
  api: string
}

export const voiceSettings = (v: Omit<VoiceSettings, 'api'> & { api?: string }): VoiceSettings => ({ api: 'audio.speech.v1', ...v })

export class InvalidAudio extends Error {}
export class TTSTransientError extends Error {}
export class TTSError extends Error {}

// ---------------------------------------------------------------------------
// audio validation (decodability check without external decoders)
// ---------------------------------------------------------------------------

const MP3_BITRATES: Record<string, number[]> = {
  '3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 L3
  '2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2 L3
  '0': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2.5 L3
}
const MP3_RATES: Record<string, number[]> = { '3': [44100, 48000, 32000], '2': [22050, 24000, 16000], '0': [11025, 12000, 8000] }

function mp3DurationMs(data: Uint8Array): number {
  let pos = 0
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    if (data.length < 10) throw new InvalidAudio('truncated ID3')
    pos = 10 + (((data[6]! & 0x7f) << 21) | ((data[7]! & 0x7f) << 14) | ((data[8]! & 0x7f) << 7) | (data[9]! & 0x7f))
  }
  let frames = 0
  let samples = 0
  let rate = 0
  while (pos + 4 <= data.length) {
    const h0 = data[pos]!, h1 = data[pos + 1]!, h2 = data[pos + 2]!
    if (h0 !== 0xff || (h1 & 0xe0) !== 0xe0) {
      if (!frames) throw new InvalidAudio('MP3 frame sync not found')
      break
    }
    const ver = (h1 >> 3) & 3, layer = (h1 >> 1) & 3, brIdx = (h2 >> 4) & 0xf, srIdx = (h2 >> 2) & 3, pad = (h2 >> 1) & 1
    if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      if (!frames) throw new InvalidAudio('unsupported/invalid MP3 header')
      break
    }
    const br = MP3_BITRATES[String(ver)]![brIdx - 1]! * 1000
    const sr = MP3_RATES[String(ver)]![srIdx]!
    const spf = ver === 3 ? 1152 : 576
    const flen = Math.floor((spf / 8 * br) / sr) + pad
    if (flen < 4) throw new InvalidAudio('bad MP3 frame length')
    frames++
    samples += spf
    rate = sr
    pos += flen
  }
  if (frames < 2) throw new InvalidAudio('too few MP3 frames')
  return Math.floor(samples * 1000 / rate)
}

function wavDurationMs(data: Uint8Array): number {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const tag = (o: number) => String.fromCharCode(data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!)
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new InvalidAudio('not a RIFF/WAVE file')
  let pos = 12
  let rate = 0, channels = 0, bits = 0, dataLen = -1
  while (pos + 8 <= data.length) {
    const id = tag(pos)
    const size = dv.getUint32(pos + 4, true)
    if (id === 'fmt ') {
      if (dv.getUint16(pos + 8, true) !== 1) throw new InvalidAudio('WAV must be PCM')
      channels = dv.getUint16(pos + 10, true)
      rate = dv.getUint32(pos + 12, true)
      bits = dv.getUint16(pos + 22, true)
    } else if (id === 'data') {
      dataLen = Math.min(size, data.length - pos - 8)
      break
    }
    pos += 8 + size + (size & 1)
  }
  if (!rate || !channels || !bits || dataLen <= 0) throw new InvalidAudio('WAV decode failed')
  const frames = Math.floor(dataLen / (channels * bits / 8))
  if (!frames) throw new InvalidAudio('empty WAV')
  return Math.floor(frames * 1000 / rate)
}

/** Returns [mime, duration_ms]. Rejects HTML/JSON error bodies and garbage. */
export function validateAudio(data: Uint8Array, fmt: 'mp3' | 'wav'): [string, number] {
  if (!data || data.length < 64) throw new InvalidAudio('empty or too small')
  const head = new TextDecoder().decode(data.subarray(0, 16)).trimStart()
  if (head.startsWith('<') || head.startsWith('{') || head.startsWith('[')) throw new InvalidAudio('looks like HTML/JSON, not audio')
  if (fmt === 'wav') return ['audio/wav', wavDurationMs(data)]
  if (fmt === 'mp3') return ['audio/mpeg', mp3DurationMs(data)]
  throw new InvalidAudio(`unsupported format ${fmt}`)
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

export interface SpeechSynthesizer {
  name: string
  isMock: boolean
  synthesize(text: string, vs: VoiceSettings, signal?: AbortSignal): Promise<Uint8Array>
}

export function mockToneWav(text: string, speed = 1, rate = 24000): Uint8Array {
  const secs = Math.max(0.6, Math.min(4.0, text.length * 0.03 / Math.max(speed, 0.1)))
  const n = Math.floor(rate * secs)
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true)
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true)
  let f = 440
  for (const ch of text) f += ch.charCodeAt(0)
  f = 440 + (f % 200)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = 0.5 * (1 - Math.cos(2 * Math.PI * Math.min(1, (t % 0.5) / 0.5)))
    dv.setInt16(44 + i * 2, Math.round(3000 * env * Math.sin(2 * Math.PI * f * t)), true)
  }
  return new Uint8Array(buf)
}

/** Produces a soft tone WAV whose length scales with text length (NOT speech). */
export class MockSpeechSynthesizer implements SpeechSynthesizer {
  name = 'mock'
  isMock = true
  calls: string[] = []
  constructor(public failTexts: Record<string, Error[]> = {}, public delayMs = 50, public garbageTexts = new Set<string>()) {}

  async synthesize(text: string, vs: VoiceSettings): Promise<Uint8Array> {
    this.calls.push(text)
    await new Promise((r) => setTimeout(r, this.delayMs))
    const errs = this.failTexts[text]
    if (errs?.length) throw errs.shift()!
    if (this.garbageTexts.has(text)) return new TextEncoder().encode('<html><body>502 Bad Gateway</body></html>' + ' '.repeat(100))
    return mockToneWav(text, vs.speed)
  }
}

export class OpenAISpeechSynthesizer implements SpeechSynthesizer {
  name = 'openai'
  isMock = false
  constructor(private settings: Settings, private client: any = null) {}

  private async getClient() {
    if (this.client) return this.client
    const { default: OpenAI } = await import('openai')
    if (!this.settings.openaiApiKey) throw new TTSError('OPENAI_API_KEY が未設定です。')
    this.client = new OpenAI({ apiKey: this.settings.openaiApiKey, maxRetries: 0, timeout: this.settings.ttsTimeoutMs })
    return this.client
  }

  async synthesize(text: string, vs: VoiceSettings, signal?: AbortSignal): Promise<Uint8Array> {
    const OpenAI = (await import('openai')).default
    const client = await this.getClient()
    const params: Record<string, unknown> = { model: vs.model, voice: vs.voice, input: text, response_format: vs.format, speed: vs.speed }
    if (vs.style_text && !vs.model.startsWith('tts-1')) params.instructions = vs.style_text // not supported by tts-1 / tts-1-hd
    let resp: any
    try {
      resp = await client.audio.speech.create(params, { signal })
    } catch (e: any) {
      if (e instanceof OpenAI.RateLimitError) throw new TTSTransientError('429')
      if (e instanceof OpenAI.APIConnectionError) throw new TTSTransientError(e.constructor.name)
      if (e instanceof OpenAI.APIError) {
        const st = e.status ?? 0
        if (st >= 500 || st === 408 || st === 409) throw new TTSTransientError(`HTTP ${st}`)
        throw new TTSError(`TTS API エラー HTTP ${st}`)
      }
      throw e
    }
    const ctype: string = resp.headers?.get?.('content-type') ?? ''
    if (ctype && !(ctype.startsWith('audio/') || ctype.startsWith('application/octet-stream'))) throw new InvalidAudio(`unexpected content-type ${ctype}`)
    return new Uint8Array(await resp.arrayBuffer())
  }
}

export function makeSynthesizer(settings: Settings): SpeechSynthesizer {
  return settings.ttsProvider === 'openai' ? new OpenAISpeechSynthesizer(settings) : new MockSpeechSynthesizer()
}
