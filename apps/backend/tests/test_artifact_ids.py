from __future__ import annotations

import re
from pathlib import Path

from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, reconfigure_engine, run_migrations
from app.models import Project
from app.services.artifacts import register_artifact
from app.utils.ids import new_artifact_id, new_id

ARTIFACT_ID_PATTERN = re.compile(r"^art_[0-9a-f]{28}$")
GENERIC_ID_PATTERN = re.compile(r"^job_[0-9a-f]{12}$")


def _prepare_database() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)


def _add_project(session, tmp_path: Path, project_id: str) -> Project:
    source_path = tmp_path / f"{project_id}-source.wav"
    imported_path = tmp_path / f"{project_id}-imported.wav"
    project = Project(
        id=project_id,
        display_name="Artifact ID Test",
        source_sha256=f"{len(project_id):064x}",
        source_path=str(source_path),
        imported_path=str(imported_path),
    )
    session.add(project)
    session.flush()
    return project


def test_new_artifact_id_uses_column_safe_hex_entropy() -> None:
    artifact_id = new_artifact_id()

    assert len(artifact_id) == 32
    assert ARTIFACT_ID_PATTERN.fullmatch(artifact_id)


def test_generic_new_id_shape_is_unchanged() -> None:
    generic_id = new_id("job")

    assert GENERIC_ID_PATTERN.fullmatch(generic_id)


def test_register_artifact_generates_column_safe_id(tmp_path: Path) -> None:
    _prepare_database()
    artifact_path = tmp_path / "analysis.json"
    artifact_path.write_text("{}", encoding="utf-8")

    with SessionLocal() as session:
        project = _add_project(session, tmp_path, "proj_artifact_id_generated")

        artifact = register_artifact(
            session,
            project_id=project.id,
            artifact_type="analysis_json",
            artifact_format="json",
            path=artifact_path,
            generated_by="test",
        )

        assert len(artifact.id) == 32
        assert ARTIFACT_ID_PATTERN.fullmatch(artifact.id)


def test_register_artifact_preserves_explicit_legacy_id(tmp_path: Path) -> None:
    _prepare_database()
    artifact_path = tmp_path / "source.wav"
    artifact_path.write_bytes(b"source")

    with SessionLocal() as session:
        project = _add_project(session, tmp_path, "proj_artifact_id_explicit")

        artifact = register_artifact(
            session,
            project_id=project.id,
            artifact_type="source_audio",
            artifact_format="wav",
            path=artifact_path,
            artifact_id="art_legacy",
            generated_by="test",
            can_delete=False,
            can_regenerate=False,
        )

        assert artifact.id == "art_legacy"
