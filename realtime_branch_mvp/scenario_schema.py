"""Strict server-side scenario schema.

The same Pydantic models are used for (1) the JSON Schema given to Claude and
(2) validating everything Claude returns or the user edits. Structural
validity here says nothing about semantic correctness; see
``scenario_validator`` for graph checks and keep human review mandatory.

Playback / transition conventions (do not change without updating router.py):
* On entering a node the app plays that node's ``assistant_text`` once.
  Edges carry no reply text, so nothing is ever spoken twice.
* A fallback (unclear) plays the control node's text and then waits for an
  answer to the *same* node without re-speaking it.
* Control node targets come only from enum actions; return targets are held by
  the app, never generated as free node ids.
"""
from __future__ import annotations

import json
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1"

ID_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"
CONTROL_BRANCH_PREFIX = "ctrl_"
CTRL_UNCLEAR = "ctrl_unclear"
CTRL_END_REQUEST = "ctrl_end_request"
RESERVED_BRANCH_IDS = (CTRL_UNCLEAR, CTRL_END_REQUEST)

MAX_TEXT = 300
MAX_LABEL = 40
MAX_DESC = 300
MAX_COND = 200
MAX_EXAMPLE = 80


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class EdgeKind(str, Enum):
    NORMAL = "normal"          # forward progress in the main DAG
    CONFIRM = "confirm"        # affirmative answer to a confirmation
    DENY = "deny"              # negative answer / "no"
    CORRECTION = "correction"  # explicit move back to an earlier node (loop, bounded by policy)


class ControlKind(str, Enum):
    CLARIFY = "clarify"        # unclear / unexpected / off-topic answer
    NO_INPUT = "no_input"      # silence until timeout
    LIMIT = "limit"            # too many retries / turns -> hand off and end
    END_REQUEST = "end_request"  # user asked to stop


class ControlAction(str, Enum):
    RETURN_TO_ORIGIN = "RETURN_TO_ORIGIN"
    END = "END"
    GOTO_FIXED_NODE = "GOTO_FIXED_NODE"


class Edge(_Strict):
    id: str = Field(pattern=ID_PATTERN, description="ノード内で一意。ctrl_ で始めない")
    label: str = Field(min_length=1, max_length=MAX_LABEL)
    intent_description: str = Field(min_length=1, max_length=MAX_DESC, description="この分岐を選ぶべき意図の説明")
    match_conditions: list[str] = Field(default_factory=list, max_length=6, description="判断条件（自然文）")
    positive_examples: list[str] = Field(min_length=1, max_length=12, description="想定返答・言い換えの例（完全一致用ではない）")
    negative_examples: list[str] = Field(default_factory=list, max_length=12, description="この分岐に入れてはいけない例")
    target_node_id: str = Field(pattern=ID_PATTERN)
    kind: EdgeKind = EdgeKind.NORMAL


class Node(_Strict):
    id: str = Field(pattern=ID_PATTERN)
    label: str = Field(min_length=1, max_length=MAX_LABEL)
    assistant_text: str = Field(min_length=1, max_length=MAX_TEXT, description="このノードに入った時に一度だけ読み上げる文そのもの")
    terminal: bool = False
    edges: list[Edge] = Field(default_factory=list, max_length=8)
    fallback_node_id: Optional[str] = Field(default=None, description="clarify 種別の control node id")
    no_input_node_id: Optional[str] = Field(default=None, description="no_input 種別の control node id")


class ControlNode(_Strict):
    id: str = Field(pattern=ID_PATTERN)
    label: str = Field(min_length=1, max_length=MAX_LABEL)
    kind: ControlKind
    assistant_text: str = Field(min_length=1, max_length=MAX_TEXT)
    action: ControlAction
    goto_node_id: Optional[str] = Field(default=None, description="action が GOTO_FIXED_NODE の時だけ指定")


class Policy(_Strict):
    max_turns: int = Field(default=12, ge=1, le=50)
    max_clarify_per_node: int = Field(default=2, ge=0, le=5)
    max_no_input_per_node: int = Field(default=2, ge=0, le=5)
    no_input_timeout_ms: int = Field(default=8000, ge=2000, le=30000)
    limit_node_id: str = Field(pattern=ID_PATTERN, description="上限到達時の control node (action=END)")
    end_request_node_id: str = Field(pattern=ID_PATTERN, description="終了希望時の control node (action=END)")


class GeneratedScenario(_Strict):
    """Exactly what Claude is asked to produce."""
    title: str = Field(min_length=1, max_length=80)
    entry_node_id: str = Field(pattern=ID_PATTERN)
    nodes: list[Node] = Field(min_length=1, max_length=40)
    control_nodes: list[ControlNode] = Field(min_length=1, max_length=12)
    policy: Policy
    design_notes: str = Field(default="", max_length=600, description="簡潔な設計説明（推論全文は不要）")


class Scenario(GeneratedScenario):
    """Stored scenario: generated body + app-owned metadata."""
    schema_version: Literal["1"] = SCHEMA_VERSION
    scenario_id: str
    version: int = Field(ge=1)
    locale: Literal["ja-JP"] = "ja-JP"
    source_instruction: str = Field(default="", max_length=4000)
    source_facts: str = Field(default="", max_length=8000)
    constraints: list[str] = Field(default_factory=list, max_length=30)

    # audio_manifest is never part of the scenario; the app attaches it per version.

    def node(self, node_id: str) -> Optional[Node]:
        return next((n for n in self.nodes if n.id == node_id), None)

    def control(self, node_id: str) -> Optional[ControlNode]:
        return next((n for n in self.control_nodes if n.id == node_id), None)

    def body(self) -> GeneratedScenario:
        return GeneratedScenario.model_validate(
            self.model_dump(include=set(GeneratedScenario.model_fields))
        )


def utterance_key(kind: str, node_id: str) -> str:
    assert kind in ("node", "control")
    return f"{kind}:{node_id}"


# ---------------------------------------------------------------------------
# JSON Schema for Claude
# ---------------------------------------------------------------------------

_UNSUPPORTED_KEYS = {
    "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum", "pattern", "default", "title",
}


def _inline_refs(node: Any, defs: dict[str, Any]) -> Any:
    if isinstance(node, dict):
        if "$ref" in node:
            name = node["$ref"].split("/")[-1]
            return _inline_refs(defs[name], defs)
        return {k: _inline_refs(v, defs) for k, v in node.items() if k != "$defs"}
    if isinstance(node, list):
        return [_inline_refs(v, defs) for v in node]
    return node


def _sanitize(node: Any) -> Any:
    """Drop keywords structured outputs may not accept; the server re-validates
    with the full Pydantic model, so dropping constraints here is safe."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in _UNSUPPORTED_KEYS:
                continue
            if k == "properties":
                out[k] = {pk: _sanitize(pv) for pk, pv in v.items()}
            else:
                out[k] = _sanitize(v)
        if out.get("type") == "object":
            out["additionalProperties"] = False
            out["required"] = list(out.get("properties", {}).keys())
        # Optional[str] -> anyOf [string, null] is kept as-is.
        return out
    if isinstance(node, list):
        return [_sanitize(v) for v in node]
    return node


def generation_json_schema(sanitized: bool = True) -> dict[str, Any]:
    raw = GeneratedScenario.model_json_schema()
    defs = raw.get("$defs", {})
    inlined = _inline_refs(raw, defs)
    return _sanitize(inlined) if sanitized else inlined


def full_json_schema_text() -> str:
    """Human-readable schema (with limits) included in the system prompt."""
    return json.dumps(generation_json_schema(sanitized=False), ensure_ascii=False)
