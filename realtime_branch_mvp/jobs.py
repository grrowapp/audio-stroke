"""In-process background jobs (single process). Progress and failures are
persisted; jobs running at shutdown are recovered as ``interrupted``."""
from __future__ import annotations

import asyncio
import logging
import random
import traceback
from dataclasses import asdict
from typing import Any, Optional

from audio_store import AudioStore, build_manifest, manifest_missing, manifest_summary
from config import Settings
from scenario_generator import BaseGenerator, GenerationError, GenerationRequest
from scenario_schema import Scenario
from scenario_store import (
    AUDIO_FAILED, CANCELED, FAILED, READY, RUNNING, SUCCEEDED, Store, new_id,
)
from scenario_validator import Limits, validate_scenario
from tts import InvalidAudio, SpeechSynthesizer, TTSTransientError, VoiceSettings, validate_audio

log = logging.getLogger("jobs")


class JobManager:
    def __init__(self, settings: Settings, store: Store, audio: AudioStore,
                 generator: BaseGenerator, synthesizer: SpeechSynthesizer):
        self.settings = settings
        self.store = store
        self.audio = audio
        self.generator = generator
        self.synthesizer = synthesizer
        self._tasks: dict[str, asyncio.Task] = {}
        self._audio_job_for_version: dict[tuple[str, int], str] = {}

    # ------------------------------------------------------------------
    def cancel(self, job_id: str) -> bool:
        t = self._tasks.get(job_id)
        if t and not t.done():
            t.cancel()
            return True
        return False

    async def wait(self, job_id: str) -> None:
        t = self._tasks.get(job_id)
        if t:
            try:
                await t
            except asyncio.CancelledError:
                pass

    def _spawn(self, job_id: str, coro) -> None:
        async def runner():
            try:
                await coro
            except asyncio.CancelledError:
                self.store.update_job(job_id, status=CANCELED, error="利用者により取り消されました")
                raise
            except GenerationError as e:
                self.store.update_job(job_id, status=FAILED, error=f"{e.code}: {e.message}",
                                      result={"usage": e.usage, "details": e.details})
            except Exception as e:  # never swallow: record reason
                log.exception("job %s failed", job_id)
                self.store.update_job(job_id, status=FAILED, error=f"{type(e).__name__}: {e}",
                                      result={"trace": traceback.format_exc()[-2000:]})
            finally:
                self._tasks.pop(job_id, None)

        self._tasks[job_id] = asyncio.get_running_loop().create_task(runner())

    # ------------------------------------------------------------------
    def start_generation(self, req: GenerationRequest, source: dict[str, Any]) -> str:
        job_id = self.store.create_job("generate", {"request": source, "provider": self.generator.name})
        self._spawn(job_id, self._run_generation(job_id, req, source))
        return job_id

    async def _run_generation(self, job_id: str, req: GenerationRequest, source: dict[str, Any]) -> None:
        progress: dict[str, Any] = {"stage": "starting", "provider": self.generator.name, "mock": self.generator.is_mock}
        self.store.update_job(job_id, status=RUNNING, progress=progress)

        def on_progress(p: dict) -> None:
            progress.update(p)
            self.store.update_job(job_id, progress=progress)

        outcome = await self.generator.generate(req, on_progress)
        scenario_id = new_id("scn")
        constraints = [x.strip() for x in (req.prohibitions or "").splitlines() if x.strip()][:20]
        scenario = Scenario(
            **outcome.scenario.model_dump(),
            scenario_id=scenario_id,
            version=1,
            source_instruction=req.instruction,
            source_facts=req.facts,
            constraints=constraints,
        )
        validation = validate_scenario(scenario, req.limits())
        if not validation.ok:  # generator validated the body; this re-check guards metadata merge
            raise GenerationError("invalid", "生成結果の検証に失敗しました", outcome.usage, [i.message for i in validation.errors])
        vd = validation.as_dict()
        vd["limits"] = asdict(req.limits())
        self.store.insert_version(scenario, vd, self.generator.name, None)
        self.store.update_job(job_id, status=SUCCEEDED, progress={**progress, "stage": "done"}, result={
            "scenario_id": scenario_id, "version": 1, "usage": outcome.usage,
            "attempts": outcome.attempts, "repairs": outcome.repairs,
            "provider": outcome.provider, "model": outcome.model, "mock": self.generator.is_mock,
        })

    # ------------------------------------------------------------------
    def start_audio(self, scenario: Scenario, voice: VoiceSettings, limits: Limits, only_failed: bool = False) -> str:
        key = (scenario.scenario_id, scenario.version)
        prev = self._audio_job_for_version.get(key)
        if prev and prev in self._tasks:
            raise RuntimeError("この版の音声生成ジョブは既に実行中です")
        job_id = self.store.create_job("audio", {"scenario_id": scenario.scenario_id, "version": scenario.version,
                                                 "voice": voice.as_dict(), "only_failed": only_failed})
        self._audio_job_for_version[key] = job_id
        self._spawn(job_id, self._run_audio(job_id, scenario, voice, limits, only_failed))
        return job_id

    async def _run_audio(self, job_id: str, scenario: Scenario, voice: VoiceSettings, limits: Limits, only_failed: bool) -> None:
        s = self.settings
        sid, ver = scenario.scenario_id, scenario.version
        row = self.store.get_version(sid, ver)
        old = (row or {}).get("manifest") if only_failed else None
        manifest = build_manifest(scenario, voice, self.audio)
        if old and old.get("voice") == voice.as_dict():
            for k, e in manifest["entries"].items():
                if e["status"] != "ready" and old["entries"].get(k, {}).get("status") == "ready":
                    e["status"] = "pending"  # file vanished; regenerate
        todo = [e for e in manifest["entries"].values() if e["status"] != "ready"]
        chars = sum(len(e["text"]) for e in todo)
        if len(manifest["entries"]) > s.tts_max_items:
            raise GenerationError("too_many_items", f"音声数 {len(manifest['entries'])} が上限 {s.tts_max_items} を超えています")
        if chars > s.tts_max_total_chars:
            raise GenerationError("too_many_chars", f"生成文字数 {chars} が上限 {s.tts_max_total_chars} を超えています")
        for e in todo:
            if len(e["text"]) > s.tts_max_chars_per_item:
                raise GenerationError("item_too_long", f"{e['utterance_key']} の文字数が上限を超えています")

        progress = {"total": len(manifest["entries"]), "done": len(manifest["entries"]) - len(todo), "failed": 0,
                    "cache_hits": sum(1 for e in manifest["entries"].values() if e["cache_hit"]),
                    "chars_to_generate": chars, "mock": self.synthesizer.is_mock, "provider": self.synthesizer.name}
        self.store.save_manifest(sid, ver, manifest)
        self.store.update_job(job_id, status=RUNNING, progress=progress)
        sem = asyncio.Semaphore(max(1, s.tts_concurrency))
        lock = asyncio.Lock()

        async def one(entry: dict) -> None:
            async with sem:
                entry["status"] = "generating"
                attempt, delay, err = 0, 1.0, None
                while attempt < s.tts_max_attempts:
                    attempt += 1
                    try:
                        data = await asyncio.wait_for(self.synthesizer.synthesize(entry["text"], voice), timeout=s.tts_timeout_s)
                        if len(data) > s.tts_max_audio_bytes:
                            raise InvalidAudio("audio too large")
                        mime, dur = validate_audio(data, voice.format)
                        meta = self.audio.write(entry["audio_id"], data, mime, dur, voice.as_dict())
                        entry.update(status="ready", error=None, **meta)
                        err = None
                        break
                    except (TTSTransientError, asyncio.TimeoutError, InvalidAudio) as e:
                        err = f"{type(e).__name__}: {e}"
                        if attempt < s.tts_max_attempts:
                            await asyncio.sleep(delay + random.uniform(0, delay / 4))
                            delay *= 2
                    except Exception as e:  # non-retryable (auth, 4xx …)
                        err = f"{type(e).__name__}: {e}"
                        break
                async with lock:
                    if err:
                        entry.update(status="failed", error=err)
                        progress["failed"] += 1
                    else:
                        progress["done"] += 1
                    self.store.save_manifest(sid, ver, manifest)
                    self.store.update_job(job_id, progress=progress)

        try:
            await asyncio.gather(*(one(e) for e in todo))
        except asyncio.CancelledError:
            for e in manifest["entries"].values():
                if e["status"] == "generating":
                    e["status"] = "pending"
            self.store.save_manifest(sid, ver, manifest)
            self.store.set_version_status(sid, ver, AUDIO_FAILED)
            self.audio.cleanup_partials()
            raise
        missing = manifest_missing(manifest, self.audio, scenario)
        validation = validate_scenario(scenario, limits)
        final_status = READY if (not missing and validation.ok) else AUDIO_FAILED
        self.store.set_version_status(sid, ver, final_status)
        summary = manifest_summary(manifest)
        self.store.update_job(job_id, status=SUCCEEDED if final_status == READY else FAILED, progress=progress,
                              result={"version_status": final_status, "missing": missing, "summary": summary,
                                      "tts_chars_generated": chars},
                              error=None if final_status == READY else f"{len(missing)}件の音声が未完了です")
