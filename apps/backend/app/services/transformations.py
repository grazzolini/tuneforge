from __future__ import annotations

import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.transform import cents_from_reference, run_ffmpeg_transform, semitones_to_cents
from app.errors import AppError
from app.models import Artifact, Project
from app.services.analysis import analyze_project
from app.services.artifacts import find_cached_artifact, register_artifact
from app.services.paths import project_exports_dir, project_previews_dir
from app.utils.hashing import stable_hash


@dataclass
class TransformPlan:
    artifact_type: str
    destination_path: Path
    output_format: str
    total_cents: float
    cache_key: str | None
    metadata: dict[str, Any]


def _reference_cents(session: Session, project: Project, target_reference_hz: float) -> float:
    analysis = project.analysis or analyze_project(session, project)
    if analysis.estimated_reference_hz is None:
        raise AppError("PROCESSING_FAILED", "Could not determine the source tuning reference.")
    return cents_from_reference(analysis.estimated_reference_hz, target_reference_hz)


def _preview_cache_key(project_id: str, payload: dict[str, Any]) -> str:
    return stable_hash({"project_id": project_id, **payload})


def build_preview_plan(
    session: Session,
    *,
    project: Project,
    retune: dict[str, Any] | None,
    transpose: dict[str, Any] | None,
    output_format: str,
) -> tuple[TransformPlan, Artifact | None]:
    if output_format != get_settings().preview_format:
        raise AppError(
            "INVALID_REQUEST",
            f"Preview output must be {get_settings().preview_format}.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    total_cents = 0.0
    metadata: dict[str, Any] = {"retune": retune, "transpose": transpose}
    if retune:
        if retune.get("target_cents_offset") is not None:
            total_cents += float(retune["target_cents_offset"])
        else:
            total_cents += _reference_cents(session, project, float(retune["target_reference_hz"]))
    if transpose:
        total_cents += semitones_to_cents(int(transpose["semitones"]))
    if total_cents == 0:
        raise AppError("INVALID_REQUEST", "Preview requires at least one non-zero transform.")

    cache_key = _preview_cache_key(
        project.id,
        {"retune": retune or {}, "transpose": transpose or {}, "output_format": output_format},
    )
    cached = find_cached_artifact(session, cache_key=cache_key)
    destination = project_previews_dir(project.id) / f"{cache_key}.{output_format}"
    plan = TransformPlan(
        artifact_type="preview_mix",
        destination_path=destination,
        output_format=output_format,
        total_cents=total_cents,
        cache_key=cache_key,
        metadata={**metadata, "total_cents": total_cents},
    )
    return plan, cached


def build_single_transform_plan(
    session: Session,
    *,
    project: Project,
    transform_type: str,
    payload: dict[str, Any],
) -> TransformPlan:
    output_format = payload.get("output_format", get_settings().preview_format)
    preview_only = payload.get("preview_only", True)
    if transform_type == "retune":
        if payload.get("target_cents_offset") is not None:
            total_cents = float(payload["target_cents_offset"])
        else:
            total_cents = _reference_cents(session, project, float(payload["target_reference_hz"]))
    else:
        total_cents = semitones_to_cents(int(payload["semitones"]))

    root = project_previews_dir(project.id) if preview_only else project_exports_dir(project.id)
    artifact_type = "preview_mix" if preview_only else "export_mix"
    file_name = stable_hash({"project_id": project.id, "type": transform_type, "payload": payload})
    destination = root / f"{file_name}.{output_format}"
    return TransformPlan(
        artifact_type=artifact_type,
        destination_path=destination,
        output_format=output_format,
        total_cents=total_cents,
        cache_key=file_name if preview_only else None,
        metadata={"kind": transform_type, "payload": payload, "total_cents": total_cents},
    )


def execute_transform_plan(
    session: Session,
    *,
    project: Project,
    plan: TransformPlan,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> Artifact:
    source_path = Path(project.imported_path)
    sample_rate = project.sample_rate or 44100
    run_ffmpeg_transform(
        source_path,
        plan.destination_path.with_suffix(""),
        sample_rate,
        plan.total_cents,
        plan.output_format,
        on_progress=on_progress,
        should_cancel=should_cancel,
        register_process=register_process,
        unregister_process=unregister_process,
    )
    output_path = plan.destination_path.with_suffix(f".{plan.output_format}")
    artifact = register_artifact(
        session,
        project_id=project.id,
        artifact_type=plan.artifact_type,
        artifact_format=plan.output_format,
        path=output_path,
        metadata=plan.metadata,
        cache_key=plan.cache_key,
        generated_by="ffmpeg",
    )
    return artifact


def export_artifacts(
    session: Session,
    *,
    project: Project,
    artifact_ids: list[str],
    output_format: str,
    destination_path: str | None,
) -> Artifact:
    if len(artifact_ids) != 1:
        raise AppError("INVALID_REQUEST", "V1 export supports exactly one source artifact.")
    artifact = session.get(Artifact, artifact_ids[0])
    if artifact is None or artifact.project_id != project.id:
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact not found.", status_code=status.HTTP_404_NOT_FOUND)
    source_path = Path(artifact.path)
    root = Path(destination_path).expanduser().resolve() if destination_path else project_exports_dir(project.id)
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{source_path.stem}.{output_format}"
    if artifact.format == output_format:
        shutil.copy2(source_path, target)
    else:
        sample_rate = project.sample_rate or 44100
        run_ffmpeg_transform(
            source_path,
            target.with_suffix(""),
            sample_rate,
            0.0,
            output_format,
        )
    return register_artifact(
        session,
        project_id=project.id,
        artifact_type="export_mix",
        artifact_format=output_format,
        path=target,
        metadata={"source_artifact_id": artifact.id},
        generated_by="ffmpeg",
        can_delete=True,
        can_regenerate=False,
    )
