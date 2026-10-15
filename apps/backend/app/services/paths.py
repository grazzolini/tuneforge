from __future__ import annotations

from hashlib import sha256
from pathlib import Path

from app.config import get_settings
from app.errors import AppError
from app.services.sync_identity import project_id_to_storage_key


def project_root(project_id: str) -> Path:
    return get_settings().projects_root / project_id_to_storage_key(project_id)


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


def artifact_storage_key(artifact_id: str) -> str:
    """Keep exact logical identifiers separate from filesystem names."""
    return sha256(artifact_id.encode("utf-8")).hexdigest()


def validate_new_artifact_id(artifact_id: str) -> None:
    if (
        not artifact_id
        or artifact_id in {".", ".."}
        or any(char in artifact_id for char in "/\\:\0")
        or any(ord(char) < 32 or ord(char) == 127 for char in artifact_id)
    ):
        raise AppError(
            "SYNC_MANIFEST_INVALID", "New artifact identifiers must not contain paths or control characters.",
        )


def contained_output_path(root: Path, path: Path) -> Path:
    if not path.resolve(strict=False).is_relative_to(root.resolve(strict=False)):
        raise AppError("INVALID_ARTIFACT_PATH", "Generated artifact path escapes the project store.")
    return path
