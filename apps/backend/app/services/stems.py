from __future__ import annotations

import tempfile
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from subprocess import Popen
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.stems import separate_sources, separate_two_stems
from app.errors import AppError, JobCancelledError
from app.models import Artifact, Project, utcnow
from app.services.artifacts import refresh_artifact_file_metadata, register_artifact
from app.services.paths import project_stems_dir
from app.services.stem_models import (
    STEM_ARTIFACT_TYPES,
    TWO_STEMS_MODEL_ID,
    StemModelDefinition,
    model_output_artifact_type,
    resolve_stem_model,
)
from app.services.stem_signal_metadata import (
    STEM_SIGNAL_METADATA_KEY,
    add_analysis_usability_to_stem_signal_metadatas,
    build_stem_signal_metadata,
    has_current_stem_signal_analysis_usability,
    has_current_stem_signal_metadata,
)
from app.services.sync_tombstones import record_artifact_delete_tombstone
from app.utils.ids import new_id


@dataclass(frozen=True)
class StemOutputPlan:
    source: str
    artifact_type: str
    path: Path
    output_format: str


@dataclass(frozen=True)
class StemGenerationResult:
    artifacts: list[Artifact]
    generated_this_job: bool
    signal_metadata_hydrated: bool = False


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


def build_stem_plan(
    source_artifact: Artifact,
    *,
    output_format: str,
    stem_model: StemModelDefinition,
    generation_id: str | None = None,
) -> list[StemOutputPlan]:
    stems_dir = project_stems_dir(source_artifact.project_id) / source_artifact.id / stem_model.id
    if generation_id is not None:
        stems_dir = stems_dir / generation_id
    return [
        StemOutputPlan(
            source=source,
            artifact_type=model_output_artifact_type(source),
            path=stems_dir / f"{source}.{output_format}",
            output_format=output_format,
        )
        for source in stem_model.sources
    ]


def _stem_artifacts_for_source(
    session: Session,
    *,
    project_id: str,
    source_artifact_id: str,
    stem_model_id: str | None = None,
) -> list[Artifact]:
    stmt = select(Artifact).where(
        Artifact.project_id == project_id,
        Artifact.type.in_(tuple(STEM_ARTIFACT_TYPES)),
    ).order_by(Artifact.created_at.desc(), Artifact.id.desc())
    return [
        artifact
        for artifact in session.scalars(stmt)
        if artifact.metadata_json.get("source_artifact_id") == source_artifact_id
        and (stem_model_id is None or artifact.metadata_json.get("stem_model") == stem_model_id)
    ]


def _complete_existing_stem_artifacts(
    session: Session,
    *,
    project_id: str,
    source_artifact_id: str,
    stem_model: StemModelDefinition,
) -> list[Artifact] | None:
    artifacts = _stem_artifacts_for_source(
        session,
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        stem_model_id=stem_model.id,
    )
    artifacts_by_type = {artifact.type: artifact for artifact in artifacts}
    expected_types = [model_output_artifact_type(source) for source in stem_model.sources]
    existing = [artifacts_by_type.get(artifact_type) for artifact_type in expected_types]
    if any(artifact is None for artifact in existing):
        return None

    complete = [artifact for artifact in existing if artifact is not None]
    if all(
        artifact.metadata_json.get("stem_model") == stem_model.id and Path(artifact.path).exists()
        for artifact in complete
    ):
        return complete
    return None


def existing_stem_artifacts(
    session: Session,
    *,
    project_id: str,
    source_artifact_id: str,
) -> tuple[Artifact | None, Artifact | None]:
    artifacts = _complete_existing_stem_artifacts(
        session,
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        stem_model=resolve_stem_model(TWO_STEMS_MODEL_ID),
    )
    if artifacts is None:
        return None, None
    return artifacts[0], artifacts[1]


