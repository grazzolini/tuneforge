from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypedDict

import soundfile as sf
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.audio_encoding import DurableAudioFormat, require_encoding_available
from app.engines.vocal_refinement import (
    ProcessCallback,
    check_cancel,
    decode_float,
    encode_vocal_parts,
    run_vocal_refinement,
)
from app.errors import AppError
from app.models import Artifact, Job, Project
from app.runtime_status import JobRuntimeEvent
from app.services.artifacts import _has_pending_audio_job, register_artifact
from app.services.audio_working import materialize_pcm_wav
from app.services.paths import artifact_storage_key, contained_output_path, project_root, project_stems_dir
from app.services.project_storage import queue_project_storage_reconciliation
from app.services.stem_models import VOCAL_SUBSTEM_ARTIFACT_TYPES, VOCAL_SUBSTEM_TYPES
from app.services.sync_tombstones import record_artifact_delete_tombstone
from app.services.vocal_substem_model import (
    MEGA53_CONFIG_SHA256,
    MEGA53_ENGINE_REVISION,
    MEGA53_MODEL,
    MEGA53_REVISION,
    MEGA53_SHA256,
    resolve_mega53,
    vocal_substem_capabilities,
)
from app.utils.hashing import file_sha256
from app.utils.ids import new_id

VOCAL_MEMBERSHIP = "vocal_substems"


class VocalProcessOptions(TypedDict):
    should_cancel: Callable[[], bool] | None
    register_process: ProcessCallback | None
    unregister_process: Callable[[], None] | None


@dataclass(frozen=True)
class VocalGeneration:
    artifacts: list[Artifact]
    device: str
    installed_dir: Path


def vocal_parts_for_parent(session: Session, parent: Artifact) -> list[Artifact]:
    return [
        child for child in session.scalars(select(Artifact).where(
            Artifact.project_id == parent.project_id, Artifact.type.in_(VOCAL_SUBSTEM_ARTIFACT_TYPES),
        ))
        if child.metadata_json.get("parent_artifact_id") == parent.id
    ]


def vocal_membership(parent: Artifact) -> dict[str, Any] | None:
    group = parent.metadata_json.get(VOCAL_MEMBERSHIP)
    return group if isinstance(group, dict) else None


def _is_six_stem_vocals(parent: Artifact) -> bool:
    return (
        parent.type == "vocal_stem" and parent.metadata_json.get("stem_model") == "htdemucs_6s"
        and parent.metadata_json.get("mode") == "six_stems"
    )


def _managed_path(artifact: Artifact) -> Path:
    return contained_output_path(project_root(artifact.project_id), Path(artifact.path))


def _verified(artifact: Artifact) -> bool:
    try:
        return bool(artifact.content_sha256 and file_sha256(_managed_path(artifact)) == artifact.content_sha256)
    except AppError:
        return False


def _vocal_parent(session: Session, project_id: str, parent_id: str) -> Artifact:
    parent = session.get(Artifact, parent_id, populate_existing=True)
    if parent is None or parent.project_id != project_id or not _is_six_stem_vocals(parent):
        raise AppError("INVALID_REQUEST", "Refine Vocals requires six-stem Vocals output.", status_code=422)
    return parent


def _vocal_source(session: Session, parent: Artifact) -> Artifact | None:
    source_id = parent.metadata_json.get("source_artifact_id")
    source = session.get(Artifact, source_id, populate_existing=True) if isinstance(source_id, str) else None
    if source is None or source.project_id != parent.project_id or source.type not in {"source_audio", "preview_mix"}:
        return None
    return source


def _vocal_inputs(session: Session, project_id: str, parent_id: str) -> tuple[Artifact, Artifact]:
    parent = _vocal_parent(session, project_id, parent_id)
    source = _vocal_source(session, parent)
    if source is None or not _verified(parent) or not _verified(source):
        raise AppError("INVALID_AUDIO_FILE", "Vocals or its source mix is missing or changed.", status_code=409)
    return parent, source


def _snapshot(artifact: Artifact) -> dict[str, Any]:
    return {
        "id": artifact.id, "sha256": artifact.content_sha256, "format": artifact.format,
        "updated_at": artifact.updated_at.isoformat(),
    }


