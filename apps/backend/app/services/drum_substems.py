from __future__ import annotations

import tempfile
from collections.abc import Callable
from pathlib import Path
from subprocess import Popen

import soundfile as sf
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.audio_encoding import DurableAudioFormat, require_encoding_available
from app.engines.drum_substems import encode_bounded_drum_parts
from app.engines.stems import separate_sources
from app.errors import AppError, JobCancelledError
from app.models import Artifact, Job, Project
from app.services.artifacts import _has_pending_audio_job, register_artifact
from app.services.audio_working import materialize_pcm_wav
from app.services.drum_substem_model import (
    DRUMSEP_MODEL_ID,
    drumsep_capabilities,
    resolve_drumsep_checkpoint,
)
from app.services.paths import project_stems_dir
from app.services.project_storage import queue_project_storage_reconciliation
from app.services.stem_models import DRUM_SUBSTEM_ARTIFACT_TYPES, DRUM_SUBSTEM_SOURCES
from app.services.sync_tombstones import record_artifact_delete_tombstone
from app.utils.hashing import file_sha256
from app.utils.ids import new_id


def drum_parts_for_parent(session: Session, parent: Artifact) -> list[Artifact]:
    return [
        artifact for artifact in session.scalars(
            select(Artifact).where(
                Artifact.project_id == parent.project_id,
                Artifact.type.in_(tuple(DRUM_SUBSTEM_ARTIFACT_TYPES)),
            )
        ) if artifact.metadata_json.get("parent_artifact_id") == parent.id
    ]


def require_drum_parent(session: Session, *, project_id: str, parent_id: str) -> Artifact:
    parent = session.get(Artifact, parent_id)
    if parent is None or parent.project_id != project_id or parent.type != "drums_stem":
        raise AppError("INVALID_REQUEST", "Refine Drums requires an existing six-stem Drums artifact.", status_code=422)
    metadata = parent.metadata_json
    if metadata.get("stem_model") != "htdemucs_6s" or metadata.get("mode") != "six_stems":
        raise AppError("INVALID_REQUEST", "Refine Drums requires six-stem Drums output.", status_code=422)
    source_id = metadata.get("source_artifact_id")
    if not isinstance(source_id, str):
        raise AppError("INVALID_REQUEST", "Drums source lineage is missing.", status_code=422)
    source = session.get(Artifact, source_id)
    if source is None or source.project_id != project_id or source.type not in {"source_audio", "preview_mix"}:
        raise AppError("INVALID_REQUEST", "Drums source artifact is unavailable.", status_code=422)
    if not Path(parent.path).is_file() or file_sha256(Path(parent.path)) != parent.content_sha256:
        raise AppError(
            "INVALID_AUDIO_FILE", "Drums stem is missing or changed. Regenerate stems first.", status_code=409,
        )
    return parent


def _conflicting_job(
    session: Session, *, project_id: str, parent: Artifact | None,
    source_id: str | None,
) -> bool:
    jobs = session.scalars(select(Job).where(
        Job.project_id == project_id,
        Job.type.in_(("stems", "drum_substems")),
        Job.status.in_(("pending", "running")),
    ))
    for job in jobs:
        if job.type == "stems" and job.payload_json.get("source_artifact_id") == source_id:
            return True
        if job.type == "drum_substems" and (
            parent is None and job.payload_json.get("source_artifact_id") == source_id
            or parent is not None and job.payload_json.get("drums_artifact_id") == parent.id
        ):
            return True
    return False


def validate_drum_refinement_request(
    session: Session, *, project_id: str, parent_id: str,
    output_format: DurableAudioFormat,
) -> tuple[Artifact, str]:
    require_encoding_available(output_format)
    parent = require_drum_parent(session, project_id=project_id, parent_id=parent_id)
    source_id = str(parent.metadata_json["source_artifact_id"])
    if _conflicting_job(session, project_id=project_id, parent=parent, source_id=source_id):
        raise AppError("ARTIFACT_BUSY", "Stem generation or drum refinement is already active.", status_code=409)
    if not drumsep_capabilities()["available"]:
        raise AppError(
            "STEM_MODEL_UNAVAILABLE", "DrumSep is unavailable on this device or its descriptor is invalid.",
            status_code=409,
        )
    return parent, source_id


