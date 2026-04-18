from __future__ import annotations

from pathlib import Path

from app.config import get_settings


def project_root(project_id: str) -> Path:
    return get_settings().projects_root / project_id


def project_source_dir(project_id: str) -> Path:
    return project_root(project_id) / "source"


def project_analysis_dir(project_id: str) -> Path:
    return project_root(project_id) / "analysis"


def project_previews_dir(project_id: str) -> Path:
    return project_root(project_id) / "previews"


def project_stems_dir(project_id: str) -> Path:
    return project_root(project_id) / "stems"


def project_exports_dir(project_id: str) -> Path:
    return project_root(project_id) / "exports"


def ensure_project_dirs(project_id: str) -> None:
    for path in (
        project_root(project_id),
        project_source_dir(project_id),
        project_analysis_dir(project_id),
        project_previews_dir(project_id),
        project_stems_dir(project_id),
        project_exports_dir(project_id),
    ):
        path.mkdir(parents=True, exist_ok=True)
