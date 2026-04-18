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
from app.services.artifacts import prune_project_artifacts, register_artifact
from app.services.paths import project_stems_dir


@dataclass
class StemPlan:
    vocal_path: Path
    instrumental_path: Path
    output_format: str


def build_stem_plan(project: Project, *, output_format: str) -> StemPlan:
    stems_dir = project_stems_dir(project.id)
    return StemPlan(
        vocal_path=stems_dir / f"vocals.{output_format}",
        instrumental_path=stems_dir / f"instrumental.{output_format}",
        output_format=output_format,
    )


def existing_stem_artifacts(session: Session, *, project_id: str) -> tuple[Artifact | None, Artifact | None]:
    stmt = select(Artifact).where(
        Artifact.project_id == project_id,
        Artifact.type.in_(("vocal_stem", "instrumental_stem")),
    )
    artifacts = list(session.scalars(stmt))
    vocal = next((artifact for artifact in artifacts if artifact.type == "vocal_stem"), None)
    instrumental = next((artifact for artifact in artifacts if artifact.type == "instrumental_stem"), None)
    if vocal and instrumental and Path(vocal.path).exists() and Path(instrumental.path).exists():
        return vocal, instrumental
    return None, None


def generate_stems(
    session: Session,
    *,
    project: Project,
    output_format: str,
    force: bool,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> list[Artifact]:
    if output_format != "wav":
        raise AppError("INVALID_REQUEST", "Stem output must be wav in v1.")

    if not force:
        vocal, instrumental = existing_stem_artifacts(session, project_id=project.id)
        if vocal and instrumental:
            if on_progress:
                on_progress(100)
            return [vocal, instrumental]

    plan = build_stem_plan(project, output_format=output_format)
    metadata = separate_two_stems(
        Path(project.imported_path),
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
        metadata={"mode": "two_stem", **metadata},
    )
    instrumental_artifact = register_artifact(
        session,
        project_id=project.id,
        artifact_type="instrumental_stem",
        artifact_format=plan.output_format,
        path=plan.instrumental_path,
        metadata={"mode": "two_stem", **metadata},
    )

    prune_project_artifacts(
        session,
        project_id=project.id,
        artifact_type="vocal_stem",
        keep_artifact_id=vocal_artifact.id,
    )
    prune_project_artifacts(
        session,
        project_id=project.id,
        artifact_type="instrumental_stem",
        keep_artifact_id=instrumental_artifact.id,
    )

    return [vocal_artifact, instrumental_artifact]