def _upsert_stem_artifact(
    session: Session,
    *,
    existing_artifact: Artifact | None,
    project_id: str,
    artifact_type: str,
    artifact_format: str,
    path: Path,
    metadata: dict[str, Any],
) -> Artifact:
    if existing_artifact is None:
        return register_artifact(
            session,
            project_id=project_id,
            artifact_type=artifact_type,
            artifact_format=artifact_format,
            path=path,
            metadata=metadata,
            generated_by="demucs",
            can_delete=True,
            can_regenerate=True,
        )

    old_path = Path(existing_artifact.path)
    if old_path != path:
        _cleanup_artifact_path(old_path)

    existing_artifact.format = artifact_format
    existing_artifact.path = str(path)
    refresh_artifact_file_metadata(existing_artifact, path)
    existing_artifact.generated_by = "demucs"
    existing_artifact.can_delete = True
    existing_artifact.can_regenerate = True
    existing_artifact.metadata_json = metadata
    existing_artifact.created_at = utcnow()
    session.flush()
    return existing_artifact


def _cleanup_artifact_path(path: Path) -> None:
    if path.exists():
        path.unlink(missing_ok=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass


def _prune_extra_stem_artifacts(
    session: Session,
    *,
    project_id: str,
    source_artifact_id: str,
    stem_model_id: str | None,
    keep_ids: set[str],
) -> None:
    for artifact in _stem_artifacts_for_source(
        session,
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        stem_model_id=stem_model_id,
    ):
        if artifact.id not in keep_ids:
            record_artifact_delete_tombstone(session, artifact)
            _cleanup_artifact_path(Path(artifact.path))
            session.delete(artifact)


def _separate_with_model(
    source_path: Path,
    plan: list[StemOutputPlan],
    *,
    stem_model: StemModelDefinition,
    on_progress: Callable[[int], None] | None,
    should_cancel: Callable[[], bool] | None,
    register_process: Callable[[Popen[str]], None] | None,
    unregister_process: Callable[[], None] | None,
) -> dict[str, object]:
    settings = get_settings()
    if stem_model.id == TWO_STEMS_MODEL_ID:
        output_by_source = {output.source: output.path for output in plan}
        return separate_two_stems(
            source_path,
            output_by_source["vocals"],
            output_by_source["instrumental"],
            model=stem_model.id,
            device=settings.stem_device,
            model_repo=settings.demucs_model_repo,
            on_progress=on_progress,
            should_cancel=should_cancel,
            register_process=register_process,
            unregister_process=unregister_process,
        )

    return separate_sources(
        source_path,
        {output.source: output.path for output in plan},
        model=stem_model.id,
        device=settings.stem_device,
        model_repo=settings.demucs_model_repo,
        on_progress=on_progress,
        should_cancel=should_cancel,
        register_process=register_process,
        unregister_process=unregister_process,
    )


def _temp_stem_plan(plan: list[StemOutputPlan]) -> tuple[tempfile.TemporaryDirectory[str], list[StemOutputPlan]]:
    if not plan:
        raise AppError("INVALID_REQUEST", "At least one stem output is required.")
    final_dir = plan[0].path.parent
    final_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = tempfile.TemporaryDirectory(prefix=".tuneforge-stems-", dir=final_dir)
    temp_root = Path(temp_dir.name)
    return temp_dir, [
        replace(output, path=temp_root / f"{output.source}.{output.output_format}")
        for output in plan
    ]


def _replace_stem_outputs(temp_plan: list[StemOutputPlan], final_plan: list[StemOutputPlan]) -> None:
    for temp_output, final_output in zip(temp_plan, final_plan, strict=True):
        final_output.path.parent.mkdir(parents=True, exist_ok=True)
        temp_output.path.replace(final_output.path)


def _ensure_not_cancelled(should_cancel: Callable[[], bool] | None) -> None:
    if should_cancel and should_cancel():
        raise JobCancelledError()


def _cleanup_stem_outputs(plan: list[StemOutputPlan]) -> None:
    for output in plan:
        _cleanup_artifact_path(output.path)


def _hydrate_stem_signal_metadata(session: Session, artifacts: list[Artifact]) -> bool:
    updated = False
    for artifact in artifacts:
        if has_current_stem_signal_metadata(artifact.metadata_json):
            continue
        metadata = dict(artifact.metadata_json)
        metadata[STEM_SIGNAL_METADATA_KEY] = build_stem_signal_metadata(Path(artifact.path))
        artifact.metadata_json = metadata
        updated = True

    if artifacts and any(
        not has_current_stem_signal_analysis_usability(artifact.metadata_json)
        for artifact in artifacts
    ):
        updated_metadatas = add_analysis_usability_to_stem_signal_metadatas(
            [artifact.metadata_json for artifact in artifacts]
        )
        for artifact, metadata in zip(artifacts, updated_metadatas, strict=True):
            artifact.metadata_json = metadata
        updated = True

    if updated:
        session.flush()
    return updated


def generate_stems(
    session: Session,
    *,
    project: Project,
    source_artifact_id: str | None,
    output_format: str,
    force: bool,
    stem_model: str | None = None,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> StemGenerationResult:
    if output_format != "wav":
        raise AppError("INVALID_REQUEST", "Stem output must be wav in v1.")

    source_artifact = resolve_stem_source_artifact(
        session,
        project=project,
        source_artifact_id=source_artifact_id,
    )
    selected_model = resolve_stem_model(stem_model, require_available=True)

    if not force:
        existing = _complete_existing_stem_artifacts(
            session,
            project_id=project.id,
            source_artifact_id=source_artifact.id,
            stem_model=selected_model,
        )
        if existing:
            signal_metadata_hydrated = False
            if source_artifact.type == "source_audio":
                signal_metadata_hydrated = _hydrate_stem_signal_metadata(session, existing)
            if on_progress:
                on_progress(100)
            return StemGenerationResult(
                artifacts=existing,
                generated_this_job=False,
                signal_metadata_hydrated=signal_metadata_hydrated,
            )

    plan = build_stem_plan(
        source_artifact,
        output_format=output_format,
        stem_model=selected_model,
        generation_id=new_id("stemset"),
    )
    temp_dir, temp_plan = _temp_stem_plan(plan)
    with temp_dir:
        metadata = _separate_with_model(
            Path(source_artifact.path),
            temp_plan,
            stem_model=selected_model,
            on_progress=on_progress,
            should_cancel=should_cancel,
            register_process=register_process,
            unregister_process=unregister_process,
        )
        _ensure_not_cancelled(should_cancel)
        _replace_stem_outputs(temp_plan, plan)
        try:
            _ensure_not_cancelled(should_cancel)
        except JobCancelledError:
            _cleanup_stem_outputs(plan)
            raise

    existing_artifacts = _stem_artifacts_for_source(
        session,
        project_id=project.id,
        source_artifact_id=source_artifact.id,
        stem_model_id=selected_model.id,
    )
    existing_by_type = {artifact.type: artifact for artifact in existing_artifacts}
    saved_artifacts: list[Artifact] = []

    stem_output_metadatas: list[tuple[StemOutputPlan, dict[str, Any]]] = []
    for output in plan:
        stem_metadata = {
            "mode": selected_model.mode,
            "stem_model": selected_model.id,
            "stem_model_label": selected_model.label,
            "stem_source": output.source,
            "source_artifact_id": source_artifact.id,
            "source_artifact_type": source_artifact.type,
            **metadata,
        }
        if source_artifact.type == "source_audio":
            stem_metadata[STEM_SIGNAL_METADATA_KEY] = build_stem_signal_metadata(output.path)
        stem_output_metadatas.append((output, stem_metadata))

    if source_artifact.type == "source_audio":
        updated_metadatas = add_analysis_usability_to_stem_signal_metadatas(
            [stem_metadata for _, stem_metadata in stem_output_metadatas]
        )
        stem_output_metadatas = [
            (output, updated_metadata)
            for (output, _), updated_metadata in zip(
                stem_output_metadatas,
                updated_metadatas,
                strict=True,
            )
        ]

    for output, stem_metadata in stem_output_metadatas:
        saved_artifacts.append(
            _upsert_stem_artifact(
                session,
                existing_artifact=existing_by_type.get(output.artifact_type),
                project_id=project.id,
                artifact_type=output.artifact_type,
                artifact_format=output.output_format,
                path=output.path,
                metadata=stem_metadata,
            )
        )

    _prune_extra_stem_artifacts(
        session,
        project_id=project.id,
        source_artifact_id=source_artifact.id,
        stem_model_id=None,
        keep_ids={artifact.id for artifact in saved_artifacts},
    )

    return StemGenerationResult(artifacts=saved_artifacts, generated_this_job=True)
