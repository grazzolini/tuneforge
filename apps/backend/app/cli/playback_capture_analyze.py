from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np
import soundfile as sf

from app.engines.audio_signal import AudioSignalThresholds, inspect_audio_signal_array

DEFAULT_MIN_DURATION_SECONDS = 1.0
DEFAULT_RMS_THRESHOLD = 0.002
DEFAULT_MARKER_TOLERANCE_SECONDS = 0.08
DEFAULT_SPACING_TOLERANCE_SECONDS = 0.08
DEFAULT_QUIET_WINDOW_MAX_RMS = 0.003
DEFAULT_LOOP_MIN_SIMILARITY = 0.7
PLAYBACK_CAPTURE_SIGNAL_WINDOW_SECONDS = 0.05
PLAYBACK_CAPTURE_SIGNAL_THRESHOLDS = AudioSignalThresholds(
    peak=DEFAULT_RMS_THRESHOLD,
    rms=DEFAULT_RMS_THRESHOLD,
    active_duration_seconds=0.0,
    window_seconds=PLAYBACK_CAPTURE_SIGNAL_WINDOW_SECONDS,
)


class PlaybackCaptureAnalyzeCliError(RuntimeError):
    pass


@dataclass(frozen=True)
class AudioCapture:
    samples: np.ndarray
    sample_rate: int

    @property
    def duration_seconds(self) -> float:
        return float(self.samples.size / self.sample_rate)


@dataclass(frozen=True)
class AudioCaptureSignalSummary:
    duration_seconds: float
    sample_rate: int
    rms: float
    peak: float


@dataclass(frozen=True)
class PulseMarker:
    kind: str
    time_seconds: float
    playback_seconds: float | None = None


@dataclass(frozen=True)
class QuietWindow:
    start_seconds: float
    end_seconds: float
    max_rms: float


@dataclass(frozen=True)
class LoopExpectation:
    start_seconds: float
    end_seconds: float
    restart_seconds: float | None
    start_capture_seconds: float | None
    min_similarity: float
    require_similarity: bool


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        summary = _run_analysis(args)
    except PlaybackCaptureAnalyzeCliError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    except Exception as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1

    sys.stdout.write(json.dumps(summary, sort_keys=True))
    sys.stdout.write("\n")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.playback_capture_analyze",
        description="Analyze a local playback smoke audio capture against its timing sidecar.",
    )
    parser.add_argument("--audio", required=True, type=Path, metavar="PATH")
    parser.add_argument("--sidecar", required=True, type=Path, metavar="PATH")
    parser.add_argument(
        "--min-duration",
        type=float,
        metavar="SECONDS",
        help="Minimum capture duration. Overrides sidecar minDurationSeconds.",
    )
    parser.add_argument(
        "--rms-threshold",
        type=float,
        metavar="RMS",
        help="Minimum full-capture RMS. Overrides sidecar rmsThreshold.",
    )
    parser.add_argument(
        "--marker-tolerance",
        type=float,
        metavar="SECONDS",
        help="Tolerance for expected beat/click markers. Overrides sidecar beatToleranceSeconds.",
    )
    return parser


