from __future__ import annotations

import json
from collections.abc import Mapping
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.analysis import AnalysisPayload, analyze_track
from app.engines.beat_this import BeatThisRuntimeError, analyze_track_with_beat_this, beat_this_dependency_status
from app.errors import AppError
from app.models import AnalysisResult, Artifact, Project
from app.services.artifacts import refresh_artifact_file_metadata, register_artifact
from app.services.audio_working import materialize_pcm_wav
from app.services.paths import project_analysis_dir

SOURCE_STEM_ARTIFACT_TYPES = ("drums_stem", "bass_stem")
BUILT_IN_BEAT_BACKEND = "built-in"
BEAT_THIS_BACKEND = "beat-this"


def analyze_project(
    session: Session,
    project: Project,
    *,
    beat_backend: str = BUILT_IN_BEAT_BACKEND,
) -> AnalysisResult:
    source_artifact = _project_source_artifact(project)
    source_stem_artifacts = (
        _source_stem_artifacts(project, source_artifact) if source_artifact is not None else ()
    )
    with ExitStack() as stack:
        source_path = stack.enter_context(materialize_pcm_wav(Path(project.imported_path)))
        source_stem_paths = tuple(
            stack.enter_context(materialize_pcm_wav(Path(artifact.path)))
            for artifact in source_stem_artifacts
        )
        results = _analyze_track_with_backend(
            source_path,
            source_stem_paths=source_stem_paths,
            beat_backend=beat_backend,
            duration_seconds=project.duration_seconds,
        )
    analysis = session.get(AnalysisResult, project.id)
    if analysis is None:
        analysis = AnalysisResult(project_id=project.id)
        session.add(analysis)

    analysis.source_artifact_id = source_artifact.id if source_artifact is not None else None
    analysis.estimated_key = results["estimated_key"]  # type: ignore[assignment]
    analysis.key_confidence = results["key_confidence"]  # type: ignore[assignment]
    analysis.estimated_reference_hz = results["estimated_reference_hz"]  # type: ignore[assignment]
    analysis.tuning_offset_cents = results["tuning_offset_cents"]  # type: ignore[assignment]
    analysis.tempo_bpm = results["tempo_bpm"]  # type: ignore[assignment]
    analysis.timing_json = results["timing"]  # type: ignore[assignment]
    analysis.analysis_version = "v3"
    session.flush()

    _write_analysis_artifact(
        session,
        project=project,
        analysis=analysis,
        analysis_backend=beat_backend,
        source_artifact=source_artifact,
        source_stem_artifacts=() if beat_backend == BEAT_THIS_BACKEND else source_stem_artifacts,
    )

    return analysis


def _analyze_track_with_backend(
    source_path: Path,
    *,
    source_stem_paths: tuple[Path, ...],
    beat_backend: str,
    duration_seconds: float | None,
) -> AnalysisPayload:
    if beat_backend == BUILT_IN_BEAT_BACKEND:
        if source_stem_paths:
            return analyze_track(source_path, source_stem_paths=source_stem_paths)
        return analyze_track(source_path)

    if beat_backend == BEAT_THIS_BACKEND:
        available, reason = beat_this_dependency_status()
        if not available:
            raise AppError(
                "ADVANCED_BEAT_BACKEND_UNAVAILABLE",
                reason or "Beat This backend is unavailable.",
                status_code=status.HTTP_409_CONFLICT,
                details={"backend": BEAT_THIS_BACKEND},
            )
        try:
            return analyze_track_with_beat_this(
                source_path,
                duration_seconds=duration_seconds,
            )
        except BeatThisRuntimeError as exc:
            raise AppError(
                "ADVANCED_BEAT_BACKEND_FAILED",
                str(exc),
                status_code=status.HTTP_409_CONFLICT,
                details={"backend": BEAT_THIS_BACKEND},
            ) from exc

    raise AppError(
        "UNSUPPORTED_BEAT_BACKEND",
        f"Unsupported beat backend: {beat_backend}.",
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        details={"supported_backends": [BUILT_IN_BEAT_BACKEND, BEAT_THIS_BACKEND]},
    )


def _project_source_artifact(project: Project) -> Artifact | None:
    return next((artifact for artifact in project.artifacts if artifact.type == "source_audio"), None)


def _source_stem_artifacts(project: Project, source_artifact: Artifact) -> tuple[Artifact, ...]:
    latest_by_type: dict[str, Artifact] = {}
    for artifact in project.artifacts:
        if not _is_source_analysis_stem(artifact, source_artifact):
            continue
        current = latest_by_type.get(artifact.type)
        if current is None or (artifact.created_at, artifact.id) > (current.created_at, current.id):
            latest_by_type[artifact.type] = artifact

    source_stem_artifacts: list[Artifact] = []
    for artifact_type in SOURCE_STEM_ARTIFACT_TYPES:
        selected_artifact = latest_by_type.get(artifact_type)
        if selected_artifact is not None:
            source_stem_artifacts.append(selected_artifact)
    return tuple(source_stem_artifacts)


