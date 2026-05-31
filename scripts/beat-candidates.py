from __future__ import annotations

import argparse
import importlib
import json
import math
import os
import sqlite3
import sys
import tempfile
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.request import pathname2url

BACKEND_ROOT = Path(__file__).resolve().parents[1] / "apps" / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

beat_this_engine = importlib.import_module("app.engines.beat_this")

SOURCE_INPUT = "source"
STEM_INPUTS = ("drums", "bass")
SOURCE_STEM_TYPES = {"drums": "drums_stem", "bass": "bass_stem"}
MIN_STABLE_BEAT_COUNT = 4
MAX_STABLE_INTERVAL_CV = 0.12
MIN_STABLE_TIMING_CONFIDENCE = 0.5
MATERIAL_INTERVAL_CV_ABSOLUTE_IMPROVEMENT = 0.05
MATERIAL_INTERVAL_CV_RELATIVE_FACTOR = 0.8
TIMING_ALIGNMENT_TOLERANCE_BEAT_FRACTION = 0.22
MIN_TIMING_ALIGNMENT_TOLERANCE_SECONDS = 0.06
MAX_TIMING_ALIGNMENT_TOLERANCE_SECONDS = 0.16
MIN_BEAT_ALIGNMENT_MATCH_RATIO = 0.6
MIN_DOWNBEAT_ALIGNMENT_MATCH_RATIO = 0.5


@dataclass(frozen=True)
class ProjectInfo:
    project_id: str
    display_name: str
    imported_path: Path
    duration_seconds: float | None


@dataclass(frozen=True)
class ArtifactRow:
    artifact_id: str
    project_id: str
    artifact_type: str
    path: Path
    metadata: dict[str, Any]
    created_at: str


@dataclass(frozen=True)
class Candidate:
    input_id: str
    path: Path | None
    artifact_id: str | None
    metadata: dict[str, Any]


@dataclass(frozen=True)
class TimingQuality:
    usable: bool
    valid_bars: bool
    beat_count: int
    positive_intervals: bool
    interval_cv: float | None
    meter_confidence: float
    downbeat_confidence: float


@dataclass(frozen=True)
class CandidateResult:
    candidate: Candidate
    status: str
    error: str | None
    elapsed_seconds: float | None
    timing: Mapping[str, Any] | None
    quality: TimingQuality


class DiagnosticError(Exception):
    pass


def main() -> int:
    start_time = time.perf_counter()
    parser = build_parser()
    args = parser.parse_args()

    try:
        data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else default_data_dir()
        output_dir = Path(args.output_dir).expanduser().resolve()
        if is_relative_to(output_dir, data_dir):
            raise DiagnosticError(f"Output dir must be outside the TuneForge data dir: {output_dir}")
        if not data_dir.is_dir():
            raise DiagnosticError(f"Data dir not found: {data_dir}")
        database_path = data_dir / "app.sqlite"
        if not database_path.is_file():
            raise DiagnosticError(f"Database not found: {database_path}")

        available, reason = beat_this_engine.beat_this_dependency_status()
        if not available:
            raise DiagnosticError(reason or "Advanced Beat Analysis dependency is unavailable.")

        projects = load_projects(database_path, data_dir, args.project_id)
        if not projects:
            raise DiagnosticError("No projects found.")
        artifacts = load_artifacts(database_path, data_dir, [project.project_id for project in projects])
        output_dir.mkdir(parents=True, exist_ok=True)

        project_reports = [
            analyze_project_candidates(project, artifacts.get(project.project_id, ()))
            for project in projects
        ]
        summary: dict[str, Any] = {
            "data_dir": str(data_dir),
            "database_path": str(database_path),
            "output_dir": str(output_dir),
            "product_behavior": "advanced beat analysis uses source audio only",
            "project_count": len(project_reports),
            "projects": project_reports,
            "elapsed_seconds": round(time.perf_counter() - start_time, 3),
        }

        report_text = render_text_report(summary)
        report_path = output_dir / "beat-candidates.txt"
        json_path = output_dir / "beat-candidates.json"
        validate_output_path(report_path, data_dir)
        validate_output_path(json_path, data_dir)
        write_output_file(report_path, report_text)
        write_output_file(json_path, json.dumps(summary, indent=2, sort_keys=True))
        print(report_text)
        return 0
    except DiagnosticError as error:
        print(f"beat-candidates: {error}", file=sys.stderr)
        return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run read-only beat-this diagnostics for TuneForge source/drums/bass candidates.",
    )
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, default=Path("beat-candidates"))
    parser.add_argument("--project-id", action="append", default=[])
    return parser


