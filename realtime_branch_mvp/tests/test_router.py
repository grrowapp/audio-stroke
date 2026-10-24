"""Dynamic router tests (ported from the former fixed SELECT_NEED / CONFIRM_* router)."""
import json

import router
from conftest import sample_scenario
from scenario_schema import CTRL_END_REQUEST, CTRL_UNCLEAR


def call(branch, **kw):
    out = {"type": "function_call", "name": "select_branch", "status": "completed",
           "arguments": json.dumps({"branch_id": branch, "reason": "r"})}
    out.update(kw)
    return out


def done(output, status="completed"):
    return {"status": status, "output": output}


def test_allowed_enum_is_per_node():
    sc = sample_scenario()
    assert router.allowed_branch_ids(sc.node("select_need")) == ["pricing", "demo", "support", CTRL_UNCLEAR, CTRL_END_REQUEST]
    assert router.allowed_branch_ids(sc.node("confirm_demo")) == ["yes", "change", CTRL_UNCLEAR, CTRL_END_REQUEST]
    tool = router.select_branch_tool(sc.node("confirm_demo"))
    assert tool["parameters"]["properties"]["branch_id"]["enum"] == ["yes", "change", CTRL_UNCLEAR, CTRL_END_REQUEST]
    assert tool["parameters"]["additionalProperties"] is False


def test_response_event_is_out_of_band_text_only():
    sc = sample_scenario()
    n = sc.node("select_need")
    ev = router.response_event(scenario=sc, node=n, input_items=[{"type": "item_reference", "id": "item_1"}],
                               metadata={"phase": "final"}, last_prompt_text=n.assistant_text, history=[],
                               phase="final", event_id="evt_r_x")
    r = ev["response"]
    assert r["conversation"] == "none"
    assert r["output_modalities"] == ["text"]
    assert r["input"] == [{"type": "item_reference", "id": "item_1"}]
    assert r["tool_choice"] == "required" and r["tools"][0]["name"] == "select_branch"
    assert "前の指示を無視" in r["instructions"]  # injection-in-audio guidance


def test_parse_valid_and_invalid():
    allowed = ["pricing", "demo", CTRL_UNCLEAR]
    assert router.parse_response(done([call("demo")]), allowed).branch_id == "demo"
    assert router.parse_response(done([call("hack")]), allowed).error == "branch_not_allowed"
    assert router.parse_response(done([call("demo"), call("pricing")]), allowed).error == "multiple_function_calls"
    assert router.parse_response(done([]), allowed).error == "no_function_call"
    assert router.parse_response(done([{"type": "message", "content": [{"text": "料金です"}]}]), allowed).error == "no_function_call"
    assert router.parse_response(done([call("demo", arguments="{not json")]), allowed).error == "invalid_json_arguments"
    assert router.parse_response(done([call("demo", arguments=json.dumps({"branch_id": 3}))]), allowed).error == "branch_id_not_string"
    assert router.parse_response(done([call("demo", name="run_shell")]), allowed).error == "unknown_function"
    assert router.parse_response(done([call("demo")], status="failed"), allowed).error.startswith("status:failed")
    assert router.parse_response(done([call("demo")], status="cancelled"), allowed).error.startswith("status:cancelled")


def test_legacy_pricing_demo_support_paths():
    sc = sample_scenario()
    for branch, confirm, end in [("pricing", "confirm_pricing", "end_pricing"), ("demo", "confirm_demo", "end_demo"),
                                 ("support", "confirm_support", "end_support")]:
        c = router.Counters()
        s1 = router.transition(sc, "select_need", branch, c)
        assert s1.play_key == f"node:{confirm}" and s1.after == "listen"
        s2 = router.transition(sc, confirm, "yes", c)
        assert s2.play_key == f"node:{end}" and s2.after == "finish"


def test_fallback_returns_to_origin_without_respeaking():
    sc = sample_scenario()
    c = router.Counters()
    s = router.transition(sc, "select_need", CTRL_UNCLEAR, c)
    assert s.play_key == "control:clarify_need" and s.after == "listen" and s.next_node_id == "select_need"


def test_clarify_limit_then_handoff():
    sc = sample_scenario()
    c = router.Counters()
    for _ in range(sc.policy.max_clarify_per_node):
        assert router.transition(sc, "select_need", CTRL_UNCLEAR, c).reason == "fallback"
    s = router.transition(sc, "select_need", CTRL_UNCLEAR, c)
    assert s.reason == "limit" and s.play_key == "control:limit_handoff" and s.after == "finish"


def test_no_input_limit():
    sc = sample_scenario()
    c = router.Counters()
    assert router.transition_no_input(sc, "confirm_demo", c).play_key == "control:no_input_confirm"
    router.transition_no_input(sc, "confirm_demo", c)
    assert router.transition_no_input(sc, "confirm_demo", c).reason == "limit"


def test_end_request_from_any_node_and_correction():
    sc = sample_scenario()
    for nid in ("select_need", "confirm_pricing", "confirm_support"):
        s = router.transition(sc, nid, CTRL_END_REQUEST, router.Counters())
        assert s.play_key == "control:end_request" and s.after == "finish"
    s = router.transition(sc, "confirm_pricing", "change", router.Counters())
    assert s.play_key == "node:select_need" and s.after == "listen"


def test_max_turns_forces_limit():
    sc = sample_scenario()
    c = router.Counters(user_turns=sc.policy.max_turns)
    assert router.transition(sc, "select_need", "demo", c).reason == "limit"


def test_unvalidated_branch_is_treated_as_unclear():
    sc = sample_scenario()
    s = router.transition(sc, "select_need", "not_an_edge", router.Counters())
    assert s.reason == "fallback"