def lock_vocal_artifact_rows(session: Session, project_id: str, artifact_ids: tuple[str, ...]) -> None:
    # Take SQLite's write lock before rechecking lineage and installing files.
    session.execute(update(Artifact).where(
        Artifact.project_id == project_id, Artifact.id.in_(artifact_ids),
    ).values(updated_at=Artifact.updated_at).execution_options(synchronize_session=False))


def _snapshot_inputs(
    session: Session, project_id: str, payload: dict[str, Any],
) -> tuple[Artifact, Artifact]:
    parent, source = _vocal_inputs(session, project_id, payload["vocals_artifact_id"])
    if _snapshot(parent) != payload["parent_snapshot"] or _snapshot(source) != payload["source_snapshot"]:
        raise AppError("ARTIFACT_CHANGED", "Vocals or its source mix changed during refinement.", status_code=409)
    return parent, source


def _vocal_job_busy(session: Session, project_id: str, source_id: str, *, refinements_only: bool) -> bool:
    types = ("vocal_substems",) if refinements_only else ("stems", "vocal_substems", "convert_audio")
    jobs = session.scalars(select(Job).where(
        Job.project_id == project_id, Job.type.in_(types), Job.status.in_(("pending", "running")),
    ))
    return any(
        job.type == "convert_audio" or job.payload_json.get("source_artifact_id") == source_id
        for job in jobs
    )


def guard_vocal_parent_rebuild(session: Session, project_id: str, source_id: str) -> None:
    if _vocal_job_busy(session, project_id, source_id, refinements_only=True):
        raise AppError("ARTIFACT_BUSY", "Vocal refinement is already active for this source.", status_code=409)


def validate_vocal_refinement_request(
    session: Session, *, project_id: str, parent_id: str, output_format: DurableAudioFormat,
) -> dict[str, Any]:
    require_encoding_available(output_format)
    if not vocal_substem_capabilities()["available"]:
        raise AppError("STEM_MODEL_UNAVAILABLE", "Mega53 is unavailable on this device.", status_code=409)
    parent, source = _vocal_inputs(session, project_id, parent_id)
    if _vocal_job_busy(session, project_id, source.id, refinements_only=False):
        raise AppError("ARTIFACT_BUSY", "An audio job is already active for this source.", status_code=409)
    return {"source_artifact_id": source.id, "parent_snapshot": _snapshot(parent), "source_snapshot": _snapshot(source)}


def _current_member(parent: Artifact, child: Artifact, group: dict[str, Any]) -> str | None:
    part = child.metadata_json.get("vocal_part")
    members = group.get("child_artifact_ids")
    fingerprints = group.get("child_sha256")
    generation = group.get("generation_id")
    if (
        not _is_six_stem_vocals(parent) or not isinstance(generation, str) or not generation
        or not isinstance(part, str) or child.type != VOCAL_SUBSTEM_TYPES.get(part)
        or child.project_id != parent.project_id
        or child.metadata_json.get("parent_artifact_id") != parent.id
        or child.metadata_json.get("source_artifact_id") != parent.metadata_json.get("source_artifact_id")
        or child.metadata_json.get("generation_id") != generation
        or not isinstance(members, dict) or members.get(part) != child.id
        or not isinstance(fingerprints, dict) or fingerprints.get(part) != child.content_sha256
        or child.format != group.get("format")
    ):
        return None
    return part


def validated_vocal_members(
    parent: Artifact, source: Artifact, artifacts: dict[str, Artifact],
) -> list[Artifact] | None:
    group = vocal_membership(parent)
    if (
        not _is_six_stem_vocals(parent) or group is None or group.get("parent_sha256") != parent.content_sha256
        or group.get("source_sha256") != source.content_sha256
        or group.get("source_artifact_id") != source.id or parent.metadata_json.get("source_artifact_id") != source.id
        or group.get("expected_parts") != list(VOCAL_SUBSTEM_TYPES)
        or not isinstance(group.get("generation_id"), str) or not group["generation_id"]
        or not parent.content_sha256 or not source.content_sha256
    ):
        return None
    excluded = group.get("excluded_parts")
    members = group.get("child_artifact_ids")
    hashes = group.get("child_sha256")
    if (
        not isinstance(excluded, list)
        or any(not isinstance(part, str) or part not in VOCAL_SUBSTEM_TYPES for part in excluded)
        or len(set(excluded)) != len(excluded) or not isinstance(members, dict) or not isinstance(hashes, dict)
        or set(members) != set(VOCAL_SUBSTEM_TYPES) - set(excluded) or set(hashes) != set(members)
    ):
        return None
    children = []
    for part, child_id in members.items():
        child = artifacts.get(child_id) if isinstance(child_id, str) else None
        if child is None or not child.content_sha256 or _current_member(parent, child, group) != part:
            return None
        children.append(child)
    return children


