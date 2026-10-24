import asyncio
import os
from pathlib import Path

import pytest

from audio_store import AudioStore, build_manifest, cache_key, manifest_missing
from conftest import MOCK_VOICE, sample_body, sample_scenario, tiny_wav
from jobs import JobManager
from scenario_generator import GenerationRequest, MockScenarioGenerator
from scenario_schema import Scenario
from scenario_store import AUDIO_FAILED, INTERRUPTED, READY, REVIEW, Store
from scenario_validator import Limits, validate_scenario
from tts import InvalidAudio, MockSpeechSynthesizer, TTSTransientError, VoiceSettings, mock_tone_wav, validate_audio


def jm(settings, store, audio, synth=None, gen=None):
    return JobManager(settings, store, audio, gen or MockScenarioGenerator(settings, delay_s=0),
                      synth or MockSpeechSynthesizer(delay_s=0))


def insert(store, sc):
    store.insert_version(sc, validate_scenario(sc).as_dict(), "mock", None)


# ---------------- cache keys ----------------

def test_cache_key_changes_with_every_setting():
    base = cache_key(MOCK_VOICE, "こんにちは")
    assert base == cache_key(MOCK_VOICE, "こんにちは")
    variants = [
        VoiceSettings(**{**MOCK_VOICE.as_dict(), "voice": "other"}),
        VoiceSettings(**{**MOCK_VOICE.as_dict(), "speed": 1.1}),
        VoiceSettings(**{**MOCK_VOICE.as_dict(), "style_id": "calm", "style_text": "ゆっくり"}),
        VoiceSettings(**{**MOCK_VOICE.as_dict(), "model": "m2"}),
        VoiceSettings(**{**MOCK_VOICE.as_dict(), "format": "mp3"}),
        VoiceSettings(**{**MOCK_VOICE.as_dict(), "provider": "openai"}),
    ]
    keys = {cache_key(v, "こんにちは") for v in variants} | {cache_key(MOCK_VOICE, "こんにちは。")}
    assert base not in keys and len(keys) == 7


def test_same_text_shares_audio_across_nodes(audio):
    sc = sample_scenario()
    m = build_manifest(sc, MOCK_VOICE, audio)
    ids = [e["audio_id"] for e in m["entries"].values()]
    assert len(ids) == len(set(ids))  # sample has distinct texts
    body = sample_body()
    body["nodes"][6]["assistant_text"] = body["nodes"][5]["assistant_text"]
    from conftest import GeneratedScenario
    sc2 = Scenario(**GeneratedScenario.model_validate(body).model_dump(), scenario_id=sc.scenario_id, version=2)
    m2 = build_manifest(sc2, MOCK_VOICE, audio)
    assert m2["entries"]["node:end_demo"]["audio_id"] == m2["entries"]["node:end_support"]["audio_id"]


# ---------------- audio validation ----------------

def test_validate_audio_rejects_html_and_garbage():
    with pytest.raises(InvalidAudio):
        validate_audio(b"<html><body>error</body></html>" + b" " * 100, "mp3")
    with pytest.raises(InvalidAudio):
        validate_audio(b'{"error": "x"}' + b" " * 100, "wav")
    with pytest.raises(InvalidAudio):
        validate_audio(os.urandom(500), "mp3")
    mime, dur = validate_audio(tiny_wav(300), "wav")
    assert mime == "audio/wav" and dur == 300


def test_validate_mp3_frames():
    # MPEG1 Layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames
    hdr = bytes([0xFF, 0xFB, 0x90, 0x00])
    frame = hdr + b"\x00" * (417 - 4)
    mime, dur = validate_audio(b"ID3\x03\x00\x00\x00\x00\x00\x00" + frame * 10, "mp3")
    assert mime == "audio/mpeg" and 250 <= dur <= 270


def test_atomic_write_and_partials(audio, settings):
    (settings.data_dir / "audio" / ".partial-abc.tmp").write_bytes(b"half")
    assert audio.cleanup_partials() == 1
    aid = cache_key(MOCK_VOICE, "x")
    assert not audio.is_ready(aid)
    audio.write(aid, tiny_wav(), "audio/wav", 200, {})
    assert audio.is_ready(aid) and audio.verify_content(aid)
    p = Path(audio.store.get_asset(aid)["path"])
    p.write_bytes(b"tampered" + tiny_wav()[8:])
    assert not audio.verify_content(aid)
    p.unlink()
    assert not audio.is_ready(aid)