def guard_parent_rebuild(
    session: Session, *, project_id: str, source_artifact_id: str,
) -> None:
    if _conflicting_job(session, project_id=project_id, parent=None, source_id=source_artifact_id):
        raise AppError("ARTIFACT_BUSY", "Stem generation or drum refinement is already active.", status_code=409)


def invalidate_drum_refinement(session: Session, parent: Artifact) -> None:
    for child in drum_parts_for_parent(session, parent):
        record_artifact_delete_tombstone(session, child)
        session.delete(child)
    if "drum_substems" in parent.metadata_json:
        metadata = dict(parent.metadata_json)
        metadata.pop("drum_substems", None)
        parent.metadata_json = metadata
    queue_project_storage_reconciliation(session, parent.project_id)


def delete_drum_substem_set(session: Session, *, project_id: str, parent_id: str) -> None:
    parent = require_drum_parent(session, project_id=project_id, parent_id=parent_id)
    if _has_pending_audio_job(session, project_id=project_id):
        raise AppError("ARTIFACT_BUSY", "Audio jobs are active; refined drums cannot be deleted.", status_code=409)
    if _conflicting_job(
        session, project_id=project_id, parent=parent,
        source_id=str(parent.metadata_json["source_artifact_id"]),
    ):
        raise AppError("ARTIFACT_BUSY", "Stem generation or drum refinement is active.", status_code=409)
    invalidate_drum_refinement(session, parent)


