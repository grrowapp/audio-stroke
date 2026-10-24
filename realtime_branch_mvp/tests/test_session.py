"""Conversation engine tests with a scripted Realtime transport (no network)."""
import asyncio
import base64
import json

import pytest

from realtime_session import RuntimeSettings
from scenario_schema import CTRL_END_REQUEST, CTRL_UNCLEAR


async def test_e2e_entry_to_terminal(harness_factory):
    h = harness_factory()
    await h.start()
    assert h.plays() == ["node:select_need"]
    # session.update: text-only out, server VAD that never auto-responds
    su = h.transport.sent[0]
    assert su["type"] == "session.update" and su["session"]["output_modalities"] == ["text"]
    td = su["session"]["audio"]["input"]["turn_detection"]
    assert td["create_response"] is False and td["interrupt_response"] is False and td["silence_duration_ms"] == 600
    await h.answer("demo")
    await h.until(lambda: h.engine.phase.value == "LISTENING" and h.engine.node_id == "confirm_demo")
    assert h.plays()[-1] == "node:confirm_demo"
    await h.answer("yes")
    await asyncio.wait_for(h.task, 3)
    assert h.plays() == ["node:select_need", "node:confirm_demo", "node:end_demo"]
    assert h.engine.phase.value == "FINISHED"
    assert h.msgs("finished")[-1]["reason"] == "completed"
    # final requests reference the committed user item; never inline-commit/clear for preview
    fin = h.transport.requests("final")[0]["response"]
    assert fin["input"][0]["type"] == "item_reference" and fin["conversation"] == "none"
    names = {l["name"] for l in map(json.loads, open(h.metrics.path)) if l["event"] == "latency"}
    assert {"vad_event_to_branch_ms", "request_to_branch_ms", "speech_start_to_next_playback_ms"} <= names


async def test_terminal_waits_for_playback_ended(harness_factory):
    h = harness_factory(auto_play=False)
    task = asyncio.get_running_loop().create_task(h.engine.run())
    h.transport.push({"type": "session.updated"})
    await h.until(lambda: h.msgs("play"))
    pid = h.msgs("play")[0]["playback_id"]
    assert h.engine.mic_enabled is False  # half-duplex while playing
    h.engine.push_browser_audio(b"\x00\x00" * 480)
    await asyncio.sleep(0.02)
    assert "input_audio_buffer.append" not in h.transport.types()
    assert h.metrics.counters["dropped_frames_while_playing"] == 1
    h.engine.push_browser_json({"type": "playback_started", "playback_id": pid})
    await asyncio.sleep(0.02)
    assert h.engine.phase.value == "PLAYING"
    h.engine.push_browser_json({"type": "playback_ended", "playback_id": pid})
    await h.until(lambda: h.engine.phase.value == "LISTENING")
    assert h.engine.mic_enabled is True
    h.engine.push_browser_json({"type": "stop"})
    await asyncio.wait_for(task, 3)


async def test_preview_streams_without_commit_and_final_wins(harness_factory):
    """preview says pricing, the user corrects to demo: pricing audio must never play."""
    h = harness_factory()
    await h.start()
    iid = h.speech_start()
    await asyncio.sleep(0.01)
    n_clear_before = h.transport.types().count("input_audio_buffer.clear")
    await h.feed(400)
    await h.until(lambda: h.transport.requests("preview"))
    prev = h.transport.requests("preview")[0]
    r = prev["response"]
    assert r["conversation"] == "none"
    audio_items = [i for i in r["input"] if i.get("type") == "message"]
    assert audio_items and audio_items[0]["content"][0]["type"] == "input_audio"
    pcm = base64.b64decode(audio_items[0]["content"][0]["audio"])
    assert len(pcm) == 2 * 24 * 300  # exactly this utterance's prefix at the 300 ms threshold
    h.transport.respond(prev, "pricing")
    await h.until(lambda: h.msgs("preview"))
    assert h.msgs("preview")[0]["branch_id"] == "pricing"
    assert h.plays() == ["node:select_need"]  # preview never plays
    assert h.engine.node_id == "select_need"
    # streaming continues; preview never commits/clears the live buffer
    await h.feed(400)
    t = h.transport.types()
    assert "input_audio_buffer.commit" not in t
    assert t.count("input_audio_buffer.clear") == n_clear_before
    h.speech_stop(iid)
    await h.until(lambda: h.transport.requests("final"))
    h.transport.respond(h.transport.requests("final")[0], "demo")
    await h.until(lambda: len(h.plays()) == 2)
    assert h.plays()[-1] == "node:confirm_demo"
    assert "node:confirm_pricing" not in h.plays()
    await h.stop()


