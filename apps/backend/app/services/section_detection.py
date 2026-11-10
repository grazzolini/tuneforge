from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import stat
import tempfile
from collections.abc import Callable, Iterator
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from pathlib import Path
from subprocess import Popen
from typing import Any

import soundfile as sf
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.section_detection import MAX_DURATION_SECONDS, MODEL_REVISION, detect_sections
from app.errors import AppError, JobCancelledError
from app.models import (
    AnalysisResult,
    Artifact,
    ChordTimeline,
    Job,
    LyricsTranscript,
    Project,
    SectionAnalysisResult,
    utcnow,
)
from app.runtime_status import JobRuntimeEvent
from app.services.audio_working import materialize_pcm_wav
from app.services.metadata import extract_audio_metadata
from app.services.paths import project_root, project_stems_dir
from app.services.stem_models import DEFAULT_STEM_MODEL_ID, SIX_STEM_SOURCES, model_output_artifact_type
from app.services.stems import resolve_stem_source_artifact
from app.utils.model_cache import sha256_file


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def section_inputs(session: Session, project: Project, *, hash_files: bool = True) -> dict[str, Any]:
    if get_settings().runtime_platform in {"android", "ios", "mobile"}:
        raise AppError("SECTIONS_UNAVAILABLE", "Section detection is available on desktop only.", status_code=409)
    source = resolve_stem_source_artifact(session, project=project, source_artifact_id=None)
    artifacts = list(session.scalars(select(Artifact).where(Artifact.project_id == project.id)))
    stems: dict[str, Artifact] = {}
    for name in SIX_STEM_SOURCES:
        matches = [
            a
            for a in artifacts
            if a.type == model_output_artifact_type(name)
            and a.metadata_json.get("stem_model") == DEFAULT_STEM_MODEL_ID
            and a.metadata_json.get("source_artifact_id") == source.id
        ]
        if len(matches) != 1:
            raise AppError(
                "SECTION_STEMS_REQUIRED",
                "Section detection requires a complete six-stem set from this source.",
                status_code=409,
            )
        stems[name] = matches[0]
    root = project_stems_dir(project.id)
    parents = {Path(a.path).resolve().parent for a in stems.values()}
    if len(parents) != 1 or any(not Path(a.path).resolve().is_relative_to(root) for a in stems.values()):
        raise AppError("SECTION_STEMS_MISMATCH", "Section stems do not share a valid generation.", status_code=409)
    for job in session.scalars(
        select(Job).where(Job.project_id == project.id, Job.type == "stems", Job.status.in_(("pending", "running")))
    ):
        if job.payload_json.get("source_artifact_id") in {None, source.id}:
            raise AppError(
                "SECTION_STEMS_BUSY", "Wait for stem generation to finish before detecting sections.", status_code=409
            )
    files: dict[str, Any] = {}
    for name, artifact in {"source": source, **stems}.items():
        path = Path(artifact.path)
        info = _owned_regular(path, project_root(project.id) if name == "source" else root)
        digest = sha256_file(path) if hash_files else None
        if digest and artifact.content_sha256 and digest != artifact.content_sha256:
            raise AppError(
                "SECTION_INPUT_CHANGED", "Section input no longer matches its recorded content.", status_code=409
            )
        files[name] = {
            "id": artifact.id,
            "path": str(path),
            "metadata": artifact.metadata_json,
            "size": info.st_size,
            "mtime_ns": info.st_mtime_ns,
            "sha256": digest,
        }
    return {"source_artifact_id": source.id, "files": files}


def _owned_regular(path: Path, root: Path) -> os.stat_result:
    try:
        if ".." in path.parts:
            raise ValueError("parent traversal")
        relative = path.absolute().relative_to(root.absolute())
        current = root
        for component in relative.parts:
            if current.is_symlink():
                raise ValueError("symlink")
            current = current / component
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 512 * 1024 * 1024:
            raise ValueError("not a bounded regular file")
        return info
    except (OSError, ValueError) as exc:
        raise AppError(
            "SECTION_INPUT_UNREADABLE",
            "Section inputs must be bounded regular files inside this project.",
            status_code=409,
        ) from exc


