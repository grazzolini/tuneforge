from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.transform import (
    cents_from_reference,
    probe_export_formats,
    run_ffmpeg_transform,
    semitones_to_cents,
)
from app.errors import AppError, JobCancelledError
from app.models import Artifact, Project
from app.services.analysis import analyze_project
from app.services.artifacts import find_cached_artifact, register_artifact
from app.services.paths import project_exports_dir, project_previews_dir
from app.services.stem_models import STEM_ARTIFACT_TYPE_SOURCES, STEM_ARTIFACT_TYPES
from app.utils.hashing import stable_hash


@dataclass
class TransformPlan:
    artifact_type: str
    destination_path: Path
    output_format: str
    total_cents: float
    cache_key: str | None
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ExportBatchResult:
    artifact_ids: list[str]
    export_result: dict[str, Any]


def _reference_cents(session: Session, project: Project, target_reference_hz: float) -> float:
    analysis = project.analysis or analyze_project(session, project)
    if analysis.estimated_reference_hz is None:
        raise AppError("PROCESSING_FAILED", "Could not determine the source tuning reference.")
    return cents_from_reference(analysis.estimated_reference_hz, target_reference_hz)


def _preview_cache_key(project_id: str, payload: dict[str, Any]) -> str:
    return stable_hash({"project_id": project_id, **payload})


def _ensure_not_cancelled(should_cancel: Callable[[], bool] | None) -> None:
    if should_cancel and should_cancel():
        raise JobCancelledError()


def _resolve_legacy_export_file_path(
    artifact: Artifact,
    *,
    output_format: str,
    destination_path: str | None,
    destination_file_path: str | None,
) -> Path:
    if destination_file_path:
        return Path(destination_file_path).expanduser().resolve()
    source_path = Path(artifact.path)
    root = (
        Path(destination_path).expanduser().resolve()
        if destination_path
        else project_exports_dir(artifact.project_id)
    )
    return root / f"{source_path.stem}.{output_format}"


def _new_sibling_temp_paths(target: Path, output_format: str) -> tuple[Path, Path]:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=target.parent,
        prefix="tuneforge-export-",
        delete=False,
    ) as temp_file:
        temp_base_path = Path(temp_file.name)
    temp_base_path.unlink(missing_ok=True)
    return temp_base_path, temp_base_path.with_suffix(f".{output_format}")


def ensure_export_destination_available(*, destination_file_path: str | None, overwrite_existing: bool) -> None:
    if not destination_file_path or overwrite_existing:
        return
    target = Path(destination_file_path).expanduser().resolve()
    if target.exists():
        raise AppError(
            "EXPORT_DESTINATION_EXISTS",
            "Export destination already exists.",
            status_code=status.HTTP_409_CONFLICT,
            details={"destination_file_path": str(target)},
        )


def export_capabilities() -> dict[str, Any]:
    formats = probe_export_formats()
    return {
        "platform": "desktop",
        "formats": [
            {"id": output_format, "available": available, "reason": reason}
            for output_format, (available, reason) in formats.items()
        ],
        "destinations": [
            {"id": destination, "available": True, "reason": None}
            for destination in ("single_file", "folder", "zip")
        ],
        "max_artifact_count": None,
    }


def _safe_filename_base(value: str) -> str:
    sanitized = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", value).strip(" .")
    sanitized = re.sub(r"\s+", " ", sanitized)
    return sanitized[:120] or "TuneForge Export"


def _primary_audio_artifact(artifact: Artifact, artifacts_by_id: dict[str, Artifact]) -> Artifact | None:
    if artifact.type in {"source_audio", "preview_mix"}:
        return artifact
    if artifact.type not in STEM_ARTIFACT_TYPES:
        return None
    source_artifact_id = artifact.metadata_json.get("source_artifact_id")
    return artifacts_by_id.get(source_artifact_id) if isinstance(source_artifact_id, str) else None


