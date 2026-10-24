/**
 * Timing / usage / evaluation log (JSONL).
 * Server timings use performance.now() (monotonic); browser timings are
 * measured with performance.now in the browser and logged with clock="browser".
 * Values from different clocks are never subtracted from each other.
 * Privacy: no raw audio, no base64, no API keys, no transcripts are written.
 */
import fs from 'node:fs'
import path from 'node:path'

export const METRIC_DEFINITIONS: Record<string, string> = {
  speech_start_event_to_first_preview_ms: 'server: speech_started 受信 → 最初の有効な暫定分類受信',
  vad_event_to_branch_ms: 'server: speech_stopped 受信 → 有効な final 分岐確定（物理的な発話終了からではない）',
  request_to_branch_ms: 'server: final response.create 送信 → 有効な final 受信',
  decision_message_to_playback_started_ms: 'browser: 再生指示受信 → 実際の再生開始（同一ブラウザ時計）',
  client_notification_speech_stopped_to_playback_started_ms: 'browser: speech_stopped 通知受信 → 再生開始（参考・client-notification基準）',
  speech_start_to_next_playback_ms: 'server: speech_started → 次の再生指示送信（ユーザー自身の発話時間を含む。純粋なシステム遅延ではない）',
  barge_in_speech_start_to_playback_stop_ms: 'server: 再生中の speech_started 受信 → 再生停止指示送信（割り込み確認猶予を含む）',
}

const FORBIDDEN = new Set(['audio', 'pcm', 'base64', 'transcript', 'api_key', 'authorization'])

function scrub(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(scrub)
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).filter(([k]) => !FORBIDDEN.has(k.toLowerCase())).map(([k, v]) => [k, scrub(v)]))
  if (typeof o === 'string' && o.length > 500) return o.slice(0, 500)
  return o
}

export class SessionMetrics {
  path: string
  t0: number
  counters: Record<string, number> = {
    turns: 0, preview_requests: 0, preview_results: 0, preview_changes: 0, preview_invalidated: 0, final_requests: 0,
    final_invalidated: 0, fallbacks: 0, audio_cache_hit: 0, audio_cache_miss: 0, playback_failed: 0, stale_ignored: 0,
    dropped_frames_while_playing: 0, barge_in: 0, barge_in_rejected: 0,
  }
  realtimeUsage = { responses: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  private fd: number | null

  constructor(logDir: string, public sessionId: string, public clock: () => number = () => performance.now()) {
    fs.mkdirSync(logDir, { recursive: true })
    this.path = path.join(logDir, `${sessionId}.jsonl`)
    this.fd = fs.openSync(this.path, 'a')
    this.t0 = clock()
  }

  nowMs = () => this.clock() - this.t0
  inc(name: string, n = 1) { this.counters[name] = (this.counters[name] ?? 0) + n }

  addUsage(usage: Record<string, unknown> | null | undefined) {
    if (!usage) return
    this.realtimeUsage.responses++
    for (const k of ['input_tokens', 'output_tokens', 'total_tokens'] as const) if (typeof usage[k] === 'number') this.realtimeUsage[k] += usage[k] as number
  }

  event(kind: string, fields: Record<string, unknown> = {}) {
    const rec = { t_ms: Math.round(this.nowMs() * 10) / 10, session_id: this.sessionId, event: kind, ...(scrub(fields) as Record<string, unknown>) }
    if (this.fd !== null) fs.writeSync(this.fd, JSON.stringify(rec) + '\n')
    return rec
  }

  close(summary: Record<string, unknown> = {}) {
    this.event('summary', { counters: this.counters, realtime_usage: this.realtimeUsage, ...summary })
    if (this.fd !== null) fs.closeSync(this.fd)
    this.fd = null
  }
}
