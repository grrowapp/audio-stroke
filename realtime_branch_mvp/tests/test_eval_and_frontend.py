import json
import re
from pathlib import Path

import router
from conftest import ROOT, sample_scenario

REQUIRED_PHRASES = ["料金を知りたい", "デモを見たい", "使い方が分からない", "料金、ではなくデモです", "それは結構です",
                    "大丈夫です", "はい、でもちょっと待って", "前の話に戻って", "終了してください"]


def test_eval_fixture_is_well_formed():
    data = json.loads((ROOT / "fixtures" / "eval_ja.json").read_text(encoding="utf-8"))
    sc = sample_scenario()
    utterances = [c["utterance"] for c in data["cases"] if c["utterance"]]
    for p in REQUIRED_PHRASES:
        assert p in utterances, p
    kinds = {c["audio"] for c in data["cases"]}
    assert {"tts", "noise", "silence"} <= kinds
    assert any(c.get("pre_silence_ms") for c in data["cases"])  # long pause
    ids = set()
    for c in data["cases"]:
        assert c["id"] not in ids
        ids.add(c["id"])
        node = sc.node(c["node_id"])
        assert node is not None and not node.terminal
        allowed = set(router.allowed_branch_ids(node)) | {"__no_input__"}
        assert set(c["expected"]) <= allowed, c
    # ambiguous phrases are labelled per node, not globally
    by = {(c["node_id"], c["utterance"]): c["expected"] for c in data["cases"]}
    assert by[("select_need", "大丈夫です")] != by[("confirm_pricing", "大丈夫です")]


def test_frontend_never_uses_innerhtml_or_eval():
    js = (ROOT / "static" / "client.js").read_text(encoding="utf-8")
    for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
        assert bad not in js, bad
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    assert "<script>" not in html  # only external same-origin script (CSP script-src 'self')


def test_no_secrets_in_static_or_logs_code():
    for p in list((ROOT / "static").iterdir()) + [ROOT / "metrics.py"]:
        t = p.read_text(encoding="utf-8")
        assert "OPENAI_API_KEY" not in t and "ANTHROPIC_API_KEY" not in t
        assert not re.search(r"sk-[A-Za-z0-9]{10,}", t)


def test_env_example_has_empty_keys():
    env = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert re.search(r"^OPENAI_API_KEY=$", env, re.M)
    assert re.search(r"^ANTHROPIC_API_KEY=$", env, re.M)