def _practice_mix_label(session: Session, project_id: str, artifact_id: str) -> str:
    mixes = list(
        session.scalars(
            select(Artifact)
            .where(Artifact.project_id == project_id, Artifact.type == "preview_mix")
            .order_by(Artifact.created_at.asc(), Artifact.id.asc())
        )
    )
    return f"Practice Mix {next((index for index, mix in enumerate(mixes, 1) if mix.id == artifact_id), 1)}"


def _audio_set_label(session: Session, artifact: Artifact) -> str:
    return (
        "Source"
        if artifact.type == "source_audio"
        else _practice_mix_label(session, artifact.project_id, artifact.id)
    )


def _artifact_export_label(artifact: Artifact) -> str | None:
    source = STEM_ARTIFACT_TYPE_SOURCES.get(artifact.type)
    return source.replace("_", " ").title() if source else None


def _deduplicate_output_names(names: list[str]) -> list[str]:
    counts: dict[str, int] = {}
    deduplicated: list[str] = []
    for name in names:
        path = Path(name)
        key = name.casefold()
        counts[key] = counts.get(key, 0) + 1
        suffix = "" if counts[key] == 1 else f" ({counts[key]})"
        deduplicated.append(f"{path.stem}{suffix}{path.suffix}")
    return deduplicated


def prepare_export_job_payload(
    session: Session,
    *,
    project: Project,
    request_payload: dict[str, Any],
) -> dict[str, Any]:
    artifact_ids = list(request_payload.get("artifact_ids", []))
    artifacts = [session.get(Artifact, artifact_id) for artifact_id in artifact_ids]
    if any(artifact is None or artifact.project_id != project.id for artifact in artifacts):
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact does not belong to this project.", status_code=404)
    selected = [artifact for artifact in artifacts if artifact is not None]
    all_project_artifacts = {
        artifact.id: artifact
        for artifact in session.scalars(select(Artifact).where(Artifact.project_id == project.id))
    }
    primary_artifacts = [_primary_audio_artifact(artifact, all_project_artifacts) for artifact in selected]
    if any(primary is None for primary in primary_artifacts):
        raise AppError("INVALID_REQUEST", "Only source tracks, practice mixes, and their stems can be exported.")
    primary_ids = {primary.id for primary in primary_artifacts if primary is not None}
    if len(primary_ids) != 1:
        raise AppError("EXPORT_AUDIO_SET_MISMATCH", "Selected artifacts must belong to one audio set.")
    output_format = str(request_payload.get("output_format", "wav"))
    format_available, reason = probe_export_formats().get(output_format, (False, "Unsupported export format."))
    if not format_available:
        raise AppError("EXPORT_FORMAT_UNAVAILABLE", reason or "Export format is unavailable.", status_code=422)

    primary = next(primary for primary in primary_artifacts if primary is not None)
    destination = request_payload.get("destination")
    if isinstance(destination, dict):
        filename_base = _safe_filename_base(str(request_payload.get("filename_base") or project.display_name))
        context_label = _audio_set_label(session, primary)
        raw_names = [
            f"{filename_base} - {context_label}"
            f"{' - ' + label if (label := _artifact_export_label(artifact)) else ''}.{output_format}"
            for artifact in selected
        ]
        output_names = _deduplicate_output_names(raw_names)
        normalized_destination = {
            "type": str(destination.get("type")),
            "target": str(destination.get("target")),
            "overwrite": bool(destination.get("overwrite", False)),
        }
    else:
        artifact = selected[0]
        target = _resolve_legacy_export_file_path(
            artifact,
            output_format=output_format,
            destination_path=request_payload.get("destination_path"),
            destination_file_path=request_payload.get("destination_file_path"),
        )
        output_names = [target.name]
        normalized_destination = {
            "type": "single_file",
            "target": str(target),
            "overwrite": bool(request_payload.get("overwrite_existing", False)),
        }

    _preflight_export_destination(normalized_destination, output_names)
    return {
        "artifact_ids": artifact_ids,
        "mixdown_mode": "copy",
        "output_format": output_format,
        "filename_base": _safe_filename_base(str(request_payload.get("filename_base") or project.display_name)),
        "destination": normalized_destination,
        "output_names": output_names,
        "audio_set_artifact_id": primary.id,
    }


