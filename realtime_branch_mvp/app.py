"""HTTP / WebSocket entry point (local single-process MVP).

Run:  python app.py      (binds 127.0.0.1 by default)

Not a shared service: there is no authentication, authorization or usage
quota. Publishing it requires adding those first.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from audio_store import AUDIO_ID_RE, AudioStore, build_manifest, manifest_missing, manifest_summary
from config import SAMPLE_INSTRUCTION, STYLE_PRESETS, FIXED_RULES, Settings
from jobs import JobManager
from metrics import METRIC_DEFINITIONS, SessionMetrics
from realtime_session import (
    ConversationEngine, MockRealtimeTransport, OpenAIRealtimeTransport, RealtimeTransport, RuntimeSettings,
)
from scenario_generator import BaseGenerator, GenerationError, GenerationRequest, make_generator
from scenario_schema import GeneratedScenario, Scenario
from scenario_store import AUDIO_FAILED, AUDIO_PREPARING, READY, REVIEW, Store
from scenario_validator import Limits, validate_scenario
from tts import SpeechSynthesizer, VoiceSettings, make_synthesizer

log = logging.getLogger("app")
STATIC = Path(__file__).parent / "static"
ID_RE = re.compile(r"^[a-z]+_[0-9a-f]{16}$")


# ---------------------------------------------------------------------------
# request bodies
# ---------------------------------------------------------------------------

class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GenerateBody(_Body):
    instruction: str = Field(min_length=1, max_length=4000)
    facts: str = Field(default="", max_length=8000)
    prohibitions: str = Field(default="", max_length=2000)
    first_utterance: str = Field(default="", max_length=300)
    max_depth: int = Field(default=4, ge=1, le=6)
    max_nodes: int = Field(default=20, ge=4, le=30)
    max_branches: int = Field(default=4, ge=1, le=6)


class ScenarioEditBody(_Body):
    base_version: int = Field(ge=1)
    scenario: dict


class VoiceBody(_Body):
    provider: str
    model: str
    voice: str
    speed: float = 1.0
    style_id: str = "polite"


class ApproveBody(_Body):
    voice: VoiceBody
    confirm_reviewed: bool = False


class SessionBody(_Body):
    scenario_id: str
    version: int = Field(ge=1)
    request_id: Optional[str] = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    runtime: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------

def create_app(
    settings: Optional[Settings] = None,
    generator: Optional[BaseGenerator] = None,
    synthesizer: Optional[SpeechSynthesizer] = None,
    transport_factory: Optional[Callable[[], RealtimeTransport]] = None,
    extra_allowed_hosts: tuple[str, ...] = (),
) -> FastAPI:
    settings = settings or Settings()
    settings.ensure_dirs()
    store = Store(str(settings.db_path))
    recovered = store.recover_after_restart()
    audio = AudioStore(settings.data_dir / "audio", store)
    audio.cleanup_partials()
    generator = generator or make_generator(settings)
    synthesizer = synthesizer or make_synthesizer(settings)
    jobs = JobManager(settings, store, audio, generator, synthesizer)

    def default_transport() -> RealtimeTransport:
        if settings.realtime_provider == "openai":
            return OpenAIRealtimeTransport(settings.realtime_url, settings.realtime_model, settings.openai_api_key)
        return MockRealtimeTransport()

    transport_factory = transport_factory or default_transport

    hosts = {f"127.0.0.1:{settings.port}", f"localhost:{settings.port}", *extra_allowed_hosts}
    origins = {f"http://{h}" for h in hosts}

    app = FastAPI(title="Realtime branch MVP", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.store = store
    app.state.audio = audio
    app.state.jobs = jobs
    app.state.engines: dict[str, ConversationEngine] = {}
    app.state.recovered = recovered

    # ---------------- security middleware ----------------
    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = request.headers.get("host", "")
        if host not in hosts:
            return JSONResponse({"detail": "host not allowed"}, status_code=421)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin not in origins:
                return JSONResponse({"detail": "cross-origin request rejected"}, status_code=403)
            if not request.headers.get("content-type", "").startswith("application/json"):
                return JSONResponse({"detail": "application/json required"}, status_code=415)
            cl = request.headers.get("content-length")
            if cl is None or not cl.isdigit() or int(cl) > settings.max_http_body_bytes:
                return JSONResponse({"detail": "body too large or length missing"}, status_code=413)
        resp = await call_next(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        return resp

    # ---------------- helpers ----------------
    def version_or_404(sid: str, ver: int) -> dict:
        if not ID_RE.match(sid):
            raise HTTPException(404, "not found")
        row = store.get_version(sid, ver)
        if not row:
            raise HTTPException(404, "version not found")
        return row

    def limits_of(row: dict) -> Limits:
        lim = (row.get("validation") or {}).get("limits")
        return Limits(**lim) if lim else Limits()

    def voice_from(body: VoiceBody) -> VoiceSettings:
        if body.provider != settings.tts_provider:
            raise HTTPException(400, f"provider は {settings.tts_provider} のみ利用できます")
        models = settings.effective_tts_models()
        voices = settings.effective_tts_voices()
        if not models or not voices:
            raise HTTPException(400, "TTS_MODEL / TTS_VOICE が未設定です。.env で利用可能な値を設定してください。")
        if body.model not in models:
            raise HTTPException(400, "許可されていない TTS モデルです")
        if body.voice not in voices:
            raise HTTPException(400, "許可されていない声です")
        if not (settings.speed_min <= body.speed <= settings.speed_max):
            raise HTTPException(400, f"速度は {settings.speed_min}〜{settings.speed_max} で指定してください")
        if body.style_id not in STYLE_PRESETS:
            raise HTTPException(400, "許可されていない発話スタイルです")
        return VoiceSettings(provider=body.provider, model=body.model, voice=body.voice,
                             format=settings.effective_tts_format(), speed=round(body.speed, 2),
                             style_id=body.style_id, style_text=STYLE_PRESETS[body.style_id])

    def version_view(row: dict) -> dict:
        return {
            **{k: row[k] for k in ("scenario_id", "version", "status", "scenario", "validation", "generator",
                                   "parent_version", "voice", "created_at", "approved_at")},
            "is_mock_generated": row["generator"] == "mock",
            "audio_summary": manifest_summary(row.get("manifest")),
        }

    # ---------------- pages ----------------
    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/api/config")
    async def get_config():
        return {
            "providers": {
                "scenario": {"name": generator.name, "mock": generator.is_mock, "model": generator.model},
                "tts": {"name": synthesizer.name, "mock": synthesizer.is_mock},
                "realtime": {"name": settings.realtime_provider, "mock": settings.realtime_provider != "openai",
                             "model": settings.realtime_model or None, "preview_mode": settings.preview_audio_mode},
            },
            "voice_options": {
                "providers": [settings.tts_provider],
                "models": settings.effective_tts_models(),
                "voices": settings.effective_tts_voices(),
                "format": settings.effective_tts_format(),
                "speed": {"min": settings.speed_min, "max": settings.speed_max, "default": 1.0},
                "styles": [{"id": k, "text": v} for k, v in STYLE_PRESETS.items()],
            },
            "limits": {"max_depth": settings.max_depth_limit, "max_nodes": settings.max_nodes_limit,
                       "max_branches": settings.max_branches_limit},
            "runtime_defaults": RuntimeSettings().as_dict(),
            "runtime_bounds": RuntimeSettings.BOUNDS,
            "sample_instruction": SAMPLE_INSTRUCTION,
            "fixed_rules": FIXED_RULES,
            "metric_definitions": METRIC_DEFINITIONS,
            "recovered_after_restart": recovered,
        }

    # ---------------- generation / jobs ----------------
    @app.post("/api/scenarios/generate")
    async def generate(body: GenerateBody):
        if body.max_depth > settings.max_depth_limit or body.max_nodes > settings.max_nodes_limit \
                or body.max_branches > settings.max_branches_limit:
            raise HTTPException(400, "上限値がサーバー設定を超えています")
        req = GenerationRequest(**body.model_dump())
        job_id = jobs.start_generation(req, body.model_dump())
        return {"job_id": job_id, "mock": generator.is_mock}

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        if not ID_RE.match(job_id):
            raise HTTPException(404, "not found")
        j = store.get_job(job_id)
        if not j:
            raise HTTPException(404, "job not found")
        j.get("result") and j["result"].pop("trace", None)
        if j["kind"] == "audio":
            row = store.get_version(j["params"]["scenario_id"], j["params"]["version"])
            if row:
                j["audio_summary"] = manifest_summary(row.get("manifest"))
                j["version_status"] = row["status"]
        return j

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str):
        if not ID_RE.match(job_id):
            raise HTTPException(404, "not found")
        return {"canceled": jobs.cancel(job_id)}

    # ---------------- scenarios / versions ----------------
    @app.get("/api/scenarios")
    async def list_scenarios():
        return {"scenarios": store.list_scenarios()}

    @app.get("/api/scenarios/{sid}/versions")
    async def list_versions(sid: str):
        if not ID_RE.match(sid):
            raise HTTPException(404, "not found")
        return {"versions": store.list_versions(sid)}

    @app.get("/api/scenarios/{sid}/versions/{ver}")
    async def get_version(sid: str, ver: int):
        return version_view(version_or_404(sid, ver))

    def parse_edit(sid: str, base: dict, data: dict, new_version: int) -> tuple[Optional[Scenario], dict]:
        try:
            body = GeneratedScenario.model_validate(data)
        except ValidationError as e:
            return None, {"ok": False, "errors": [{"code": "schema", "message": f"{'.'.join(map(str, er['loc']))}: {er['msg']}",
                                                   "path": ".".join(map(str, er["loc"]))} for er in e.errors()],
                          "warnings": [], "stats": {}}
        meta = {k: base["scenario"][k] for k in ("source_instruction", "source_facts", "constraints")}
        sc = Scenario(**body.model_dump(), scenario_id=sid, version=new_version, **meta)
        vr = validate_scenario(sc, limits_of(base))
        vd = vr.as_dict()
        vd["limits"] = asdict(limits_of(base))
        return sc, vd

    @app.post("/api/scenarios/{sid}/validate")
    async def validate_only(sid: str, body: ScenarioEditBody):
        base = version_or_404(sid, body.base_version)
        _sc, vd = parse_edit(sid, base, body.scenario, base["version"])
        return vd

    @app.post("/api/scenarios/{sid}/versions")
    async def save_version(sid: str, body: ScenarioEditBody):
        base = version_or_404(sid, body.base_version)
        new_ver = store.next_version(sid)
        sc, vd = parse_edit(sid, base, body.scenario, new_ver)
        if sc is None:
            raise HTTPException(422, {"message": "スキーマ不一致のため保存できません", "validation": vd})
        store.insert_version(sc, vd, "edit", base["version"])
        return version_view(store.get_version(sid, new_ver))

    @app.post("/api/scenarios/{sid}/versions/{ver}/approve")
    async def approve(sid: str, ver: int, body: ApproveBody):
        row = version_or_404(sid, ver)
        if not body.confirm_reviewed:
            raise HTTPException(400, "内容を確認したことの明示（confirm_reviewed）が必要です")
        if row["status"] == AUDIO_PREPARING:
            raise HTTPException(409, "この版は音声生成中です")
        sc = Scenario.model_validate(row["scenario"])
        vr = validate_scenario(sc, limits_of(row))
        if not vr.ok:
            raise HTTPException(422, {"message": "検証エラーがあるため承認できません", "validation": vr.as_dict()})
        vs = voice_from(body.voice)
        manifest = build_manifest(sc, vs, audio)
        store.approve_version(sid, ver, vs.as_dict(), manifest)
        try:
            job_id = jobs.start_audio(sc, vs, limits_of(row))
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return {"job_id": job_id, "summary": manifest_summary(manifest), "mock": synthesizer.is_mock}

    @app.post("/api/scenarios/{sid}/versions/{ver}/audio/retry")
    async def retry_audio(sid: str, ver: int):
        row = version_or_404(sid, ver)
        if row["status"] not in (AUDIO_FAILED, READY) or not row.get("voice"):
            raise HTTPException(409, "再試行できる状態ではありません（承認済みで失敗した版のみ）")
        sc = Scenario.model_validate(row["scenario"])
        vs = VoiceSettings(**row["voice"])
        store.set_version_status(sid, ver, AUDIO_PREPARING)
        try:
            job_id = jobs.start_audio(sc, vs, limits_of(row), only_failed=True)
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return {"job_id": job_id}

    @app.get("/api/scenarios/{sid}/versions/{ver}/manifest")
    async def get_manifest(sid: str, ver: int):
        row = version_or_404(sid, ver)
        m = row.get("manifest")
        if not m:
            return {"entries": {}, "summary": manifest_summary(None), "status": row["status"]}
        return {"entries": m["entries"], "voice": m["voice"], "summary": manifest_summary(m), "status": row["status"],
                "mock_audio": m["voice"]["provider"] == "mock"}

    @app.get("/api/audio/{audio_id}")
    async def get_audio(audio_id: str):
        if not AUDIO_ID_RE.match(audio_id):
            raise HTTPException(404, "not found")
        a = audio.ready_asset(audio_id)
        if not a:
            raise HTTPException(404, "not found")
        return FileResponse(a["path"], media_type=a["mime"], headers={"Cache-Control": "private, max-age=3600"})

    # ---------------- sessions ----------------
    @app.post("/api/sessions")
    async def create_session(body: SessionBody):
        row = version_or_404(body.scenario_id, body.version)
        if row["status"] != READY:
            raise HTTPException(409, f"この版は READY ではありません（{row['status']}）")
        sc = Scenario.model_validate(row["scenario"])
        vr = validate_scenario(sc, limits_of(row))
        if not vr.ok:
            raise HTTPException(409, "グラフ検証に合格していません")
        missing = manifest_missing(row.get("manifest"), audio, sc)
        if missing:
            raise HTTPException(409, {"message": "未準備の音声があります", "missing": missing})
        bad = [e["utterance_key"] for e in row["manifest"]["entries"].values() if not audio.verify_content(e["audio_id"])]
        if bad:
            raise HTTPException(409, {"message": "音声ファイルの内容が manifest と一致しません", "missing": bad})
        try:
            rs = RuntimeSettings.from_user(body.runtime)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if settings.realtime_provider == "openai" and (not settings.realtime_model or not settings.openai_api_key):
            raise HTTPException(400, "REALTIME_MODEL / OPENAI_API_KEY が未設定です")
        session_id, created = store.create_session(body.scenario_id, body.version, rs.as_dict(), body.request_id)
        s = store.get_session(session_id)
        if not created and (s["scenario_id"] != body.scenario_id or s["version"] != body.version):
            raise HTTPException(409, "request_id が別の版で使用済みです")
        return {"session_id": session_id, "created": created, "status": s["status"],
                "scenario_id": body.scenario_id, "version": body.version,
                "entry_audio_id": row["manifest"]["entries"][f"node:{sc.entry_node_id}"]["audio_id"],
                "manifest": {k: {"audio_id": e["audio_id"], "text": e["text"]} for k, e in row["manifest"]["entries"].items()},
                "branches": {n.id: [e.id for e in n.edges] for n in sc.nodes},
                "mock_realtime": settings.realtime_provider != "openai"}

    @app.get("/api/sessions/{session_id}/log.jsonl")
    async def session_log(session_id: str):
        if not ID_RE.match(session_id):
            raise HTTPException(404, "not found")
        p = settings.data_dir / "logs" / f"{session_id}.jsonl"
        if not p.is_file():
            raise HTTPException(404, "not found")
        return FileResponse(p, media_type="application/x-ndjson", filename=f"{session_id}.jsonl")

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        if ws.headers.get("host", "") not in hosts or ws.headers.get("origin") not in origins:
            await ws.close(code=1008)
            return
        sid = ws.query_params.get("session_id", "")
        s = store.get_session(sid) if ID_RE.match(sid) else None
        if not s:
            await ws.close(code=1008)
            return
        if not store.claim_session(sid):
            await ws.accept()
            await ws.send_json({"type": "finished", "phase": "ERROR", "reason": "session_used",
                                "message": "このセッションは使用済みです。新しく開始してください。"})
            await ws.close()
            return
        row = store.get_version(s["scenario_id"], s["version"])
        sc = Scenario.model_validate(row["scenario"])
        if row["status"] != READY or manifest_missing(row.get("manifest"), audio, sc):
            await ws.accept()
            await ws.send_json({"type": "finished", "phase": "ERROR", "reason": "not_ready",
                                "message": "シナリオ版の準備が完了していません。"})
            store.end_session(sid, "error", "not_ready")
            await ws.close()
            return
        await ws.accept()
        send_lock = asyncio.Lock()

        async def send_browser(msg: dict) -> None:
            async with send_lock:
                await ws.send_text(json.dumps(msg, ensure_ascii=False))

        try:
            transport = transport_factory()
        except ValueError as e:
            await send_browser({"type": "finished", "phase": "ERROR", "reason": "config", "message": str(e)})
            store.end_session(sid, "error", "config")
            await ws.close()
            return
        metrics = SessionMetrics(settings.data_dir / "logs", sid)
        engine = ConversationEngine(
            session_id=sid, scenario=sc, manifest=row["manifest"], audio=audio, transport=transport,
            send_browser=send_browser, settings=RuntimeSettings.from_user(s["runtime"]), metrics=metrics,
            preview_audio_mode=settings.preview_audio_mode, max_frame_bytes=settings.max_ws_audio_frame_bytes,
            max_send_buffer=settings.max_openai_send_buffer_bytes,
        )
        app.state.engines[sid] = engine
        run_task = asyncio.create_task(engine.run())

        async def receive_loop():
            try:
                while True:
                    m = await ws.receive()
                    if m["type"] == "websocket.disconnect":
                        break
                    if m.get("bytes") is not None:
                        engine.push_browser_audio(m["bytes"])
                    elif m.get("text") is not None:
                        if len(m["text"]) > settings.max_ws_text_bytes:
                            engine.push_browser_json({"type": "stop"})
                            break
                        try:
                            msg = json.loads(m["text"])
                        except ValueError:
                            continue
                        if isinstance(msg, dict) and not str(msg.get("type", "")).startswith("_"):
                            engine.push_browser_json(msg)
            except (WebSocketDisconnect, RuntimeError):
                pass
            engine.push_browser_json({"type": "_disconnect"})

        recv_task = asyncio.create_task(receive_loop())
        try:
            reason = await run_task
        finally:
            recv_task.cancel()
            app.state.engines.pop(sid, None)
            store.end_session(sid, "finished" if engine.phase.value == "FINISHED" else engine.phase.value.lower(),
                              engine.end_reason)
            try:
                await ws.close()
            except RuntimeError:
                pass

    return app


if __name__ == "__main__":
    import uvicorn

    from config import load_dotenv

    logging.basicConfig(level=logging.INFO)
    load_dotenv(Path(__file__).parent / ".env")
    st = Settings()
    if st.host not in ("127.0.0.1", "localhost"):
        raise SystemExit("このMVPはローカル専用です。HOST は 127.0.0.1 にしてください。")
    uvicorn.run(create_app(st), host=st.host, port=st.port, log_level="info")
