"""Realtime conversation engine: VAD, streaming preview / final classification,
cancellation, stale-result rejection, half-duplex playback with acks.

The engine never calls Claude or TTS. Every spoken utterance comes from the
pre-generated manifest; a cache miss stops the session safely.

All state changes are serialized through one asyncio queue (browser messages,
browser audio, Realtime server events, timers), so ordering is deterministic.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets
import time
from collections import deque
from dataclasses import dataclass, field, fields
from enum import Enum
from typing import Any, Awaitable, Callable, Optional

import router
from audio_store import AudioStore
from metrics import SessionMetrics
from scenario_schema import CTRL_END_REQUEST, CTRL_UNCLEAR, ControlAction, Scenario

log = logging.getLogger("realtime")

SAMPLE_RATE = 24000
BYTES_PER_SAMPLE = 2
SAMPLES_PER_MS = SAMPLE_RATE // 1000


class Phase(str, Enum):
    CONNECTING = "CONNECTING"
    PLAYING = "PLAYING"
    LISTENING = "LISTENING"
    DECIDING = "DECIDING"
    PLAYBACK_ERROR = "PLAYBACK_ERROR"
    FINISHED = "FINISHED"
    STOPPED = "STOPPED"
    ERROR = "ERROR"


TERMINAL_PHASES = {Phase.FINISHED, Phase.STOPPED, Phase.ERROR}


@dataclass
class RuntimeSettings:
    """Per-session tunables (UI-selectable within these bounds)."""
    silence_duration_ms: int = 600
    prefix_padding_ms: int = 300
    vad_threshold: float = 0.5
    preview_enabled: bool = True
    preview_min_audio_ms: int = 800
    preview_interval_ms: int = 800
    preview_max_per_utterance: int = 3
    preview_timeout_ms: int = 5000
    final_grace_ms: int = 200
    final_timeout_ms: int = 8000
    item_wait_timeout_ms: int = 4000
    playback_start_timeout_ms: int = 6000
    playback_end_slack_ms: int = 8000
    session_ready_timeout_ms: int = 10000
    max_utterance_ms: int = 20000
    max_classification_requests: int = 150
    ring_seconds: int = 40
    # Assumption (verify against the live API): audio_start_ms is measured from the
    # start of all audio written during the session and does not reset on clear.
    vad_timeline_resets_on_clear: bool = False

    BOUNDS = {
        "silence_duration_ms": (200, 2000), "prefix_padding_ms": (0, 1000), "vad_threshold": (0.1, 0.95),
        "preview_min_audio_ms": (300, 3000), "preview_interval_ms": (300, 3000), "preview_max_per_utterance": (0, 5),
        "final_grace_ms": (0, 1500), "final_timeout_ms": (2000, 20000), "max_utterance_ms": (3000, 30000),
    }

    @classmethod
    def from_user(cls, data: Optional[dict]) -> "RuntimeSettings":
        rs = cls()
        if not data:
            return rs
        names = {f.name for f in fields(cls)}
        for k, (lo, hi) in cls.BOUNDS.items():
            if k in data and k in names:
                try:
                    v = float(data[k])
                except (TypeError, ValueError):
                    raise ValueError(f"{k} が数値ではありません")
                if not (lo <= v <= hi):
                    raise ValueError(f"{k} は {lo}〜{hi} の範囲で指定してください")
                setattr(rs, k, v if isinstance(getattr(rs, k), float) else int(v))
        if "preview_enabled" in data:
            rs.preview_enabled = bool(data["preview_enabled"])
        return rs

    def as_dict(self) -> dict:
        return {f.name: getattr(self, f.name) for f in fields(self)}


# ---------------------------------------------------------------------------
# PCM ring buffer (memory only, discarded at session end)
# ---------------------------------------------------------------------------

class PcmRing:
    """Keeps the most recent ``capacity_samples`` of PCM16 audio that was sent to
    Realtime, addressed by absolute sample index since the session's first append."""

    def __init__(self, capacity_samples: int):
        self.capacity = capacity_samples
        self.chunks: deque[tuple[int, bytes]] = deque()
        self.total = 0           # absolute samples appended so far
        self.retained_start = 0  # first absolute sample still retained

    def append(self, pcm: bytes) -> int:
        if len(pcm) % BYTES_PER_SAMPLE:
            raise ValueError("PCM16 frame must have an even number of bytes")
        start = self.total
        self.chunks.append((start, bytes(pcm)))
        self.total += len(pcm) // BYTES_PER_SAMPLE
        while self.chunks and self.total - self.chunks[0][0] - len(self.chunks[0][1]) // BYTES_PER_SAMPLE >= self.capacity:
            s, b = self.chunks.popleft()
            self.retained_start = s + len(b) // BYTES_PER_SAMPLE
        return start

    def slice(self, start: int, end: int) -> Optional[bytes]:
        """Bytes for samples [start, end). None if any part is no longer retained."""
        if start < self.retained_start or end > self.total or start > end:
            return None
        out = bytearray()
        for s, b in self.chunks:
            n = len(b) // BYTES_PER_SAMPLE
            e = s + n
            if e <= start or s >= end:
                continue
            lo = max(start, s) - s
            hi = min(end, e) - s
            out += b[lo * BYTES_PER_SAMPLE: hi * BYTES_PER_SAMPLE]
        return bytes(out)

    def drop_all(self) -> None:
        self.chunks.clear()
        self.retained_start = self.total


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

class TransportClosed(Exception):
    pass


class RealtimeTransport:
    is_mock = False

    async def connect(self) -> None: ...
    async def send(self, event: dict) -> None: ...
    async def recv(self) -> dict: ...
    async def close(self) -> None: ...

    def buffered_bytes(self) -> int:
        return 0

    async def control(self, msg: dict) -> None:  # mock only
        pass


