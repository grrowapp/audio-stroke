"""Pre-conversation speech synthesis (provider boundary).

This is a separate process step from Claude scenario generation: it only
voices utterance texts that a human has already approved. It is never called
on the conversation path (cache misses there stop the session instead).
"""
from __future__ import annotations

import asyncio
import io
import math
import struct
import wave
from dataclasses import asdict, dataclass
from typing import Any, Optional

from config import Settings

CACHE_SPEC_VERSION = "2"


@dataclass(frozen=True)
class VoiceSettings:
    provider: str
    model: str
    voice: str
    format: str
    speed: float
    style_id: str
    style_text: str
    api: str = "audio.speech.v1"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class InvalidAudio(Exception):
    pass


class TTSTransientError(Exception):
    pass


class TTSError(Exception):
    pass


# ---------------------------------------------------------------------------
# audio validation (decodability check without external decoders)
# ---------------------------------------------------------------------------

_MP3_BITRATES = {
    # (version_bit, layer) -> kbps table index 1..14
    (3, 1): [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],   # MPEG1 L3
    (2, 1): [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       # MPEG2 L3
    (0, 1): [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       # MPEG2.5 L3
}
_MP3_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def _mp3_duration_ms(data: bytes) -> int:
    pos = 0
    if data[:3] == b"ID3":
        if len(data) < 10:
            raise InvalidAudio("truncated ID3")
        size = (data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F)
        pos = 10 + size
    frames = 0
    total_samples = 0
    n = len(data)
    while pos + 4 <= n:
        h = data[pos:pos + 4]
        if h[0] != 0xFF or (h[1] & 0xE0) != 0xE0:
            if frames == 0:
                raise InvalidAudio("MP3 frame sync not found")
            break  # trailing tag / padding
        ver = (h[1] >> 3) & 0x03
        layer = (h[1] >> 1) & 0x03
        br_idx = (h[2] >> 4) & 0x0F
        sr_idx = (h[2] >> 2) & 0x03
        pad = (h[2] >> 1) & 0x01
        if ver == 1 or layer != 1 or br_idx in (0, 15) or sr_idx == 3:
            if frames == 0:
                raise InvalidAudio("unsupported/invalid MP3 header")
            break
        br = _MP3_BITRATES[(ver, layer)][br_idx - 1] * 1000
        sr = _MP3_RATES[ver][sr_idx]
        spf = 1152 if ver == 3 else 576
        flen = (spf // 8 * br) // sr + pad
        if flen < 4:
            raise InvalidAudio("bad MP3 frame length")
        frames += 1
        total_samples += spf
        pos += flen
        rate = sr
    if frames < 2:
        raise InvalidAudio("too few MP3 frames")
    return int(total_samples * 1000 / rate)


def validate_audio(data: bytes, fmt: str) -> tuple[str, Optional[int]]:
    """Return (mime, duration_ms). Rejects HTML/JSON error bodies and garbage."""
    if not data or len(data) < 64:
        raise InvalidAudio("empty or too small")
    head = data[:16].lstrip()
    if head[:1] in (b"<", b"{", b"["):
        raise InvalidAudio("looks like HTML/JSON, not audio")
    if fmt == "wav":
        if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            raise InvalidAudio("not a RIFF/WAVE file")
        try:
            with wave.open(io.BytesIO(data)) as w:
                frames = w.getnframes()
                rate = w.getframerate()
                if rate <= 0 or frames <= 0:
                    raise InvalidAudio("empty WAV")
                w.readframes(min(frames, 10))
                return "audio/wav", int(frames * 1000 / rate)
        except (wave.Error, EOFError) as e:
            raise InvalidAudio(f"WAV decode failed: {e}") from e
    if fmt == "mp3":
        return "audio/mpeg", _mp3_duration_ms(data)
    raise InvalidAudio(f"unsupported format {fmt}")


# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------

class SpeechSynthesizer:
    name = "base"
    is_mock = False

    async def synthesize(self, text: str, vs: VoiceSettings) -> bytes:
        raise NotImplementedError


class MockSpeechSynthesizer(SpeechSynthesizer):
    """Produces a soft tone WAV whose length scales with text length (NOT speech)."""
    name = "mock"
    is_mock = True

    def __init__(self, fail_texts: Optional[dict[str, list[Exception]]] = None, delay_s: float = 0.05,
                 garbage_texts: Optional[set[str]] = None):
        self.fail_texts = fail_texts or {}
        self.garbage_texts = garbage_texts or set()
        self.delay_s = delay_s
        self.calls: list[str] = []

    async def synthesize(self, text: str, vs: VoiceSettings) -> bytes:
        self.calls.append(text)
        await asyncio.sleep(self.delay_s)
        errs = self.fail_texts.get(text)
        if errs:
            raise errs.pop(0)
        if text in self.garbage_texts:
            return b"<html><body>502 Bad Gateway</body></html>" + b" " * 100
        return mock_tone_wav(text, vs.speed)


def mock_tone_wav(text: str, speed: float = 1.0, rate: int = 24000) -> bytes:
    secs = max(0.6, min(4.0, len(text) * 0.03 / max(speed, 0.1)))
    n = int(rate * secs)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        f = 440 + (sum(map(ord, text)) % 200)
        for i in range(n):
            t = i / rate
            env = 0.5 * (1 - math.cos(2 * math.pi * min(1.0, (t % 0.5) / 0.5)))
            frames += struct.pack("<h", int(3000 * env * math.sin(2 * math.pi * f * t)))
        w.writeframes(bytes(frames))
    return buf.getvalue()


class OpenAISpeechSynthesizer(SpeechSynthesizer):
    name = "openai"

    def __init__(self, settings: Settings, client: Any = None):
        self.settings = settings
        if client is None:
            import openai

            if not settings.openai_api_key:
                raise TTSError("OPENAI_API_KEY が未設定です。")
            client = openai.AsyncOpenAI(api_key=settings.openai_api_key, max_retries=0, timeout=settings.tts_timeout_s)
        self.client = client

    async def synthesize(self, text: str, vs: VoiceSettings) -> bytes:
        import openai

        kwargs: dict[str, Any] = {
            "model": vs.model, "voice": vs.voice, "input": text,
            "response_format": vs.format, "speed": vs.speed,
        }
        if vs.style_text and not vs.model.startswith("tts-1"):
            kwargs["instructions"] = vs.style_text  # not supported by tts-1 / tts-1-hd
        try:
            resp = await self.client.audio.speech.create(**kwargs)
        except openai.RateLimitError as e:
            raise TTSTransientError("429") from e
        except openai.APIStatusError as e:
            if e.status_code >= 500 or e.status_code in (408, 409):
                raise TTSTransientError(f"HTTP {e.status_code}") from e
            raise TTSError(f"TTS API エラー HTTP {e.status_code}") from e
        except openai.APIConnectionError as e:
            raise TTSTransientError(type(e).__name__) from e
        ctype = ""
        try:
            ctype = resp.response.headers.get("content-type", "")
        except AttributeError:
            pass
        if ctype and not (ctype.startswith("audio/") or ctype.startswith("application/octet-stream")):
            raise InvalidAudio(f"unexpected content-type {ctype}")
        return resp.content


def make_synthesizer(settings: Settings) -> SpeechSynthesizer:
    if settings.tts_provider == "openai":
        return OpenAISpeechSynthesizer(settings)
    return MockSpeechSynthesizer()
