"""Content-addressed audio cache + per-version manifests.

Cache key = sha256 over (cache spec version, provider, model, voice, format,
speed, style id + text, API settings, exact utterance text). Node ids are not
part of the key, so identical text+settings share one file, and edits that only
touch branch conditions reuse audio.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Optional

from scenario_schema import Scenario
from scenario_store import Store
from scenario_validator import reachable_utterance_keys
from tts import CACHE_SPEC_VERSION, VoiceSettings

AUDIO_ID_RE = re.compile(r"^[0-9a-f]{64}$")
EXT = {"audio/mpeg": ".mp3", "audio/wav": ".wav"}


def cache_key(vs: VoiceSettings, text: str) -> str:
    payload = {
        "cache_spec": CACHE_SPEC_VERSION,
        "provider": vs.provider,
        "model": vs.model,
        "voice": vs.voice,
        "format": vs.format,
        "speed": round(vs.speed, 3),
        "style_id": vs.style_id,
        "style_text": vs.style_text,
        "api": vs.api,
        "text": text,
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


class AudioStore:
    def __init__(self, root: Path, store: Store):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.store = store

    def _path_for(self, audio_id: str, mime: str) -> Path:
        assert AUDIO_ID_RE.match(audio_id)
        return self.root / f"{audio_id}{EXT[mime]}"

    def is_ready(self, audio_id: str) -> bool:
        return self.ready_asset(audio_id) is not None

    def ready_asset(self, audio_id: str) -> Optional[dict[str, Any]]:
        if not AUDIO_ID_RE.match(audio_id or ""):
            return None
        a = self.store.get_asset(audio_id)
        if not a:
            return None
        p = Path(a["path"])
        try:
            if p.parent.resolve() != self.root.resolve() or not p.is_file() or p.stat().st_size != a["byte_length"]:
                return None
        except OSError:
            return None
        return a

    def verify_content(self, audio_id: str) -> bool:
        a = self.ready_asset(audio_id)
        if not a:
            return False
        return hashlib.sha256(Path(a["path"]).read_bytes()).hexdigest() == a["content_sha256"]

    def write(self, audio_id: str, data: bytes, mime: str, duration_ms: Optional[int], settings: dict) -> dict[str, Any]:
        """Atomic: write temp file in the same dir, fsync, rename, then publish DB row."""
        final = self._path_for(audio_id, mime)
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".partial-", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, final)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        sha = hashlib.sha256(data).hexdigest()
        self.store.put_asset(audio_id, str(final), mime, len(data), sha, duration_ms, settings)
        return {"content_sha256": sha, "byte_length": len(data), "mime": mime, "duration_ms": duration_ms}

    def cleanup_partials(self) -> int:
        n = 0
        for p in self.root.glob(".partial-*"):
            try:
                p.unlink()
                n += 1
            except OSError:
                pass
        return n


def build_manifest(scenario: Scenario, vs: VoiceSettings, audio: AudioStore) -> dict[str, Any]:
    entries: dict[str, Any] = {}
    for key, kind, text in reachable_utterance_keys(scenario):
        aid = cache_key(vs, text)
        a = audio.ready_asset(aid)
        entries[key] = {
            "utterance_key": key,
            "kind": kind,
            "text": text,
            "audio_id": aid,
            "status": "ready" if a else "pending",
            "cache_hit": bool(a),
            "mime": a["mime"] if a else None,
            "byte_length": a["byte_length"] if a else None,
            "content_sha256": a["content_sha256"] if a else None,
            "duration_ms": a["duration_ms"] if a else None,
            "error": None,
        }
    return {
        "scenario_id": scenario.scenario_id,
        "version": scenario.version,
        "voice": vs.as_dict(),
        "entries": entries,
    }


def manifest_summary(manifest: Optional[dict]) -> dict[str, Any]:
    if not manifest:
        return {"total": 0, "ready": 0, "failed": 0, "pending": 0, "cache_hits": 0, "chars": 0}
    es = manifest["entries"].values()
    return {
        "total": len(manifest["entries"]),
        "ready": sum(1 for e in es if e["status"] == "ready"),
        "failed": sum(1 for e in es if e["status"] == "failed"),
        "pending": sum(1 for e in es if e["status"] in ("pending", "generating")),
        "cache_hits": sum(1 for e in es if e.get("cache_hit")),
        "chars": sum(len(e["text"]) for e in es),
        "chars_to_generate": sum(len(e["text"]) for e in es if not e.get("cache_hit")),
    }


def manifest_missing(manifest: Optional[dict], audio: AudioStore, scenario: Scenario) -> list[str]:
    """Keys that are not playable right now. Empty list == every required audio is ready."""
    if not manifest:
        return ["<no manifest>"]
    missing = []
    required = {k for k, _kind, _t in reachable_utterance_keys(scenario)}
    entries = manifest.get("entries", {})
    for key in sorted(required):
        e = entries.get(key)
        if not e or e.get("status") != "ready" or not audio.is_ready(e.get("audio_id", "")):
            missing.append(key)
            continue
        expected_text = next(t for k, _kind, t in reachable_utterance_keys(scenario) if k == key)
        if e["text"] != expected_text:
            missing.append(key)
    return missing
