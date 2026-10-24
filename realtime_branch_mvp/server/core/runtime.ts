/** Per-session runtime settings (UI-selectable within server-enforced bounds). */
export interface RuntimeSettings {
  silence_duration_ms: number
  prefix_padding_ms: number
  vad_threshold: number
  preview_enabled: boolean
  preview_min_audio_ms: number
  preview_interval_ms: number
  preview_max_per_utterance: number
  preview_timeout_ms: number
  final_grace_ms: number
  final_timeout_ms: number
  item_wait_timeout_ms: number
  playback_start_timeout_ms: number
  playback_end_slack_ms: number
  session_ready_timeout_ms: number
  max_utterance_ms: number
  max_classification_requests: number
  ring_seconds: number
  /** Hard cap on one conversation (cost / runaway guard). */
  session_max_ms: number
  /** Full-duplex: keep streaming the mic while the assistant speaks and stop playback on confirmed user speech. */
  barge_in_enabled: boolean
  /** Speech must last this long after speech_started before playback is stopped (echo / noise guard). */
  barge_in_confirm_ms: number
  /** Assumption (verify against the live API): audio_start_ms is measured from the start of all audio
   * written during the session and does not reset on clear. */
  vad_timeline_resets_on_clear: boolean
}

export const RUNTIME_BOUNDS: Record<string, [number, number]> = {
  silence_duration_ms: [200, 2000], prefix_padding_ms: [0, 1000], vad_threshold: [0.1, 0.95],
  preview_min_audio_ms: [300, 3000], preview_interval_ms: [300, 3000], preview_max_per_utterance: [0, 5],
  final_grace_ms: [0, 1500], final_timeout_ms: [2000, 20000], max_utterance_ms: [3000, 30000],
  barge_in_confirm_ms: [0, 1500], session_max_ms: [30000, 1800000],
}
const RUNTIME_BOOLS = ['preview_enabled', 'barge_in_enabled'] as const

export const defaultRuntime = (o: Partial<RuntimeSettings> = {}): RuntimeSettings => ({
  silence_duration_ms: 600, prefix_padding_ms: 300, vad_threshold: 0.5, preview_enabled: true, preview_min_audio_ms: 800,
  preview_interval_ms: 800, preview_max_per_utterance: 3, preview_timeout_ms: 5000, final_grace_ms: 200, final_timeout_ms: 8000,
  item_wait_timeout_ms: 4000, playback_start_timeout_ms: 6000, playback_end_slack_ms: 8000, session_ready_timeout_ms: 10000,
  max_utterance_ms: 20000, max_classification_requests: 150, ring_seconds: 40, session_max_ms: 600000, barge_in_enabled: false, barge_in_confirm_ms: 250,
  vad_timeline_resets_on_clear: false, ...o,
})

export function runtimeFromUser(data: Record<string, unknown> | null | undefined): RuntimeSettings {
  const rs = defaultRuntime()
  if (!data) return rs
  for (const [k, [lo, hi]] of Object.entries(RUNTIME_BOUNDS)) {
    if (!(k in data)) continue
    const v = Number(data[k])
    if (!Number.isFinite(v)) throw new Error(`${k} が数値ではありません`)
    if (v < lo || v > hi) throw new Error(`${k} は ${lo}〜${hi} の範囲で指定してください`)
    ;(rs as any)[k] = Number.isInteger(rs[k as keyof RuntimeSettings]) ? Math.round(v) : v
  }
  for (const k of RUNTIME_BOOLS) if (k in data) rs[k] = !!data[k]
  return rs
}