def _preflight_export_destination(destination: dict[str, Any], output_names: list[str]) -> None:
    target = Path(str(destination["target"])).expanduser().resolve()
    overwrite = bool(destination.get("overwrite", False))
    destination_type = destination["type"]
    if destination_type == "folder":
        if target.exists() and not target.is_dir():
            raise AppError("INVALID_REQUEST", "Export folder destination is not a directory.")
        collisions = [str(target / name) for name in output_names if (target / name).exists()]
        if collisions and not overwrite:
            raise AppError(
                "EXPORT_DESTINATION_EXISTS",
                "One or more export destinations already exist.",
                status_code=status.HTTP_409_CONFLICT,
                details={"destination_file_paths": collisions},
            )
        return
    if target.exists() and not overwrite:
        raise AppError(
            "EXPORT_DESTINATION_EXISTS",
            "Export destination already exists.",
            status_code=status.HTTP_409_CONFLICT,
            details={"destination_file_path": str(target)},
        )


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


def _export_one_to_target(
    *,
    source: Artifact,
    target: Path,
    output_format: str,
    overwrite: bool,
    sample_rate: int,
    should_cancel: Callable[[], bool] | None,
    register_process: Callable[[subprocess.Popen[str]], None] | None,
    unregister_process: Callable[[], None] | None,
    on_progress: Callable[[int], None] | None,
) -> None:
    source_path = Path(source.path)
    temp_base_path, temp_path = _new_sibling_temp_paths(target, output_format)
    try:
        if source.format == output_format:
            _ensure_not_cancelled(should_cancel)
            shutil.copy2(source_path, temp_path)
            if on_progress:
                on_progress(90)
            _ensure_not_cancelled(should_cancel)
        else:
            run_ffmpeg_transform(
                source_path,
                temp_base_path,
                sample_rate,
                0.0,
                output_format,
                on_progress=on_progress,
                should_cancel=should_cancel,
                register_process=register_process,
                unregister_process=unregister_process,
            )
            _ensure_not_cancelled(should_cancel)
        if target.exists() and not overwrite:
            raise AppError("EXPORT_DESTINATION_EXISTS", "An export destination already exists.", status_code=409)
        temp_path.replace(target)
    finally:
        temp_base_path.unlink(missing_ok=True)
        temp_path.unlink(missing_ok=True)


def _export_result_payload(items: list[dict[str, Any]]) -> dict[str, Any]:
    completed_count = sum(item["status"] == "completed" for item in items)
    failed_count = sum(item["status"] == "failed" for item in items)
    outcome = "completed" if completed_count == len(items) else "partial" if completed_count else "failed"
    return {
        "outcome": outcome,
        "total_count": len(items),
        "completed_count": completed_count,
        "failed_count": failed_count,
        "items": [dict(item) for item in items],
    }


