from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from app.utils.model_cache import whisper_cache_dir


def _default_data_root() -> Path:
    override = os.environ.get("TUNEFORGE_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Tuneforge"
    return home / ".local" / "share" / "tuneforge"


@dataclass(frozen=True)
class Settings:
    app_name: str
    api_prefix: str
    data_root: Path
    database_path: Path
    projects_root: Path
    cache_root: Path
    backend_host: str
    backend_port: int
    default_export_format: str
    supported_import_formats: tuple[str, ...]
    supported_export_formats: tuple[str, ...]
    preview_format: str
    ffmpeg_path: str
    ffprobe_path: str
    stem_model: str
    stem_device: str
    demucs_model_repo: Path | None
    model_bundle_dir: Path | None
    lyrics_model: str
    lyrics_device: str
    lyrics_cache_dir: Path
    default_chord_backend: str
    runtime_platform: str
    additional_cors_origins: tuple[str, ...]
    max_workers: int
    backend_root: Path

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.database_path}"

    @property
    def base_url(self) -> str:
        return f"http://{self.backend_host}:{self.backend_port}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    backend_root = Path(__file__).resolve().parents[1]
    data_root = _default_data_root()
    cache_root = data_root / "cache"
    return Settings(
        app_name="Tuneforge",
        api_prefix="/api/v1",
        data_root=data_root,
        database_path=data_root / "app.sqlite",
        projects_root=data_root / "projects",
        cache_root=cache_root,
        backend_host=os.environ.get("TUNEFORGE_HOST", "127.0.0.1"),
        backend_port=int(os.environ.get("TUNEFORGE_PORT", "8765")),
        default_export_format="wav",
        supported_import_formats=("mp3", "wav", "flac", "m4a", "aac", "ogg", "mp4", "webm"),
        supported_export_formats=("wav", "mp3", "flac"),
        preview_format="wav",
        ffmpeg_path=os.environ.get("TUNEFORGE_FFMPEG_PATH", "ffmpeg"),
        ffprobe_path=os.environ.get("TUNEFORGE_FFPROBE_PATH", "ffprobe"),
        stem_model=os.environ.get("TUNEFORGE_STEM_MODEL", "htdemucs_6s"),
        stem_device=os.environ.get("TUNEFORGE_STEM_DEVICE", "auto"),
        demucs_model_repo=(
            Path(os.environ["TUNEFORGE_DEMUCS_MODEL_REPO"]).expanduser().resolve()
            if os.environ.get("TUNEFORGE_DEMUCS_MODEL_REPO")
            else None
        ),
        model_bundle_dir=(
            Path(os.environ["TUNEFORGE_MODEL_BUNDLE_DIR"]).expanduser().resolve()
            if os.environ.get("TUNEFORGE_MODEL_BUNDLE_DIR")
            else None
        ),
        lyrics_model=os.environ.get("TUNEFORGE_LYRICS_MODEL", "turbo"),
        lyrics_device=os.environ.get("TUNEFORGE_LYRICS_DEVICE", "auto"),
        lyrics_cache_dir=Path(
            os.environ.get("TUNEFORGE_LYRICS_CACHE_DIR", str(whisper_cache_dir()))
        )
        .expanduser()
        .resolve(),
        default_chord_backend=os.environ.get("TUNEFORGE_DEFAULT_CHORD_BACKEND", "tuneforge-fast"),
        runtime_platform=os.environ.get("TUNEFORGE_RUNTIME_PLATFORM", "desktop").strip().lower(),
        additional_cors_origins=_parse_additional_cors_origins(
            os.environ.get("TUNEFORGE_ADDITIONAL_CORS_ORIGINS", "")
        ),
        max_workers=1,
        backend_root=backend_root,
    )


def ensure_data_dirs(settings: Settings | None = None) -> None:
    current = settings or get_settings()
    current.data_root.mkdir(parents=True, exist_ok=True)
    current.projects_root.mkdir(parents=True, exist_ok=True)
    current.cache_root.mkdir(parents=True, exist_ok=True)
    current.lyrics_cache_dir.mkdir(parents=True, exist_ok=True)
    if current.model_bundle_dir is not None:
        from app.utils.model_bundle import seed_model_bundle_caches

        seed_model_bundle_caches(current)


def _parse_additional_cors_origins(value: str) -> tuple[str, ...]:
    origins: list[str] = []
    for raw_origin in value.split(","):
        origin = raw_origin.strip().rstrip("/")
        if not origin:
            continue
        if not _is_loopback_http_origin(origin):
            raise ValueError(
                "TUNEFORGE_ADDITIONAL_CORS_ORIGINS only accepts http://127.0.0.1:<port> "
                "or http://localhost:<port> origins."
            )
        if origin not in origins:
            origins.append(origin)
    return tuple(origins)


def _is_loopback_http_origin(origin: str) -> bool:
    parsed = urlparse(origin)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        return False
    try:
        port = parsed.port
    except ValueError:
        return False
    if port is None:
        return False
    return not parsed.path and not parsed.params and not parsed.query and not parsed.fragment
