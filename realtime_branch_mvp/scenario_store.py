"""Local SQLite persistence (single process). Versions are immutable once saved:
an edit always creates a new version; a running session keeps the version it
pinned at creation time.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from typing import Any, Optional

from scenario_schema import Scenario

# version statuses
REVIEW = "REVIEW"                    # draft, awaiting human review/approval
AUDIO_PREPARING = "AUDIO_PREPARING"  # approved, audio job running
AUDIO_FAILED = "AUDIO_FAILED"        # approved, some audio missing (retry possible)
READY = "READY"                      # approved + validated + all audio ready

# job statuses
QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELED, INTERRUPTED = (
    "queued", "running", "succeeded", "failed", "canceled", "interrupted")
TERMINAL_JOB = {SUCCEEDED, FAILED, CANCELED, INTERRUPTED}


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS scenario_versions (
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  generator TEXT NOT NULL,
  parent_version INTEGER,
  voice_json TEXT,
  manifest_json TEXT,
  created_at REAL NOT NULL,
  approved_at REAL,
  PRIMARY KEY (scenario_id, version)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  params_json TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_assets (
  audio_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  duration_ms INTEGER,
  settings_json TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT,
  runtime_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_request ON sessions(request_id);
"""


class Store:
    def __init__(self, path: str):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA_SQL)

    def close(self) -> None:
        self._db.close()

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._db.execute(sql, args))

    def _x(self, sql: str, args: tuple = ()) -> None:
        with self._lock:
            self._db.execute(sql, args)

    # ---------------- recovery ----------------
    def recover_after_restart(self) -> dict[str, int]:
        """Jobs running at shutdown are marked interrupted, never silently ready."""
        with self._lock:
            now = time.time()
            c1 = self._db.execute(
                "UPDATE jobs SET status=?, error=?, updated_at=? WHERE status IN (?,?)",
                (INTERRUPTED, "サーバー再起動により中断されました", now, QUEUED, RUNNING),
            ).rowcount
            c2 = self._db.execute(
                "UPDATE scenario_versions SET status=? WHERE status=?", (AUDIO_FAILED, AUDIO_PREPARING)
            ).rowcount
            c3 = self._db.execute(
                "UPDATE sessions SET status='aborted', end_reason='server_restart', ended_at=? WHERE status IN ('created','active')",
                (now,),
            ).rowcount
        return {"jobs": c1, "versions": c2, "sessions": c3}

    # ---------------- scenarios ----------------
    def next_version(self, scenario_id: str) -> int:
        rows = self._q("SELECT MAX(version) AS v FROM scenario_versions WHERE scenario_id=?", (scenario_id,))
        return (rows[0]["v"] or 0) + 1

    def insert_version(self, scenario: Scenario, validation: dict, generator: str, parent_version: Optional[int]) -> None:
        self._x(
            "INSERT INTO scenario_versions(scenario_id, version, status, data_json, validation_json, generator, parent_version, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (scenario.scenario_id, scenario.version, REVIEW, scenario.model_dump_json(), json.dumps(validation, ensure_ascii=False),
             generator, parent_version, time.time()),
        )

    def get_version(self, scenario_id: str, version: int) -> Optional[dict[str, Any]]:
        rows = self._q("SELECT * FROM scenario_versions WHERE scenario_id=? AND version=?", (scenario_id, version))
        if not rows:
            return None
        r = rows[0]
        return {
            "scenario_id": r["scenario_id"],
            "version": r["version"],
            "status": r["status"],
            "scenario": json.loads(r["data_json"]),
            "validation": json.loads(r["validation_json"]),
            "generator": r["generator"],
            "parent_version": r["parent_version"],
            "voice": json.loads(r["voice_json"]) if r["voice_json"] else None,
            "manifest": json.loads(r["manifest_json"]) if r["manifest_json"] else None,
            "created_at": r["created_at"],
            "approved_at": r["approved_at"],
        }

    def list_versions(self, scenario_id: str) -> list[dict[str, Any]]:
        rows = self._q(
            "SELECT scenario_id, version, status, generator, parent_version, created_at, approved_at FROM scenario_versions"
            " WHERE scenario_id=? ORDER BY version", (scenario_id,))
        return [dict(r) for r in rows]

    def list_scenarios(self) -> list[dict[str, Any]]:
        rows = self._q(
            "SELECT scenario_id, MAX(version) AS latest, MAX(created_at) AS updated FROM scenario_versions GROUP BY scenario_id ORDER BY updated DESC")
        return [dict(r) for r in rows]

    def set_version_status(self, scenario_id: str, version: int, status: str) -> None:
        self._x("UPDATE scenario_versions SET status=? WHERE scenario_id=? AND version=?", (status, scenario_id, version))

    def approve_version(self, scenario_id: str, version: int, voice: dict, manifest: dict) -> None:
        self._x(
            "UPDATE scenario_versions SET status=?, voice_json=?, manifest_json=?, approved_at=? WHERE scenario_id=? AND version=?",
            (AUDIO_PREPARING, json.dumps(voice, ensure_ascii=False), json.dumps(manifest, ensure_ascii=False), time.time(), scenario_id, version),
        )

    def save_manifest(self, scenario_id: str, version: int, manifest: dict) -> None:
        self._x("UPDATE scenario_versions SET manifest_json=? WHERE scenario_id=? AND version=?",
                (json.dumps(manifest, ensure_ascii=False), scenario_id, version))

    # ---------------- jobs ----------------
    def create_job(self, kind: str, params: dict) -> str:
        jid = new_id("job")
        now = time.time()
        self._x("INSERT INTO jobs(id, kind, status, params_json, progress_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (jid, kind, QUEUED, json.dumps(params, ensure_ascii=False), "{}", now, now))
        return jid

    def update_job(self, job_id: str, *, status: Optional[str] = None, progress: Optional[dict] = None,
                   result: Optional[dict] = None, error: Optional[str] = None) -> None:
        sets, args = ["updated_at=?"], [time.time()]
        if status is not None:
            sets.append("status=?"); args.append(status)
        if progress is not None:
            sets.append("progress_json=?"); args.append(json.dumps(progress, ensure_ascii=False))
        if result is not None:
            sets.append("result_json=?"); args.append(json.dumps(result, ensure_ascii=False))
        if error is not None:
            sets.append("error=?"); args.append(error)
        args.append(job_id)
        self._x(f"UPDATE jobs SET {', '.join(sets)} WHERE id=?", tuple(args))

    def get_job(self, job_id: str) -> Optional[dict[str, Any]]:
        rows = self._q("SELECT * FROM jobs WHERE id=?", (job_id,))
        if not rows:
            return None
        r = rows[0]
        return {
            "id": r["id"], "kind": r["kind"], "status": r["status"],
            "params": json.loads(r["params_json"]), "progress": json.loads(r["progress_json"]),
            "result": json.loads(r["result_json"]) if r["result_json"] else None,
            "error": r["error"], "created_at": r["created_at"], "updated_at": r["updated_at"],
        }

    # ---------------- audio ----------------
    def put_asset(self, audio_id: str, path: str, mime: str, byte_length: int, sha: str,
                  duration_ms: Optional[int], settings: dict) -> None:
        self._x(
            "INSERT OR REPLACE INTO audio_assets(audio_id, path, mime, byte_length, content_sha256, duration_ms, settings_json, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (audio_id, path, mime, byte_length, sha, duration_ms, json.dumps(settings, ensure_ascii=False), time.time()))

    def get_asset(self, audio_id: str) -> Optional[dict[str, Any]]:
        rows = self._q("SELECT * FROM audio_assets WHERE audio_id=?", (audio_id,))
        return dict(rows[0]) if rows else None

    def delete_asset(self, audio_id: str) -> None:
        self._x("DELETE FROM audio_assets WHERE audio_id=?", (audio_id,))

    # ---------------- sessions ----------------
    def create_session(self, scenario_id: str, version: int, runtime: dict, request_id: Optional[str]) -> tuple[str, bool]:
        """Returns (session_id, created). Same request_id → same session (double-click safe)."""
        with self._lock:
            if request_id:
                rows = self._q("SELECT id FROM sessions WHERE request_id=?", (request_id,))
                if rows:
                    return rows[0]["id"], False
            sid = new_id("sess")
            self._x("INSERT INTO sessions(id, scenario_id, version, status, request_id, runtime_json, created_at) VALUES (?,?,?,?,?,?,?)",
                    (sid, scenario_id, version, "created", request_id, json.dumps(runtime), time.time()))
            return sid, True

    def get_session(self, sid: str) -> Optional[dict[str, Any]]:
        rows = self._q("SELECT * FROM sessions WHERE id=?", (sid,))
        if not rows:
            return None
        d = dict(rows[0])
        d["runtime"] = json.loads(d.pop("runtime_json"))
        return d

    def claim_session(self, sid: str) -> bool:
        """Atomically move created → active. Sessions are single-use."""
        with self._lock:
            cur = self._db.execute("UPDATE sessions SET status='active' WHERE id=? AND status='created'", (sid,))
            return cur.rowcount == 1

    def end_session(self, sid: str, status: str, reason: str) -> None:
        self._x("UPDATE sessions SET status=?, end_reason=?, ended_at=? WHERE id=?", (status, reason, time.time(), sid))
