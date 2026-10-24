"""Semantic graph validation for scenarios.

Errors block approval / audio generation / conversation start. Warnings must be
shown to the reviewer; they never make a scenario "safe" by themselves —
factual correctness of free text cannot be guaranteed by code, so human review
is always required.
"""
from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from scenario_schema import (
    CONTROL_BRANCH_PREFIX,
    ControlAction,
    ControlKind,
    EdgeKind,
    GeneratedScenario,
    Scenario,
)


@dataclass
class Limits:
    max_depth: int = 4
    max_nodes: int = 20          # main + control nodes
    max_branches: int = 4        # edges per node
    max_total_edges: int = 80
    max_total_text_chars: int = 6000
    max_condition_chars_per_node: int = 2500


@dataclass
class Issue:
    code: str
    message: str
    path: str = ""

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "path": self.path}


@dataclass
class ValidationResult:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors

    def err(self, code: str, message: str, path: str = "") -> None:
        self.errors.append(Issue(code, message, path))

    def warn(self, code: str, message: str, path: str = "") -> None:
        self.warnings.append(Issue(code, message, path))

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "errors": [e.as_dict() for e in self.errors],
            "warnings": [w.as_dict() for w in self.warnings],
            "stats": self.stats,
        }


# Dynamic slots / placeholders are forbidden in spoken text.
_SLOT_RE = re.compile(r"\{[^}]*\}|\[[^\]]*\]|［[^］]*］|〇〇|○○|◯◯|ＸＸ|XX|xx|＿＿|__|<[^>]+>|＜[^＞]+＞")
# Money amounts (e.g. 1,000円 / ¥500 / 3万円 / 20%) must appear in source facts.
_MONEY_RE = re.compile(r"(?:[¥￥]\s?[0-9０-９][0-9０-９,，]*|[0-9０-９][0-9０-９,，.]*\s?(?:万|千|百)?\s?円|[0-9０-９]+(?:\.[0-9]+)?\s?[%％])")
_PROMISE_WORDS = ("予約が完了", "予約完了", "申込が完了", "申し込みが完了", "契約が成立", "確定しました", "必ず", "保証します", "無料です")


def _norm_num(s: str) -> str:
    table = str.maketrans("０１２３４５６７８９，％￥", "0123456789,%¥")
    return re.sub(r"[\s,]", "", s.translate(table))