def _is_source_analysis_stem(artifact: Artifact, source_artifact: Artifact) -> bool:
    if artifact.type not in SOURCE_STEM_ARTIFACT_TYPES:
        return False
    metadata = artifact.metadata_json
    if metadata.get("source_artifact_id") != source_artifact.id:
        return False
    if metadata.get("source_artifact_type") not in {None, "source_audio"}:
        return False
    return Path(artifact.path).exists()


def _write_analysis_artifact(
    session: Session,
    *,
    project: Project,
    analysis: AnalysisResult,
    analysis_backend: str | None,
    source_artifact: Artifact | None,
    source_stem_artifacts: tuple[Artifact, ...] | None,
) -> None:
    existing_artifact = _existing_analysis_artifact(session, project.id)
    analysis_metadata = _analysis_artifact_metadata(
        existing_artifact=existing_artifact,
        analysis=analysis,
        analysis_backend=analysis_backend,
        source_artifact=source_artifact,
        source_stem_artifacts=source_stem_artifacts,
    )
    analysis_payload = {
        "project_id": project.id,
        "estimated_key": analysis.estimated_key,
        "key_confidence": analysis.key_confidence,
        "estimated_reference_hz": analysis.estimated_reference_hz,
        "tuning_offset_cents": analysis.tuning_offset_cents,
        "tempo_bpm": analysis.tempo_bpm,
        "timing": analysis.timing_json,
        **analysis_metadata,
    }
    analysis_dir = project_analysis_dir(project.id)
    analysis_dir.mkdir(parents=True, exist_ok=True)
    analysis_path = analysis_dir / "analysis.json"
    analysis_path.write_text(
        json.dumps(analysis_payload, indent=2),
        encoding="utf-8",
    )

    if existing_artifact is None:
        register_artifact(
            session,
            project_id=project.id,
            artifact_type="analysis_json",
            artifact_format="json",
            path=analysis_path,
            metadata=analysis_metadata,
            generated_by="analysis",
        )
    else:
        refresh_artifact_file_metadata(existing_artifact, analysis_path)
        existing_artifact.generated_by = "analysis"
        existing_artifact.can_delete = True
        existing_artifact.can_regenerate = True
        existing_artifact.metadata_json = analysis_metadata

    session.flush()


def _existing_analysis_artifact(session: Session, project_id: str) -> Artifact | None:
    return session.scalar(
        select(Artifact)
        .where(Artifact.project_id == project_id, Artifact.type == "analysis_json")
        .order_by(Artifact.created_at.asc(), Artifact.id.asc())
    )


def _analysis_artifact_metadata(
    *,
    existing_artifact: Artifact | None,
    analysis: AnalysisResult,
    analysis_backend: str | None,
    source_artifact: Artifact | None,
    source_stem_artifacts: tuple[Artifact, ...] | None,
) -> dict[str, Any]:
    existing_metadata = existing_artifact.metadata_json if existing_artifact is not None else {}
    if not isinstance(existing_metadata, dict):
        existing_metadata = {}

    return {
        "analysis_generated_at": _analysis_generated_at_iso(),
        "analysis_backend": _analysis_backend_for_write(analysis_backend, existing_metadata),
        "analysis_version": analysis.analysis_version,
        "source_artifact_id": analysis.source_artifact_id,
        "source_artifact_sha256": source_artifact.content_sha256 if source_artifact is not None else None,
        "source_stem_artifact_ids": _source_stem_artifact_ids(
            source_stem_artifacts,
            existing_metadata,
        ),
        "source_stem_content_sha256s": _source_stem_content_sha256s(
            source_stem_artifacts,
            existing_metadata,
        ),
    }


def _analysis_backend_for_write(
    analysis_backend: str | None,
    existing_metadata: Mapping[str, Any],
) -> str:
    if analysis_backend in {BUILT_IN_BEAT_BACKEND, BEAT_THIS_BACKEND}:
        return analysis_backend
    existing_backend = existing_metadata.get("analysis_backend")
    if existing_backend in {BUILT_IN_BEAT_BACKEND, BEAT_THIS_BACKEND}:
        return cast(str, existing_backend)
    return BUILT_IN_BEAT_BACKEND


def _source_stem_artifact_ids(
    source_stem_artifacts: tuple[Artifact, ...] | None,
    existing_metadata: Mapping[str, Any],
) -> list[str]:
    if source_stem_artifacts is not None:
        return [artifact.id for artifact in source_stem_artifacts]
    existing_ids = existing_metadata.get("source_stem_artifact_ids")
    if isinstance(existing_ids, list) and all(isinstance(item, str) for item in existing_ids):
        return list(existing_ids)
    return []


def _source_stem_content_sha256s(
    source_stem_artifacts: tuple[Artifact, ...] | None,
    existing_metadata: Mapping[str, Any],
) -> list[str | None]:
    if source_stem_artifacts is not None:
        return [artifact.content_sha256 for artifact in source_stem_artifacts]
    existing_sha256s = existing_metadata.get("source_stem_content_sha256s")
    if isinstance(existing_sha256s, list) and all(
        isinstance(item, str) or item is None for item in existing_sha256s
    ):
        return list(existing_sha256s)
    return []


def _analysis_generated_at_iso() -> str:
    return datetime.now(UTC).isoformat()