async def test_preview_arriving_after_final_is_ignored(harness_factory):
    h = harness_factory()
    await h.start()
    iid = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(400)
    await h.until(lambda: h.transport.requests("preview"))
    prev = h.transport.requests("preview")[0]
    h.speech_stop(iid)
    await h.until(lambda: h.transport.requests("final"))
    h.transport.respond(h.transport.requests("final")[0], "support")
    await h.until(lambda: len(h.plays()) == 2)
    h.transport.respond(prev, "pricing")  # late preview
    await asyncio.sleep(0.05)
    assert not h.msgs("preview")
    assert h.plays()[-1] == "node:confirm_support"
    assert h.metrics.counters["stale_ignored"] >= 1
    await h.stop()


async def test_preview_scheduling_limits(harness_factory):
    h = harness_factory(rs=RuntimeSettings(preview_min_audio_ms=200, preview_interval_ms=0, preview_max_per_utterance=3,
                                           final_grace_ms=10))
    await h.start()
    h.speech_start()
    await asyncio.sleep(0.01)
    for _ in range(6):
        await h.feed(220)
        reqs = h.transport.requests("preview")
        await h.until(lambda: len(h.transport.requests("preview")) >= min(3, len(reqs)))
        if reqs:
            # at most one in flight: no new preview until this one answers
            assert sum(1 for p in h.engine.pending.values() if p.phase == "preview" and not p.done) <= 1
            h.transport.respond(reqs[-1], "pricing")
            await asyncio.sleep(0.02)
    assert len(h.transport.requests("preview")) == 3  # max per utterance
    await h.stop()


async def test_preview_item_mode_uses_ack_then_reference(harness_factory):
    h = harness_factory(mode="item")
    await h.start()
    h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(400)
    await h.until(lambda: any(e["type"] == "conversation.item.create" for e in h.transport.sent))
    create = next(e for e in h.transport.sent if e["type"] == "conversation.item.create")
    tmp = create["item"]["id"]
    assert not h.transport.requests("preview")  # waits for ack
    h.transport.push({"type": "conversation.item.done", "item": {"id": tmp}})
    await h.until(lambda: h.transport.requests("preview"))
    inp = h.transport.requests("preview")[0]["response"]["input"]
    assert inp[-1] == {"type": "item_reference", "id": tmp}
    h.transport.respond(h.transport.requests("preview")[0], "demo")
    await h.until(lambda: any(e["type"] == "conversation.item.delete" and e["item_id"] == tmp for e in h.transport.sent))
    await h.stop()


async def test_reutterance_during_final_invalidates_and_rejudges_whole_answer(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=150, preview_enabled=False))
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(300)
    h.speech_stop(i1)
    await h.until(lambda: h.transport.requests("final"))
    old = h.transport.requests("final")[0]
    # user resumes before playback: old final becomes stale
    i2 = h.speech_start()
    await asyncio.sleep(0.02)
    h.transport.respond(old, "pricing")
    await asyncio.sleep(0.05)
    assert h.plays() == ["node:select_need"]
    await h.feed(300)
    h.speech_stop(i2)
    await h.until(lambda: len(h.transport.requests("final")) == 2)
    new = h.transport.requests("final")[1]
    assert [x["id"] for x in new["response"]["input"]] == [i1, i2]  # whole answer, ordered
    assert int(new["response"]["metadata"]["decision_generation"]) > int(old["response"]["metadata"]["decision_generation"])
    h.transport.respond(new, "demo")
    await h.until(lambda: len(h.plays()) == 2)
    assert h.plays()[-1] == "node:confirm_demo"
    assert h.metrics.counters["final_invalidated"] == 1
    await h.stop()


