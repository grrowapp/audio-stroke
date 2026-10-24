"""Optional smoke tests against the real, PAID APIs. Skipped unless RUN_REAL_API=1.

Run only after explicit approval of the cost:
    RUN_REAL_API=1 python -m pytest -m realapi -q
"""
import asyncio
import os

import pytest

pytestmark = [pytest.mark.realapi,
              pytest.mark.skipif(os.environ.get("RUN_REAL_API") != "1", reason="paid API; set RUN_REAL_API=1")]


async def test_claude_generates_valid_graph():
    from config import Settings
    from scenario_generator import ClaudeScenarioGenerator, GenerationRequest
    s = Settings()
    out = await ClaudeScenarioGenerator(s).generate(GenerationRequest(instruction=__import__("config").SAMPLE_INSTRUCTION))
    assert out.validation.ok


async def test_openai_tts_returns_decodable_audio():
    from config import Settings
    from tts import OpenAISpeechSynthesizer, VoiceSettings, validate_audio
    s = Settings()
    vs = VoiceSettings("openai", s.tts_model, s.tts_voice, s.tts_format, 1.0, "polite", "丁寧に")
    data = await OpenAISpeechSynthesizer(s).synthesize("お問い合わせありがとうございます。", vs)
    validate_audio(data, s.tts_format)


async def test_realtime_session_update_accepted():
    from config import Settings
    from realtime_session import OpenAIRealtimeTransport
    s = Settings()
    t = OpenAIRealtimeTransport(s.realtime_url, s.realtime_model, s.openai_api_key)
    await t.connect()
    await t.send({"type": "session.update", "session": {"type": "realtime", "output_modalities": ["text"]}})
    for _ in range(10):
        ev = await asyncio.wait_for(t.recv(), 10)
        assert ev["type"] != "error", ev
        if ev["type"] == "session.updated":
            break
    await t.close()
