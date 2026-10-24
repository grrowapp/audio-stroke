"""Server-side settings. All secrets come from environment variables only.

The process is a single-process local MVP. Values here are the hard upper
bounds the server enforces; the UI may only choose values inside them.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader; existing environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.split(" #", 1)[0].strip()
        os.environ.setdefault(k.strip(), v)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    return int(raw) if raw else default


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    return float(raw) if raw else default


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = _env(name)
    if not raw:
        return list(default)
    return [x.strip() for x in raw.split(",") if x.strip()]


# Style presets: the UI chooses an id; only server-defined text reaches TTS.
STYLE_PRESETS: dict[str, str] = {
    "polite": "丁寧で落ち着いたビジネス口調の日本語で、はっきりと話してください。",
    "bright": "明るく親しみやすい口調の日本語で、聞き取りやすく話してください。",
    "calm": "ゆっくりと穏やかな口調の日本語で話してください。",
    "none": "",
}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", str(Path(__file__).parent / "data"))))
    host: str = field(default_factory=lambda: _env("HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("PORT", 8000))

    # ---- Claude (scenario generation, before the conversation only) ----
    scenario_provider: str = field(default_factory=lambda: _env("SCENARIO_PROVIDER", "mock"))  # mock | claude
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"), repr=False)
    claude_model: str = field(default_factory=lambda: _env("CLAUDE_SCENARIO_MODEL"))
    claude_effort: str = field(default_factory=lambda: _env("CLAUDE_EFFORT"))  # optional: low|medium|high|xhigh|max
    claude_output_mode: str = field(default_factory=lambda: _env("CLAUDE_OUTPUT_MODE", "structured"))  # structured | tool
    claude_refusal_fallback: str = field(default_factory=lambda: _env("CLAUDE_REFUSAL_FALLBACK", "off"))  # off | default
    claude_timeout_s: float = field(default_factory=lambda: _env_float("CLAUDE_TIMEOUT_S", 180.0))
    claude_max_attempts: int = field(default_factory=lambda: _env_int("CLAUDE_MAX_ATTEMPTS", 3))
    claude_max_repairs: int = 2  # fixed by spec
    claude_max_tokens: int = field(default_factory=lambda: _env_int("CLAUDE_MAX_TOKENS", 32000))
    claude_max_response_chars: int = 200_000

    # ---- TTS (before the conversation only) ----
    tts_provider: str = field(default_factory=lambda: _env("TTS_PROVIDER", "mock"))  # mock | openai
    openai_api_key: str = field(default_factory=lambda: _env("OPENAI_API_KEY"), repr=False)
    tts_model: str = field(default_factory=lambda: _env("TTS_MODEL"))
    tts_voice: str = field(default_factory=lambda: _env("TTS_VOICE"))
    tts_format: str = field(default_factory=lambda: _env("TTS_FORMAT", "mp3"))  # mp3 | wav
    tts_allowed_models: list[str] = field(default_factory=lambda: _env_list("TTS_ALLOWED_MODELS", []))
    tts_allowed_voices: list[str] = field(default_factory=lambda: _env_list("TTS_ALLOWED_VOICES", []))
    tts_concurrency: int = field(default_factory=lambda: _env_int("TTS_CONCURRENCY", 2))
    tts_max_attempts: int = field(default_factory=lambda: _env_int("TTS_MAX_ATTEMPTS", 3))
    tts_timeout_s: float = field(default_factory=lambda: _env_float("TTS_TIMEOUT_S", 60.0))
    tts_max_chars_per_item: int = 400
    tts_max_items: int = 80
    tts_max_total_chars: int = 12_000
    tts_max_audio_bytes: int = 5_000_000
    speed_min: float = 0.7
    speed_max: float = 1.5

    # ---- Realtime (classification during the conversation) ----
    realtime_provider: str = field(default_factory=lambda: _env("REALTIME_PROVIDER", "mock"))  # mock | openai
    realtime_model: str = field(default_factory=lambda: _env("REALTIME_MODEL"))
    realtime_url: str = field(default_factory=lambda: _env("REALTIME_URL", "wss://api.openai.com/v1/realtime"))
    # inline: out-of-band response with inline input_audio prefix
    # item: conversation.item.create (+ack) then item_reference
    preview_audio_mode: str = field(default_factory=lambda: _env("PREVIEW_AUDIO_MODE", "inline"))

    # ---- generation limits ----
    max_instruction_chars: int = 4000
    max_facts_chars: int = 8000
    max_prohibitions_chars: int = 2000
    max_first_utterance_chars: int = 300
    max_depth_limit: int = 6
    max_nodes_limit: int = 30
    max_branches_limit: int = 6

    # ---- transport limits ----
    max_http_body_bytes: int = 512_000
    max_ws_text_bytes: int = 16_000
    max_ws_audio_frame_bytes: int = 24_000  # 500 ms of PCM16 @ 24 kHz
    max_openai_send_buffer_bytes: int = 4_000_000

    def ensure_dirs(self) -> None:
        (self.data_dir / "audio").mkdir(parents=True, exist_ok=True)
        (self.data_dir / "logs").mkdir(parents=True, exist_ok=True)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "mvp.sqlite3"

    def effective_tts_models(self) -> list[str]:
        if self.tts_provider == "mock":
            return ["mock-tone"]
        models = list(self.tts_allowed_models)
        if self.tts_model and self.tts_model not in models:
            models.insert(0, self.tts_model)
        return models

    def effective_tts_voices(self) -> list[str]:
        if self.tts_provider == "mock":
            return ["mock"]
        voices = list(self.tts_allowed_voices)
        if self.tts_voice and self.tts_voice not in voices:
            voices.insert(0, self.tts_voice)
        return voices

    def effective_tts_format(self) -> str:
        return "wav" if self.tts_provider == "mock" else self.tts_format


SAMPLE_INSTRUCTION = (
    "問い合わせ受付として、料金案内・デモ相談・操作サポートの希望を確認し、選択後に内容を確認して終了してください。"
    "料金の具体額や予約完了は断言せず、曖昧なら聞き返してください。"
)

# Fixed rules that are always appended to the user's prohibitions.
FIXED_RULES = [
    "価格・金額・割引・契約条件を捏造しない。資料に無い具体額を発話しない。",
    "予約完了・申込完了・契約成立などを断言しない。",
    "顧客名・日付・金額などの動的な値を発話文に埋め込まない（プレースホルダ禁止）。",
]
