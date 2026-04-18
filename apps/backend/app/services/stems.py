from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from subprocess import Popen

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.stems import separate_two_stems
from app.errors import AppError
from app.models import Artifact, Project
from app.services.artifacts import register_artifact
from app.services.paths import project_stems_dir


@dataclass
class StemPlan:
    source_artifact: Artifact
    vocal_path: Path
    instrumental_path: Path
    output_format: str


def _default_source_artifact(session: Session, *, project_id: str) -> Artifact:
    stmt = select(Artifact).where(
        Artifact.project_id == project_id,
        Artifact.type == "source_audio",
    )
    artifact = session.scalar(stmt)
    if artifact is None:
        raise AppError("ARTIFACT_NOT_FOUND", "Source audio artifact not found.")
    return artifact


def resolve_stem_source_artifact(
    session: Session,
    *,
    project: Project,
    source_artifact_id: str | None,
) -> Artifact:
    if source_artifact_id is None:
        return _default_source_artifact(session, project_id=project.id)

    artifact = session.get(Artifact, source_artifact_id)
    if artifact is None or artifact.project_id != project.id:
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact does not belong to this project.")
    if artifact.type not in {"source_audio", "preview_mix"}:
        raise AppError("INVALID_REQUEST", "Stems can only be generated from source audio or practice mixes.")
    return artifact


def build_stem_plan(source_artifact: Artifact, *, output_format: str) -> StemPlan:
    stems_dir = project_stems_dir(source_artifact.project_id)
    return StemPlan(
        source_artifact=source_artifact,
        vocal_path=stems_dir / source_artifact.id / f"vocals.{output_format}",
        instrumental_path=stems_dir / source_artifact.id / f"instrumental.{output_format}",
        output_format=output_format,
    )


def existing_stem_artifacts(
    session: Session,
    *,
    project_id: str,
    source_artifact_id: str,
) -> tuple[Artifact | None, Artifact | None]:
    stmt = select(Artifact).where(
        Artifact.project_id == project_id,
        Artifact.type.in_(("vocal_stem", "instrumental_stem")),
    )
    artifacts = [
        artifact
        for artifact in session.scalars(stmt)
        if artifact.metadata_json.get("source_artifact_id") == source_artifact_id
    ]
    vocal = next((artifact for artifact in artifacts if artifact.type == "vocal_stem"), None)
    instrumental = next((artifact for artifact in artifacts if artifact.type == "instrumental_stem"), None)
    if vocal and instrumental and Path(vocal.path).exists() and Path(instrumental.path).exists():
        return vocal, instrumental
    return None, None


def generate_stems(
    session: Session,
    *,
    project: Project,
    source_artifact_id: str | None,
    output_format: str,
    force: bool,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> list[Artifact]:
    if output_format != "wav":
        raise AppError("INVALID_REQUEST", "Stem output must be wav in v1.")

    source_artifact = resolve_stem_source_artifact(
        session,
        project=project,
        source_artifact_id=source_artifact_id,
    )

    if not force:
        vocal, instrumental = existing_stem_artifacts(
            session,
            project_id=project.id,
            source_artifact_id=source_artifact.id,
        )
        if vocal and instrumental:
            if on_progress:
                on_progress(100)
            return [vocal, instrumental]

    plan = build_stem_plan(source_artifact, output_format=output_format)
    metadata = separate_two_stems(
        Path(source_artifact.path),
        plan.vocal_path,
        plan.instrumental_path,
        model=get_settings().stem_model,
        device=get_settings().stem_device,
        on_progress=on_progress,
        should_cancel=should_cancel,
        register_process=register_process,
        unregister_process=unregister_process,
    )

    vocal_artifact = register_artifact(
        session,
        project_id=project.id,
        artifact_type="vocal_stem",
        artifact_format=plan.output_format,
        path=plan.vocal_path,
        metadata={
            "mode": "two_stem",
            "source_artifact_id": source_artifact.id,
            "source_artifact_type": source_artifact.type,
            **metadata,
        },
    )
    instrumental_artifact = register_artifact(
        session,
        project_id=project.id,
        artifact_type="instrumental_stem",
        artifact_format=plan.output_format,
        path=plan.instrumental_path,
        metadata={
            "mode": "two_stem",
            "source_artifact_id": source_artifact.id,
            "source_artifact_type": source_artifact.type,
            **metadata,
        },
    )

    return [vocal_artifact, instrumental_artifact]
