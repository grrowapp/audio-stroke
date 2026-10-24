/** PCM16 ring buffer on the hot path (memory only, discarded at session end). */
export const SAMPLE_RATE = 24000
export const BYTES_PER_SAMPLE = 2
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000

/** Keeps the most recent `capacity` samples of PCM16 sent to Realtime, addressed by absolute sample index. */
export class PcmRing {
  chunks: { start: number; data: Uint8Array }[] = []
  total = 0 // absolute samples appended so far
  retainedStart = 0 // first absolute sample still retained
  constructor(public capacity: number) {}

  append(pcm: Uint8Array): number {
    if (pcm.length % BYTES_PER_SAMPLE) throw new Error('PCM16 frame must have an even number of bytes')
    const start = this.total
    this.chunks.push({ start, data: new Uint8Array(pcm) })
    this.total += pcm.length / BYTES_PER_SAMPLE
    while (this.chunks.length && this.total - this.chunks[0]!.start - this.chunks[0]!.data.length / BYTES_PER_SAMPLE >= this.capacity) {
      const c = this.chunks.shift()!
      this.retainedStart = c.start + c.data.length / BYTES_PER_SAMPLE
    }
    return start
  }

  /** Bytes for samples [start, end). null if any part is no longer retained. */
  slice(start: number, end: number): Uint8Array | null {
    if (start < this.retainedStart || end > this.total || start > end) return null
    const out = new Uint8Array((end - start) * BYTES_PER_SAMPLE)
    let off = 0
    for (const { start: s, data } of this.chunks) {
      const n = data.length / BYTES_PER_SAMPLE
      const e = s + n
      if (e <= start || s >= end) continue
      const lo = Math.max(start, s) - s
      const hi = Math.min(end, e) - s
      out.set(data.subarray(lo * BYTES_PER_SAMPLE, hi * BYTES_PER_SAMPLE), off)
      off += (hi - lo) * BYTES_PER_SAMPLE
    }
    return out
  }

  dropAll() {
    this.chunks = []
    this.retainedStart = this.total
  }
}