def export_artifacts(
    session: Session,
    *,
    project: Project,
    artifact_ids: list[str],
    output_format: str,
    destination: dict[str, Any],
    output_names: list[str],
    on_progress: Callable[[int], None] | None = None,
    on_result: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> ExportBatchResult:
    artifacts = [session.get(Artifact, artifact_id) for artifact_id in artifact_ids]
    if len(artifacts) != len(output_names) or any(artifact is None for artifact in artifacts):
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact not found.", status_code=status.HTTP_404_NOT_FOUND)
    selected = [artifact for artifact in artifacts if artifact is not None]
    target = Path(str(destination["target"])).expanduser().resolve()
    destination_type = str(destination["type"])
    overwrite = bool(destination.get("overwrite", False))
    _preflight_export_destination(destination, output_names)
    sample_rate = project.sample_rate or 44100
    items = [
        {
            "artifact_id": artifact.id,
            "output_name": output_name,
            "status": "pending",
            "progress": 0,
            "result_artifact_id": None,
            "error": None,
        }
        for artifact, output_name in zip(selected, output_names, strict=True)
    ]
    result_artifact_ids: list[str] = []

    def publish_result() -> None:
        if on_result:
            on_result(_export_result_payload(items))

    with tempfile.TemporaryDirectory(prefix="tuneforge-export-stage-") as stage_dir_name:
        stage_dir = Path(stage_dir_name)
        completed_outputs: list[tuple[Artifact, Path, str]] = []
        for index, (artifact, output_name) in enumerate(zip(selected, output_names, strict=True)):
            _ensure_not_cancelled(should_cancel)
            item = items[index]
            item["status"] = "running"
            item["progress"] = 5
            publish_result()
            item_target = stage_dir / output_name if destination_type == "zip" else (
                target / output_name if destination_type == "folder" else target
            )

            def report_item_progress(value: int, *, item_index: int = index) -> None:
                items[item_index]["progress"] = min(99, max(0, value))
                if on_progress:
                    on_progress(int(((item_index + value / 100) / len(items)) * 85) + 10)
                publish_result()

            try:
                _export_one_to_target(
                    source=artifact,
                    target=item_target,
                    output_format=output_format,
                    overwrite=overwrite,
                    sample_rate=sample_rate,
                    should_cancel=should_cancel,
                    register_process=register_process,
                    unregister_process=unregister_process,
                    on_progress=report_item_progress,
                )
            except JobCancelledError:
                item["status"] = "cancelled"
                publish_result()
                raise
            except (AppError, OSError):
                item["status"] = "failed"
                item["error"] = "Could not export this audio item."
                publish_result()
                continue

            item["status"] = "completed"
            item["progress"] = 100
            completed_outputs.append((artifact, item_target, output_name))
            if destination_type != "zip":
                exported = register_artifact(
                    session,
                    project_id=project.id,
                    artifact_type="export_mix",
                    artifact_format=output_format,
                    path=item_target,
                    metadata={"source_artifact_id": artifact.id, "output_name": output_name},
                    generated_by="ffmpeg",
                    can_delete=True,
                    can_regenerate=False,
                )
                item["result_artifact_id"] = exported.id
                result_artifact_ids.append(exported.id)
            publish_result()

        if destination_type == "zip" and completed_outputs:
            _ensure_not_cancelled(should_cancel)
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=target.parent,
                prefix="tuneforge-export-",
                suffix=".zip",
                delete=False,
            ) as temp:
                zip_path = Path(temp.name)
            try:
                with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    for _artifact, staged_path, output_name in completed_outputs:
                        archive.write(staged_path, arcname=output_name)
                _ensure_not_cancelled(should_cancel)
                if target.exists() and not overwrite:
                    _preflight_export_destination(destination, output_names)
                zip_path.replace(target)
            finally:
                zip_path.unlink(missing_ok=True)
            archive_artifact = register_artifact(
                session,
                project_id=project.id,
                artifact_type="export_mix",
                artifact_format="zip",
                path=target,
                metadata={
                    "source_artifact_ids": [artifact.id for artifact, _, _ in completed_outputs],
                    "output_names": [output_name for _, _, output_name in completed_outputs],
                    "contained_format": output_format,
                },
                generated_by="ffmpeg",
                can_delete=True,
                can_regenerate=False,
            )
            result_artifact_ids.append(archive_artifact.id)
            for item in items:
                if item["status"] == "completed":
                    item["result_artifact_id"] = archive_artifact.id
            publish_result()

    export_result = _export_result_payload(items)
    return ExportBatchResult(artifact_ids=result_artifact_ids, export_result=export_result)