@contextmanager
def _working_inputs(
    inputs: dict[str, Any],
    *,
    should_cancel: Callable[[], bool] | None,
    register_process: Callable[[Popen[str]], None] | None,
    unregister_process: Callable[[], None] | None,
) -> Iterator[tuple[dict[str, str], int]]:
    def cancelled() -> None:
        if should_cancel and should_cancel():
            raise JobCancelledError()

    # Probe dimensions before any whole-file decode/allocation. Ordinary Demucs output
    # is 44.1 kHz mono/stereo; unsupported profiles fail without touching the model cache.
    materialized_bytes = 0
    decode_limits: dict[str, dict[str, int]] = {}
    for name, item in inputs["files"].items():
        cancelled()
        metadata = extract_audio_metadata(Path(item["path"]))
        duration, rate, channels = (metadata[k] for k in ("duration_seconds", "sample_rate", "channels"))
        if (
            duration is None
            or not math.isfinite(duration)
            or duration <= 0
            or duration > MAX_DURATION_SECONDS + 0.1
            or channels not in {1, 2}
            or not isinstance(rate, int)
            or rate <= 0
            or (rate > 192000 if name == "source" else rate != 44100)
            or duration * rate * channels * 4 > 512 * 1024 * 1024
        ):
            raise AppError(
                "SECTION_INPUT_PROFILE_UNSUPPORTED",
                "Section detection requires tracks up to 926 seconds and 44.1 kHz mono/stereo stems.",
                status_code=409,
            )
        padding = {"m4a": 1024, "mp3": 1152}.get(Path(item["path"]).suffix[1:].lower(), 0)
        decode_limits[name] = {
            "frame_limit": math.ceil(duration * rate) + padding + 1,
            "expected_sample_rate": rate,
            "expected_channels": channels,
        }
        if Path(item["path"]).suffix.lower() != ".wav":
            materialized_bytes += (decode_limits[name]["frame_limit"] + 2) * channels * 2 + 1024 * 1024
    scratch_bytes = materialized_bytes
    if shutil.disk_usage(tempfile.gettempdir()).free < scratch_bytes + 16 * 1024 * 1024:
        raise AppError(
            "SECTION_DISK_SPACE_REQUIRED", "Not enough temporary disk space for section decoding.", status_code=409
        )
    with ExitStack() as stack:
        paths = {}
        for name, item in inputs["files"].items():
            cancelled()
            paths[name] = stack.enter_context(
                materialize_pcm_wav(
                    Path(item["path"]),
                    should_cancel=should_cancel,
                    register_process=register_process,
                    unregister_process=unregister_process,
                    **decode_limits[name],
                )
            )
        clocks = {name: sf.info(path) for name, path in paths.items()}
        stem_clocks = {
            (clocks[name].samplerate, clocks[name].frames, clocks[name].channels) for name in SIX_STEM_SOURCES
        }
        if len(stem_clocks) != 1:
            raise AppError(
                "SECTION_STEMS_MISMATCH", "Decoded section stem sample clocks do not match.", status_code=409
            )
        rate, frames, channels = next(iter(stem_clocks))
        source = clocks["source"]
        target = round(source.frames / source.samplerate * rate)
        padding = max(
            {"m4a": 1024, "mp3": 1152}.get(Path(inputs["files"][name]["path"]).suffix[1:].lower(), 1)
            for name in SIX_STEM_SOURCES
        )
        if (
            rate != 44100
            or channels not in {1, 2}
            or source.duration > MAX_DURATION_SECONDS
            or abs(frames - target) > padding
            or frames < target - 1
        ):
            raise AppError(
                "SECTION_STEMS_MISMATCH", "Decoded section stems do not match the source sample clock.", status_code=409
            )
        cancelled()
        yield {name: str(paths[name]) for name in SIX_STEM_SOURCES}, min(frames, target)


def _identity(inputs: dict[str, Any]) -> str:
    return _digest(
        {
            "source_artifact_id": inputs["source_artifact_id"],
            "files": {
                name: {key: value for key, value in item.items() if key != "sha256"}
                for name, item in inputs["files"].items()
            },
        }
    )


