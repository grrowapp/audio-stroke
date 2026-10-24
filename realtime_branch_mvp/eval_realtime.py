"""Optional, PAID evaluation of Realtime branch classification on real audio.

    python eval_realtime.py --i-understand-this-costs-money [--only tts|human|noise]

* ``tts`` cases are synthesized with the configured OpenAI TTS (response_format=pcm,
  assumed 24 kHz / 16-bit / mono — verify against the current docs).
* ``human`` cases are read from fixtures/human/<case_id>.wav (24 kHz mono PCM16) if present.
* Results for synthetic and human audio are reported separately; synthetic accuracy
  does not imply microphone accuracy.

The same out-of-band ``response.create`` + ``select_branch`` request as the app's
final decision is used (manual commit, VAD off). Nothing here runs in the test suite.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import random
import struct
import sys
import time
import wave
from pathlib import Path

import router
from config import Settings
from realtime_session import OpenAIRealtimeTransport
from scenario_schema import GeneratedScenario, Scenario

ROOT = Path(__file__).parent


def load_scenario() -> Scenario:
    body = json.loads((ROOT / "fixtures" / "sample_scenario.json").read_text(encoding="utf-8"))
    return Scenario(**GeneratedScenario.model_validate(body).model_dump(), scenario_id="scn_eval000000000000", version=1)


async def tts_pcm(settings: Settings, text: str) -> bytes:
    import openai

    client = openai.AsyncOpenAI(api_key=settings.openai_api_key)
    resp = await client.audio.speech.create(model=settings.tts_model, voice=settings.tts_voice, input=text, response_format="pcm")
    return resp.content


def read_wav(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        if w.getframerate() != 24000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit(f"{path}: 24kHz mono PCM16 が必要です")
        return w.readframes(w.getnframes())


async def wait_for(transport, pred, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        ev = await asyncio.wait_for(transport.recv(), timeout=end - time.monotonic())
        if ev.get("type") == "error":
            print("  realtime error:", ev.get("error", {}).get("message"), file=sys.stderr)
        if pred(ev):
            return ev
    raise TimeoutError


async def classify(transport, sc: Scenario, node_id: str, pcm: bytes, case_id: str) -> tuple[str, float, str]:
    await transport.send({"type": "input_audio_buffer.clear"})
    for i in range(0, len(pcm), 4800):
        await transport.send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm[i:i + 4800]).decode()})
    await transport.send({"type": "input_audio_buffer.commit"})
    committed = await wait_for(transport, lambda e: e.get("type") == "input_audio_buffer.committed")
    iid = committed["item_id"]
    await wait_for(transport, lambda e: e.get("type") == "conversation.item.done" and e.get("item", {}).get("id") == iid)
    node = sc.node(node_id)
    md = {"phase": "final", "request_key": case_id[:60]}
    ev = router.response_event(scenario=sc, node=node, input_items=[{"type": "item_reference", "id": iid}], metadata=md,
                               last_prompt_text=node.assistant_text, history=[], phase="final", event_id="evt_" + case_id[:40])
    t0 = time.monotonic()
    await transport.send(ev)
    done = await wait_for(transport, lambda e: e.get("type") == "response.done"
                          and (e.get("response", {}).get("metadata") or {}).get("request_key") == md["request_key"])
    dt = (time.monotonic() - t0) * 1000
    parsed = router.parse_response(done["response"], router.allowed_branch_ids(node))
    await transport.send({"type": "conversation.item.delete", "item_id": iid})
    return (parsed.branch_id if parsed.ok else f"INVALID:{parsed.error}"), dt, json.dumps(done["response"].get("usage") or {})


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--i-understand-this-costs-money", action="store_true")
    ap.add_argument("--only", choices=["tts", "human", "noise"])
    args = ap.parse_args()
    if not args.i_understand_this_costs_money:
        raise SystemExit("有料API（TTS と Realtime）を呼びます。--i-understand-this-costs-money を付けて実行してください。")
    s = Settings()
    for k in ("openai_api_key", "realtime_model", "tts_model", "tts_voice"):
        if not getattr(s, k):
            raise SystemExit(f"{k.upper()} が未設定です")
    sc = load_scenario()
    cases = json.loads((ROOT / "fixtures" / "eval_ja.json").read_text(encoding="utf-8"))["cases"]
    t = OpenAIRealtimeTransport(s.realtime_url, s.realtime_model, s.openai_api_key)
    await t.connect()
    await t.send({"type": "session.update", "session": {
        "type": "realtime", "output_modalities": ["text"], "instructions": router.SESSION_INSTRUCTIONS,
        "audio": {"input": {"format": {"type": "audio/pcm", "rate": 24000}, "turn_detection": None}}}})
    await wait_for(t, lambda e: e.get("type") == "session.updated")
    results = []
    for c in cases:
        sources = []
        if c["audio"] == "tts" and args.only in (None, "tts"):
            pcm = await tts_pcm(s, c["utterance"])
            if c.get("pre_silence_ms"):
                pcm = b"\x00\x00" * 24 * c["pre_silence_ms"] + pcm
            sources.append(("synthetic_tts", pcm))
        if c["audio"] == "noise" and args.only in (None, "noise"):
            rnd = random.Random(1)
            sources.append(("noise", b"".join(struct.pack("<h", rnd.randint(-3000, 3000)) for _ in range(24000))))
        hp = ROOT / "fixtures" / "human" / f"{c['id']}.wav"
        if hp.exists() and args.only in (None, "human"):
            sources.append(("human_mic", read_wav(hp)))
        if c["audio"] == "silence":
            print(f"- {c['id']}: 無音は no-input タイマーの対象（分類しない）")
            continue
        for src, pcm in sources:
            got, ms, usage = await classify(t, sc, c["node_id"], pcm, c["id"])
            ok = got in c["expected"]
            results.append({"id": c["id"], "source": src, "expected": c["expected"], "got": got, "ok": ok, "ms": round(ms)})
            print(f"{'OK ' if ok else 'NG '} {src:13s} {c['id']:18s} expected={c['expected']} got={got} {ms:.0f}ms usage={usage}")
    await t.close()
    for src in sorted({r["source"] for r in results}):
        rs = [r for r in results if r["source"] == src]
        print(f"[{src}] accuracy {sum(r['ok'] for r in rs)}/{len(rs)}")
    out = ROOT / "data" / f"eval_{int(time.time())}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print("saved", out)


if __name__ == "__main__":
    os.chdir(ROOT)
    asyncio.run(main())
