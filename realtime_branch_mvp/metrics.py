"""Timing / usage / evaluation log (JSONL).

Server timings use ``time.monotonic``; browser timings are measured with
``performance.now`` in the browser and logged as-is with ``clock="browser"``.
Values from different clocks are never subtracted from each other.

Privacy: no raw audio, no base64, no API keys, no transcripts are written.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Optional

# Measurement boundaries (shown in the UI and README)
METRIC_DEFINITIONS = {
    "speech_start_event_to_first_preview_ms": "server: speech_started 受信 → 最初の有効な暫定分類受信",
    "vad_event_to_branch_ms": "server: speech_stopped 受信 → 有効な final 分岐確定（物理的な発話終了からではない）",
    "request_to_branch_ms": "server: final response.create 送信 → 有効な final 受信",
    "decision_message_to_playback_started_ms": "browser: 再生指示受信 → 実際の再生開始（同一ブラウザ時計）",
    "client_notification_speech_stopped_to_playback_started_ms": "browser: speech_stopped 通知受信 → 再生開始（参考・client-notification基準）",
    "speech_start_to_next_playback_ms": "server: speech_started → 次の再生指示送信（ユーザー自身の発話時間を含む。純粋なシステム遅延ではない）",
}

_FORBIDDEN_KEYS = {"audio", "pcm", "base64", "transcript", "api_key", "authorization"}


def _scrub(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items() if k.lower() not in _FORBIDDEN_KEYS}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    if isinstance(obj, str) and len(obj) > 500:
        return obj[:500]
    return obj


class SessionMetrics:
    def __init__(self, log_dir: Path, session_id: str, clock=time.monotonic):
        self.path = Path(log_dir) / f"{session_id}.jsonl"
        self.session_id = session_id
        self.clock = clock
        self.t0 = clock()
        self.counters: dict[str, int] = {
            "turns": 0, "preview_requests": 0, "preview_results": 0, "preview_changes": 0,
            "preview_invalidated": 0, "final_requests": 0, "final_invalidated": 0, "fallbacks": 0,
            "audio_cache_hit": 0, "audio_cache_miss": 0, "playback_failed": 0, "stale_ignored": 0,
            "dropped_frames_while_playing": 0,
        }
        self.realtime_usage = {"responses": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        self._fh = open(self.path, "a", encoding="utf-8")

    def now_ms(self) -> float:
        return (self.clock() - self.t0) * 1000.0

    def inc(self, name: str, n: int = 1) -> None:
        self.counters[name] = self.counters.get(name, 0) + n

    def add_usage(self, usage: Optional[dict]) -> None:
        if not usage:
            return
        self.realtime_usage["responses"] += 1
        for k in ("input_tokens", "output_tokens", "total_tokens"):
            v = usage.get(k)
            if isinstance(v, int):
                self.realtime_usage[k] += v

    def event(self, kind: str, **fields: Any) -> dict:
        rec = {"t_ms": round(self.now_ms(), 1), "session_id": self.session_id, "event": kind, **_scrub(fields)}
        if not self._fh.closed:
            self._fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self._fh.flush()
        return rec

    def close(self, **summary: Any) -> None:
        self.event("summary", counters=self.counters, realtime_usage=self.realtime_usage, **summary)
        self._fh.close()
