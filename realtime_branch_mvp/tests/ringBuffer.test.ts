import { describe, expect, it } from 'vitest'
import { PcmRing, runtimeFromUser } from '../server/lib/realtimeSession'

const pcm = (vals: number[]) => { const b = new Uint8Array(vals.length * 2); const dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setInt16(i * 2, v, true)); return b }
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i)

describe('PcmRing + runtime settings', () => {
  it('slices across chunk boundaries', () => {
    const r = new PcmRing(1000)
    r.append(pcm(range(0, 10))); r.append(pcm(range(10, 25))); r.append(pcm(range(25, 30)))
    expect(r.total).toBe(30)
    expect(r.slice(8, 12)).toEqual(pcm([8, 9, 10, 11]))
    expect(r.slice(0, 30)).toEqual(pcm(range(0, 30)))
    expect(r.slice(30, 30)).toEqual(new Uint8Array(0))
  })

  it('evicts old samples; out-of-range → null; odd byte frame rejected; dropAll keeps the absolute timeline', () => {
    const r = new PcmRing(20)
    for (let i = 0; i < 5; i++) r.append(pcm(Array(10).fill(i)))
    expect(r.retainedStart).toBeGreaterThanOrEqual(20)
    expect(r.slice(0, 10)).toBeNull()
    expect(r.slice(r.retainedStart, r.total)).not.toBeNull()
    expect(r.slice(r.total - 5, r.total + 1)).toBeNull()
    expect(() => new PcmRing(100).append(new Uint8Array(3))).toThrow()
    const r2 = new PcmRing(1000)
    r2.append(pcm(Array(100).fill(1)))
    r2.dropAll()
    expect(r2.total).toBe(100); expect(r2.slice(0, 10)).toBeNull()
    r2.append(pcm(Array(10).fill(2)))
    expect(r2.slice(100, 110)).toEqual(pcm(Array(10).fill(2)))
  })

  it('runtime settings bounds and booleans', () => {
    const rs = runtimeFromUser({ silence_duration_ms: 700, final_grace_ms: 0, preview_enabled: false, barge_in_enabled: true, barge_in_confirm_ms: 100 })
    expect(rs.silence_duration_ms).toBe(700); expect(rs.final_grace_ms).toBe(0); expect(rs.preview_enabled).toBe(false)
    expect(rs.barge_in_enabled).toBe(true); expect(rs.barge_in_confirm_ms).toBe(100)
    expect(() => runtimeFromUser({ silence_duration_ms: 50 })).toThrow()
    expect(() => runtimeFromUser({ final_grace_ms: 'abc' })).toThrow()
    expect(() => runtimeFromUser({ barge_in_confirm_ms: 5000 })).toThrow()
  })
})
