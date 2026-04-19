from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


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
    return Settings(
        app_name="Tuneforge",
        api_prefix="/api/v1",
        data_root=data_root,
        database_path=data_root / "app.sqlite",
        projects_root=data_root / "projects",
        cache_root=data_root / "cache",
        backend_host=os.environ.get("TUNEFORGE_HOST", "127.0.0.1"),
        backend_port=int(os.environ.get("TUNEFORGE_PORT", "8765")),
        default_export_format="wav",
        supported_import_formats=("mp3", "wav", "flac", "m4a", "aac", "ogg", "mp4", "webm"),
        supported_export_formats=("wav", "mp3", "flac"),
        preview_format="wav",
        ffmpeg_path=os.environ.get("TUNEFORGE_FFMPEG_PATH", "ffmpeg"),
        ffprobe_path=os.environ.get("TUNEFORGE_FFPROBE_PATH", "ffprobe"),
        stem_model=os.environ.get("TUNEFORGE_STEM_MODEL", "htdemucs_ft"),
        stem_device=os.environ.get("TUNEFORGE_STEM_DEVICE", "auto"),
        max_workers=1,
        backend_root=backend_root,
    )


def ensure_data_dirs(settings: Settings | None = None) -> None:
    current = settings or get_settings()
    current.data_root.mkdir(parents=True, exist_ok=True)
    current.projects_root.mkdir(parents=True, exist_ok=True)
    current.cache_root.mkdir(parents=True, exist_ok=True)