async def test_reutterance_in_grace_window_cancels_decision(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=300, preview_enabled=False))
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(200)
    h.speech_stop(i1)
    await h.until(lambda: h.transport.requests("final"))
    h.transport.respond(h.transport.requests("final")[0], "pricing")
    await h.until(lambda: h.msgs("final"))
    h.speech_start()  # inside the grace window
    await asyncio.sleep(0.4)
    assert h.plays() == ["node:select_need"]
    assert h.msgs("final_invalidated")
    await h.stop()


async def test_items_not_deleted_while_referenced(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=10, preview_enabled=False))
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(200)
    h.speech_stop(i1)
    await h.until(lambda: h.transport.requests("final"))
    old = h.transport.requests("final")[0]
    h.speech_start()  # invalidates old final; old response still running and references i1
    await asyncio.sleep(0.03)
    assert not any(e["type"] == "conversation.item.delete" for e in h.transport.sent)
    assert any(e["type"] == "response.cancel" for e in h.transport.sent) is False  # no response_id known yet
    h.transport.respond(old, "pricing")
    await asyncio.sleep(0.03)
    # still part of the current turn → still kept
    assert not any(e["type"] == "conversation.item.delete" for e in h.transport.sent)
    await h.stop()


@pytest.mark.parametrize("bad", [
    {"output": []},
    {"output": [{"type": "function_call", "name": "select_branch", "arguments": "{}"},
                {"type": "function_call", "name": "select_branch", "arguments": "{}"}]},
    {"output": [{"type": "function_call", "name": "select_branch", "arguments": json.dumps({"branch_id": "hack"})}]},
    {"output": [{"type": "function_call", "name": "select_branch", "arguments": "nope"}]},
    {"status": "failed"},
])
async def test_invalid_final_output_goes_to_fallback(harness_factory, bad):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=10, preview_enabled=False))
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(200)
    h.speech_stop(i1)
    await h.until(lambda: h.transport.requests("final"))
    h.transport.respond(h.transport.requests("final")[0], "demo", **bad)
    await h.until(lambda: len(h.plays()) == 2)
    assert h.plays()[-1] == "control:clarify_need"
    assert h.msgs("final")[-1]["fallback_reason"]
    await h.until(lambda: h.engine.phase.value == "LISTENING")
    assert h.engine.node_id == "select_need"  # fallback returns to origin, does not re-speak it
    assert h.plays().count("node:select_need") == 1
    await h.stop()


async def test_stale_responses_rejected(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=10, preview_enabled=False))
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(200)
    h.speech_stop(i1)
    await h.until(lambda: h.transport.requests("final"))
    req = h.transport.requests("final")[0]
    md = dict(req["response"]["metadata"])
    # other version / other turn / unknown key are ignored
    h.transport.respond(req, "pricing", metadata={**md, "request_key": "deadbeef"}, rid="r_unknown")
    await asyncio.sleep(0.05)
    assert h.plays() == ["node:select_need"]  # unknown request → ignored, still deciding
    h.transport.respond(req, "pricing", metadata={**md, "scenario_version": "99"}, rid="r_ver")
    # a result for another version is never applied; the turn falls back instead of hanging
    await h.until(lambda: len(h.plays()) == 2)
    assert h.plays()[-1] == "control:clarify_need"
    h.transport.respond(req, "pricing")  # late duplicate of the consumed request
    await asyncio.sleep(0.05)
    assert "node:confirm_pricing" not in h.plays()
    assert h.metrics.counters["stale_ignored"] >= 3
    await h.stop()


