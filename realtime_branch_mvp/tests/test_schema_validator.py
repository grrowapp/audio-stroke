import copy
import json

import pytest
from pydantic import ValidationError

from conftest import sample_body
from scenario_schema import GeneratedScenario, generation_json_schema
from scenario_validator import Limits, reachable_utterance_keys, validate_scenario


def v(body, limits=None, facts=""):
    return validate_scenario(GeneratedScenario.model_validate(body), limits or Limits(), source_facts=facts)


def codes(res):
    return {e.code for e in res.errors}


def test_sample_graph_is_valid():
    r = v(sample_body())
    assert r.ok, r.errors
    assert r.stats["max_depth"] == 2
    assert any(w.code == "human_review_required" for w in r.warnings)


def test_broken_json_is_rejected_by_schema():
    with pytest.raises(ValueError):
        json.loads('{"title": "x", ')


def test_extra_field_rejected():
    b = sample_body()
    b["nodes"][0]["reply_text"] = "二重発話"
    with pytest.raises(ValidationError):
        GeneratedScenario.model_validate(b)
    b = sample_body()
    b["audio_manifest"] = {}
    with pytest.raises(ValidationError):
        GeneratedScenario.model_validate(b)


def test_bad_id_pattern_rejected():
    b = sample_body()
    b["nodes"][0]["edges"][0]["id"] = "../etc"
    with pytest.raises(ValidationError):
        GeneratedScenario.model_validate(b)


def test_duplicate_ids():
    b = sample_body()
    b["control_nodes"][0]["id"] = "select_need"
    assert "duplicate_id" in codes(v(b))
    b = sample_body()
    b["nodes"][0]["edges"][1]["id"] = "pricing"
    assert "duplicate_edge" in codes(v(b))


def test_broken_reference_and_entry():
    b = sample_body()
    b["nodes"][0]["edges"][0]["target_node_id"] = "nowhere"
    assert "broken_ref" in codes(v(b))
    b = sample_body()
    b["entry_node_id"] = "clarify_need"  # control node is not a valid entry
    assert "bad_entry" in codes(v(b))


def test_illegal_loop_on_normal_edges():
    b = sample_body()
    b["nodes"][1]["edges"][1]["kind"] = "normal"  # confirm_pricing -> select_need becomes a normal cycle
    assert "illegal_loop" in codes(v(b))


def test_correction_must_go_back():
    b = sample_body()
    b["nodes"][0]["edges"][0]["kind"] = "correction"  # select_need -> confirm_pricing is forward
    r = v(b)
    assert "bad_correction" in codes(r)


def test_unreachable_node():
    b = sample_body()
    b["nodes"].append({"id": "orphan", "label": "孤立", "assistant_text": "孤立しています。", "terminal": True,
                       "edges": [], "fallback_node_id": None, "no_input_node_id": None})
    assert "unreachable" in codes(v(b))


def test_limits_exceeded():
    r = v(sample_body(), Limits(max_nodes=5))
    assert "too_many_nodes" in codes(r)
    r = v(sample_body(), Limits(max_depth=1))
    assert "too_deep" in codes(r)
    r = v(sample_body(), Limits(max_branches=2))
    assert "too_many_branches" in codes(r)


def test_missing_fallback_no_input_and_policy():
    b = sample_body()
    b["nodes"][0]["fallback_node_id"] = None
    b["nodes"][1]["no_input_node_id"] = "clarify_confirm"  # wrong kind
    r = v(b)
    assert {"missing_fallback", "bad_no_input_kind"} <= codes(r)
    b = sample_body()
    b["policy"]["end_request_node_id"] = "clarify_need"
    assert "bad_policy_ref" in codes(v(b))


def test_terminal_rules():
    b = sample_body()
    b["nodes"][4]["edges"] = copy.deepcopy(b["nodes"][1]["edges"])
    assert "terminal_has_edges" in codes(v(b))
    b = sample_body()
    for n in b["nodes"]:
        n["terminal"] = False
    r = v(b)
    assert "dead_end" in codes(r)


def test_dead_end_non_terminal():
    b = sample_body()
    b["nodes"][4]["terminal"] = False
    b["nodes"][4]["fallback_node_id"] = "clarify_need"
    b["nodes"][4]["no_input_node_id"] = "no_input_need"
    assert "dead_end" in codes(v(b))


def test_dynamic_slot_and_unsourced_amount():
    b = sample_body()
    b["nodes"][0]["assistant_text"] = "{customer_name}様、お問い合わせありがとうございます。"
    assert "dynamic_slot" in codes(v(b))
    b = sample_body()
    b["nodes"][1]["assistant_text"] = "料金は月額3,000円です。よろしいでしょうか。"
    assert "unsourced_amount" in codes(v(b))
    assert v(b, facts="ベーシックプランは月額3,000円").ok
    b = sample_body()
    b["nodes"][5]["assistant_text"] = "予約が完了しました。"
    assert any(w.code == "possible_promise" for w in v(b).warnings)


def test_control_action_rules():
    b = sample_body()
    b["control_nodes"][4]["action"] = "RETURN_TO_ORIGIN"  # limit must END
    assert "control_must_end" in codes(v(b))
    b = sample_body()
    b["control_nodes"][0]["action"] = "GOTO_FIXED_NODE"
    b["control_nodes"][0]["goto_node_id"] = "missing"
    assert "broken_ref" in codes(v(b))


def test_reserved_prefix():
    b = sample_body()
    b["nodes"][0]["edges"][0]["id"] = "ctrl_unclear"
    assert "reserved_prefix" in codes(v(b))


def test_reachable_utterances_include_controls():
    from conftest import sample_scenario
    keys = [k for k, _kind, _t in reachable_utterance_keys(sample_scenario())]
    assert "node:select_need" in keys and "control:end_request" in keys and "control:limit_handoff" in keys
    assert len(keys) == 13


def test_generation_schema_is_strict_and_inlined():
    s = generation_json_schema()
    txt = json.dumps(s)
    assert "$ref" not in txt and "maxLength" not in txt
    assert s["additionalProperties"] is False
    node = s["properties"]["nodes"]["items"]
    assert node["additionalProperties"] is False and "assistant_text" in node["required"]