def vocal_substem_file_integrity(
    artifact: Artifact, artifacts: dict[str, Artifact],
) -> str | None:
    if artifact.type == "vocal_stem" and VOCAL_MEMBERSHIP in artifact.metadata_json:
        parent = artifact
        source_id = parent.metadata_json.get("source_artifact_id")
        source = artifacts.get(source_id) if isinstance(source_id, str) else None
        group = vocal_membership(parent)
        if (
            source is None or group is None or group.get("source_artifact_id") != source.id
            or group.get("source_sha256") != source.content_sha256 or not _verified(source)
            or group.get("parent_sha256") != parent.content_sha256
        ):
            return "corrupt"
    elif artifact.type in VOCAL_SUBSTEM_ARTIFACT_TYPES:
        parent_id = artifact.metadata_json.get("parent_artifact_id")
        child_parent = artifacts.get(parent_id) if isinstance(parent_id, str) else None
        group = vocal_membership(child_parent) if child_parent else None
        if child_parent is None or group is None or not _current_member(child_parent, artifact, group):
            return "corrupt"
    else:
        return None
    try:
        if not _managed_path(artifact).is_file():
            return "missing"
        return "verified" if _verified(artifact) else "corrupt"
    except AppError:
        return "corrupt"


def remove_vocal_child_membership(session: Session, child: Artifact) -> None:
    parent_id = child.metadata_json.get("parent_artifact_id")
    parent = session.get(Artifact, parent_id) if isinstance(parent_id, str) else None
    group = vocal_membership(parent) if parent is not None else None
    if parent is None or group is None:
        return
    part = _current_member(parent, child, group)
    excluded = group.get("excluded_parts")
    if part is None or not isinstance(excluded, list) or any(not isinstance(item, str) for item in excluded):
        return
    members = {key: value for key, value in group["child_artifact_ids"].items() if key != part}
    hashes = {key: value for key, value in group["child_sha256"].items() if key != part}
    parent.metadata_json = {**parent.metadata_json, VOCAL_MEMBERSHIP: {
        **group, "excluded_parts": sorted(set(excluded) | {part}),
        "child_artifact_ids": members, "child_sha256": hashes,
    }}


def invalidate_vocal_refinement(session: Session, parent: Artifact) -> None:
    children = vocal_parts_for_parent(session, parent)
    for child in children:
        record_artifact_delete_tombstone(session, child)
        session.delete(child)
    if VOCAL_MEMBERSHIP in parent.metadata_json:
        parent.metadata_json = {key: value for key, value in parent.metadata_json.items() if key != VOCAL_MEMBERSHIP}
    if children:
        queue_project_storage_reconciliation(session, parent.project_id)


def delete_vocal_substem_set(session: Session, *, project_id: str, parent_id: str) -> None:
    parent = _vocal_parent(session, project_id, parent_id)
    if _has_pending_audio_job(session, project_id=project_id):
        raise AppError("ARTIFACT_BUSY", "Audio jobs are active. Refined vocals cannot be deleted.", status_code=409)
    invalidate_vocal_refinement(session, parent)


def _copy_verified(artifact: Artifact, target: Path, should_cancel: Callable[[], bool] | None) -> Path:
    with _managed_path(artifact).open("rb") as source, target.open("xb") as output:
        while block := source.read(4 * 1024 * 1024):
            check_cancel(should_cancel)
            output.write(block)
    if file_sha256(target) != artifact.content_sha256:
        raise AppError("ARTIFACT_CHANGED", "An input changed while being staged for vocal refinement.", status_code=409)
    return target