async def test_duplicate_done_applied_once(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=10, preview_enabled=False))
    await h.start()
    await h.answer("pricing")
    await h.until(lambda: len(h.plays()) == 2)
    req = h.transport.requests("final")[0]
    h.transport.respond(req, "pricing", rid="dup")
    await h.until(lambda: h.engine.phase.value == "LISTENING" and h.engine.node_id == "confirm_pricing")
    await asyncio.sleep(0.05)
    assert h.plays() == ["node:select_need", "node:confirm_pricing"]
    await h.stop()


async def test_final_after_cancel_and_timeout(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=10, preview_enabled=False, final_timeout_ms=2000))
    h.rs.final_timeout_ms = 80
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(200)
    h.speech_stop(i1)
    await h.until(lambda: h.transport.requests("final"))
    req = h.transport.requests("final")[0]
    h.transport.push({"type": "response.created", "response": {"id": "r1", "metadata": req["response"]["metadata"]}})
    await h.until(lambda: len(h.plays()) == 2, timeout=2)
    assert h.plays()[-1] == "control:clarify_need"
    assert {"type": "response.cancel", "response_id": "r1"} in h.transport.sent
    h.transport.respond(req, "demo", rid="r1", created=False)  # final arrives after cancel
    await asyncio.sleep(0.05)
    assert "node:confirm_demo" not in h.plays()
    await h.stop()


async def test_final_timeout_without_response_created(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_enabled=False))
    h.rs.final_timeout_ms = 60
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(200)
    h.speech_stop(i1)
    await h.until(lambda: len(h.plays()) == 2)
    assert h.plays()[-1] == "control:clarify_need"
    assert h.msgs("final")[-1]["fallback_reason"] == "final_timeout"
    await h.stop()


async def test_missing_committed_item_times_out_to_fallback(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_enabled=False))
    h.rs.item_wait_timeout_ms = 60
    await h.start()
    i1 = h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(200)
    h.speech_stop(i1, commit=False)
    await h.until(lambda: len(h.plays()) == 2)
    assert h.msgs("final")[-1]["fallback_reason"] == "input_item_timeout"
    assert not h.transport.requests("final")
    await h.stop()


async def test_no_input_then_limit(harness_factory):
    h = harness_factory()
    h.scenario.policy.no_input_timeout_ms = 2000
    await h.start()
    for _ in range(3):
        h.engine._set_timer("no_input", 1)  # fire immediately (timer path is the same as the real timeout)
        n = len(h.plays())
        await h.until(lambda: len(h.plays()) > n)
    assert h.plays()[1:] == ["control:no_input_need", "control:no_input_need", "control:limit_handoff"]
    await asyncio.wait_for(h.task, 3)
    assert h.engine.phase.value == "FINISHED"


async def test_clarify_limit_and_end_request(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_enabled=False))
    await h.start()
    for _ in range(2):
        await h.answer(CTRL_UNCLEAR)
        await h.until(lambda: h.engine.phase.value == "LISTENING" and h.plays()[-1] == "control:clarify_need")
    await h.answer(CTRL_UNCLEAR)
    await asyncio.wait_for(h.task, 3)
    assert h.plays()[-1] == "control:limit_handoff"

    h2 = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_enabled=False))
    await h2.start()
    await h2.answer("pricing")
    await h2.until(lambda: h2.engine.node_id == "confirm_pricing" and h2.engine.phase.value == "LISTENING")
    await h2.answer(CTRL_END_REQUEST)
    await asyncio.wait_for(h2.task, 3)
    assert h2.plays()[-1] == "control:end_request" and h2.engine.phase.value == "FINISHED"


