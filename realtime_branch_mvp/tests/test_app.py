"""HTTP + WebSocket integration with mock providers (no keys, no network)."""
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import create_app
from realtime_session import MockRealtimeTransport
from scenario_generator import MockScenarioGenerator
from tts import MockSpeechSynthesizer

ORIGIN = {"origin": "http://testserver"}


@pytest.fixture
def client(settings):
    synth = MockSpeechSynthesizer(delay_s=0)
    app = create_app(settings, generator=MockScenarioGenerator(settings, delay_s=0), synthesizer=synth,
                     transport_factory=lambda: MockRealtimeTransport(response_delay_s=0.02),
                     extra_allowed_hosts=("testserver",))
    with TestClient(app) as c:
        c.synth = synth
        yield c


def post(c, path, body):
    r = c.post(path, json=body, headers=ORIGIN)
    return r


def wait_job(c, jid, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        j = c.get(f"/api/jobs/{jid}").json()
        if j["status"] in ("succeeded", "failed", "canceled", "interrupted"):
            return j
        time.sleep(0.05)
    raise AssertionError("job timeout")


def voice(c):
    cfg = c.get("/api/config").json()
    vo = cfg["voice_options"]
    return {"provider": vo["providers"][0], "model": vo["models"][0], "voice": vo["voices"][0], "speed": 1.0, "style_id": "polite"}


def prepare_ready(c):
    r = post(c, "/api/scenarios/generate", {"instruction": "問い合わせ受付"})
    assert r.status_code == 200, r.text
    j = wait_job(c, r.json()["job_id"])
    assert j["status"] == "succeeded", j
    sid = j["result"]["scenario_id"]
    r = post(c, f"/api/scenarios/{sid}/versions/1/approve", {"voice": voice(c), "confirm_reviewed": True})
    assert r.status_code == 200, r.text
    j = wait_job(c, r.json()["job_id"])
    assert j["status"] == "succeeded", j
    return sid


def test_config_reports_mock(client):
    cfg = client.get("/api/config").json()
    assert cfg["providers"]["scenario"]["mock"] and cfg["providers"]["tts"]["mock"] and cfg["providers"]["realtime"]["mock"]
    assert "speech_start_event_to_first_preview_ms" in cfg["metric_definitions"]
    assert "ANTHROPIC" not in json.dumps(cfg) and "sk-" not in json.dumps(cfg)


def test_origin_host_and_content_type_guards(client):
    assert client.post("/api/scenarios/generate", json={"instruction": "x"}).status_code == 403  # no Origin
    assert client.post("/api/scenarios/generate", json={"instruction": "x"}, headers={"origin": "http://evil.example"}).status_code == 403
    r = client.post("/api/scenarios/generate", content="instruction=x", headers={**ORIGIN, "content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 415
    r = client.get("/api/config", headers={"host": "evil.example"})
    assert r.status_code == 421
    big = {"instruction": "x" * 600_000}
    assert post(client, "/api/scenarios/generate", big).status_code == 413
    assert post(client, "/api/scenarios/generate", {"instruction": "x" * 4001}).status_code == 422
    assert post(client, "/api/scenarios/generate", {"instruction": "x", "max_nodes": 999}).status_code == 422


def test_audio_path_traversal_rejected(client):
    for p in ["/api/audio/..%2F..%2Fetc%2Fpasswd", "/api/audio/" + "a" * 63, "/api/audio/" + "g" * 64, "/api/audio/" + "0" * 64]:
        assert client.get(p).status_code == 404
    assert client.get("/api/sessions/../../x/log.jsonl").status_code == 404


def test_full_flow_review_edit_approve_ready_session(client):
    r = post(client, "/api/scenarios/generate", {"instruction": "問い合わせ受付", "first_utterance": "お電話ありがとうございます。料金、デモ、操作サポートのどれをご希望ですか。"})
    j = wait_job(client, r.json()["job_id"])
    sid = j["result"]["scenario_id"]
    row = client.get(f"/api/scenarios/{sid}/versions/1").json()
    assert row["status"] == "REVIEW" and row["is_mock_generated"]
    # draft cannot start a session
    assert post(client, "/api/sessions", {"scenario_id": sid, "version": 1}).status_code == 409
    # approval requires explicit review confirmation
    assert post(client, f"/api/scenarios/{sid}/versions/1/approve", {"voice": voice(client)}).status_code == 400
    # disallowed voice values are rejected server-side
    bad = {**voice(client), "voice": "alloy"}
    assert post(client, f"/api/scenarios/{sid}/versions/1/approve", {"voice": bad, "confirm_reviewed": True}).status_code == 400

    # edit → new version, validation runs
    sc = row["scenario"]
    body = {k: sc[k] for k in ("title", "entry_node_id", "nodes", "control_nodes", "policy", "design_notes")}
    body["nodes"][1]["assistant_text"] = "料金のご案内ですね。月額3,000円です。"
    r = post(client, f"/api/scenarios/{sid}/versions", {"base_version": 1, "scenario": body})
    assert r.status_code == 200
    v2 = r.json()
    assert v2["version"] == 2 and not v2["validation"]["ok"]
    assert post(client, f"/api/scenarios/{sid}/versions/2/approve", {"voice": voice(client), "confirm_reviewed": True}).status_code == 422
    # schema violations are refused
    body2 = json.loads(json.dumps(body))
    body2["nodes"][0]["evil"] = "<script>"
    assert post(client, f"/api/scenarios/{sid}/versions", {"base_version": 1, "scenario": body2}).status_code == 422

    # approve v1 → audio → READY
    r = post(client, f"/api/scenarios/{sid}/versions/1/approve", {"voice": voice(client), "confirm_reviewed": True})
    j = wait_job(client, r.json()["job_id"])
    assert j["status"] == "succeeded" and j["version_status"] == "READY"
    m = client.get(f"/api/scenarios/{sid}/versions/1/manifest").json()
    assert m["summary"]["ready"] == m["summary"]["total"] == 13 and m["mock_audio"]
    aid = next(iter(m["entries"].values()))["audio_id"]
    a = client.get(f"/api/audio/{aid}")
    assert a.status_code == 200 and a.headers["content-type"] == "audio/wav" and a.content[:4] == b"RIFF"

    s1 = post(client, "/api/sessions", {"scenario_id": sid, "version": 1, "request_id": "abc123"}).json()
    s2 = post(client, "/api/sessions", {"scenario_id": sid, "version": 1, "request_id": "abc123"}).json()
    assert s1["session_id"] == s2["session_id"] and s2["created"] is False
    assert post(client, "/api/sessions", {"scenario_id": sid, "version": 1, "runtime": {"silence_duration_ms": 5}}).status_code == 400


def test_session_blocked_when_audio_missing(client, settings):
    sid = prepare_ready(client)
    m = client.get(f"/api/scenarios/{sid}/versions/1/manifest").json()
    victim = m["entries"]["control:end_request"]["audio_id"]
    for p in (settings.data_dir / "audio").glob(f"{victim}.*"):
        p.unlink()
    r = post(client, "/api/sessions", {"scenario_id": sid, "version": 1})
    assert r.status_code == 409 and "control:end_request" in json.dumps(r.json())


def recv_until(ws, pred, limit=400):
    seen = []
    for _ in range(limit):
        m = ws.receive_json()
        seen.append(m)
        if pred(m):
            return m, seen
    raise AssertionError(f"not seen: {[x['type'] for x in seen][-20:]}")


def ack_play(ws, m):
    ws.send_json({"type": "playback_started", "playback_id": m["playback_id"]})
    ws.send_json({"type": "playback_ended", "playback_id": m["playback_id"]})


def test_ws_e2e_with_mock_realtime(client, settings):
    sid = prepare_ready(client)
    calls_before = len(client.synth.calls)
    sess = post(client, "/api/sessions", {"scenario_id": sid, "version": 1,
                                          "runtime": {"final_grace_ms": 50, "preview_min_audio_ms": 300, "preview_interval_ms": 300}}).json()
    url = f"/ws?session_id={sess['session_id']}"
    with pytest.raises(Exception):
        with client.websocket_connect(url, headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()
    with client.websocket_connect(url, headers=ORIGIN) as ws:
        play, _ = recv_until(ws, lambda m: m["type"] == "play")
        assert play["utterance_key"] == "node:select_need"
        ack_play(ws, play)
        recv_until(ws, lambda m: m["type"] == "state" and m["phase"] == "LISTENING")
        ws.send_json({"type": "mock_vad", "action": "start", "preview_branch": "pricing", "final_branch": "demo"})
        for _ in range(25):
            ws.send_bytes(b"\x00\x00" * 480)
        prev, _ = recv_until(ws, lambda m: m["type"] == "preview")
        assert prev["branch_id"] == "pricing" and prev["provisional"]
        ws.send_json({"type": "mock_vad", "action": "stop"})
        fin, seen = recv_until(ws, lambda m: m["type"] == "final")
        assert fin["branch_id"] == "demo"
        play2, seen2 = recv_until(ws, lambda m: m["type"] == "play")
        assert play2["utterance_key"] == "node:confirm_demo"  # final wins over preview
        assert not any(m["type"] == "play" and m["utterance_key"] == "node:confirm_pricing" for m in seen + seen2)
        ack_play(ws, play2)
        recv_until(ws, lambda m: m["type"] == "state" and m["phase"] == "LISTENING")
        ws.send_json({"type": "mock_vad", "action": "start", "final_branch": "yes"})
        for _ in range(5):
            ws.send_bytes(b"\x00\x00" * 480)
        ws.send_json({"type": "mock_vad", "action": "stop"})
        play3, _ = recv_until(ws, lambda m: m["type"] == "play")
        assert play3["utterance_key"] == "node:end_demo" and play3["terminal_after"]
        ack_play(ws, play3)
        done, _ = recv_until(ws, lambda m: m["type"] == "finished")
        assert done["phase"] == "FINISHED"
    assert len(client.synth.calls) == calls_before  # no TTS during the conversation
    # single-use session
    with client.websocket_connect(url, headers=ORIGIN) as ws:
        m = ws.receive_json()
        assert m["reason"] == "session_used"
    # log export: no audio / keys
    log = client.get(f"/api/sessions/{sess['session_id']}/log.jsonl")
    assert log.status_code == 200
    lines = [json.loads(x) for x in log.text.splitlines()]
    kinds = {x["event"] for x in lines}
    assert {"session_start", "preview", "turn", "summary"} <= kinds
    assert "AAAA" not in log.text and "audio\":" not in log.text
    summary = [x for x in lines if x["event"] == "summary"][0]
    assert summary["counters"]["preview_results"] >= 1 and summary["counters"]["turns"] == 2


def test_ws_stop_during_playback(client):
    sid = prepare_ready(client)
    sess = post(client, "/api/sessions", {"scenario_id": sid, "version": 1}).json()
    with client.websocket_connect(f"/ws?session_id={sess['session_id']}", headers=ORIGIN) as ws:
        recv_until(ws, lambda m: m["type"] == "play")
        ws.send_json({"type": "stop"})
        done, _ = recv_until(ws, lambda m: m["type"] == "finished")
        assert done["phase"] == "STOPPED" and done["reason"] == "user_stop"