def default_data_dir() -> Path:
    override = os.environ.get("TUNEFORGE_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Tuneforge"
    return home / ".local" / "share" / "tuneforge"


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def validate_output_path(path: Path, data_dir: Path) -> None:
    try:
        resolved = path.resolve(strict=False)
    except RuntimeError as error:
        raise DiagnosticError(f"Output path cannot be resolved safely: {path}") from error
    if is_relative_to(resolved, data_dir):
        raise DiagnosticError(f"Output path must not target the TuneForge data dir: {path} -> {resolved}")


def write_output_file(path: Path, content: str) -> None:
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_file.write(content)
            temp_path = Path(temp_file.name)
        temp_path.replace(path)
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()


def load_projects(database_path: Path, data_dir: Path, project_ids: Sequence[str]) -> list[ProjectInfo]:
    uri = f"file:{pathname2url(str(database_path))}?mode=ro"
    try:
        with sqlite3.connect(uri, uri=True) as connection:
            rows = connection.execute(
                """
                SELECT id, display_name, imported_path, duration_seconds
                FROM projects
                ORDER BY display_name, id
                """
            ).fetchall()
    except sqlite3.Error as error:
        raise DiagnosticError(f"Could not read projects in read-only mode: {error}") from error

    selected_ids: set[str] = set()
    for raw_project_id in project_ids:
        project_id = raw_project_id.strip()
        if not project_id:
            raise DiagnosticError("--project-id cannot be empty.")
        selected_ids.add(project_id)

    projects: list[ProjectInfo] = []
    for project_id, display_name, imported_path, duration_seconds in rows:
        normalized_id = str(project_id)
        if selected_ids and normalized_id not in selected_ids:
            continue
        projects.append(
            ProjectInfo(
                project_id=normalized_id,
                display_name=str(display_name),
                imported_path=resolve_data_path(data_dir, str(imported_path)),
                duration_seconds=optional_float(duration_seconds),
            )
        )
    if selected_ids and not projects:
        raise DiagnosticError("No projects matched selected --project-id values.")
    return projects


def load_artifacts(
    database_path: Path,
    data_dir: Path,
    project_ids: Sequence[str],
) -> dict[str, tuple[ArtifactRow, ...]]:
    if not project_ids:
        return {}
    placeholders = ",".join("?" for _ in project_ids)
    uri = f"file:{pathname2url(str(database_path))}?mode=ro"
    try:
        with sqlite3.connect(uri, uri=True) as connection:
            rows = connection.execute(
                f"""
                SELECT id, project_id, type, path, metadata_json, created_at
                FROM artifacts
                WHERE project_id IN ({placeholders})
                  AND type IN ('source_audio', 'drums_stem', 'bass_stem')
                ORDER BY project_id, type, created_at, id
                """,
                tuple(project_ids),
            ).fetchall()
    except sqlite3.Error as error:
        raise DiagnosticError(f"Could not read artifacts in read-only mode: {error}") from error

    artifacts: dict[str, list[ArtifactRow]] = {}
    for artifact_id, project_id, artifact_type, path, metadata_json, created_at in rows:
        row = ArtifactRow(
            artifact_id=str(artifact_id),
            project_id=str(project_id),
            artifact_type=str(artifact_type),
            path=resolve_data_path(data_dir, str(path)),
            metadata=parse_metadata(metadata_json),
            created_at=str(created_at),
        )
        artifacts.setdefault(row.project_id, []).append(row)
    return {project_id: tuple(rows) for project_id, rows in artifacts.items()}


def analyze_project_candidates(project: ProjectInfo, artifacts: Sequence[ArtifactRow]) -> dict[str, Any]:
    candidates = project_candidates(project, artifacts)
    results = [run_candidate(candidate, duration_seconds=project.duration_seconds) for candidate in candidates]
    source_result = results[0]
    candidate_reports = [candidate_report(result, source_result) for result in results]
    return {
        "project_id": project.project_id,
        "display_name": project.display_name,
        "duration_seconds": project.duration_seconds,
        "product_behavior": "source",
        "candidates": candidate_reports,
    }


def project_candidates(project: ProjectInfo, artifacts: Sequence[ArtifactRow]) -> tuple[Candidate, ...]:
    latest_source = latest_artifact([artifact for artifact in artifacts if artifact.artifact_type == "source_audio"])
    source_candidate = Candidate(
        input_id=SOURCE_INPUT,
        path=project.imported_path,
        artifact_id=latest_source.artifact_id if latest_source is not None else None,
        metadata=latest_source.metadata if latest_source is not None else {},
    )
    source_artifact_id = latest_source.artifact_id if latest_source is not None else None

    stem_candidates: list[Candidate] = []
    for input_id in STEM_INPUTS:
        artifact = latest_source_stem_artifact(
            artifacts,
            artifact_type=SOURCE_STEM_TYPES[input_id],
            source_artifact_id=source_artifact_id,
        )
        stem_candidates.append(
            Candidate(
                input_id=input_id,
                path=artifact.path if artifact is not None else None,
                artifact_id=artifact.artifact_id if artifact is not None else None,
                metadata=artifact.metadata if artifact is not None else {},
            )
        )
    return (source_candidate, *stem_candidates)


def latest_source_stem_artifact(
    artifacts: Sequence[ArtifactRow],
    *,
    artifact_type: str,
    source_artifact_id: str | None,
) -> ArtifactRow | None:
    if source_artifact_id is None:
        return None
    matches = [
        artifact
        for artifact in artifacts
        if artifact.artifact_type == artifact_type
        and artifact.metadata.get("source_artifact_id") == source_artifact_id
        and artifact.metadata.get("source_artifact_type") in {None, "source_audio"}
    ]
    return latest_artifact(matches)


def latest_artifact(artifacts: Sequence[ArtifactRow]) -> ArtifactRow | None:
    return max(artifacts, key=lambda artifact: (artifact.created_at, artifact.artifact_id), default=None)


def run_candidate(candidate: Candidate, *, duration_seconds: float | None) -> CandidateResult:
    if candidate.path is None:
        return failed_candidate(candidate, "missing_artifact", "No source-track artifact found.")
    if not candidate.path.is_file():
        return failed_candidate(candidate, "missing_file", f"File not found: {candidate.path}")

    start_time = time.perf_counter()
    try:
        timing = beat_this_engine.detect_beat_this_timing(candidate.path, duration_seconds=duration_seconds)
    except beat_this_engine.BeatThisRuntimeError as error:
        elapsed = round(time.perf_counter() - start_time, 3)
        return CandidateResult(candidate, "run_failed", str(error), elapsed, None, empty_quality())
    except Exception as error:  # pragma: no cover - defensive CLI boundary
        elapsed = round(time.perf_counter() - start_time, 3)
        return CandidateResult(candidate, "run_failed", str(error), elapsed, None, empty_quality())

    elapsed = round(time.perf_counter() - start_time, 3)
    if timing is None:
        return CandidateResult(
            candidate,
            "no_timing",
            "beat-this did not return a usable timing grid.",
            elapsed,
            None,
            empty_quality(),
        )
    return CandidateResult(candidate, "ok", None, elapsed, timing, timing_quality(timing))


def failed_candidate(candidate: Candidate, status: str, error: str) -> CandidateResult:
    return CandidateResult(candidate, status, error, None, None, empty_quality())


def candidate_report(result: CandidateResult, source_result: CandidateResult) -> dict[str, Any]:
    alignment = alignment_report(result.timing, source_result.timing)
    gate, outcome = diagnostic_gate(result, source_result, alignment)
    quality = result.quality
    return {
        "input": result.candidate.input_id,
        "artifact_id": result.candidate.artifact_id,
        "path": str(result.candidate.path) if result.candidate.path is not None else None,
        "status": result.status,
        "error": result.error,
        "elapsed_seconds": result.elapsed_seconds,
        "beat_count": quality.beat_count,
        "interval_cv": quality.interval_cv,
        "meter_confidence": quality.meter_confidence,
        "downbeat_confidence": quality.downbeat_confidence,
        "stem_signal_has_signal": stem_signal_has_signal(result.candidate.metadata),
        "alignment_vs_source": alignment,
        "diagnostic_gate": gate,
        "diagnostic_outcome": outcome,
    }


def diagnostic_gate(
    result: CandidateResult,
    source_result: CandidateResult,
    alignment: dict[str, Any] | None,
) -> tuple[str, str]:
    if result.candidate.input_id == SOURCE_INPUT:
        if result.status != "ok":
            return result.status, "product_source_unavailable"
        if is_stable_timing(result.quality):
            return "source_stable", "product_source"
        return "source_baseline", "product_source"

    if result.status != "ok":
        return result.status, "diagnostic_not_run"
    if source_result.status != "ok":
        return "source_unavailable", "diagnostic_inconclusive"
    if not result.quality.usable:
        return "unusable_timing", "diagnostic_rejected"
    if result.quality.beat_count < MIN_STABLE_BEAT_COUNT:
        return "too_few_beats", "diagnostic_rejected"
    if not has_material_interval_cv_improvement(result.quality, source_result.quality):
        return "no_material_interval_cv_improvement", "diagnostic_rejected"
    if not has_comparable_beat_count(result.quality, source_result.quality):
        return "beat_count_not_comparable", "diagnostic_rejected"
    if not has_comparable_timing_confidence(result.quality, source_result.quality):
        return "confidence_not_comparable", "diagnostic_rejected"
    if alignment is None or not alignment.get("aligned"):
        return "not_source_aligned", "diagnostic_rejected"
    return "diagnostic_candidate", "diagnostic_candidate_only"


def timing_quality(timing: Mapping[str, Any]) -> TimingQuality:
    beat_seconds = timing_beat_seconds(timing)
    intervals = [second - first for first, second in zip(beat_seconds, beat_seconds[1:], strict=False)]
    positive_intervals = bool(intervals and all(math.isfinite(value) and value > 0.0 for value in intervals))
    interval_cv = None
    if positive_intervals:
        mean_interval = sum(intervals) / len(intervals)
        if mean_interval > 0.0:
            variance = sum((value - mean_interval) ** 2 for value in intervals) / len(intervals)
            interval_cv = math.sqrt(variance) / mean_interval
    valid_bars = bool(timing.get("bars"))
    return TimingQuality(
        usable=valid_bars and len(beat_seconds) >= 2 and positive_intervals,
        valid_bars=valid_bars,
        beat_count=len(beat_seconds),
        positive_intervals=positive_intervals,
        interval_cv=interval_cv,
        meter_confidence=finite_confidence(timing.get("meter_confidence")),
        downbeat_confidence=finite_confidence(timing.get("downbeat_confidence")),
    )


def empty_quality() -> TimingQuality:
    return TimingQuality(
        usable=False,
        valid_bars=False,
        beat_count=0,
        positive_intervals=False,
        interval_cv=None,
        meter_confidence=0.0,
        downbeat_confidence=0.0,
    )


def is_stable_timing(quality: TimingQuality) -> bool:
    return (
        quality.usable
        and quality.valid_bars
        and quality.beat_count >= MIN_STABLE_BEAT_COUNT
        and quality.positive_intervals
        and quality.interval_cv is not None
        and quality.interval_cv <= MAX_STABLE_INTERVAL_CV
        and timing_confidence(quality) >= MIN_STABLE_TIMING_CONFIDENCE
    )


def has_material_interval_cv_improvement(candidate: TimingQuality, source: TimingQuality) -> bool:
    if candidate.interval_cv is None:
        return False
    if source.interval_cv is None:
        return True
    return (
        candidate.interval_cv + MATERIAL_INTERVAL_CV_ABSOLUTE_IMPROVEMENT <= source.interval_cv
        and candidate.interval_cv <= source.interval_cv * MATERIAL_INTERVAL_CV_RELATIVE_FACTOR
    )


def has_comparable_beat_count(candidate: TimingQuality, source: TimingQuality) -> bool:
    return candidate.beat_count >= max(MIN_STABLE_BEAT_COUNT, source.beat_count - 1)


def has_comparable_timing_confidence(candidate: TimingQuality, source: TimingQuality) -> bool:
    return timing_confidence(candidate) >= max(0.0, timing_confidence(source) - 0.25)


def timing_confidence(quality: TimingQuality) -> float:
    return max(quality.meter_confidence, quality.downbeat_confidence)


def alignment_report(
    candidate_timing: Mapping[str, Any] | None,
    source_timing: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if candidate_timing is None or source_timing is None:
        return None
    source_beats = timing_beat_seconds(source_timing)
    candidate_beats = timing_beat_seconds(candidate_timing)
    if source_beats == candidate_beats:
        return {
            "tolerance_seconds": 0.0,
            "beat_match_ratio": 1.0,
            "downbeat_match_ratio": 1.0,
            "aligned": True,
        }
    if not source_beats or not candidate_beats:
        return {
            "tolerance_seconds": None,
            "beat_match_ratio": 0.0,
            "downbeat_match_ratio": 0.0,
            "aligned": False,
        }

    tolerance = timing_alignment_tolerance_seconds(source_beats, candidate_beats)
    beat_match_ratio = min(
        nearest_alignment_match_ratio(source_beats, candidate_beats, tolerance),
        nearest_alignment_match_ratio(candidate_beats, source_beats, tolerance),
    )
    source_downbeats = timing_downbeat_seconds(source_timing)
    candidate_downbeats = timing_downbeat_seconds(candidate_timing)
    downbeat_match_ratio: float | None = None
    downbeats_aligned = True
    if len(source_downbeats) >= 2 and len(candidate_downbeats) >= 2:
        downbeat_match_ratio = min(
            nearest_alignment_match_ratio(source_downbeats, candidate_downbeats, tolerance),
            nearest_alignment_match_ratio(candidate_downbeats, source_downbeats, tolerance),
        )
        downbeats_aligned = downbeat_match_ratio >= MIN_DOWNBEAT_ALIGNMENT_MATCH_RATIO
    return {
        "tolerance_seconds": round(tolerance, 6),
        "beat_match_ratio": round(beat_match_ratio, 6),
        "downbeat_match_ratio": None if downbeat_match_ratio is None else round(downbeat_match_ratio, 6),
        "aligned": beat_match_ratio >= MIN_BEAT_ALIGNMENT_MATCH_RATIO and downbeats_aligned,
    }


def timing_alignment_tolerance_seconds(source_beats: Sequence[float], candidate_beats: Sequence[float]) -> float:
    interval_seconds = min(median_positive_interval(source_beats), median_positive_interval(candidate_beats))
    if interval_seconds <= 0.0:
        return MIN_TIMING_ALIGNMENT_TOLERANCE_SECONDS
    return min(
        MAX_TIMING_ALIGNMENT_TOLERANCE_SECONDS,
        max(MIN_TIMING_ALIGNMENT_TOLERANCE_SECONDS, interval_seconds * TIMING_ALIGNMENT_TOLERANCE_BEAT_FRACTION),
    )


def median_positive_interval(seconds: Sequence[float]) -> float:
    intervals = sorted(
        second - first
        for first, second in zip(seconds, seconds[1:], strict=False)
        if math.isfinite(second - first) and second - first > 0.0
    )
    if not intervals:
        return 0.0
    middle = len(intervals) // 2
    if len(intervals) % 2:
        return intervals[middle]
    return (intervals[middle - 1] + intervals[middle]) / 2.0


def nearest_alignment_match_ratio(reference: Sequence[float], candidate: Sequence[float], tolerance: float) -> float:
    if not reference or not candidate:
        return 0.0
    matches = 0
    for reference_seconds in reference:
        nearest_distance = min(abs(reference_seconds - candidate_seconds) for candidate_seconds in candidate)
        if nearest_distance <= tolerance:
            matches += 1
    return matches / len(reference)


def timing_beat_seconds(timing: Mapping[str, Any]) -> list[float]:
    beats = timing.get("beats")
    if not isinstance(beats, Sequence):
        return []
    seconds: list[float] = []
    for beat in beats:
        if isinstance(beat, Mapping):
            value = optional_float(beat.get("seconds"))
            if value is not None and value >= 0.0:
                seconds.append(value)
    return seconds


def timing_downbeat_seconds(timing: Mapping[str, Any]) -> list[float]:
    beats = timing.get("beats")
    if not isinstance(beats, Sequence):
        return []
    seconds: list[float] = []
    for beat in beats:
        if not isinstance(beat, Mapping):
            continue
        if beat.get("beat_in_bar") != 1:
            continue
        value = optional_float(beat.get("seconds"))
        if value is not None and value >= 0.0:
            seconds.append(value)
    return seconds


def finite_confidence(value: object) -> float:
    parsed = optional_float(value)
    if parsed is None:
        return 0.0
    return min(1.0, max(0.0, parsed))


def stem_signal_has_signal(metadata: Mapping[str, Any]) -> bool | None:
    stem_signal = metadata.get("stem_signal")
    if not isinstance(stem_signal, Mapping):
        return None
    value = stem_signal.get("has_signal")
    return value if isinstance(value, bool) else None


def resolve_data_path(data_dir: Path, raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = data_dir / path
    return path.resolve()


def parse_metadata(raw_metadata: object) -> dict[str, Any]:
    if raw_metadata is None:
        return {}
    if isinstance(raw_metadata, bytes):
        raw_metadata = raw_metadata.decode("utf-8", errors="replace")
    if not isinstance(raw_metadata, str):
        return {}
    try:
        parsed: object = json.loads(raw_metadata)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(key): value for key, value in parsed.items()}


def optional_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    return None


def render_text_report(summary: Mapping[str, Any]) -> str:
    lines = [
        "TuneForge beat candidate diagnostic",
        f"Data dir: {summary['data_dir']}",
        f"Output dir: {summary['output_dir']}",
        "Product behavior: Advanced Beat Analysis uses source audio only.",
        f"Projects: {summary['project_count']}",
        f"Elapsed: {summary['elapsed_seconds']}s",
        "",
    ]
    for project in summary["projects"]:
        lines.append(f"Project: {project['display_name']} ({project['project_id']})")
        for candidate in project["candidates"]:
            lines.append(render_candidate_line(candidate))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_candidate_line(candidate: Mapping[str, Any]) -> str:
    parts = [
        f"  {candidate['input']}:",
        f"status={candidate['status']}",
        f"beats={candidate['beat_count']}",
        f"cv={format_float(candidate['interval_cv'])}",
        f"meter={format_float(candidate['meter_confidence'])}",
        f"downbeat={format_float(candidate['downbeat_confidence'])}",
    ]
    if candidate["input"] != SOURCE_INPUT:
        parts.append(f"stem_signal.has_signal={format_optional_bool(candidate['stem_signal_has_signal'])}")
        alignment = candidate["alignment_vs_source"]
        if isinstance(alignment, Mapping):
            parts.append(f"align.beat={format_float(alignment.get('beat_match_ratio'))}")
            parts.append(f"align.downbeat={format_float(alignment.get('downbeat_match_ratio'))}")
    parts.append(f"gate={candidate['diagnostic_gate']}")
    parts.append(f"outcome={candidate['diagnostic_outcome']}")
    if candidate.get("error"):
        parts.append(f"error={candidate['error']}")
    return " ".join(parts)


def format_float(value: object) -> str:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return "n/a"
    if not math.isfinite(float(value)):
        return "n/a"
    return f"{float(value):.3f}"


def format_optional_bool(value: object) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    return "unknown"


if __name__ == "__main__":
    raise SystemExit(main())