async def test_correction_goes_back_explicitly(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_enabled=False))
    await h.start()
    await h.answer("pricing")
    await h.until(lambda: h.engine.node_id == "confirm_pricing" and h.engine.phase.value == "LISTENING")
    await h.answer("change")
    await h.until(lambda: h.engine.node_id == "select_need" and h.engine.phase.value == "LISTENING")
    assert h.plays() == ["node:select_need", "node:confirm_pricing", "node:select_need"]
    await h.stop()


async def test_old_playback_ended_does_not_open_turn(harness_factory):
    h = harness_factory(auto_play=False)
    task = asyncio.get_running_loop().create_task(h.engine.run())
    h.transport.push({"type": "session.updated"})
    await h.until(lambda: h.msgs("play"))
    first = h.msgs("play")[0]["playback_id"]
    h.engine.push_browser_json({"type": "playback_ended", "playback_id": "pb_old"})
    await asyncio.sleep(0.03)
    assert h.engine.phase.value == "PLAYING"
    h.engine.push_browser_json({"type": "playback_started", "playback_id": first})
    h.engine.push_browser_json({"type": "playback_ended", "playback_id": first})
    await h.until(lambda: h.engine.phase.value == "LISTENING")
    h.engine.push_browser_json({"type": "playback_ended", "playback_id": first})  # duplicate
    await asyncio.sleep(0.03)
    assert h.engine.turn_id == 1
    h.engine.push_browser_json({"type": "stop"})
    await asyncio.wait_for(task, 3)


async def test_playback_failure_retry_and_interrupt(harness_factory):
    h = harness_factory(auto_play=False)
    task = asyncio.get_running_loop().create_task(h.engine.run())
    h.transport.push({"type": "session.updated"})
    await h.until(lambda: h.msgs("play"))
    pid = h.msgs("play")[0]["playback_id"]
    h.engine.push_browser_json({"type": "playback_failed", "playback_id": pid, "error": "NotAllowedError"})
    await h.until(lambda: h.engine.phase.value == "PLAYBACK_ERROR")
    assert h.engine.mic_enabled is False  # never silently proceed to listening
    h.engine.push_browser_json({"type": "playback_retry"})
    await h.until(lambda: len(h.msgs("play")) == 2)
    pid2 = h.msgs("play")[1]["playback_id"]
    assert pid2 != pid
    h.engine.push_browser_json({"type": "playback_started", "playback_id": pid2})
    h.engine.push_browser_json({"type": "playback_canceled", "playback_id": pid2, "position_ms": 500})
    await h.until(lambda: h.engine.phase.value == "LISTENING")
    assert h.engine.interrupted[0]["utterance_key"] == "node:select_need"
    assert h.engine.node_id == "select_need"  # interrupted utterance's node is the one being answered
    h.engine.push_browser_json({"type": "stop"})
    await asyncio.wait_for(task, 3)


async def test_playback_ack_timeout_stops(harness_factory):
    h = harness_factory(auto_play=False)
    h.rs.playback_start_timeout_ms = 50
    task = asyncio.get_running_loop().create_task(h.engine.run())
    h.transport.push({"type": "session.updated"})
    await asyncio.wait_for(task, 3)
    assert h.engine.phase.value == "ERROR" and h.engine.end_reason == "playback_ack_timeout"


async def test_disconnect_during_playback_does_not_advance(harness_factory):
    h = harness_factory(auto_play=False)
    task = asyncio.get_running_loop().create_task(h.engine.run())
    h.transport.push({"type": "session.updated"})
    await h.until(lambda: h.msgs("play"))
    h.transport.push(None)  # Realtime socket closes
    await asyncio.wait_for(task, 3)
    assert h.engine.phase.value == "ERROR" and h.engine.end_reason == "realtime_disconnected"
    assert "次のノードへは自動で進みません" in h.msgs("finished")[-1]["message"]
    assert h.engine.turn_id == 0


