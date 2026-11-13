from __future__ import annotations

import tempfile
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import soundfile as sf
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.audio_encoding import DurableAudioFormat, encode_audio, validate_audio_file
from app.engines.vocal_refinement import (
    ProcessCallback,
    check_cancel,
    decode_float,
    require_unit_peak,
    validate_conversion,
)
from app.errors import AppError
from app.models import Artifact, Project, utcnow
from app.services.artifacts import refresh_artifact_file_metadata
from app.services.paths import contained_output_path, project_root
from app.services.project_storage import queue_project_storage_reconciliation
from app.services.stem_models import VOCAL_SUBSTEM_ARTIFACT_TYPES
from app.services.vocal_substems import (
    VOCAL_MEMBERSHIP,
    VocalProcessOptions,
    lock_vocal_artifact_rows,
    validated_vocal_members,
    vocal_membership,
)
from app.utils.hashing import file_sha256


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _matches_snapshot(artifact: Artifact, snapshot: dict[str, Any]) -> bool:
    return (
        artifact.content_sha256 == snapshot["content_sha256"] and artifact.format == snapshot["format"]
        and _utc(artifact.updated_at) == _utc(datetime.fromisoformat(snapshot["updated_at"]))
    )


def _artifact_state(artifact: Artifact) -> tuple[object, ...]:
    return artifact.id, artifact.path, artifact.content_sha256, artifact.format, artifact.updated_at


def _project_rows(session: Session, project_id: str) -> dict[str, Artifact]:
    return {artifact.id: artifact for artifact in session.scalars(select(Artifact).where(
        Artifact.project_id == project_id,
    ).execution_options(populate_existing=True))}


def _group_rows(rows: dict[str, Artifact], source_id: str) -> tuple[Artifact, list[tuple[Artifact, list[Artifact]]]]:
    source = rows.get(source_id)
    if source is None or source.type not in {"source_audio", "preview_mix"}:
        raise AppError("ARTIFACT_CHANGED", "Vocal refinement source is no longer available.", status_code=409)
    groups = []
    for parent in rows.values():
        if (parent.type != "vocal_stem" or parent.metadata_json.get("source_artifact_id") != source_id
                or VOCAL_MEMBERSHIP not in parent.metadata_json):
            continue
        children = validated_vocal_members(parent, source, rows)
        if children is None:
            raise AppError("ARTIFACT_CHANGED", "Vocal refinement membership is incomplete or changed.", status_code=409)
        groups.append((parent, children))
    return source, groups


def _group_artifacts(source: Artifact, groups: list[tuple[Artifact, list[Artifact]]]) -> list[Artifact]:
    return [source, *(artifact for parent, children in groups for artifact in (parent, *children))]


def convert_vocal_audio_groups(
    session: Session, *, project_id: str, snapshots: list[dict[str, Any]], output_format: DurableAudioFormat,
    should_cancel: Callable[[], bool] | None = None,
    register_process: ProcessCallback | None = None, unregister_process: Callable[[], None] | None = None,
) -> tuple[set[str], list[str]]:
    """Re-encode the source, parents and included parts of each vocal group as a unit."""
    rows = _project_rows(session, project_id)
    pending = {snapshot["artifact_id"]: snapshot for snapshot in snapshots}
    source_ids = {
        source_id for parent in rows.values()
        if parent.type == "vocal_stem" and VOCAL_MEMBERSHIP in parent.metadata_json
        and isinstance(source_id := parent.metadata_json.get("source_artifact_id"), str)
    }
    claimed: set[str] = set()
    converted = []
    for source_id in sorted(source_ids):
        affected_ids = {
            row.id for row in rows.values()
            if (
                row.id == source_id
                or (row.type == "vocal_stem" and VOCAL_MEMBERSHIP in row.metadata_json
                    or row.type in VOCAL_SUBSTEM_ARTIFACT_TYPES)
                and row.metadata_json.get("source_artifact_id") == source_id
            )
        }
        if not (affected_ids & pending.keys()):
            continue
        source, groups = _group_rows(rows, source_id)
        members = _group_artifacts(source, groups)
        changed = [artifact for artifact in members if artifact.format != output_format]
        if any(
            artifact.id not in pending or not _matches_snapshot(artifact, pending[artifact.id]) for artifact in changed
        ):
            raise AppError("ARTIFACT_CHANGED", "Vocal refinement changed after conversion was queued.", status_code=409)
        if changed:
            converted.extend(_convert_group(
                session, project_id, source, members, changed, output_format,
                should_cancel, register_process, unregister_process,
            ))
        claimed.update(artifact.id for artifact in members)
    return claimed, converted


