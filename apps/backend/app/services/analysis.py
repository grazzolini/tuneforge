from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, datetime
from math import isfinite
from pathlib import Path
from typing import Any, Literal, cast

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.analysis import AnalysisPayload, analyze_track
from app.engines.beat_this import BeatThisRuntimeError, analyze_track_with_beat_this, beat_this_dependency_status
from app.errors import AppError
from app.models import AnalysisResult, Artifact, Project
from app.services.artifacts import refresh_artifact_file_metadata, register_artifact
from app.services.paths import project_analysis_dir

TimingCorrectionAction = Literal["set_bar_1_beat_1", "shift_left", "shift_right", "set_meter"]
SUPPORTED_TIMING_BEATS_PER_BAR = frozenset({3, 4, 6})
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
    results = _analyze_track_with_backend(
        Path(project.imported_path),
        source_stem_paths=tuple(Path(artifact.path) for artifact in source_stem_artifacts),
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


def correct_analysis_timing(
    session: Session,
    *,
    project: Project,
    action: TimingCorrectionAction,
    playhead_seconds: float | None = None,
    beats_per_bar: int | None = None,
) -> AnalysisResult:
    analysis = session.get(AnalysisResult, project.id)
    if analysis is None or analysis.timing_json is None:
        raise AppError(
            "ANALYSIS_TIMING_NOT_FOUND",
            "Analysis timing has not been generated for this project.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    timing = _normalize_timing_payload(analysis.timing_json)
    if not timing["beats"]:
        raise AppError(
            "ANALYSIS_TIMING_NOT_FOUND",
            "Analysis timing has no beats to correct.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    meter = timing["beats_per_bar"]
    anchor_index = _timing_anchor_index(
        timing,
        prefer_pickup_phase=action in {"shift_left", "shift_right"},
    )
    if action == "set_bar_1_beat_1":
        if playhead_seconds is None:
            raise AppError("INVALID_REQUEST", "playhead_seconds is required for this timing correction.")
        anchor_index = _nearest_beat_index(timing["beats"], playhead_seconds)
    elif action == "shift_left":
        anchor_index -= 1
    elif action == "shift_right":
        anchor_index += 1
    elif action == "set_meter":
        if beats_per_bar is None:
            raise AppError("INVALID_REQUEST", "beats_per_bar is required for this timing correction.")
        if beats_per_bar not in SUPPORTED_TIMING_BEATS_PER_BAR:
            raise AppError("INVALID_REQUEST", "beats_per_bar must be one of 3, 4, or 6.")
        meter = beats_per_bar

    analysis.timing_json = _retime_grid(
        timing,
        beats_per_bar=meter,
        anchor_index=anchor_index,
        duration_seconds=project.duration_seconds,
    )
    session.flush()
    source_artifact = _analysis_source_artifact(session, project, analysis)
    _write_analysis_artifact(
        session,
        project=project,
        analysis=analysis,
        analysis_backend=None,
        source_artifact=source_artifact,
        source_stem_artifacts=None,
    )
    session.refresh(analysis)
    return analysis


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


def _analysis_source_artifact(
    session: Session,
    project: Project,
    analysis: AnalysisResult,
) -> Artifact | None:
    if analysis.source_artifact_id is not None:
        source_artifact = session.get(Artifact, analysis.source_artifact_id)
        if source_artifact is not None and source_artifact.project_id == project.id:
            return source_artifact
    return _project_source_artifact(project)


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


def _normalize_timing_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    meter = _supported_beats_per_bar(payload.get("beats_per_bar"), fallback=4)
    beats = [
        normalized
        for beat in payload.get("beats", [])
        if isinstance(beat, Mapping) and (normalized := _normalize_timing_beat(beat)) is not None
    ]
    bars = [
        normalized
        for bar in payload.get("bars", [])
        if isinstance(bar, Mapping) and (normalized := _normalize_timing_bar(bar)) is not None
    ]
    beats.sort(key=lambda beat: (beat["index"], beat["seconds"]))
    bars.sort(key=lambda bar: (bar["start_seconds"], bar["index"]))
    return {
        "beats_per_bar": meter,
        "source": str(payload.get("source") or "detected"),
        "meter": _optional_str(payload.get("meter")) or _meter_label(meter),
        "meter_confidence": _optional_float(payload.get("meter_confidence")),
        "downbeat_source": _optional_str(payload.get("downbeat_source")),
        "downbeat_confidence": _optional_float(payload.get("downbeat_confidence")),
        "beats": beats,
        "bars": bars,
    }


def _normalize_timing_beat(beat: Mapping[str, Any]) -> dict[str, int | float] | None:
    index = _optional_int(beat.get("index"))
    seconds = _optional_float(beat.get("seconds"))
    bar_index = _optional_int(beat.get("bar_index"))
    beat_in_bar = _optional_int(beat.get("beat_in_bar"))
    if index is None or seconds is None or bar_index is None or beat_in_bar is None:
        return None
    return {
        "index": index,
        "seconds": max(0.0, seconds),
        "bar_index": bar_index,
        "beat_in_bar": max(1, beat_in_bar),
    }


def _normalize_timing_bar(bar: Mapping[str, Any]) -> dict[str, int | float] | None:
    index = _optional_int(bar.get("index"))
    start_seconds = _optional_float(bar.get("start_seconds"))
    end_seconds = _optional_float(bar.get("end_seconds"))
    if index is None or start_seconds is None or end_seconds is None:
        return None
    return {
        "index": index,
        "start_seconds": max(0.0, start_seconds),
        "end_seconds": max(0.0, end_seconds),
    }


def _timing_anchor_index(timing: Mapping[str, Any], *, prefer_pickup_phase: bool = False) -> int:
    meter = cast(int, timing["beats_per_bar"])
    beats = cast(list[dict[str, int | float]], timing["beats"])
    first_beat = beats[0]
    if (
        prefer_pickup_phase
        and int(first_beat["bar_index"]) == 0
        and int(first_beat["beat_in_bar"]) > 1
    ):
        return int(first_beat["index"]) - int(first_beat["beat_in_bar"]) + 1
    for beat in beats:
        if int(beat["bar_index"]) > 0 and int(beat["beat_in_bar"]) == 1:
            return int(beat["index"]) - ((int(beat["bar_index"]) - 1) * meter)
    for beat in beats:
        if int(beat["bar_index"]) == 0 and int(beat["beat_in_bar"]) == 1:
            return int(beat["index"])
    return int(first_beat["index"]) - int(first_beat["beat_in_bar"]) + 1


def _nearest_beat_index(beats: list[dict[str, int | float]], playhead_seconds: float) -> int:
    return int(min(beats, key=lambda beat: abs(float(beat["seconds"]) - playhead_seconds))["index"])


def _retime_grid(
    timing: Mapping[str, Any],
    *,
    beats_per_bar: int,
    anchor_index: int,
    duration_seconds: float | None,
) -> dict[str, Any]:
    beats = []
    timing_beats = cast(list[dict[str, int | float]], timing["beats"])
    first_beat_index = int(timing_beats[0]["index"])
    first_visible_downbeat_index = _first_visible_downbeat_index(
        anchor_index=anchor_index,
        first_beat_index=first_beat_index,
        beats_per_bar=beats_per_bar,
    )
    for beat in timing_beats:
        beat_index = int(beat["index"])
        relative_position = beat_index - anchor_index
        beats.append(
            {
                "index": beat_index,
                "seconds": float(beat["seconds"]),
                "bar_index": _retimed_beat_bar_index(
                    beat_index,
                    first_visible_downbeat_index=first_visible_downbeat_index,
                    beats_per_bar=beats_per_bar,
                ),
                "beat_in_bar": (relative_position % beats_per_bar) + 1,
            }
        )
    return {
        "beats_per_bar": beats_per_bar,
        "source": "user_corrected",
        "meter": _meter_label(beats_per_bar),
        "meter_confidence": 1.0,
        "downbeat_source": "user",
        "downbeat_confidence": 1.0,
        "beats": beats,
        "bars": _retimed_bars(beats, _timing_duration_seconds(timing, beats, duration_seconds)),
    }


def _retimed_bars(beats: list[dict[str, int | float]], duration_seconds: float) -> list[dict[str, int | float]]:
    beats_by_bar: dict[int, list[dict[str, int | float]]] = defaultdict(list)
    for beat in beats:
        beats_by_bar[int(beat["bar_index"])].append(beat)

    bars: list[dict[str, int | float]] = []
    sorted_bar_indices = sorted(beats_by_bar)
    for position, bar_index in enumerate(sorted_bar_indices):
        bar_beats = sorted(beats_by_bar[bar_index], key=lambda beat: float(beat["seconds"]))
        start_seconds = float(bar_beats[0]["seconds"])
        if position + 1 < len(sorted_bar_indices):
            next_bar_beats = sorted(
                beats_by_bar[sorted_bar_indices[position + 1]],
                key=lambda beat: float(beat["seconds"]),
            )
            end_seconds = float(next_bar_beats[0]["seconds"])
        else:
            end_seconds = max(duration_seconds, start_seconds)
        if end_seconds <= start_seconds:
            continue
        bars.append(
            {
                "index": bar_index,
                "start_seconds": round(start_seconds, 6),
                "end_seconds": round(end_seconds, 6),
            }
        )
    return bars


def _retimed_beat_bar_index(
    beat_index: int,
    *,
    first_visible_downbeat_index: int,
    beats_per_bar: int,
) -> int:
    if beat_index < first_visible_downbeat_index:
        return 0
    return 1 + ((beat_index - first_visible_downbeat_index) // beats_per_bar)


def _first_visible_downbeat_index(
    *,
    anchor_index: int,
    first_beat_index: int,
    beats_per_bar: int,
) -> int:
    if anchor_index >= first_beat_index:
        return anchor_index
    beats_after_anchor = (first_beat_index - anchor_index) % beats_per_bar
    if beats_after_anchor == 0:
        return first_beat_index
    return first_beat_index + beats_per_bar - beats_after_anchor


def _timing_duration_seconds(
    timing: Mapping[str, Any],
    beats: list[dict[str, int | float]],
    duration_seconds: float | None,
) -> float:
    if duration_seconds is not None and isfinite(duration_seconds) and duration_seconds > 0.0:
        return duration_seconds
    bar_end_seconds = [
        float(bar["end_seconds"])
        for bar in cast(list[dict[str, int | float]], timing.get("bars", []))
        if float(bar["end_seconds"]) > 0.0
    ]
    if bar_end_seconds:
        return max(bar_end_seconds)
    return max(float(beat["seconds"]) for beat in beats)


def _supported_beats_per_bar(value: object, *, fallback: int) -> int:
    parsed = _optional_int(value)
    return parsed if parsed in SUPPORTED_TIMING_BEATS_PER_BAR else fallback


def _meter_label(beats_per_bar: int) -> str:
    if beats_per_bar == 6:
        return "6/8"
    return f"{beats_per_bar}/4"


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and isfinite(value):
        return int(value)
    return None


def _optional_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float) and isfinite(value):
        return float(value)
    return None


def _optional_str(value: object) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None