def generate_drum_substems(
    session: Session, *, project: Project, parent_id: str,
    parent_sha256: str, output_format: DurableAudioFormat, force: bool,
    allow_download: bool,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> list[Artifact]:
    require_encoding_available(output_format)
    parent = require_drum_parent(session, project_id=project.id, parent_id=parent_id)
    if parent.content_sha256 != parent_sha256:
        raise AppError("ARTIFACT_CHANGED", "Drums changed before refinement started.", status_code=409)
    manifest = parent.metadata_json.get("drum_substems")
    children = drum_parts_for_parent(session, parent)
    if (
        not force and isinstance(manifest, dict)
        and manifest.get("parent_sha256") == parent_sha256
        and manifest.get("format") == output_format
        and len(children) == len(DRUM_SUBSTEM_SOURCES)
        and all(
            Path(child.path).is_file() and file_sha256(Path(child.path)) == child.content_sha256
            for child in children
        )
    ):
        if on_progress:
            on_progress(100)
        return children

    try:
        checkpoint, checkpoint_path = resolve_drumsep_checkpoint(
            allow_download=allow_download, should_cancel=should_cancel,
            register_process=register_process, unregister_process=unregister_process,
        )
    except RuntimeError as exc:
        raise AppError("STEM_MODEL_UNAVAILABLE", str(exc), status_code=409) from exc

    source_id = str(parent.metadata_json["source_artifact_id"])
    generation_id = new_id("drumset")
    final_dir = project_stems_dir(project.id) / source_id / "htdemucs_6s" / generation_id
    final_dir.parent.mkdir(parents=True, exist_ok=True)
    metadata: dict[str, object]
    with tempfile.TemporaryDirectory(prefix=".tuneforge-drumsep-", dir=final_dir.parent) as temp_name:
        temp_dir = Path(temp_name)
        raw = {part: temp_dir / "raw" / f"{part}.wav" for part in DRUM_SUBSTEM_SOURCES}
        with materialize_pcm_wav(Path(parent.path), should_cancel=should_cancel,
                                 register_process=register_process,
                                 unregister_process=unregister_process) as working_source:
            parent_audio = sf.info(working_source)
            metadata = separate_sources(
                working_source, raw, model=DRUMSEP_MODEL_ID, device=get_settings().stem_device,
                drumsep_checkpoint=checkpoint_path, float_output=True,
                on_progress=on_progress, should_cancel=should_cancel,
                register_process=register_process, unregister_process=unregister_process,
            )
        if should_cancel and should_cancel():
            raise JobCancelledError()
        gain = encode_bounded_drum_parts(
            raw, temp_dir / "publish", output_format,
            expected_frames=parent_audio.frames,
            expected_channels=parent_audio.channels,
            expected_sample_rate=parent_audio.samplerate,
            should_cancel=should_cancel, register_process=register_process,
            unregister_process=unregister_process,
        )
        if should_cancel and should_cancel():
            raise JobCancelledError()
        current_parent = require_drum_parent(session, project_id=project.id, parent_id=parent.id)
        if current_parent.content_sha256 != parent_sha256:
            raise AppError("ARTIFACT_CHANGED", "Drums changed during refinement.", status_code=409)
        (temp_dir / "publish").replace(final_dir)
        if should_cancel and should_cancel():
            for path in final_dir.iterdir():
                path.unlink(missing_ok=True)
            final_dir.rmdir()
            raise JobCancelledError()

    try:
        generation: list[Artifact] = []
        for part in DRUM_SUBSTEM_SOURCES:
            if should_cancel and should_cancel():
                raise JobCancelledError()
            generation.append(register_artifact(
                session, project_id=project.id, artifact_type=f"{part}_drum_substem",
                artifact_format=output_format, path=final_dir / f"{part}.{output_format}",
                generated_by="drumsep", can_delete=True, can_regenerate=True,
                metadata={
                    "source_artifact_id": source_id,
                    "source_artifact_type": parent.metadata_json.get("source_artifact_type"),
                    "parent_artifact_id": parent.id,
                    "parent_sha256": parent_sha256,
                    "generation_id": generation_id,
                    "checkpoint_model": DRUMSEP_MODEL_ID,
                    "checkpoint_revision": checkpoint.revision,
                    "checkpoint_sha256": checkpoint.sha256,
                    "checkpoint_source": checkpoint.source_kind,
                    "checkpoint_upstream_sha256": checkpoint.upstream_sha256,
                    "applied_gain": gain,
                    "drum_part": part,
                    "device": metadata.get("device"),
                },
            ))
        if should_cancel and should_cancel():
            raise JobCancelledError()
        if file_sha256(Path(parent.path)) != parent_sha256:
            raise AppError("ARTIFACT_CHANGED", "Drums changed during refinement.", status_code=409)
        parent_metadata = dict(parent.metadata_json)
        parent_metadata["drum_substems"] = {
            "generation_id": generation_id,
            "parent_sha256": parent_sha256,
            "checkpoint_model": DRUMSEP_MODEL_ID,
            "checkpoint_revision": checkpoint.revision,
            "checkpoint_sha256": checkpoint.sha256,
            "checkpoint_source": checkpoint.source_kind,
            "checkpoint_upstream_sha256": checkpoint.upstream_sha256,
            "format": output_format,
            "applied_gain": gain,
            "expected_parts": list(DRUM_SUBSTEM_SOURCES),
            "excluded_parts": [],
            "child_artifact_ids": {str(child.metadata_json["drum_part"]): child.id for child in generation},
        }
        parent.metadata_json = parent_metadata
        for child in children:
            record_artifact_delete_tombstone(session, child)
            session.delete(child)
        queue_project_storage_reconciliation(session, project.id)
        if should_cancel and should_cancel():
            raise JobCancelledError()
        session.flush()
        return generation
    except Exception:
        for path in final_dir.iterdir():
            path.unlink(missing_ok=True)
        final_dir.rmdir()
        raise