def generate_vocal_substems(
    session: Session, *, project: Project, payload: dict[str, Any], output_format: DurableAudioFormat,
    on_runtime_event: Callable[[JobRuntimeEvent], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: ProcessCallback | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> VocalGeneration:
    require_encoding_available(output_format)
    parent, source = _snapshot_inputs(session, project.id, payload)
    checkpoint, config = resolve_mega53(allow_download=bool(payload.get("allow_download")), should_cancel=should_cancel)
    settings = get_settings()
    generation = new_id("vocalset")
    stems = project_stems_dir(project.id)
    final = contained_output_path(stems, stems / artifact_storage_key(source.id) / "htdemucs_6s" / generation)
    process_options = VocalProcessOptions(should_cancel=should_cancel, register_process=register_process,
                           unregister_process=unregister_process)
    installed = False
    try:
        # The project reconciler ignores staging outside the project tree.
        with tempfile.TemporaryDirectory(prefix=".vocal-refinement-", dir=settings.cache_root) as staging:
            work = Path(staging)
            mix = _copy_verified(source, work / f"mix.{source.format}", should_cancel)
            original = _copy_verified(parent, work / f"parent.{parent.format}", should_cancel)
            mix_wav, parent_wav = work / "mix-float.wav", work / "parent-float.wav"
            decode_float(original, parent_wav, **process_options)
            info = sf.info(parent_wav)
            if info.channels != 2 or info.samplerate != 44100:
                raise AppError("INVALID_AUDIO_FILE", "Six-stem Vocals must have a stereo 44.1 kHz timeline.")
            with (
                nullcontext(mix) if mix.suffix.lower() == ".wav"
                else materialize_pcm_wav(mix, **process_options)
            ) as working_mix:
                decode_float(working_mix, mix_wav, canonical=True, length=info.frames,
                             allow_aac_alignment=parent.format == "m4a", **process_options)
            raw_paths = [work / f"{part}.wav" for part in VOCAL_SUBSTEM_TYPES]
            device = run_vocal_refinement(
                mix_wav, parent_wav, raw_paths, checkpoint, config, device=settings.stem_device,
                on_runtime_event=on_runtime_event, **process_options,
            )
            if on_runtime_event:
                on_runtime_event(JobRuntimeEvent(stage="writing", stage_label="Encoding refined vocals.", progress=80))
            publish = work / "publish"
            gain = encode_vocal_parts(
                raw_paths, publish, output_format, expected_frames=info.frames, expected_channels=info.channels,
                expected_sample_rate=info.samplerate, **process_options,
            )
            if on_runtime_event:
                on_runtime_event(JobRuntimeEvent(stage="finalizing", stage_label="Saving refined vocals.", progress=95))
            check_cancel(should_cancel)
            lock_vocal_artifact_rows(session, project.id, (parent.id, source.id))
            parent, source = _snapshot_inputs(session, project.id, payload)
            old_children = vocal_parts_for_parent(session, parent)
            common = {
                "source_artifact_id": source.id,
                "source_artifact_type": source.type,
                "generation_id": generation,
                "generation_parent_sha256": parent.content_sha256,
                "generation_source_sha256": source.content_sha256,
                "checkpoint_model": MEGA53_MODEL,
                "checkpoint_revision": MEGA53_REVISION,
                "checkpoint_sha256": MEGA53_SHA256,
                "config_sha256": MEGA53_CONFIG_SHA256,
                "engine_revision": MEGA53_ENGINE_REVISION,
                "device": device,
                "applied_gain": gain,
            }
            final.parent.mkdir(parents=True, exist_ok=True)
            publish.replace(final)
            installed = True
            children = {
                part: register_artifact(
                    session, project_id=project.id, artifact_type=artifact_type,
                    artifact_format=output_format, path=final / f"{part}.{output_format}",
                    generated_by=MEGA53_MODEL, can_delete=True, can_regenerate=True,
                    metadata={**common, "parent_artifact_id": parent.id, "vocal_part": part},
                )
                for part, artifact_type in VOCAL_SUBSTEM_TYPES.items()
            }
            parent.metadata_json = {**parent.metadata_json, VOCAL_MEMBERSHIP: {
                **common, "parent_sha256": parent.content_sha256, "source_sha256": source.content_sha256,
                "format": output_format, "expected_parts": list(VOCAL_SUBSTEM_TYPES), "excluded_parts": [],
                "child_artifact_ids": {part: child.id for part, child in children.items()},
                "child_sha256": {part: child.content_sha256 for part, child in children.items()},
            }}
            for child in old_children:
                record_artifact_delete_tombstone(session, child)
                session.delete(child)
            queue_project_storage_reconciliation(session, project.id)
            session.flush()
            check_cancel(should_cancel)
            return VocalGeneration(list(children.values()), device, final)
    except Exception:
        if installed:
            shutil.rmtree(final, ignore_errors=True)
        raise