async def test_browser_disconnect_and_stop_any_state(harness_factory):
    h = harness_factory()
    await h.start()
    h.speech_start()
    await asyncio.sleep(0.01)
    h.engine.push_browser_json({"type": "_disconnect"})
    await asyncio.wait_for(h.task, 3)
    assert h.engine.phase.value == "STOPPED" and h.engine.end_reason == "browser_disconnected"
    assert h.engine.ring.total == 0 or h.engine.ring.chunks == type(h.engine.ring.chunks)()  # ring discarded


async def test_cache_miss_stops_safely_without_tts(harness_factory, monkeypatch):
    import tts
    called = []
    monkeypatch.setattr(tts.MockSpeechSynthesizer, "synthesize", lambda *a, **k: called.append(1))
    monkeypatch.setattr(tts.OpenAISpeechSynthesizer, "synthesize", lambda *a, **k: called.append(1))
    import scenario_generator
    monkeypatch.setattr(scenario_generator.BaseGenerator, "generate", lambda *a, **k: called.append(1))
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_enabled=False))
    h.manifest["entries"]["node:confirm_demo"]["status"] = "pending"
    h.engine.manifest["entries"]["node:confirm_demo"]["status"] = "pending"
    await h.start()
    await h.answer("demo")
    await asyncio.wait_for(h.task, 3)
    assert h.engine.end_reason == "audio_cache_miss"
    assert called == []  # conversation path never calls TTS / Claude


async def test_utterance_too_long_is_explicit(harness_factory):
    h = harness_factory(rs=RuntimeSettings(max_utterance_ms=3000, preview_enabled=False))
    await h.start()
    h.speech_start()
    await asyncio.sleep(0.01)
    await h.feed(3200)
    await asyncio.wait_for(h.task, 3)
    assert h.engine.end_reason == "utterance_too_long"


async def test_send_buffer_overflow_is_explicit(harness_factory):
    h = harness_factory()
    await h.start()
    h.transport.buffered_bytes = lambda: 10**9
    await h.feed(40)
    await asyncio.wait_for(h.task, 3)
    assert h.engine.end_reason == "send_buffer_overflow"


async def test_prefix_excludes_previous_turn_audio(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_min_audio_ms=300, preview_interval_ms=300))
    await h.start()
    await h.answer("pricing", speak_ms=200)
    await h.until(lambda: h.engine.node_id == "confirm_pricing" and h.engine.phase.value == "LISTENING")
    start_sample = h.engine.listen_start_sample
    h.speech_start(audio_start_ms=0)  # bogus VAD offset pointing into the previous turn
    await asyncio.sleep(0.01)
    await h.feed(400)
    await h.until(lambda: len(h.transport.requests("preview")) >= 1)
    prev = [p for p in h.transport.requests("preview") if p["response"]["metadata"]["node_id"] == "confirm_pricing"][-1]
    msg = [i for i in prev["response"]["input"] if i.get("type") == "message"][0]
    pcm = base64.b64decode(msg["content"][0]["audio"])
    assert len(pcm) <= 2 * 24 * 420
    assert h.engine.utterances[0].start_sample == start_sample
    await h.stop()


async def test_classification_instructions_contain_only_current_node(harness_factory):
    h = harness_factory(rs=RuntimeSettings(final_grace_ms=5, preview_enabled=False))
    await h.start()
    await h.answer("pricing")
    await h.until(lambda: h.engine.node_id == "confirm_pricing" and h.engine.phase.value == "LISTENING")
    await h.answer("yes")
    req = h.transport.requests("final")[-1]["response"]
    enum = req["tools"][0]["parameters"]["properties"]["branch_id"]["enum"]
    assert enum == ["yes", "change", CTRL_UNCLEAR, CTRL_END_REQUEST]
    assert "用件選択 → 料金案内" in req["instructions"]  # limited confirmed history
    await asyncio.wait_for(h.task, 3)