# ---------------- jobs ----------------

async def test_generation_job_creates_review_version(settings, store, audio):
    m = jm(settings, store, audio)
    jid = m.start_generation(GenerationRequest(instruction="x"), {"instruction": "x"})
    await m.wait(jid)
    j = store.get_job(jid)
    assert j["status"] == "succeeded", j
    row = store.get_version(j["result"]["scenario_id"], 1)
    assert row["status"] == REVIEW and row["generator"] == "mock" and row["validation"]["ok"]
    assert row["validation"]["limits"]["max_nodes"] == 20


async def test_generation_job_cancel(settings, store, audio):
    m = jm(settings, store, audio, gen=MockScenarioGenerator(settings, delay_s=5))
    jid = m.start_generation(GenerationRequest(instruction="x"), {})
    await asyncio.sleep(0.05)
    assert m.cancel(jid)
    await m.wait(jid)
    assert store.get_job(jid)["status"] == "canceled"


async def test_audio_job_ready_and_reuse(settings, store, audio):
    sc = sample_scenario()
    insert(store, sc)
    synth = MockSpeechSynthesizer(delay_s=0)
    m = jm(settings, store, audio, synth)
    store.approve_version(sc.scenario_id, 1, MOCK_VOICE.as_dict(), build_manifest(sc, MOCK_VOICE, audio))
    jid = m.start_audio(sc, MOCK_VOICE, Limits())
    await m.wait(jid)
    row = store.get_version(sc.scenario_id, 1)
    assert row["status"] == READY, store.get_job(jid)
    assert len(synth.calls) == 13
    assert manifest_missing(row["manifest"], audio, sc) == []

    # edit: condition-only change → new version, all audio reused
    body = sample_body()
    body["nodes"][0]["edges"][0]["positive_examples"].append("値段は？")
    from conftest import GeneratedScenario
    sc2 = Scenario(**GeneratedScenario.model_validate(body).model_dump(), scenario_id=sc.scenario_id, version=2)
    insert(store, sc2)
    m2 = build_manifest(sc2, MOCK_VOICE, audio)
    assert all(e["cache_hit"] for e in m2["entries"].values())
    store.approve_version(sc.scenario_id, 2, MOCK_VOICE.as_dict(), m2)
    jid2 = m.start_audio(sc2, MOCK_VOICE, Limits())
    await m.wait(jid2)
    assert len(synth.calls) == 13  # nothing re-synthesized
    assert store.get_version(sc.scenario_id, 2)["status"] == READY

    # text change on one node → exactly one miss
    body["nodes"][0]["assistant_text"] = "お電話ありがとうございます。ご用件をお聞かせください。"
    sc3 = Scenario(**GeneratedScenario.model_validate(body).model_dump(), scenario_id=sc.scenario_id, version=3)
    m3 = build_manifest(sc3, MOCK_VOICE, audio)
    assert sum(1 for e in m3["entries"].values() if not e["cache_hit"]) == 1
    # voice/style change → all miss
    other = VoiceSettings(**{**MOCK_VOICE.as_dict(), "style_id": "calm", "style_text": "ゆっくり"})
    assert not any(e["cache_hit"] for e in build_manifest(sc3, other, audio)["entries"].values())
    # the original running version is unchanged
    assert store.get_version(sc.scenario_id, 1)["scenario"]["nodes"][0]["assistant_text"] == sc.nodes[0].assistant_text