def _convert_group(
    session: Session, project_id: str, source: Artifact, members: list[Artifact], changed: list[Artifact],
    output_format: DurableAudioFormat, should_cancel: Callable[[], bool] | None,
    register_process: ProcessCallback | None, unregister_process: Callable[[], None] | None,
) -> list[str]:
    root = project_root(project_id)
    source_id = source.id
    original_states = {artifact.id: _artifact_state(artifact) for artifact in members}
    installed: list[Path] = []
    work_options = VocalProcessOptions(
        should_cancel=should_cancel, register_process=register_process, unregister_process=unregister_process,
    )
    try:
        with tempfile.TemporaryDirectory(prefix=".vocal-conversion-", dir=get_settings().cache_root) as staging:
            work = Path(staging)
            destinations: dict[str, tuple[Path, Path]] = {}
            for index, artifact in enumerate(changed):
                check_cancel(should_cancel)
                path = contained_output_path(root, Path(artifact.path))
                if not artifact.content_sha256 or file_sha256(path) != artifact.content_sha256:
                    raise AppError("ARTIFACT_CHANGED", "Vocal refinement audio is missing or changed.", status_code=409)
                destination = path.with_suffix(f".{output_format}")
                if destination.exists():
                    raise AppError(
                        "ARTIFACT_DESTINATION_EXISTS", "Converted audio destination already exists.", status_code=409,
                    )
                before = work / f"{index}-input.wav"
                encoded = work / f"{index}.{output_format}"
                after = work / f"{index}-verification.wav"
                decode_float(path, before, **work_options)
                if artifact.id != source.id and output_format in {"wav", "flac"}:
                    require_unit_peak(before, should_cancel)
                rate = sf.info(before).samplerate
                encode_audio(before, encoded, output_format,
                             movie_timescale=rate if output_format == "m4a" else None, **work_options)
                validate_audio_file(encoded, output_format)
                decode_float(encoded, after, **work_options)
                validate_conversion(
                    before, after, output_format,
                    original_is_lossless=artifact.format in {"wav", "flac"}, should_cancel=should_cancel,
                )
                destinations[artifact.id] = (encoded, destination)
                before.unlink()
                after.unlink()

            check_cancel(should_cancel)
            lock_vocal_artifact_rows(session, project_id, tuple(original_states))
            rows = _project_rows(session, project_id)
            current_source, groups = _group_rows(rows, source_id)
            current_members = _group_artifacts(current_source, groups)
            if {artifact.id: _artifact_state(artifact) for artifact in current_members} != original_states:
                raise AppError("ARTIFACT_CHANGED", "Vocal refinement changed during conversion.", status_code=409)
            for artifact in current_members:
                path = contained_output_path(root, Path(artifact.path))
                if not artifact.content_sha256 or file_sha256(path) != artifact.content_sha256:
                    raise AppError(
                        "ARTIFACT_CHANGED", "Vocal refinement audio changed during conversion.", status_code=409,
                    )
            check_cancel(should_cancel)
            for artifact in current_members:
                if artifact.id not in destinations:
                    continue
                encoded, destination = destinations[artifact.id]
                # A hard link installs without overwriting a path created while encoding.
                destination.hardlink_to(encoded)
                installed.append(destination)
                refresh_artifact_file_metadata(artifact, destination)
                artifact.format = output_format
                artifact.cache_key = None
                artifact.updated_at = utcnow()
                if artifact.type == "source_audio":
                    project = session.get(Project, project_id)
                    if project is not None:
                        project.imported_path = artifact.path
            for parent, children in groups:
                membership = vocal_membership(parent)
                assert membership is not None
                parent.metadata_json = {**parent.metadata_json, VOCAL_MEMBERSHIP: {
                    **membership, "format": output_format,
                    "parent_sha256": parent.content_sha256, "source_sha256": current_source.content_sha256,
                    "child_sha256": {child.metadata_json["vocal_part"]: child.content_sha256 for child in children},
                }}
            check_cancel(should_cancel)
            queue_project_storage_reconciliation(session, project_id)
            session.commit()
            installed.clear()
            return list(destinations)
    except Exception:
        session.rollback()
        for path in installed:
            path.unlink(missing_ok=True)
        raise