def _run_analysis(args: argparse.Namespace) -> dict[str, Any]:
    sidecar = _read_sidecar(args.sidecar)
    capture = _read_capture(args)
    signal_summary = _summarize_capture_signal(capture)

    min_duration_seconds = cast(
        float,
        _first_float(
            [args.min_duration, sidecar, _object_field(sidecar, "audio")],
            ("minDurationSeconds", "minimumDurationSeconds", "min_capture_duration_seconds", "minDuration"),
            DEFAULT_MIN_DURATION_SECONDS,
        ),
    )
    rms_threshold = cast(
        float,
        _first_float(
            [args.rms_threshold, sidecar, _object_field(sidecar, "audio")],
            ("rmsThreshold", "rms_threshold", "minRms", "minimumRms"),
            DEFAULT_RMS_THRESHOLD,
        ),
    )
    marker_tolerance_seconds = cast(
        float,
        _first_float(
            [args.marker_tolerance, sidecar],
            ("beatToleranceSeconds", "markerToleranceSeconds", "clickToleranceSeconds", "toleranceSeconds"),
            DEFAULT_MARKER_TOLERANCE_SECONDS,
        ),
    )

    if signal_summary.duration_seconds < min_duration_seconds:
        raise PlaybackCaptureAnalyzeCliError(
            f"capture duration {signal_summary.duration_seconds:.3f}s below minimum {min_duration_seconds:.3f}s"
        )
    if signal_summary.rms < rms_threshold:
        raise PlaybackCaptureAnalyzeCliError(
            f"capture RMS {signal_summary.rms:.6f} below threshold {rms_threshold:.6f}"
        )

    markers = _extract_pulse_markers(sidecar)
    marker_summary = _analyze_pulse_markers(
        capture,
        markers,
        sidecar=sidecar,
        marker_tolerance_seconds=marker_tolerance_seconds,
    )

    quiet_windows = _extract_quiet_windows(sidecar)
    quiet_summary = _analyze_quiet_windows(capture, quiet_windows)

    loop_expectations = _extract_loop_expectations(sidecar)
    loop_summary = _analyze_loop_restarts(
        capture,
        loops=loop_expectations,
        markers=markers,
        sidecar=sidecar,
        marker_tolerance_seconds=marker_tolerance_seconds,
    )

    return {
        "audio_path": str(args.audio.expanduser().resolve()),
        "sidecar_path": str(args.sidecar.expanduser().resolve()),
        "duration_seconds": round(signal_summary.duration_seconds, 6),
        "sample_rate": signal_summary.sample_rate,
        "rms": round(signal_summary.rms, 8),
        "peak": round(signal_summary.peak, 8),
        "min_duration_seconds": min_duration_seconds,
        "rms_threshold": rms_threshold,
        "pulse_markers": marker_summary,
        "quiet_windows": quiet_summary,
        "loop_restarts": loop_summary,
    }