class OpenAIRealtimeTransport(RealtimeTransport):
    """Raw GA WebSocket: wss://api.openai.com/v1/realtime?model=… with Bearer auth."""

    def __init__(self, url: str, model: str, api_key: str):
        if not model:
            raise ValueError("REALTIME_MODEL が未設定です")
        if not api_key:
            raise ValueError("OPENAI_API_KEY が未設定です")
        self.url = f"{url}?model={model}"
        self._key = api_key
        self.ws = None

    async def connect(self) -> None:
        from websockets.asyncio.client import connect

        self.ws = await connect(self.url, additional_headers={"Authorization": f"Bearer {self._key}"},
                                max_size=8 * 1024 * 1024, open_timeout=10)

    async def send(self, event: dict) -> None:
        from websockets.exceptions import ConnectionClosed
        try:
            await self.ws.send(json.dumps(event))
        except ConnectionClosed as e:
            raise TransportClosed(str(e)) from e

    async def recv(self) -> dict:
        from websockets.exceptions import ConnectionClosed
        try:
            raw = await self.ws.recv()
        except ConnectionClosed as e:
            raise TransportClosed(str(e)) from e
        return json.loads(raw)

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close()

    def buffered_bytes(self) -> int:
        try:
            return self.ws.transport.get_write_buffer_size()
        except Exception:
            return 0


