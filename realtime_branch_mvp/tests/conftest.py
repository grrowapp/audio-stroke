import asyncio
import io
import json
import sys
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from audio_store import AudioStore, build_manifest  # noqa: E402
from config import Settings  # noqa: E402
from metrics import SessionMetrics  # noqa: E402
from realtime_session import ConversationEngine, RealtimeTransport, RuntimeSettings, TransportClosed  # noqa: E402
from scenario_schema import GeneratedScenario, Scenario  # noqa: E402,F401
from scenario_store import READY, Store  # noqa: E402
from tts import VoiceSettings  # noqa: E402

SAMPLE = ROOT / "fixtures" / "sample_scenario.json"


def sample_body() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def sample_scenario(**overrides) -> Scenario:
    body = sample_body()
    body.update(overrides)
    return Scenario(**GeneratedScenario.model_validate(body).model_dump(), scenario_id="scn_0123456789abcdef", version=1)


def tiny_wav(ms: int = 200) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x01\x00" * (24 * ms))
    return buf.getvalue()


MOCK_VOICE = VoiceSettings(provider="mock", model="mock-tone", voice="mock", format="wav", speed=1.0,
                           style_id="polite", style_text="丁寧")


@pytest.fixture
def settings(tmp_path):
    s = Settings()
    s.data_dir = tmp_path / "data"
    s.scenario_provider = "mock"
    s.tts_provider = "mock"
    s.realtime_provider = "mock"
    s.ensure_dirs()
    return s


@pytest.fixture
def store(settings):
    st = Store(str(settings.db_path))
    yield st
    st.close()


@pytest.fixture
def audio(settings, store):
    return AudioStore(settings.data_dir / "audio", store)


def ready_manifest(scenario: Scenario, audio: AudioStore) -> dict:
    m = build_manifest(scenario, MOCK_VOICE, audio)
    for e in m["entries"].values():
        if e["status"] != "ready":
            meta = audio.write(e["audio_id"], tiny_wav(), "audio/wav", 200, MOCK_VOICE.as_dict())
            e.update(status="ready", **meta)
    return m


# ---------------------------------------------------------------------------
# Scripted Realtime transport + engine harness
# ---------------------------------------------------------------------------

class ScriptedTransport(RealtimeTransport):
    """Records client events; tests inject server events explicitly."""

    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict] = []
        self.closed = False
        self._n = 0

    async def connect(self):
        pass

    async def send(self, event):
        if self.closed:
            raise TransportClosed("closed")
        if event.get("type") == "input_audio_buffer.append":
            self.sent.append({"type": "input_audio_buffer.append", "len": len(event["audio"])})
        else:
            self.sent.append(event)

    async def recv(self):
        ev = await self.q.get()
        if ev is None:
            raise TransportClosed("server closed")
        return ev

    async def close(self):
        self.closed = True

    def push(self, ev):
        self.q.put_nowait(ev)

    def types(self):
        return [e["type"] for e in self.sent]

    def requests(self, phase=None):
        out = [e for e in self.sent if e["type"] == "response.create"]
        if phase:
            out = [e for e in out if e["response"]["metadata"]["phase"] == phase]
        return out

    def new_id(self, p="resp"):
        self._n += 1
        return f"{p}_{self._n}"

    def respond(self, req, branch_id=None, *, status="completed", output=None, metadata=None, created=True, rid=None):
        md = dict(req["response"]["metadata"]) if metadata is None else metadata
        rid = rid or self.new_id()
        if created:
            self.push({"type": "response.created", "response": {"id": rid, "metadata": md}})
        if output is None:
            output = [{"type": "function_call", "name": "select_branch", "status": "completed",
                       "arguments": json.dumps({"branch_id": branch_id, "reason": "test"})}]
        self.push({"type": "response.done", "response": {"id": rid, "metadata": md, "status": status, "output": output,
                                                         "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}})
        return rid


class Harness:
    def __init__(self, tmp_path, audio, scenario=None, rs=None, mode="inline", auto_play=True, play_ms=0.01):
        self.scenario = scenario or sample_scenario()
        self.audio = audio
        self.manifest = ready_manifest(self.scenario, audio)
        self.transport = ScriptedTransport()
        self.browser: list[dict] = []
        self.auto_play = auto_play
        self.play_ms = play_ms
        self.rs = rs or RuntimeSettings(final_grace_ms=30, preview_min_audio_ms=300, preview_interval_ms=300)
        self.metrics = SessionMetrics(tmp_path, "sess_test")
        self.engine = ConversationEngine(
            session_id="sess_0123456789abcdef", scenario=self.scenario, manifest=self.manifest, audio=audio,
            transport=self.transport, send_browser=self._send, settings=self.rs, metrics=self.metrics,
            preview_audio_mode=mode,
        )
        self.task = None
        self._item = 0

    async def _send(self, msg):
        self.browser.append(msg)
        if msg["type"] == "play" and self.auto_play:
            pid = msg["playback_id"]

            async def ack():
                await asyncio.sleep(0)
                self.engine.push_browser_json({"type": "playback_started", "playback_id": pid})
                await asyncio.sleep(self.play_ms)
                self.engine.push_browser_json({"type": "playback_ended", "playback_id": pid})

            asyncio.get_running_loop().create_task(ack())

    async def start(self):
        self.task = asyncio.get_running_loop().create_task(self.engine.run())
        self.transport.push({"type": "session.updated", "session": {}})
        await self.until(lambda: self.engine.phase.value == "LISTENING")

    async def until(self, cond, timeout=3.0):
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while not cond():
            if loop.time() > end:
                raise AssertionError(f"timeout; phase={self.engine.phase} browser={[m['type'] for m in self.browser][-15:]}")
            await asyncio.sleep(0.003)

    def plays(self):
        return [m["utterance_key"] for m in self.browser if m["type"] == "play"]

    def msgs(self, t):
        return [m for m in self.browser if m["type"] == t]

    async def feed(self, ms):
        for _ in range(ms // 20):
            self.engine.push_browser_audio(b"\x00\x00" * 480)
        await asyncio.sleep(0.01)

    def speech_start(self, audio_start_ms=None):
        self._item += 1
        iid = f"item_u{self._item}"
        if audio_start_ms is None:
            audio_start_ms = self.engine.ring.total // 24
        self.transport.push({"type": "input_audio_buffer.speech_started", "item_id": iid, "audio_start_ms": audio_start_ms})
        return iid

    def speech_stop(self, iid, commit=True):
        self.transport.push({"type": "input_audio_buffer.speech_stopped", "item_id": iid, "audio_end_ms": 0})
        if commit:
            self.transport.push({"type": "input_audio_buffer.committed", "item_id": iid})
            self.transport.push({"type": "conversation.item.added", "item": {"id": iid}})
            self.transport.push({"type": "conversation.item.done", "item": {"id": iid}})

    async def answer(self, branch, speak_ms=400):
        """Full turn: speech → stop → final response with ``branch``."""
        n_final = len(self.transport.requests("final"))
        iid = self.speech_start()
        await asyncio.sleep(0.01)
        await self.feed(speak_ms)
        self.speech_stop(iid)
        await self.until(lambda: len(self.transport.requests("final")) > n_final)
        req = self.transport.requests("final")[-1]
        self.transport.respond(req, branch)
        return req

    async def stop(self):
        if self.task and not self.task.done():
            self.engine.push_browser_json({"type": "stop"})
            await asyncio.wait_for(self.task, 3)


@pytest.fixture
def harness_factory(tmp_path, audio):
    made = []

    def make(**kw):
        h = Harness(tmp_path, audio, **kw)
        made.append(h)
        return h

    yield make