def _read_sidecar(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if not resolved.exists():
        raise PlaybackCaptureAnalyzeCliError(f"sidecar not found: {resolved}")
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PlaybackCaptureAnalyzeCliError(f"sidecar is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise PlaybackCaptureAnalyzeCliError("sidecar root must be a JSON object")
    return payload


def _read_capture(args: argparse.Namespace) -> AudioCapture:
    path = args.audio.expanduser().resolve()
    if not path.exists():
        raise PlaybackCaptureAnalyzeCliError(f"audio capture not found: {path}")

    try:
        data, effective_sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    except PlaybackCaptureAnalyzeCliError:
        raise
    except Exception as exc:
        raise PlaybackCaptureAnalyzeCliError(f"could not read audio capture: {exc}") from exc

    if data.size == 0:
        raise PlaybackCaptureAnalyzeCliError("audio capture is empty")
    if not np.all(np.isfinite(data)):
        raise PlaybackCaptureAnalyzeCliError("audio capture contains non-finite samples")

    mono = np.mean(data.astype(np.float64, copy=False), axis=1)
    return AudioCapture(samples=mono, sample_rate=int(effective_sample_rate))


def _summarize_capture_signal(capture: AudioCapture) -> AudioCaptureSignalSummary:
    shared_summary = inspect_audio_signal_array(
        capture.samples,
        capture.sample_rate,
        PLAYBACK_CAPTURE_SIGNAL_THRESHOLDS,
    )
    return AudioCaptureSignalSummary(
        duration_seconds=shared_summary.inspected_duration_seconds,
        sample_rate=shared_summary.sample_rate,
        rms=shared_summary.rms,
        peak=shared_summary.peak,
    )


def _analyze_pulse_markers(
    capture: AudioCapture,
    markers: list[PulseMarker],
    *,
    sidecar: dict[str, Any],
    marker_tolerance_seconds: float,
) -> dict[str, Any]:
    markers_in_range = [
        marker
        for marker in sorted(markers, key=lambda item: item.time_seconds)
        if 0 <= marker.time_seconds <= capture.duration_seconds
    ]
    if not markers_in_range:
        return {"checked": 0, "matched": 0, "max_offset_seconds": None}

    peak_floor = cast(
        float,
        _first_float(
            [sidecar],
            ("markerPeakThreshold", "clickPeakThreshold", "pulsePeakThreshold"),
            max(DEFAULT_RMS_THRESHOLD * 4, _rms(capture.samples) * 1.8),
        ),
    )
    matched_times: list[float] = []
    offsets: list[float] = []

    for marker in markers_in_range:
        match_time = _nearest_peak_time(
            capture,
            marker.time_seconds,
            tolerance_seconds=marker_tolerance_seconds,
            peak_floor=peak_floor,
        )
        if match_time is None:
            raise PlaybackCaptureAnalyzeCliError(
                f"expected {marker.kind} pulse near {marker.time_seconds:.3f}s within "
                f"{marker_tolerance_seconds:.3f}s"
            )
        matched_times.append(match_time)
        offsets.append(abs(match_time - marker.time_seconds))

    spacing_tolerance_seconds = cast(
        float,
        _first_float(
            [sidecar],
            ("spacingToleranceSeconds", "beatSpacingToleranceSeconds", "clickSpacingToleranceSeconds"),
            max(marker_tolerance_seconds, DEFAULT_SPACING_TOLERANCE_SECONDS),
        ),
    )
    expected_gaps = np.diff([marker.time_seconds for marker in markers_in_range])
    observed_gaps = np.diff(matched_times)
    if expected_gaps.size:
        gap_errors = np.abs(observed_gaps - expected_gaps)
        max_gap_error = float(np.max(gap_errors))
        if max_gap_error > spacing_tolerance_seconds:
            raise PlaybackCaptureAnalyzeCliError(
                f"pulse spacing drift {max_gap_error:.3f}s exceeds tolerance "
                f"{spacing_tolerance_seconds:.3f}s"
            )
    else:
        max_gap_error = 0.0

    bpm = _first_float([sidecar], ("bpm", "tempoBpm", "fixtureBpm"), None)
    median_gap_seconds = float(np.median(observed_gaps)) if observed_gaps.size else None
    if bpm is not None and median_gap_seconds is not None:
        expected_beat_seconds = 60.0 / bpm
        multiplier = max(1, round(median_gap_seconds / expected_beat_seconds))
        expected_marker_gap = expected_beat_seconds * multiplier
        bpm_gap_error = abs(median_gap_seconds - expected_marker_gap)
        if bpm_gap_error > spacing_tolerance_seconds:
            raise PlaybackCaptureAnalyzeCliError(
                f"median pulse gap {median_gap_seconds:.3f}s does not match {bpm:.3f} BPM "
                f"grid within {spacing_tolerance_seconds:.3f}s"
            )

    return {
        "checked": len(markers_in_range),
        "matched": len(matched_times),
        "max_offset_seconds": round(max(offsets), 6) if offsets else None,
        "max_spacing_error_seconds": round(max_gap_error, 6),
        "median_gap_seconds": round(median_gap_seconds, 6) if median_gap_seconds is not None else None,
    }


def _analyze_quiet_windows(capture: AudioCapture, quiet_windows: list[QuietWindow]) -> dict[str, Any]:
    measured: list[dict[str, Any]] = []
    for window in quiet_windows:
        start_index = _sample_index(capture, window.start_seconds)
        end_index = _sample_index(capture, window.end_seconds)
        if end_index <= start_index:
            raise PlaybackCaptureAnalyzeCliError(
                f"quiet window {window.start_seconds:.3f}-{window.end_seconds:.3f}s is empty"
            )
        window_rms = _rms(capture.samples[start_index:end_index])
        if window_rms > window.max_rms:
            raise PlaybackCaptureAnalyzeCliError(
                f"quiet window {window.start_seconds:.3f}-{window.end_seconds:.3f}s RMS "
                f"{window_rms:.6f} exceeds {window.max_rms:.6f}"
            )
        measured.append(
            {
                "start_seconds": window.start_seconds,
                "end_seconds": window.end_seconds,
                "rms": round(window_rms, 8),
                "max_rms": window.max_rms,
            }
        )
    return {"checked": len(quiet_windows), "windows": measured}


def _analyze_loop_restarts(
    capture: AudioCapture,
    *,
    loops: list[LoopExpectation],
    markers: list[PulseMarker],
    sidecar: dict[str, Any],
    marker_tolerance_seconds: float,
) -> dict[str, Any]:
    require_loop_restart = _first_bool([sidecar], ("requireLoopRestart", "require_loop_restart"), bool(loops))
    checked: list[dict[str, Any]] = []
    marker_restart_count = _marker_loop_restart_count(loops, markers, marker_tolerance_seconds)
    phase_restart_count = _phase_loop_restart_count(loops, sidecar, marker_tolerance_seconds)

    for loop in loops:
        restart_seconds = loop.restart_seconds
        if restart_seconds is not None and (restart_seconds < 0 or restart_seconds >= capture.duration_seconds):
            raise PlaybackCaptureAnalyzeCliError(
                f"loop restart {restart_seconds:.3f}s outside capture duration {capture.duration_seconds:.3f}s"
            )

        loop_marker_restart_count = _marker_loop_restart_count([loop], markers, marker_tolerance_seconds)
        loop_phase_restart_count = _phase_loop_restart_count([loop], sidecar, marker_tolerance_seconds)
        similarity: float | None = None
        if loop.require_similarity:
            if restart_seconds is None:
                raise PlaybackCaptureAnalyzeCliError("loop waveform similarity requires restart capture seconds")
            start_seconds = loop.start_capture_seconds if loop.start_capture_seconds is not None else loop.start_seconds
            similarity = _best_snippet_similarity(
                capture,
                reference_seconds=start_seconds,
                candidate_seconds=restart_seconds,
                loop_seconds=loop.end_seconds - loop.start_seconds,
                search_radius_seconds=marker_tolerance_seconds,
            )
            if similarity < loop.min_similarity:
                raise PlaybackCaptureAnalyzeCliError(
                    f"loop restart at {restart_seconds:.3f}s similarity {similarity:.3f} below "
                    f"{loop.min_similarity:.3f}"
                )
        elif require_loop_restart and loop_marker_restart_count + loop_phase_restart_count == 0:
            raise PlaybackCaptureAnalyzeCliError(
                "sidecar loop restart telemetry did not show wrap from near loop end to near loop start"
            )

        result = {
            "start_seconds": loop.start_seconds,
            "end_seconds": loop.end_seconds,
            "restart_seconds": restart_seconds,
            "marker_restart_count": loop_marker_restart_count,
            "phase_restart_count": loop_phase_restart_count,
            "waveform_similarity_required": loop.require_similarity,
        }
        if similarity is not None:
            result["similarity"] = round(similarity, 6)
        checked.append(result)

    return {
        "checked": len(checked),
        "explicit_restarts": checked,
        "marker_restart_count": marker_restart_count,
        "phase_restart_count": phase_restart_count,
    }


def _extract_pulse_markers(sidecar: dict[str, Any]) -> list[PulseMarker]:
    markers: list[PulseMarker] = []
    markers.extend(_markers_from_sequence(sidecar.get("markers"), default_kind="marker"))
    markers.extend(_markers_from_sequence(sidecar.get("beats"), default_kind="beat"))
    markers.extend(_markers_from_sequence(sidecar.get("clicks"), default_kind="click"))
    for key in ("countIn", "count_in", "precount", "preCount"):
        count_in = _object_field(sidecar, key)
        if count_in:
            markers.extend(_markers_from_sequence(count_in.get("clicks"), default_kind="count-in-click"))
            markers.extend(_markers_from_sequence(count_in.get("markers"), default_kind="count-in-click"))
    return [
        marker
        for marker in markers
        if any(token in marker.kind for token in ("beat", "click", "pulse", "marker"))
    ]


def _extract_quiet_windows(sidecar: dict[str, Any]) -> list[QuietWindow]:
    raw_windows = _first_sequence(
        sidecar,
        ("quietWindows", "expectedQuietWindows", "silenceWindows", "silentWindows"),
    )
    windows: list[QuietWindow] = []
    for raw_window in raw_windows:
        if not isinstance(raw_window, dict):
            continue
        start_seconds = _number_from_mapping(
            raw_window,
            ("startSeconds", "start", "fromSeconds", "from", "beginSeconds"),
        )
        end_seconds = _number_from_mapping(raw_window, ("endSeconds", "end", "toSeconds", "to"))
        if start_seconds is None or end_seconds is None:
            continue
        max_rms = _number_from_mapping(raw_window, ("maxRms", "rmsThreshold", "maximumRms"))
        windows.append(
            QuietWindow(
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                max_rms=max_rms if max_rms is not None else DEFAULT_QUIET_WINDOW_MAX_RMS,
            )
        )
    return windows


def _extract_loop_expectations(sidecar: dict[str, Any]) -> list[LoopExpectation]:
    raw_loops = _first_sequence(sidecar, ("loops", "loopWindows", "loopRanges"))
    single_loop = _object_field(sidecar, "loop") or _object_field(sidecar, "loopRange")
    if single_loop:
        raw_loops = [single_loop, *raw_loops]

    loops: list[LoopExpectation] = []
    for raw_loop in raw_loops:
        if not isinstance(raw_loop, dict):
            continue
        start_seconds = _number_from_mapping(
            raw_loop,
            ("startSeconds", "loopStartSeconds", "start", "loop_start_seconds"),
        )
        end_seconds = _number_from_mapping(raw_loop, ("endSeconds", "loopEndSeconds", "end", "loop_end_seconds"))
        if start_seconds is None or end_seconds is None or end_seconds <= start_seconds:
            continue
        restart_seconds = _number_from_mapping(
            raw_loop,
            (
                "restartSeconds",
                "restartCaptureSeconds",
                "loopRestartSeconds",
                "loopRestartCaptureSeconds",
                "wrapSeconds",
                "wrappedAtSeconds",
            ),
        )
        start_capture_seconds = _number_from_mapping(
            raw_loop,
            ("startCaptureSeconds", "loopStartCaptureSeconds", "referenceCaptureSeconds"),
        )
        min_similarity = _number_from_mapping(raw_loop, ("minSimilarity", "minimumSimilarity"))
        require_similarity = _first_bool(
            [raw_loop],
            ("requireSimilarity", "requireWaveformSimilarity", "require_similarity", "require_waveform_similarity"),
            False,
        )
        loops.append(
            LoopExpectation(
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                restart_seconds=restart_seconds,
                start_capture_seconds=start_capture_seconds,
                min_similarity=min_similarity if min_similarity is not None else DEFAULT_LOOP_MIN_SIMILARITY,
                require_similarity=require_similarity,
            )
        )
    return loops


def _markers_from_sequence(value: object, *, default_kind: str) -> list[PulseMarker]:
    if not isinstance(value, list):
        return []
    markers: list[PulseMarker] = []
    for item in value:
        if isinstance(item, int | float) and math.isfinite(float(item)):
            markers.append(PulseMarker(kind=default_kind, time_seconds=float(item)))
            continue
        if not isinstance(item, dict):
            continue
        time_seconds = _marker_capture_seconds(item)
        if time_seconds is None:
            continue
        kind = _marker_kind(item, default_kind)
        playback_seconds = _number_from_mapping(
            item,
            (
                "playbackSeconds",
                "playbackTimeSeconds",
                "sourceSeconds",
                "sourceTimeSeconds",
                "targetStartSeconds",
                "startTimeSeconds",
            ),
        )
        markers.append(PulseMarker(kind=kind, time_seconds=time_seconds, playback_seconds=playback_seconds))
    return markers


def _marker_capture_seconds(item: dict[str, Any]) -> float | None:
    value = _number_from_mapping(
        item,
        (
            "captureSeconds",
            "captureTimeSeconds",
            "audioSeconds",
            "audioTimeSeconds",
            "timeSeconds",
            "seconds",
            "time",
        ),
    )
    if value is not None:
        return value
    milliseconds = _number_from_mapping(item, ("captureMs", "captureTimeMs", "timeMs", "timestampMs"))
    return None if milliseconds is None else milliseconds / 1000.0


def _marker_kind(item: dict[str, Any], default: str) -> str:
    for key in ("kind", "type", "name", "label", "event"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower().replace("_", "-")
    return default


def _marker_loop_restart_count(
    loops: list[LoopExpectation],
    markers: list[PulseMarker],
    tolerance_seconds: float,
) -> int:
    markers_with_playback = sorted(
        (marker for marker in markers if marker.playback_seconds is not None),
        key=lambda marker: marker.time_seconds,
    )
    if not loops or len(markers_with_playback) < 2:
        return 0
    restart_count = 0
    for previous, current in zip(markers_with_playback, markers_with_playback[1:], strict=False):
        if previous.playback_seconds is None or current.playback_seconds is None:
            continue
        for loop in loops:
            edge_tolerance_seconds = _loop_edge_tolerance_seconds(loop, tolerance_seconds)
            min_backward_jump_seconds = _loop_min_backward_jump_seconds(loop)
            previous_near_end = _near_loop_end(previous.playback_seconds, loop, edge_tolerance_seconds)
            current_near_start = _near_loop_start(current.playback_seconds, loop, edge_tolerance_seconds)
            jumped_backward = previous.playback_seconds - current.playback_seconds >= min_backward_jump_seconds
            if previous_near_end and current_near_start:
                if not jumped_backward:
                    continue
                restart_count += 1
                break
    return restart_count


def _phase_loop_restart_count(
    loops: list[LoopExpectation],
    sidecar: dict[str, Any],
    tolerance_seconds: float,
) -> int:
    if not loops:
        return 0
    count = 0
    seen: set[tuple[float | None, float | None, float | None, float | None]] = set()
    for phase in _loop_restart_phases(sidecar):
        details = _object_field(phase, "details") or phase
        restart_from_seconds = _number_from_mapping(
            details,
            ("restartFromSeconds", "restartFrom", "fromSeconds", "previousPositionSeconds"),
        )
        position_seconds = _number_from_mapping(
            details,
            ("positionSeconds", "playbackPositionSeconds", "playbackSeconds", "loopStartSeconds"),
        )
        if restart_from_seconds is None or position_seconds is None:
            continue
        phase_loop_start = _number_from_mapping(details, ("loopStartSeconds", "startSeconds", "loopStart"))
        phase_loop_end = _number_from_mapping(details, ("loopEndSeconds", "endSeconds", "loopEnd"))
        key = (restart_from_seconds, position_seconds, phase_loop_start, phase_loop_end)
        if key in seen:
            continue
        seen.add(key)
        for loop in loops:
            edge_tolerance_seconds = _loop_edge_tolerance_seconds(loop, tolerance_seconds)
            if phase_loop_start is not None and abs(phase_loop_start - loop.start_seconds) > edge_tolerance_seconds:
                continue
            if phase_loop_end is not None and abs(phase_loop_end - loop.end_seconds) > edge_tolerance_seconds:
                continue
            if not _near_loop_end(restart_from_seconds, loop, edge_tolerance_seconds):
                continue
            if not _near_loop_start(position_seconds, loop, edge_tolerance_seconds):
                continue
            if restart_from_seconds - position_seconds < _loop_min_backward_jump_seconds(loop):
                continue
            count += 1
            break
    return count


def _loop_restart_phases(sidecar: dict[str, Any]) -> list[dict[str, Any]]:
    phases: list[dict[str, Any]] = []
    for key in ("phaseMarkers", "phases"):
        value = sidecar.get(key)
        if not isinstance(value, list):
            continue
        for phase in value:
            if not isinstance(phase, dict):
                continue
            name = _marker_kind(phase, default="").replace("_", "-")
            if name == "loop:restart-detected":
                phases.append(phase)
    return phases


def _loop_edge_tolerance_seconds(loop: LoopExpectation, base_tolerance_seconds: float) -> float:
    loop_seconds = loop.end_seconds - loop.start_seconds
    telemetry_edge_seconds = min(0.35, max(0.08, loop_seconds * 0.15))
    return max(base_tolerance_seconds, telemetry_edge_seconds)


def _loop_min_backward_jump_seconds(loop: LoopExpectation) -> float:
    loop_seconds = loop.end_seconds - loop.start_seconds
    return min(0.25, max(0.05, loop_seconds * 0.25))


def _near_loop_end(playback_seconds: float, loop: LoopExpectation, tolerance_seconds: float) -> bool:
    return loop.end_seconds - tolerance_seconds <= playback_seconds <= loop.end_seconds + max(0.5, tolerance_seconds)


def _near_loop_start(playback_seconds: float, loop: LoopExpectation, tolerance_seconds: float) -> bool:
    return loop.start_seconds - tolerance_seconds <= playback_seconds <= loop.start_seconds + tolerance_seconds


def _nearest_peak_time(
    capture: AudioCapture,
    expected_seconds: float,
    *,
    tolerance_seconds: float,
    peak_floor: float,
) -> float | None:
    start_index = _sample_index(capture, max(0.0, expected_seconds - tolerance_seconds))
    end_index = _sample_index(capture, min(capture.duration_seconds, expected_seconds + tolerance_seconds))
    if end_index <= start_index:
        return None
    window = np.abs(capture.samples[start_index:end_index])
    peak_index = int(np.argmax(window))
    peak_value = float(window[peak_index])
    if peak_value < peak_floor:
        return None
    return (start_index + peak_index) / capture.sample_rate


def _best_snippet_similarity(
    capture: AudioCapture,
    *,
    reference_seconds: float,
    candidate_seconds: float,
    loop_seconds: float,
    search_radius_seconds: float,
) -> float:
    snippet_seconds = max(0.08, min(0.5, loop_seconds / 2.0))
    candidate_offsets = np.linspace(-search_radius_seconds, search_radius_seconds, num=9)
    similarities = [
        _snippet_similarity(
            capture,
            reference_seconds=reference_seconds,
            candidate_seconds=candidate_seconds + float(offset),
            snippet_seconds=snippet_seconds,
        )
        for offset in candidate_offsets
    ]
    return max(similarities) if similarities else 0.0


def _snippet_similarity(
    capture: AudioCapture,
    *,
    reference_seconds: float,
    candidate_seconds: float,
    snippet_seconds: float,
) -> float:
    reference = _snippet(capture, reference_seconds, snippet_seconds)
    candidate = _snippet(capture, candidate_seconds, snippet_seconds)
    if reference.size == 0 or candidate.size == 0 or reference.size != candidate.size:
        return 0.0
    reference = reference - np.mean(reference)
    candidate = candidate - np.mean(candidate)
    reference_norm = float(np.linalg.norm(reference))
    candidate_norm = float(np.linalg.norm(candidate))
    if reference_norm == 0.0 or candidate_norm == 0.0:
        return 0.0
    return float(np.dot(reference, candidate) / (reference_norm * candidate_norm))


def _snippet(capture: AudioCapture, start_seconds: float, duration_seconds: float) -> np.ndarray:
    if start_seconds < 0 or duration_seconds <= 0:
        return np.asarray([], dtype=np.float64)
    start_index = _sample_index(capture, start_seconds)
    end_index = _sample_index(capture, start_seconds + duration_seconds)
    if end_index > capture.samples.size:
        return np.asarray([], dtype=np.float64)
    return capture.samples[start_index:end_index]


def _sample_index(capture: AudioCapture, seconds: float) -> int:
    return int(np.clip(round(seconds * capture.sample_rate), 0, capture.samples.size))


def _rms(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))


def _first_sequence(mapping: dict[str, Any], keys: tuple[str, ...]) -> list[Any]:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, list):
            return value
    return []


def _object_field(mapping: dict[str, Any], key: str) -> dict[str, Any]:
    value = mapping.get(key)
    return value if isinstance(value, dict) else {}


def _first_float(candidates: list[object], keys: tuple[str, ...], default: float | None) -> float | None:
    for candidate in candidates:
        if isinstance(candidate, int | float) and math.isfinite(float(candidate)):
            return float(candidate)
        if not isinstance(candidate, dict):
            continue
        value = _number_from_mapping(candidate, keys)
        if value is not None:
            return value
    return default


def _first_bool(candidates: list[object], keys: tuple[str, ...], default: bool) -> bool:
    for candidate in candidates:
        if isinstance(candidate, bool):
            return candidate
        if not isinstance(candidate, dict):
            continue
        for key in keys:
            value = candidate.get(key)
            if isinstance(value, bool):
                return value
    return default


def _number_from_mapping(mapping: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, int | float) and math.isfinite(float(value)):
            return float(value)
        if isinstance(value, str):
            try:
                parsed = float(value)
            except ValueError:
                continue
            if math.isfinite(parsed):
                return parsed
    return None


if __name__ == "__main__":
    raise SystemExit(main())