async def test_audio_partial_failure_retry_only_failed(settings, store, audio, monkeypatch):
    async def fast_sleep(s):
        pass
    monkeypatch.setattr("jobs.asyncio.sleep", fast_sleep)
    sc = sample_scenario()
    insert(store, sc)
    bad_text = sc.control("end_request").assistant_text
    garbage = sc.control("limit_handoff").assistant_text
    synth = MockSpeechSynthesizer(delay_s=0, fail_texts={bad_text: [RuntimeError("401 auth")]}, garbage_texts={garbage})
    m = jm(settings, store, audio, synth)
    store.approve_version(sc.scenario_id, 1, MOCK_VOICE.as_dict(), build_manifest(sc, MOCK_VOICE, audio))
    jid = m.start_audio(sc, MOCK_VOICE, Limits())
    await m.wait(jid)
    row = store.get_version(sc.scenario_id, 1)
    assert row["status"] == AUDIO_FAILED
    failed = {k for k, e in row["manifest"]["entries"].items() if e["status"] == "failed"}
    assert failed == {"control:end_request", "control:limit_handoff"}
    assert synth.calls.count(garbage) == settings.tts_max_attempts  # invalid audio is retried, never stored
    assert not audio.is_ready(row["manifest"]["entries"]["control:limit_handoff"]["audio_id"])
    assert set(manifest_missing(row["manifest"], audio, sc)) == failed

    synth.garbage_texts.clear()
    n_before = len(synth.calls)
    jid2 = m.start_audio(sc, MOCK_VOICE, Limits(), only_failed=True)
    await m.wait(jid2)
    assert len(synth.calls) - n_before == 2
    assert store.get_version(sc.scenario_id, 1)["status"] == READY


async def test_audio_transient_then_ok(settings, store, audio, monkeypatch):
    async def fast_sleep(s):
        pass
    monkeypatch.setattr("jobs.asyncio.sleep", fast_sleep)
    sc = sample_scenario()
    insert(store, sc)
    t = sc.nodes[0].assistant_text
    synth = MockSpeechSynthesizer(delay_s=0, fail_texts={t: [TTSTransientError("429"), TTSTransientError("503")]})
    m = jm(settings, store, audio, synth)
    store.approve_version(sc.scenario_id, 1, MOCK_VOICE.as_dict(), build_manifest(sc, MOCK_VOICE, audio))
    await m.wait(m.start_audio(sc, MOCK_VOICE, Limits()))
    assert store.get_version(sc.scenario_id, 1)["status"] == READY
    assert synth.calls.count(t) == 3


async def test_audio_job_cancel_leaves_not_ready(settings, store, audio):
    sc = sample_scenario()
    insert(store, sc)
    m = jm(settings, store, audio, MockSpeechSynthesizer(delay_s=0.5))
    store.approve_version(sc.scenario_id, 1, MOCK_VOICE.as_dict(), build_manifest(sc, MOCK_VOICE, audio))
    jid = m.start_audio(sc, MOCK_VOICE, Limits())
    await asyncio.sleep(0.05)
    m.cancel(jid)
    await m.wait(jid)
    row = store.get_version(sc.scenario_id, 1)
    assert store.get_job(jid)["status"] == "canceled"
    assert row["status"] == AUDIO_FAILED
    assert manifest_missing(row["manifest"], audio, sc)
    assert not any(e["status"] == "generating" for e in row["manifest"]["entries"].values())


async def test_audio_limits(settings, store, audio):
    sc = sample_scenario()
    insert(store, sc)
    settings.tts_max_total_chars = 50
    m = jm(settings, store, audio)
    jid = m.start_audio(sc, MOCK_VOICE, Limits())
    await m.wait(jid)
    j = store.get_job(jid)
    assert j["status"] == "failed" and "too_many_chars" in j["error"]


def test_restart_recovery(settings, store):
    sc = sample_scenario()
    insert(store, sc)
    store.approve_version(sc.scenario_id, 1, {}, {"entries": {}})
    jid = store.create_job("audio", {})
    store.update_job(jid, status="running")
    sid, _ = store.create_session(sc.scenario_id, 1, {}, None)
    rec = store.recover_after_restart()
    assert rec == {"jobs": 1, "versions": 1, "sessions": 1}
    assert store.get_job(jid)["status"] == INTERRUPTED
    assert store.get_version(sc.scenario_id, 1)["status"] == AUDIO_FAILED
    assert store.get_session(sid)["status"] == "aborted"


def test_versions_are_immutable_and_sessions_pin_version(store):
    sc = sample_scenario()
    insert(store, sc)
    sid, created = store.create_session(sc.scenario_id, 1, {}, "req1")
    sid2, created2 = store.create_session(sc.scenario_id, 1, {}, "req1")
    assert created and not created2 and sid == sid2  # double click → same session
    assert store.claim_session(sid) and not store.claim_session(sid)  # single use
    assert store.next_version(sc.scenario_id) == 2


def test_mock_tone_is_valid_wav():
    mime, dur = validate_audio(mock_tone_wav("テスト"), "wav")
    assert mime == "audio/wav" and dur >= 600