def validate_scenario(
    scenario: GeneratedScenario | Scenario,
    limits: Optional[Limits] = None,
    source_facts: str = "",
) -> ValidationResult:
    limits = limits or Limits()
    r = ValidationResult()
    if isinstance(scenario, Scenario) and not source_facts:
        source_facts = scenario.source_facts

    main_ids = [n.id for n in scenario.nodes]
    ctrl_ids = [c.id for c in scenario.control_nodes]
    all_ids = main_ids + ctrl_ids

    # ---- ids --------------------------------------------------------------
    seen: set[str] = set()
    for i, nid in enumerate(all_ids):
        if nid in seen:
            r.err("duplicate_id", f"ノードIDが重複しています: {nid}", f"nodes[{i}]")
        seen.add(nid)
        if nid.startswith(CONTROL_BRANCH_PREFIX):
            r.err("reserved_prefix", f"ノードIDに予約接頭辞 ctrl_ は使えません: {nid}")

    nodes = {n.id: n for n in scenario.nodes}
    ctrls = {c.id: c for c in scenario.control_nodes}

    if scenario.entry_node_id not in nodes:
        r.err("bad_entry", f"入口ノードが主会話ノードに存在しません: {scenario.entry_node_id}", "entry_node_id")

    # ---- size limits ------------------------------------------------------
    if len(all_ids) > limits.max_nodes:
        r.err("too_many_nodes", f"ノード数 {len(all_ids)} が上限 {limits.max_nodes} を超えています（control node を含む）")
    total_edges = sum(len(n.edges) for n in scenario.nodes)
    if total_edges > limits.max_total_edges:
        r.err("too_many_edges", f"辺数 {total_edges} が上限 {limits.max_total_edges} を超えています")
    total_text = sum(len(n.assistant_text) for n in scenario.nodes) + sum(len(c.assistant_text) for c in scenario.control_nodes)
    if total_text > limits.max_total_text_chars:
        r.err("too_much_text", f"発話文の合計 {total_text} 文字が上限 {limits.max_total_text_chars} を超えています")

    # ---- per node ---------------------------------------------------------
    for n in scenario.nodes:
        p = f"nodes.{n.id}"
        if n.terminal:
            if n.edges:
                r.err("terminal_has_edges", f"終端ノード {n.id} に分岐があります", p)
        else:
            if not n.edges:
                r.err("dead_end", f"非終端ノード {n.id} に進行先がありません", p)
            if len(n.edges) > limits.max_branches:
                r.err("too_many_branches", f"ノード {n.id} の分岐数 {len(n.edges)} が上限 {limits.max_branches} を超えています", p)
            if not any(e.kind != EdgeKind.CORRECTION for e in n.edges):
                r.err("only_correction", f"ノード {n.id} に前進する分岐がありません（訂正のみ）", p)
            # fallback / no-input are mandatory for every accepting node
            fb = ctrls.get(n.fallback_node_id or "")
            if fb is None:
                r.err("missing_fallback", f"ノード {n.id} の fallback_node_id が未設定か参照切れです", p)
            elif fb.kind != ControlKind.CLARIFY:
                r.err("bad_fallback_kind", f"ノード {n.id} の fallback は clarify 種別である必要があります", p)
            ni = ctrls.get(n.no_input_node_id or "")
            if ni is None:
                r.err("missing_no_input", f"ノード {n.id} の no_input_node_id が未設定か参照切れです", p)
            elif ni.kind != ControlKind.NO_INPUT:
                r.err("bad_no_input_kind", f"ノード {n.id} の no_input は no_input 種別である必要があります", p)

        edge_ids: set[str] = set()
        cond_chars = 0
        for e in n.edges:
            ep = f"{p}.edges.{e.id}"
            if e.id in edge_ids:
                r.err("duplicate_edge", f"ノード {n.id} 内で分岐IDが重複: {e.id}", ep)
            edge_ids.add(e.id)
            if e.id.startswith(CONTROL_BRANCH_PREFIX):
                r.err("reserved_prefix", f"分岐IDに予約接頭辞 ctrl_ は使えません: {e.id}", ep)
            if e.target_node_id not in nodes:
                r.err("broken_ref", f"分岐 {n.id}.{e.id} の遷移先 {e.target_node_id} が主会話ノードに存在しません", ep)
            cond_chars += len(e.intent_description) + sum(map(len, e.match_conditions))
            cond_chars += sum(map(len, e.positive_examples)) + sum(map(len, e.negative_examples))
            for ex in e.positive_examples + e.negative_examples + e.match_conditions:
                if len(ex) > 200:
                    r.err("example_too_long", f"条件/例文が長すぎます: {ex[:20]}…", ep)
        if cond_chars > limits.max_condition_chars_per_node:
            r.err("conditions_too_long", f"ノード {n.id} の条件文が合計 {cond_chars} 文字で上限を超えています", p)

    # ---- control nodes ----------------------------------------------------
    for c in scenario.control_nodes:
        p = f"control_nodes.{c.id}"
        if c.action == ControlAction.GOTO_FIXED_NODE:
            if not c.goto_node_id or c.goto_node_id not in nodes:
                r.err("broken_ref", f"control {c.id} の goto_node_id が主会話ノードに存在しません", p)
        elif c.goto_node_id:
            r.err("unexpected_goto", f"control {c.id} は GOTO_FIXED_NODE 以外なので goto_node_id を指定できません", p)
        if c.kind in (ControlKind.LIMIT, ControlKind.END_REQUEST) and c.action != ControlAction.END:
            r.err("control_must_end", f"control {c.id}（{c.kind.value}）の action は END である必要があります", p)
        if c.kind in (ControlKind.CLARIFY, ControlKind.NO_INPUT) and c.action == ControlAction.END:
            r.warn("clarify_ends", f"control {c.id} は聞き返し/無応答ですが会話を終了します", p)

    pol = scenario.policy
    for attr, kind in (("limit_node_id", ControlKind.LIMIT), ("end_request_node_id", ControlKind.END_REQUEST)):
        cid = getattr(pol, attr)
        c = ctrls.get(cid)
        if c is None:
            r.err("broken_ref", f"policy.{attr} が control node に存在しません: {cid}", f"policy.{attr}")
        elif c.kind != kind or c.action != ControlAction.END:
            r.err("bad_policy_ref", f"policy.{attr} は {kind.value} 種別かつ END の control node が必要です", f"policy.{attr}")

    # ---- reachability / DAG / depth ---------------------------------------
    if scenario.entry_node_id in nodes:
        forward: dict[str, list[str]] = {
            n.id: [e.target_node_id for e in n.edges if e.kind != EdgeKind.CORRECTION and e.target_node_id in nodes]
            for n in scenario.nodes
        }
        # cycle detection on forward edges (must be a DAG)
        color: dict[str, int] = {}
        cycle_nodes: set[str] = set()

        def dfs(u: str, stack: list[str]) -> None:
            color[u] = 1
            stack.append(u)
            for v in forward.get(u, []):
                if color.get(v) == 1:
                    cycle_nodes.update(stack[stack.index(v):])
                elif color.get(v) is None:
                    dfs(v, stack)
            stack.pop()
            color[u] = 2

        for nid in nodes:
            if nid not in color:
                dfs(nid, [])
        if cycle_nodes:
            r.err("illegal_loop", f"通常分岐に循環があります（訂正以外のループは不可）: {sorted(cycle_nodes)}")

        # depth = longest forward path from entry (only meaningful for DAG)
        depth: dict[str, int] = {scenario.entry_node_id: 0}
        if not cycle_nodes:
            order: list[str] = []
            seen2: set[str] = set()

            def topo(u: str) -> None:
                seen2.add(u)
                for v in forward.get(u, []):
                    if v not in seen2:
                        topo(v)
                order.append(u)

            topo(scenario.entry_node_id)
            for u in reversed(order):
                for v in forward.get(u, []):
                    depth[v] = max(depth.get(v, 0), depth[u] + 1)
            max_d = max(depth.values()) if depth else 0
            r.stats["max_depth"] = max_d
            if max_d > limits.max_depth:
                r.err("too_deep", f"主会話の深さ {max_d} が上限 {limits.max_depth} を超えています")

        # reachability over all edges (incl. correction + GOTO from controls)
        reach: set[str] = set()
        q = deque([scenario.entry_node_id])
        while q:
            u = q.popleft()
            if u in reach:
                continue
            reach.add(u)
            n = nodes[u]
            for e in n.edges:
                if e.target_node_id in nodes:
                    q.append(e.target_node_id)
            for cid in (n.fallback_node_id, n.no_input_node_id):
                c = ctrls.get(cid or "")
                if c and c.action == ControlAction.GOTO_FIXED_NODE and c.goto_node_id in nodes:
                    q.append(c.goto_node_id)
        unreachable = [nid for nid in nodes if nid not in reach]
        if unreachable:
            r.err("unreachable", f"入口から到達できないノードがあります: {unreachable}")

        if not cycle_nodes:
            only_back = [nid for nid in reach if nid not in depth]
            if only_back:
                r.err("bad_correction", f"通常分岐では到達できず訂正分岐でしか入れないノードがあります: {only_back}")

        # correction edges must go "back" (to a shallower node)
        for n in scenario.nodes:
            for e in n.edges:
                if e.kind == EdgeKind.CORRECTION and e.target_node_id in depth and n.id in depth:
                    if depth[e.target_node_id] >= depth[n.id]:
                        r.err("bad_correction", f"訂正分岐 {n.id}.{e.id} は前のノードへ戻る必要があります", f"nodes.{n.id}.edges.{e.id}")

        if not any(n.terminal for n in scenario.nodes if n.id in reach):
            r.err("no_terminal", "到達可能な終端ノードがありません")

        referenced_ctrl = {pol.limit_node_id, pol.end_request_node_id}
        for n in scenario.nodes:
            referenced_ctrl.update(x for x in (n.fallback_node_id, n.no_input_node_id) if x)
        for cid in ctrls:
            if cid not in referenced_ctrl:
                r.warn("unused_control", f"どこからも参照されない control node: {cid}")

    # ---- content checks ---------------------------------------------------
    facts_norm = _norm_num(source_facts)
    texts = [(f"nodes.{n.id}", n.assistant_text) for n in scenario.nodes]
    texts += [(f"control_nodes.{c.id}", c.assistant_text) for c in scenario.control_nodes]
    for path, text in texts:
        if _SLOT_RE.search(text):
            r.err("dynamic_slot", f"発話文に動的スロット/プレースホルダがあります: 「{text[:40]}」", path)
        for m in _MONEY_RE.finditer(text):
            if _norm_num(m.group(0)) not in facts_norm:
                r.err("unsourced_amount", f"資料に無い金額・割合が発話文にあります: {m.group(0)}", path)
        for w in _PROMISE_WORDS:
            if w in text:
                r.warn("possible_promise", f"断言・約束の可能性がある表現「{w}」を確認してください", path)

    r.stats.update(
        nodes=len(main_ids),
        control_nodes=len(ctrl_ids),
        edges=total_edges,
        text_chars=total_text,
    )
    r.warn("human_review_required", "自由文の事実性はコードで保証できません。発話文・分岐条件を必ず人が確認してください。")
    return r


def reachable_utterance_keys(scenario: Scenario) -> list[tuple[str, str, str]]:
    """(utterance_key, kind, text) for every reachable main node and every control node."""
    out: list[tuple[str, str, str]] = []
    nodes = {n.id: n for n in scenario.nodes}
    reach: list[str] = []
    q = deque([scenario.entry_node_id])
    seen: set[str] = set()
    while q:
        u = q.popleft()
        if u in seen or u not in nodes:
            continue
        seen.add(u)
        reach.append(u)
        for e in nodes[u].edges:
            q.append(e.target_node_id)
    for c in scenario.control_nodes:
        if c.action == ControlAction.GOTO_FIXED_NODE and c.goto_node_id and c.goto_node_id not in seen:
            reach.append(c.goto_node_id)
            seen.add(c.goto_node_id)
    for nid in reach:
        out.append((f"node:{nid}", "node", nodes[nid].assistant_text))
    for c in scenario.control_nodes:
        out.append((f"control:{c.id}", "control", c.assistant_text))
    return out