class MockRealtimeTransport(RealtimeTransport):
    """Local stand-in for the Realtime API (no network, no model).

    VAD boundaries and the branch it "classifies" are chosen manually from the UI
    (or by tests). It exists so the end-to-end playback / state machine can be
    demoed and tested; it does not understand audio.
    """
    is_mock = True

    def __init__(self, response_delay_s: float = 0.15):
        self.out: asyncio.Queue = asyncio.Queue()
        self.delay = response_delay_s
        self.appended_samples = 0
        self.sent: list[dict] = []
        self.preview_choice: Optional[str] = None
        self.final_choice: Optional[str] = None
        self._speech_item: Optional[str] = None
        self._tasks: set[asyncio.Task] = set()
        self._responses: dict[str, asyncio.Task] = {}
        self.closed = False

    async def connect(self) -> None:
        pass

    def _emit(self, ev: dict) -> None:
        self.out.put_nowait(ev)

    async def send(self, event: dict) -> None:
        if self.closed:
            raise TransportClosed("mock closed")
        t = event.get("type")
        rec = dict(event)
        if t == "input_audio_buffer.append":
            n = len(base64.b64decode(event["audio"])) // BYTES_PER_SAMPLE
            self.appended_samples += n
            rec = {"type": t, "samples": n}
        self.sent.append(rec)
        if t == "session.update":
            self._emit({"type": "session.updated", "session": event.get("session", {})})
        elif t == "input_audio_buffer.clear":
            self._emit({"type": "input_audio_buffer.cleared"})
        elif t == "conversation.item.create":
            item = dict(event["item"])
            item.setdefault("id", "item_" + secrets.token_hex(4))
            self._emit({"type": "conversation.item.added", "item": {**item, "content": []}})
            self._emit({"type": "conversation.item.done", "item": {**item, "content": []}})
        elif t == "conversation.item.delete":
            self._emit({"type": "conversation.item.deleted", "item_id": event["item_id"]})
        elif t == "response.create":
            rid = "resp_" + secrets.token_hex(4)
            task = asyncio.get_running_loop().create_task(self._respond(rid, event))
            self._responses[rid] = task
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        elif t == "response.cancel":
            rid = event.get("response_id")
            task = self._responses.get(rid)
            if task and not task.done():
                task.cancel()

    async def _respond(self, rid: str, event: dict) -> None:
        resp = event["response"]
        md = resp.get("metadata") or {}
        self._emit({"type": "response.created", "response": {"id": rid, "metadata": md, "status": "in_progress"}})
        try:
            await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            self._emit({"type": "response.done", "response": {"id": rid, "metadata": md, "status": "cancelled",
                                                                "status_details": {"reason": "client_cancelled"}, "output": []}})
            return
        choice = self.preview_choice if md.get("phase") == "preview" else self.final_choice
        if choice is None:
            choice = CTRL_UNCLEAR
        self._emit({"type": "response.done", "response": {
            "id": rid, "metadata": md, "status": "completed",
            "output": [{"type": "function_call", "name": router.TOOL_NAME, "call_id": "call_" + rid,
                        "status": "completed",
                        "arguments": json.dumps({"branch_id": choice, "reason": "MOCK: 手動選択"}, ensure_ascii=False)}],
            "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        }})

    async def control(self, msg: dict) -> None:
        if "preview_branch" in msg:
            self.preview_choice = msg.get("preview_branch") or None
        if "final_branch" in msg:
            self.final_choice = msg.get("final_branch") or None
        action = msg.get("action")
        ms = self.appended_samples // SAMPLES_PER_MS
        if action == "start" and self._speech_item is None:
            self._speech_item = "item_" + secrets.token_hex(4)
            self._emit({"type": "input_audio_buffer.speech_started", "item_id": self._speech_item,
                        "audio_start_ms": max(0, ms - 300)})
        elif action == "stop" and self._speech_item is not None:
            iid, self._speech_item = self._speech_item, None
            self._emit({"type": "input_audio_buffer.speech_stopped", "item_id": iid, "audio_end_ms": ms})
            self._emit({"type": "input_audio_buffer.committed", "item_id": iid})
            item = {"id": iid, "type": "message", "role": "user", "status": "completed", "content": []}
            self._emit({"type": "conversation.item.added", "item": item})
            self._emit({"type": "conversation.item.done", "item": item})

    async def recv(self) -> dict:
        ev = await self.out.get()
        if ev is None:
            raise TransportClosed("mock closed")
        return ev

    async def close(self) -> None:
        self.closed = True
        for t in list(self._tasks):
            t.cancel()
        self.out.put_nowait(None)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

@dataclass
class Utterance:
    item_id: str
    start_sample: int
    t_started: float
    stopped: bool = False
    t_stopped: Optional[float] = None
    committed: bool = False
    item_done: bool = False
    previews_sent: int = 0
    last_preview_t: float = 0.0

    @property
    def ready(self) -> bool:
        return self.stopped and self.committed and self.item_done


@dataclass
class Pending:
    key: str
    phase: str  # preview | final
    turn_id: int
    generation: int
    node_id: str
    sent_at: float
    allowed: list[str]
    references: list[str] = field(default_factory=list)
    temp_item_id: Optional[str] = None
    response_id: Optional[str] = None
    awaiting_item: bool = False
    stale: bool = False
    done: bool = False
    request_event: Optional[dict] = None


@dataclass
class Playback:
    playback_id: str
    utterance_key: str
    text: str
    after: str  # listen | finish | goto
    next_node_id: str
    reason: str
    duration_ms: Optional[int]
    turn_id: int
    generation: int
    started: bool = False
    sent_at: float = 0.0


@dataclass
class Decision:
    branch_id: str
    generation: int
    reason: str
    fallback_reason: Optional[str]
    source: str  # realtime | timeout | error


BrowserSend = Callable[[dict], Awaitable[None]]


class EngineFatal(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class ConversationEngine:
    def __init__(
        self,
        *,
        session_id: str,
        scenario: Scenario,
        manifest: dict,
        audio: AudioStore,
        transport: RealtimeTransport,
        send_browser: BrowserSend,
        settings: RuntimeSettings,
        metrics: SessionMetrics,
        preview_audio_mode: str = "inline",
        max_frame_bytes: int = 24000,
        max_send_buffer: int = 4_000_000,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.session_id = session_id
        self.scenario = scenario  # frozen for the session
        self.manifest = json.loads(json.dumps(manifest))  # private immutable copy
        self.audio = audio
        self.transport = transport
        self.send_browser = send_browser
        self.rs = settings
        self.metrics = metrics
        self.preview_mode = preview_audio_mode
        self.max_frame_bytes = max_frame_bytes
        self.max_send_buffer = max_send_buffer
        self.clock = clock

        self.queue: asyncio.Queue = asyncio.Queue()
        self.phase = Phase.CONNECTING
        self.mic_enabled = False
        self.node_id = scenario.entry_node_id
        self.last_prompt_text = ""
        self.turn_id = 0
        self.generation = 0
        self.counters = router.Counters()
        self.history: list[tuple[str, str]] = []

        self.ring = PcmRing(settings.ring_seconds * SAMPLE_RATE)
        self.vad_base_sample = 0
        self.listen_start_sample = 0
        self.utterances: list[Utterance] = []
        self.active: Optional[Utterance] = None
        self.pending: dict[str, Pending] = {}
        self.resp_to_key: dict[str, str] = {}
        self.decision: Optional[Decision] = None
        self.final_issued_generation: Optional[int] = None
        self.last_preview_branch: Optional[str] = None
        self.first_preview_logged = False
        self.items_to_delete: list[str] = []
        self.requests_sent = 0
        self.playback: Optional[Playback] = None
        self.last_speech_started_t: Optional[float] = None
        self.interrupted: list[dict] = []
        self.end_reason = ""
        self.end_detail = ""
        self._timers: dict[str, int] = {}
        self._timer_tasks: dict[str, asyncio.Task] = {}
        self._reader: Optional[asyncio.Task] = None
        self.done = False

    # ------------------------------------------------------------------ public
    def push_browser_json(self, msg: dict) -> None:
        self.queue.put_nowait(("browser", msg))

    def push_browser_audio(self, data: bytes) -> None:
        self.queue.put_nowait(("audio", data))

    async def run(self) -> str:
        self.metrics.event("session_start", scenario_id=self.scenario.scenario_id, version=self.scenario.version,
                           runtime=self.rs.as_dict(), mock_realtime=self.transport.is_mock, preview_mode=self.preview_mode)
        try:
            try:
                await self.transport.connect()
            except Exception as e:
                raise EngineFatal("realtime_connect_failed", f"Realtime API に接続できません: {type(e).__name__}")
            self._reader = asyncio.get_running_loop().create_task(self._read_transport())
            await self._send_rt(self._session_update())
            self._set_timer("session_ready", self.rs.session_ready_timeout_ms)
            await self._emit_state()
            while not self.done:
                kind, payload = await self.queue.get()
                try:
                    await self._dispatch(kind, payload)
                except EngineFatal:
                    raise
                except TransportClosed:
                    raise EngineFatal("realtime_disconnected", self._disconnect_message())
        except EngineFatal as e:
            await self._finish(Phase.ERROR, e.code, e.message)
        except asyncio.CancelledError:
            await self._finish(Phase.STOPPED, "cancelled", "")
            raise
        finally:
            for t in self._timer_tasks.values():
                t.cancel()
            if self._reader:
                self._reader.cancel()
            try:
                await self.transport.close()
            except Exception:
                pass
            self.ring.drop_all()
            self.metrics.close(end_reason=self.end_reason, final_phase=self.phase.value, node_id=self.node_id,
                               interrupted=self.interrupted)
        return self.end_reason

    # ------------------------------------------------------------------ plumbing
    async def _read_transport(self) -> None:
        try:
            while True:
                ev = await self.transport.recv()
                self.queue.put_nowait(("rt", ev))
        except TransportClosed as e:
            self.queue.put_nowait(("rt_closed", str(e)))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.queue.put_nowait(("rt_closed", f"{type(e).__name__}"))

    def _set_timer(self, name: str, ms: float) -> None:
        self._cancel_timer(name)
        token = self._timers.get(name, 0) + 1
        self._timers[name] = token

        async def fire():
            await asyncio.sleep(ms / 1000.0)
            self.queue.put_nowait(("timer", (name, token)))

        self._timer_tasks[name] = asyncio.get_running_loop().create_task(fire())

    def _cancel_timer(self, name: str) -> None:
        t = self._timer_tasks.pop(name, None)
        if t:
            t.cancel()
        self._timers[name] = self._timers.get(name, 0) + 1  # invalidates any queued fire

    async def _send_rt(self, ev: dict) -> None:
        if self.transport.buffered_bytes() > self.max_send_buffer:
            raise EngineFatal("send_buffer_overflow", "Realtime への送信が詰まっています（過負荷）。安全のため停止しました。")
        await self.transport.send(ev)

    async def _latency(self, name: str, value_ms: float, **extra: Any) -> None:
        v = round(value_ms, 1)
        self.metrics.event("latency", name=name, value_ms=v, clock="server", **extra)
        await self._send_browser({"type": "metric", "name": name, "value_ms": v})

    async def _send_browser(self, msg: dict) -> None:
        try:
            await self.send_browser(msg)
        except Exception:
            pass  # browser gone; the app will push a disconnect message

    def _session_update(self) -> dict:
        return {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["text"],
                "instructions": router.SESSION_INSTRUCTIONS,
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": self.rs.vad_threshold,
                            "prefix_padding_ms": self.rs.prefix_padding_ms,
                            "silence_duration_ms": self.rs.silence_duration_ms,
                            "create_response": False,
                            "interrupt_response": False,
                        },
                    }
                },
                "tools": [],
                "tool_choice": "none",
            },
        }

    def _disconnect_message(self) -> str:
        if self.phase == Phase.PLAYING and self.playback:
            return (f"音声再生中（{self.playback.utterance_key}）に Realtime 接続が切断されました。"
                    "次のノードへは自動で進みません。新しいセッションで再開始してください。")
        return "Realtime 接続が切断されました。新しいセッションで再開始してください。"

    # ------------------------------------------------------------------ dispatch
    async def _dispatch(self, kind: str, payload: Any) -> None:
        if self.done:
            return
        if kind == "audio":
            await self._on_audio(payload)
        elif kind == "browser":
            await self._on_browser(payload)
        elif kind == "rt":
            await self._on_rt(payload)
        elif kind == "rt_closed":
            raise EngineFatal("realtime_disconnected", self._disconnect_message())
        elif kind == "timer":
            name, token = payload
            if self._timers.get(name) == token:
                self._timer_tasks.pop(name, None)
                await self._on_timer(name)

    # ------------------------------------------------------------------ audio in
    async def _on_audio(self, data: bytes) -> None:
        if not self.mic_enabled:
            # Half-duplex: audio arriving while the assistant is playing is not
            # an answer; it is counted (not silently treated as overload).
            self.metrics.inc("dropped_frames_while_playing")
            return
        if len(data) > self.max_frame_bytes or len(data) % BYTES_PER_SAMPLE:
            raise EngineFatal("bad_audio_frame", "不正な音声フレームを受信しました。")
        self.ring.append(data)
        await self._send_rt({"type": "input_audio_buffer.append", "audio": base64.b64encode(data).decode("ascii")})
        u = self.active
        if u and not u.stopped:
            if (self.ring.total - u.start_sample) > self.rs.max_utterance_ms * SAMPLES_PER_MS:
                raise EngineFatal("utterance_too_long", f"1回の発話が上限 {self.rs.max_utterance_ms}ms を超えました。安全のため停止しました。")
            await self._maybe_preview(u)

    # ------------------------------------------------------------------ browser
    async def _on_browser(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "stop":
            await self._finish(Phase.STOPPED, "user_stop", "利用者が停止しました。")
        elif t == "_disconnect":
            where = f"（再生中: {self.playback.utterance_key}）" if self.phase == Phase.PLAYING and self.playback else ""
            await self._finish(Phase.STOPPED, "browser_disconnected", f"ブラウザが切断されました{where}。再開は新しいセッションで行ってください。")
        elif t in ("playback_started", "playback_ended", "playback_failed", "playback_canceled"):
            await self._on_playback_ack(t, msg)
        elif t == "playback_retry":
            if self.phase == Phase.PLAYBACK_ERROR and self.playback:
                pb = self.playback
                await self._play(pb.utterance_key, pb.text, pb.after, pb.next_node_id, pb.reason)
        elif t == "client_metric":
            name = str(msg.get("name", ""))[:80]
            val = msg.get("value_ms")
            if isinstance(val, (int, float)):
                self.metrics.event("client_metric", clock="browser", name=name, value_ms=round(float(val), 1),
                                   playback_id=str(msg.get("playback_id", ""))[:40], turn_id=msg.get("turn_id"))
        elif t == "mock_vad":
            if self.transport.is_mock:
                await self.transport.control(msg)
        else:
            self.metrics.event("unknown_browser_message", type=str(t)[:40])

    # ------------------------------------------------------------------ playback
    async def _play(self, key: str, text: str, after: str, next_node_id: str, reason: str) -> None:
        entry = self.manifest["entries"].get(key)
        if not entry or entry.get("status") != "ready" or not self.audio.is_ready(entry.get("audio_id", "")):
            self.metrics.inc("audio_cache_miss")
            # never synthesize on the conversation path
            raise EngineFatal("audio_cache_miss", f"事前生成音声がありません（{key}）。準備不備のため安全に停止しました。")
        self.metrics.inc("audio_cache_hit")
        self.mic_enabled = False
        self.phase = Phase.PLAYING
        pb = Playback(
            playback_id="pb_" + secrets.token_hex(5), utterance_key=key, text=text, after=after,
            next_node_id=next_node_id, reason=reason, duration_ms=entry.get("duration_ms"),
            turn_id=self.turn_id, generation=self.generation, sent_at=self.clock(),
        )
        self.playback = pb
        if self.last_speech_started_t is not None and reason not in ("entry", "goto", "retry"):
            await self._latency("speech_start_to_next_playback_ms", (pb.sent_at - self.last_speech_started_t) * 1000, note="includes the user's own speaking time")
        await self._send_browser({
            "type": "play", "playback_id": pb.playback_id, "turn_id": pb.turn_id,
            "decision_generation": pb.generation, "utterance_key": key, "text": text,
            "audio_id": entry["audio_id"], "url": f"/api/audio/{entry['audio_id']}", "mime": entry.get("mime"),
            "terminal_after": after == "finish",
        })
        self._set_timer("playback_start", self.rs.playback_start_timeout_ms)
        await self._emit_state()

    async def _on_playback_ack(self, t: str, msg: dict) -> None:
        pb = self.playback
        pid = msg.get("playback_id")
        if not pb or pid != pb.playback_id or self.phase not in (Phase.PLAYING, Phase.PLAYBACK_ERROR):
            self.metrics.inc("stale_ignored")
            self.metrics.event("stale_playback_ack", ack=t, playback_id=str(pid)[:40])
            return
        if t == "playback_started":
            if pb.started:
                return
            pb.started = True
            self._cancel_timer("playback_start")
            dur = pb.duration_ms or 60000
            self._set_timer("playback_end", dur + self.rs.playback_end_slack_ms)
        elif t == "playback_failed":
            self._cancel_timer("playback_start")
            self._cancel_timer("playback_end")
            self.metrics.inc("playback_failed")
            self.metrics.event("playback_failed", playback_id=pid, utterance_key=pb.utterance_key,
                               error=str(msg.get("error", ""))[:200])
            self.phase = Phase.PLAYBACK_ERROR
            await self._send_browser({"type": "playback_error", "playback_id": pid, "utterance_key": pb.utterance_key,
                                      "message": "音声を再生できませんでした。再試行するか、停止してください。"})
            await self._emit_state()
        elif t in ("playback_ended", "playback_canceled"):
            self._cancel_timer("playback_start")
            self._cancel_timer("playback_end")
            if t == "playback_canceled":
                rec = {"utterance_key": pb.utterance_key, "node_id": self.node_id, "position_ms": msg.get("position_ms"),
                       "turn_id": self.turn_id}
                self.interrupted.append(rec)
                self.metrics.event("playback_interrupted", **rec)
            await self._after_playback(pb)

    async def _after_playback(self, pb: Playback) -> None:
        self.playback = None
        if pb.after == "finish":
            await self._finish(Phase.FINISHED, "completed", "会話が終了しました。")
            return
        if pb.after == "goto":
            step = router.node_step(self.scenario, pb.next_node_id, "goto")
            self.node_id = step.next_node_id
            await self._play(step.play_key, step.play_text, step.after, step.next_node_id, "goto")
            return
        # listen: answer pb.next_node_id (fallback returns here without re-speaking)
        self.node_id = pb.next_node_id
        self.last_prompt_text = pb.text
        await self._start_listening()

    # ------------------------------------------------------------------ listening
    async def _start_listening(self) -> None:
        self.turn_id += 1
        self.metrics.inc("turns")
        self.utterances = []
        self.active = None
        self.decision = None
        self.final_issued_generation = None
        self.last_preview_branch = None
        self.first_preview_logged = False
        # Mic was off during playback, nothing is being spoken or referenced → safe to clear.
        await self._send_rt({"type": "input_audio_buffer.clear"})
        self.ring.drop_all()
        self.listen_start_sample = self.ring.total
        if self.rs.vad_timeline_resets_on_clear:
            self.vad_base_sample = self.ring.total
        self.phase = Phase.LISTENING
        self.mic_enabled = True
        node = self.scenario.node(self.node_id)
        assert node is not None
        self._set_timer("no_input", self.scenario.policy.no_input_timeout_ms)
        await self._send_browser({"type": "prefetch", "audio_ids": self._candidate_audio_ids(node, None)})
        await self._emit_state()
        await self._gc_items()

    def _candidate_audio_ids(self, node, preferred: Optional[str]) -> list[str]:
        keys: list[str] = []
        order = [e for e in node.edges]
        if preferred:
            order.sort(key=lambda e: 0 if e.id == preferred else 1)
        for e in order:
            keys.append(f"node:{e.target_node_id}")
        for cid in (node.fallback_node_id, node.no_input_node_id,
                    self.scenario.policy.end_request_node_id, self.scenario.policy.limit_node_id):
            if cid:
                keys.append(f"control:{cid}")
        out = []
        for k in keys:
            e = self.manifest["entries"].get(k)
            if e and e["audio_id"] not in out:
                out.append(e["audio_id"])
        return out

    # ------------------------------------------------------------------ realtime events
    async def _on_rt(self, ev: dict) -> None:
        t = ev.get("type", "")
        if t == "session.updated":
            if self.phase == Phase.CONNECTING:
                self._cancel_timer("session_ready")
                step = router.entry_step(self.scenario)
                self.node_id = step.next_node_id
                await self._play(step.play_key, step.play_text, step.after, step.next_node_id, "entry")
        elif t == "input_audio_buffer.speech_started":
            await self._on_speech_started(ev)
        elif t == "input_audio_buffer.speech_stopped":
            await self._on_speech_stopped(ev)
        elif t == "input_audio_buffer.committed":
            u = self._utt(ev.get("item_id"))
            if u:
                u.committed = True
                await self._maybe_final()
        elif t in ("conversation.item.done", "conversation.item.added"):
            item = ev.get("item") or {}
            iid = item.get("id")
            u = self._utt(iid)
            if u and t == "conversation.item.done":
                u.item_done = True
                await self._maybe_final()
            else:
                await self._on_temp_item_ready(iid, t)
        elif t == "response.created":
            resp = ev.get("response") or {}
            key = (resp.get("metadata") or {}).get("request_key")
            if key and key in self.pending and resp.get("id"):
                self.pending[key].response_id = resp["id"]
                self.resp_to_key[resp["id"]] = key
                if self.pending[key].stale:
                    await self._cancel_response(self.pending[key])
        elif t == "response.done":
            await self._on_response_done(ev.get("response") or {})
        elif t == "error":
            await self._on_rt_error(ev.get("error") or {})
        elif t == "conversation.item.deleted":
            pass

    def _utt(self, item_id: Optional[str]) -> Optional[Utterance]:
        return next((u for u in self.utterances if u.item_id == item_id), None)

    async def _on_speech_started(self, ev: dict) -> None:
        if self.phase not in (Phase.LISTENING, Phase.DECIDING) or not self.mic_enabled:
            self.metrics.event("speech_started_ignored", phase=self.phase.value)
            return
        self._cancel_timer("no_input")
        now = self.clock()
        self.last_speech_started_t = now
        if self.final_issued_generation is not None or self.decision is not None:
            # user resumed speaking before the decided audio started → old decision is stale
            await self._invalidate_final("re_utterance")
        start_ms = int(ev.get("audio_start_ms") or 0)
        start = self.vad_base_sample + start_ms * SAMPLES_PER_MS
        start = max(start, self.listen_start_sample)  # never include previous turns / assistant time
        u = Utterance(item_id=ev.get("item_id") or f"unknown_{len(self.utterances)}", start_sample=start, t_started=now)
        self.utterances.append(u)
        self.active = u
        self.phase = Phase.LISTENING
        self.metrics.event("speech_started", turn_id=self.turn_id, item_id=u.item_id, audio_start_ms=start_ms,
                           utterance_index=len(self.utterances))
        node = self.scenario.node(self.node_id)
        await self._send_browser({"type": "speech_started", "turn_id": self.turn_id})
        await self._send_browser({"type": "prefetch", "audio_ids": self._candidate_audio_ids(node, self.last_preview_branch)})
        await self._emit_state()

    async def _on_speech_stopped(self, ev: dict) -> None:
        u = self._utt(ev.get("item_id")) or self.active
        if not u or u.stopped:
            return
        u.stopped = True
        u.t_stopped = self.clock()
        if self.active is u:
            self.active = None
        self.phase = Phase.DECIDING
        self.metrics.event("speech_stopped", turn_id=self.turn_id, item_id=u.item_id, audio_end_ms=ev.get("audio_end_ms"))
        await self._send_browser({"type": "speech_stopped", "turn_id": self.turn_id})
        self._set_timer("item_wait", self.rs.item_wait_timeout_ms)
        await self._emit_state()
        await self._maybe_final()

    # ------------------------------------------------------------------ preview
    def _live(self, phase: str) -> list[Pending]:
        return [p for p in self.pending.values() if p.phase == phase and not p.done and not p.stale]

    async def _maybe_preview(self, u: Utterance) -> None:
        rs = self.rs
        if not rs.preview_enabled or u.previews_sent >= rs.preview_max_per_utterance:
            return
        if self._live("preview") or self._live("final") or self.decision is not None:
            return
        now = self.clock()
        if u.previews_sent and (now - u.last_preview_t) * 1000 < rs.preview_interval_ms:
            return
        if (self.ring.total - u.start_sample) < rs.preview_min_audio_ms * SAMPLES_PER_MS:
            return
        if self.requests_sent >= rs.max_classification_requests:
            raise EngineFatal("too_many_requests", "分類リクエスト数の上限に達しました。安全のため停止しました。")
        prefix = self.ring.slice(u.start_sample, self.ring.total)
        if prefix is None:
            u.previews_sent = rs.preview_max_per_utterance
            self.metrics.event("preview_skipped", reason="prefix_unavailable")
            return
        u.previews_sent += 1
        u.last_preview_t = now
        refs = [x.item_id for x in self.utterances if x is not u and x.ready]
        node = self.scenario.node(self.node_id)
        audio_b64 = base64.b64encode(prefix).decode("ascii")
        p = self._new_pending("preview", node, refs)
        audio_msg = {"type": "message", "role": "user", "content": [{"type": "input_audio", "audio": audio_b64}]}
        if self.preview_mode == "item":
            p.temp_item_id = "pv_" + secrets.token_hex(6)
            p.awaiting_item = True
            await self._send_rt({"type": "conversation.item.create", "event_id": "evt_i_" + p.key,
                                 "item": {"id": p.temp_item_id, **audio_msg}})
        else:
            await self._send_request(p, [*self._refs(refs), audio_msg])
        self.metrics.inc("preview_requests")
        self.metrics.event("preview_request", turn_id=self.turn_id, generation=self.generation,
                           prefix_ms=len(prefix) // BYTES_PER_SAMPLE // SAMPLES_PER_MS, index=u.previews_sent,
                           mode=self.preview_mode)
        self._set_timer("preview_timeout", rs.preview_timeout_ms)

    async def _on_temp_item_ready(self, iid: Optional[str], t: str) -> None:
        if t != "conversation.item.done" or not iid:
            return
        p = next((x for x in self.pending.values() if x.temp_item_id == iid and x.awaiting_item), None)
        if not p:
            return
        p.awaiting_item = False
        if p.stale:
            p.done = True
            self.items_to_delete.append(iid)
            await self._gc_items()
            return
        await self._send_request(p, [*self._refs(p.references), {"type": "item_reference", "id": iid}])

    @staticmethod
    def _refs(ids: list[str]) -> list[dict]:
        return [{"type": "item_reference", "id": i} for i in ids]

    def _new_pending(self, phase: str, node, refs: list[str]) -> Pending:
        key = secrets.token_hex(8)
        p = Pending(key=key, phase=phase, turn_id=self.turn_id, generation=self.generation, node_id=node.id,
                    sent_at=self.clock(), allowed=router.allowed_branch_ids(node), references=list(refs))
        self.pending[key] = p
        return p

    async def _send_request(self, p: Pending, input_items: list[dict]) -> None:
        node = self.scenario.node(p.node_id)
        metadata = {
            "session_id": self.session_id, "scenario_version": str(self.scenario.version), "node_id": p.node_id,
            "turn_id": str(p.turn_id), "decision_generation": str(p.generation), "phase": p.phase, "request_key": p.key,
        }
        ev = router.response_event(scenario=self.scenario, node=node, input_items=input_items, metadata=metadata,
                                   last_prompt_text=self.last_prompt_text, history=self.history, phase=p.phase,
                                   event_id="evt_r_" + p.key)
        p.sent_at = self.clock()
        if p.temp_item_id:
            p.references = [*p.references, p.temp_item_id]
        self.requests_sent += 1
        await self._send_rt(ev)

    # ------------------------------------------------------------------ final
    async def _maybe_final(self) -> None:
        if self.phase != Phase.DECIDING or self.active is not None or not self.utterances:
            return
        if not all(u.ready for u in self.utterances):
            return
        if self.final_issued_generation == self.generation and self._live("final"):
            return
        if self.decision is not None:
            return
        self._cancel_timer("item_wait")
        # final has priority: previews in flight become stale
        for p in self._live("preview"):
            p.stale = True
            self.metrics.inc("preview_invalidated")
            await self._cancel_response(p)
        self._cancel_timer("preview_timeout")
        if self.requests_sent >= self.rs.max_classification_requests:
            raise EngineFatal("too_many_requests", "分類リクエスト数の上限に達しました。安全のため停止しました。")
        self.generation += 1
        node = self.scenario.node(self.node_id)
        refs = [u.item_id for u in self.utterances]
        p = self._new_pending("final", node, refs)
        await self._send_request(p, self._refs(refs))
        self.final_issued_generation = self.generation
        self.metrics.inc("final_requests")
        self.metrics.event("final_request", turn_id=self.turn_id, generation=self.generation, items=len(refs))
        self._set_timer("final_timeout", self.rs.final_timeout_ms)
        await self._emit_state()

    async def _invalidate_final(self, why: str) -> None:
        for p in self._live("final"):
            p.stale = True
            await self._cancel_response(p)
        self._cancel_timer("final_timeout")
        self._cancel_timer("grace")
        self.decision = None
        self.final_issued_generation = None
        self.generation += 1
        self.metrics.inc("final_invalidated")
        self.metrics.event("final_invalidated", reason=why, turn_id=self.turn_id, generation=self.generation)
        await self._send_browser({"type": "final_invalidated", "reason": why, "turn_id": self.turn_id})

    async def _cancel_response(self, p: Pending) -> None:
        if p.response_id and not p.done:
            try:
                await self._send_rt({"type": "response.cancel", "response_id": p.response_id})
            except TransportClosed:
                pass

    async def _on_response_done(self, resp: dict) -> None:
        md = resp.get("metadata") or {}
        key = md.get("request_key") or self.resp_to_key.get(resp.get("id", ""))
        p = self.pending.get(key or "")
        if p is None or p.done:
            self.metrics.inc("stale_ignored")
            self.metrics.event("response_ignored", reason="unknown_or_duplicate", response_id=str(resp.get("id"))[:40])
            return
        p.done = True
        self.metrics.add_usage(resp.get("usage"))
        if p.temp_item_id:
            self.items_to_delete.append(p.temp_item_id)
        await self._gc_items()
        expected = {"session_id": self.session_id, "scenario_version": str(self.scenario.version), "node_id": p.node_id,
                    "turn_id": str(p.turn_id), "decision_generation": str(p.generation), "phase": p.phase}
        if md and any(md.get(k) != v for k, v in expected.items()):
            self.metrics.inc("stale_ignored")
            self.metrics.event("response_ignored", reason="metadata_mismatch", phase=p.phase)
            if p.phase == "final" and not p.stale and p.generation == self.generation and p.turn_id == self.turn_id:
                self._cancel_timer("final_timeout")
                await self._on_final(p, CTRL_UNCLEAR, "", "metadata_mismatch", "invalid_output")
            return
        current = (p.turn_id == self.turn_id and p.node_id == self.node_id and p.generation == self.generation
                   and self.phase in (Phase.LISTENING, Phase.DECIDING))
        if p.stale or not current:
            self.metrics.inc("stale_ignored")
            if p.phase == "preview":
                self.metrics.inc("preview_invalidated")
            self.metrics.event("response_ignored", reason="stale", phase=p.phase, turn_id=p.turn_id,
                               generation=p.generation, current_generation=self.generation)
            return
        parsed = router.parse_response(resp, p.allowed)
        if p.phase == "preview":
            self._cancel_timer("preview_timeout")
            if self.decision is not None or self.final_issued_generation is not None:
                self.metrics.inc("preview_invalidated")
                return
            if not parsed.ok:
                self.metrics.event("preview_invalid", error=parsed.error)
                return
            await self._on_preview(p, parsed)
        else:
            self._cancel_timer("final_timeout")
            if parsed.ok:
                await self._on_final(p, parsed.branch_id, parsed.reason, None, "realtime")
            else:
                await self._on_final(p, CTRL_UNCLEAR, "", parsed.error, "invalid_output")

    async def _on_preview(self, p: Pending, parsed: router.ParsedBranch) -> None:
        self.metrics.inc("preview_results")
        if self.last_preview_branch and self.last_preview_branch != parsed.branch_id:
            self.metrics.inc("preview_changes")
        self.last_preview_branch = parsed.branch_id
        first_u = self.utterances[0] if self.utterances else None
        if not self.first_preview_logged and first_u:
            self.first_preview_logged = True
            await self._latency("speech_start_event_to_first_preview_ms", (self.clock() - first_u.t_started) * 1000, turn_id=self.turn_id)
        node = self.scenario.node(self.node_id)
        info = self._branch_info(node, parsed.branch_id)
        self.metrics.event("preview", turn_id=self.turn_id, branch_id=parsed.branch_id)
        await self._send_browser({"type": "preview", "turn_id": self.turn_id, "branch_id": parsed.branch_id,
                                  "label": info["label"], "next_text": info["next_text"], "reason": parsed.reason,
                                  "provisional": True})
        await self._send_browser({"type": "prefetch", "audio_ids": self._candidate_audio_ids(node, parsed.branch_id)})

    def _branch_info(self, node, branch_id: str) -> dict:
        if branch_id == CTRL_UNCLEAR:
            c = self.scenario.control(node.fallback_node_id or "")
            return {"label": "聞き返し（不明・想定外）", "next_text": c.assistant_text if c else ""}
        if branch_id == CTRL_END_REQUEST:
            c = self.scenario.control(self.scenario.policy.end_request_node_id)
            return {"label": "終了希望", "next_text": c.assistant_text if c else ""}
        e = next((e for e in node.edges if e.id == branch_id), None)
        tgt = self.scenario.node(e.target_node_id) if e else None
        return {"label": e.label if e else branch_id, "next_text": tgt.assistant_text if tgt else ""}

    async def _on_final(self, p: Optional[Pending], branch_id: str, reason: str, fallback_reason: Optional[str], source: str) -> None:
        now = self.clock()
        last_stop = max((u.t_stopped for u in self.utterances if u.t_stopped), default=None)
        if p is not None and source == "realtime":
            await self._latency("request_to_branch_ms", (now - p.sent_at) * 1000, turn_id=self.turn_id)
        if last_stop is not None and source == "realtime":
            await self._latency("vad_event_to_branch_ms", (now - last_stop) * 1000, turn_id=self.turn_id)
        self.decision = Decision(branch_id, self.generation, reason, fallback_reason, source)
        node = self.scenario.node(self.node_id)
        info = self._branch_info(node, branch_id)
        await self._send_browser({"type": "final", "turn_id": self.turn_id, "branch_id": branch_id,
                                  "label": info["label"], "next_text": info["next_text"], "reason": reason,
                                  "fallback_reason": fallback_reason, "grace_ms": self.rs.final_grace_ms})
        # short re-utterance grace before committing (counted in latency, not hidden)
        self._set_timer("grace", self.rs.final_grace_ms)

    async def _commit_decision(self) -> None:
        d = self.decision
        if d is None or d.generation != self.generation or self.active is not None:
            return
        self.decision = None
        self.final_issued_generation = None
        node = self.scenario.node(self.node_id)
        step = router.transition(self.scenario, self.node_id, d.branch_id, self.counters)
        if d.branch_id == CTRL_UNCLEAR:
            self.metrics.inc("fallbacks")
        label = self._branch_info(node, d.branch_id)["label"]
        self.history.append((node.label, label))
        self.metrics.event("turn", turn_id=self.turn_id, node_id=node.id, branch_id=d.branch_id, source=d.source,
                           fallback_reason=d.fallback_reason, step_reason=step.reason, next_key=step.play_key,
                           preview_last=self.last_preview_branch, preview_matched=(self.last_preview_branch == d.branch_id),
                           utterances=len(self.utterances), generation=d.generation)
        self.items_to_delete.extend(u.item_id for u in self.utterances)
        self.utterances = []
        await self._gc_items()
        await self._play(step.play_key, step.play_text, step.after, step.next_node_id, step.reason)

    async def _gc_items(self) -> None:
        """Delete input items only once no live request references them."""
        if not self.items_to_delete:
            return
        live_refs: set[str] = set()
        for p in self.pending.values():
            if not p.done:
                live_refs.update(p.references)
                if p.temp_item_id:
                    live_refs.add(p.temp_item_id)
        current = {u.item_id for u in self.utterances}
        keep = []
        for iid in self.items_to_delete:
            if iid in live_refs or iid in current:
                keep.append(iid)
                continue
            try:
                await self._send_rt({"type": "conversation.item.delete", "item_id": iid})
            except TransportClosed:
                pass
        self.items_to_delete = keep
        # forget finished requests
        for k in [k for k, p in self.pending.items() if p.done]:
            rid = self.pending[k].response_id
            self.pending.pop(k)
            if rid:
                self.resp_to_key.pop(rid, None)

    async def _on_rt_error(self, err: dict) -> None:
        eid = err.get("event_id") or ""
        self.metrics.event("realtime_error", code=str(err.get("code", ""))[:80], err_type=str(err.get("type", ""))[:80],
                           event_id=str(eid)[:60], message=str(err.get("message", ""))[:200])
        key = eid[6:] if eid.startswith(("evt_r_", "evt_i_")) else None
        p = self.pending.get(key or "")
        if p and not p.done:
            p.done = True
            await self._gc_items()
            if p.phase == "final" and not p.stale and p.generation == self.generation and p.turn_id == self.turn_id:
                self._cancel_timer("final_timeout")
                await self._on_final(p, CTRL_UNCLEAR, "", "realtime_error", "error")
            return
        if self.phase == Phase.CONNECTING:
            raise EngineFatal("realtime_session_error", "Realtime セッション設定でエラーが発生しました（モデル名・設定を確認してください）。")

    # ------------------------------------------------------------------ timers
    async def _on_timer(self, name: str) -> None:
        if name == "session_ready":
            raise EngineFatal("realtime_timeout", "Realtime セッションの準備がタイムアウトしました。")
        if name == "playback_start":
            raise EngineFatal("playback_ack_timeout", "ブラウザから再生開始の確認がありません。自動では次へ進まず停止しました。")
        if name == "playback_end":
            raise EngineFatal("playback_ack_timeout", "ブラウザから再生終了の確認がありません。自動では次へ進まず停止しました。")
        if name == "no_input":
            if self.phase == Phase.LISTENING and not self.utterances:
                self.metrics.event("no_input", turn_id=self.turn_id, node_id=self.node_id)
                step = router.transition_no_input(self.scenario, self.node_id, self.counters)
                await self._play(step.play_key, step.play_text, step.after, step.next_node_id, step.reason)
        elif name == "preview_timeout":
            for p in self._live("preview"):
                p.stale = True
                self.metrics.inc("preview_invalidated")
                await self._cancel_response(p)
        elif name == "item_wait":
            if self.phase == Phase.DECIDING and self.active is None and self.decision is None \
                    and not all(u.ready for u in self.utterances):
                await self._on_final(None, CTRL_UNCLEAR, "", "input_item_timeout", "timeout")
        elif name == "final_timeout":
            live = self._live("final")
            for p in live:
                p.stale = True
                await self._cancel_response(p)
            if self.phase == Phase.DECIDING and self.decision is None and self.active is None:
                await self._on_final(live[0] if live else None, CTRL_UNCLEAR, "", "final_timeout", "timeout")
        elif name == "grace":
            await self._commit_decision()

    # ------------------------------------------------------------------ state / end
    async def _emit_state(self) -> None:
        node = self.scenario.node(self.node_id)
        await self._send_browser({
            "type": "state", "phase": self.phase.value, "mic_enabled": self.mic_enabled,
            "speaking": self.active is not None, "node_id": self.node_id,
            "node_label": node.label if node else "", "node_text": node.assistant_text if node else "",
            "turn_id": self.turn_id, "decision_generation": self.generation,
            "scenario_id": self.scenario.scenario_id, "scenario_version": self.scenario.version,
            "playing_key": self.playback.utterance_key if self.playback else None,
            "counters": self.metrics.counters, "mock_realtime": self.transport.is_mock,
        })

    async def _finish(self, phase: Phase, reason: str, message: str) -> None:
        if self.done:
            return
        self.done = True
        self.phase = phase
        self.mic_enabled = False
        self.end_reason = reason
        self.end_detail = message
        for p in self.pending.values():
            if not p.done:
                p.stale = True
                await self._cancel_response(p)
        self.metrics.event("session_end", phase=phase.value, reason=reason, node_id=self.node_id)
        await self._emit_state()
        await self._send_browser({"type": "finished", "phase": phase.value, "reason": reason, "message": message,
                                  "counters": self.metrics.counters, "realtime_usage": self.metrics.realtime_usage})