def _cues(session: Session, project_id: str, source_id: str) -> dict[str, Any]:
    analysis = session.get(AnalysisResult, project_id)
    chords = session.get(ChordTimeline, project_id)
    lyrics = session.get(LyricsTranscript, project_id)
    timing = analysis.timing_json or {} if analysis and analysis.source_artifact_id == source_id else {}
    related_ids = {
        source_id,
        *(
            a.id
            for a in session.scalars(select(Artifact).where(Artifact.project_id == project_id))
            if a.metadata_json.get("source_artifact_id") == source_id
        ),
    }
    chord_segments = chords.segments_json if chords and chords.source_artifact_id in related_ids | {None} else []
    lyric_segments = lyrics.segments_json if lyrics and lyrics.source_artifact_id in related_ids | {None} else []

    def identity(row: Any, fields: tuple[str, ...]) -> dict[str, Any] | None:
        if row is None:
            return None
        return {key: getattr(row, key) for key in fields}

    return {
        "beats": [float(b["seconds"]) for b in timing.get("beats", [])],
        "bars": [float(b["start_seconds"]) for b in timing.get("bars", [])],
        "chords": [[float(c["start_seconds"]), float(c["end_seconds"]), c["label"]] for c in chord_segments],
        "lyrics": lyric_segments,
        "identities": {
            "analysis": identity(analysis, ("source_artifact_id", "analysis_version", "timing_json", "metadata_json")),
            "chords": identity(
                chords,
                (
                    "source_artifact_id",
                    "source_kind",
                    "backend",
                    "has_user_edits",
                    "source_segments_json",
                    "segments_json",
                    "timeline_json",
                    "metadata_json",
                ),
            ),
            "lyrics": identity(
                lyrics,
                (
                    "source_artifact_id",
                    "source_kind",
                    "backend",
                    "has_user_edits",
                    "source_segments_json",
                    "segments_json",
                    "language_override",
                ),
            ),
        },
    }


def generate_section_analysis(
    session: Session,
    project: Project,
    *,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
    on_runtime_event: Callable[[JobRuntimeEvent], None] | None = None,
) -> SectionAnalysisResult:
    def cancelled() -> None:
        if should_cancel and should_cancel():
            raise JobCancelledError()

    inputs = section_inputs(session, project)
    cues = _cues(session, project.id, inputs["source_artifact_id"])
    cue_fingerprint = _digest(cues)
    project_id = project.id
    # Release the read transaction before model loading/download/compute.
    session.commit()
    cancelled()
    with _working_inputs(
        inputs,
        should_cancel=should_cancel,
        register_process=register_process,
        unregister_process=unregister_process,
    ) as (working_paths, verified_frames):
        prediction = detect_sections(
            working_paths,
            cues=cues,
            frames=verified_frames,
            should_cancel=should_cancel,
            register_process=register_process,
            unregister_process=unregister_process,
            on_runtime_event=on_runtime_event,
        )
    cancelled()
    raw_sections = _validated_sections(prediction["raw_sections"])
    refined_sections = _validated_sections(prediction["refined_sections"])
    del prediction
    # Hash outside the brief final write lock. Then validate DB identities, clocks,
    # stat revisions and cue content under the lock before publishing one replacement.
    session.expire_all()
    current = session.get(Project, project_id)
    if current is None or current.sync_status != "local" or section_inputs(session, current) != inputs:
        raise AppError("SECTION_INPUT_CHANGED", "Section inputs changed; retry detection.", status_code=409)
    session.commit()
    session.execute(text("BEGIN IMMEDIATE"))
    session.expire_all()
    current = session.get(Project, project_id)
    if (
        current is None
        or current.sync_status != "local"
        or _identity(section_inputs(session, current, hash_files=False)) != _identity(inputs)
        or _digest(_cues(session, project_id, inputs["source_artifact_id"])) != cue_fingerprint
    ):
        raise AppError("SECTION_INPUT_CHANGED", "Section inputs or cues changed; retry detection.", status_code=409)
    cancelled()
    row = session.get(SectionAnalysisResult, project_id)
    if row is None:
        row = SectionAnalysisResult(project_id=project_id)
        session.add(row)
    row.model_revision = MODEL_REVISION
    row.raw_sections_json, row.refined_sections_json = raw_sections, refined_sections
    row.source_artifact_id = inputs["source_artifact_id"]
    row.sections_json = deepcopy(refined_sections)
    row.source_kind = "generated"
    row.has_user_edits = False
    row.updated_at = utcnow()
    session.flush()
    return row


def _validated_sections(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    previous = 0.0
    compact = []
    for segment in segments:
        start, end = float(segment["start_seconds"]), float(segment["end_seconds"])
        label = segment["label"]
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < previous
            or end <= start
            or not isinstance(label, str)
            or not label
        ):
            raise AppError("SECTION_DETECTION_FAILED", "Section model returned an invalid timeline.")
        previous = end
        compact.append({"start_seconds": start, "end_seconds": end, "label": label})
    if not compact:
        raise AppError("SECTION_DETECTION_FAILED", "Section model returned no named segments.")
    return compact
