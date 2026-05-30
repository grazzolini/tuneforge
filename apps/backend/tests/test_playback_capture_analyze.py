from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.cli import playback_capture_analyze


def test_cli_analyzes_wav_capture_with_markers_loop_and_quiet_window(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    audio_path = tmp_path / "capture.wav"
    sidecar_path = tmp_path / "capture.json"
    marker_seconds = [0.5, 1.0, 1.5, 2.0, 2.5]
    _write_loop_capture(audio_path, marker_seconds=marker_seconds)
    _write_json(
        sidecar_path,
        {
            "minDurationSeconds": 3.2,
            "rmsThreshold": 0.005,
            "bpm": 120,
            "beatToleranceSeconds": 0.04,
            "markers": [
                {"kind": "count-in-click", "timeSeconds": seconds}
                for seconds in marker_seconds
            ],
            "loops": [
                {
                    "startSeconds": 1.0,
                    "endSeconds": 2.0,
                    "restartSeconds": 2.0,
                    "minSimilarity": 0.85,
                    "requireSimilarity": True,
                }
            ],
            "quietWindows": [{"startSeconds": 3.1, "endSeconds": 3.3, "maxRms": 0.001}],
        },
    )

    exit_code = playback_capture_analyze.main(
        ["--audio", str(audio_path), "--sidecar", str(sidecar_path)]
    )

    captured = capsys.readouterr()
    assert exit_code == 0, captured.err
    payload = json.loads(captured.out)
    assert captured.err == ""
    assert payload["duration_seconds"] == pytest.approx(3.4)
    assert payload["rms"] > 0.005
    assert payload["pulse_markers"]["checked"] == len(marker_seconds)
    assert payload["pulse_markers"]["matched"] == len(marker_seconds)
    assert payload["pulse_markers"]["max_spacing_error_seconds"] < 0.02
    assert payload["loop_restarts"]["checked"] == 1
    assert payload["loop_restarts"]["explicit_restarts"][0]["similarity"] > 0.99
    assert payload["quiet_windows"]["checked"] == 1


def test_cli_accepts_playback_smoke_sidecar_shape(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    audio_path = tmp_path / "playback-smoke-capture.wav"
    sidecar_path = tmp_path / "playback-smoke-capture.timing.json"
    phases = [
        _phase("capture:prepared", 0, {"provider": "pulse", "routeOutput": True}),
        _phase("capture:start", 100, {"provider": "pulse", "device": "tuneforge.monitor"}),
        _phase("smoke:start", 500, {"appUrl": "http://127.0.0.1:1420"}),
        _phase("tempo:set", 800, {"bpm": 120}),
        _phase("song-precount:telemetry-passed", 500, {"startTimeSeconds": 0}),
        _phase("loop:set", 900, {"startSeconds": 1.0, "endSeconds": 2.0}),
        _phase("loop-precount:telemetry-passed", 1000, {"startTimeSeconds": 1.0}),
        _phase(
            "loop:restart-detected",
            2000,
            {
                "loopStartSeconds": 1.0,
                "loopEndSeconds": 2.0,
                "restartFromSeconds": 1.96,
                "positionSeconds": 1.02,
            },
        ),
        _phase("smoke:passed", 3100, {}),
        _phase("capture:stopped", 3400, {"exists": True, "sizeBytes": 4096}),
    ]
    _write_loop_capture(audio_path, marker_seconds=[0.5, 1.0, 2.0], repeat_loop_segment=False)
    _write_json(
        sidecar_path,
        {
            "schema_version": 1,
            "provider": "pulse",
            "provider_command": "parecord",
            "route_output": True,
            "sample_rate_hz": 8_000,
            "channels": 1,
            "audio": {"sampleRate": 8_000, "channels": 1, "path": str(audio_path)},
            "minDurationSeconds": 3.2,
            "rmsThreshold": 0.005,
            "markerToleranceSeconds": 0.08,
            "spacingToleranceSeconds": 0.08,
            "phaseMarkers": phases,
            "phases": phases,
            "markers": [
                {"kind": "song-precount-playback-marker", "timeSeconds": 0.5, "playbackSeconds": 0},
                {"kind": "loop-precount-playback-marker", "timeSeconds": 1.0, "playbackSeconds": 1.0},
                {"kind": "loop-restart-marker", "timeSeconds": 2.0, "playbackSeconds": 1.0},
            ],
            "quietWindows": [{"startSeconds": 0.2, "endSeconds": 0.35, "maxRms": 0.001}],
            "loops": [
                {
                    "startSeconds": 1.0,
                    "endSeconds": 2.0,
                }
            ],
            "requireLoopRestart": True,
            "capture_file": {"exists": True, "sizeBytes": 4096},
        },
    )

    exit_code = playback_capture_analyze.main(
        ["--audio", str(audio_path), "--sidecar", str(sidecar_path)]
    )

    captured = capsys.readouterr()
    assert exit_code == 0, captured.err
    payload = json.loads(captured.out)
    assert captured.err == ""
    assert payload["pulse_markers"]["checked"] == 3
    assert payload["loop_restarts"]["checked"] == 1
    assert payload["loop_restarts"]["phase_restart_count"] == 1
    assert payload["loop_restarts"]["explicit_restarts"][0]["waveform_similarity_required"] is False
    assert payload["loop_restarts"]["explicit_restarts"][0]["restart_seconds"] is None
    assert "similarity" not in payload["loop_restarts"]["explicit_restarts"][0]
    assert payload["quiet_windows"]["checked"] == 1


def test_cli_rejects_required_loop_restart_without_valid_wrap_telemetry(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    audio_path = tmp_path / "playback-smoke-capture.wav"
    sidecar_path = tmp_path / "playback-smoke-capture.timing.json"
    phases = [
        _phase("capture:start", 100, {"provider": "pipewire", "device": "tuneforge.monitor"}),
        _phase("smoke:start", 500, {"appUrl": "http://127.0.0.1:1420"}),
        _phase("song-precount:telemetry-passed", 500, {"startTimeSeconds": 0}),
        _phase("loop:set", 900, {"startSeconds": 1.0, "endSeconds": 2.0}),
        _phase("loop-precount:telemetry-passed", 1000, {"startTimeSeconds": 1.0}),
        _phase(
            "loop:restart-detected",
            2000,
            {
                "loopStartSeconds": 1.0,
                "loopEndSeconds": 2.0,
                "restartFromSeconds": 1.2,
                "positionSeconds": 1.0,
            },
        ),
        _phase("smoke:passed", 3100, {}),
        _phase("capture:stopped", 3400, {"exists": True, "sizeBytes": 4096}),
    ]
    _write_loop_capture(audio_path, marker_seconds=[0.5, 1.0, 2.0], repeat_loop_segment=False)
    _write_json(
        sidecar_path,
        {
            "audio": {"sampleRate": 8_000, "channels": 1, "path": str(audio_path)},
            "minDurationSeconds": 3.2,
            "rmsThreshold": 0.005,
            "markerToleranceSeconds": 0.08,
            "phaseMarkers": phases,
            "phases": phases,
            "markers": [
                {"kind": "song-precount-playback-marker", "timeSeconds": 0.5, "playbackSeconds": 0},
                {"kind": "loop-precount-playback-marker", "timeSeconds": 1.0, "playbackSeconds": 1.0},
                {"kind": "loop-restart-marker", "timeSeconds": 2.0, "playbackSeconds": 1.0},
            ],
            "quietWindows": [{"startSeconds": 0.2, "endSeconds": 0.35, "maxRms": 0.001}],
            "loops": [
                {
                    "startSeconds": 1.0,
                    "endSeconds": 2.0,
                    "startCaptureSeconds": 1.0,
                    "restartSeconds": 2.0,
                    "minSimilarity": 0.65,
                }
            ],
            "requireLoopRestart": True,
        },
    )

    exit_code = playback_capture_analyze.main(
        ["--audio", str(audio_path), "--sidecar", str(sidecar_path)]
    )

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert "did not show wrap from near loop end to near loop start" in captured.err


def test_cli_rejects_silent_capture(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    audio_path = tmp_path / "silent.wav"
    sidecar_path = tmp_path / "capture.json"
    sf.write(audio_path, np.zeros(8_000, dtype=np.float32), 8_000)
    _write_json(sidecar_path, {"minDurationSeconds": 0.5, "rmsThreshold": 0.01})

    exit_code = playback_capture_analyze.main(
        ["--audio", str(audio_path), "--sidecar", str(sidecar_path)]
    )

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert "capture RMS" in captured.err


def test_cli_uses_shared_audio_signal_summary_when_available(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_path = tmp_path / "capture.wav"
    sidecar_path = tmp_path / "capture.json"
    _write_pulse_capture(audio_path, marker_seconds=[])
    _write_json(sidecar_path, {"minDurationSeconds": 1.0, "rmsThreshold": 0.2})

    class SharedSummary:
        inspected_duration_seconds = 1.25
        sample_rate = 12_345
        rms = 0.25
        peak = 0.75

    def inspect_audio_signal_array(
        samples: np.ndarray,
        sample_rate: int,
        thresholds: object,
    ) -> SharedSummary:
        assert samples.size == 16_000
        assert sample_rate == 8_000
        assert thresholds is playback_capture_analyze.PLAYBACK_CAPTURE_SIGNAL_THRESHOLDS
        return SharedSummary()

    monkeypatch.setattr(playback_capture_analyze, "inspect_audio_signal_array", inspect_audio_signal_array)

    exit_code = playback_capture_analyze.main(
        ["--audio", str(audio_path), "--sidecar", str(sidecar_path)]
    )

    captured = capsys.readouterr()
    assert exit_code == 0, captured.err
    payload = json.loads(captured.out)
    assert payload["duration_seconds"] == pytest.approx(1.25)
    assert payload["sample_rate"] == 12_345
    assert payload["rms"] == pytest.approx(0.25)
    assert payload["peak"] == pytest.approx(0.75)


def test_cli_rejects_missing_expected_pulse(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    audio_path = tmp_path / "capture.wav"
    sidecar_path = tmp_path / "capture.json"
    _write_pulse_capture(audio_path, marker_seconds=[0.5])
    _write_json(
        sidecar_path,
        {
            "minDurationSeconds": 1.5,
            "rmsThreshold": 0.002,
            "beatToleranceSeconds": 0.04,
            "markers": [
                {"kind": "count-in-click", "timeSeconds": 0.5},
                {"kind": "count-in-click", "timeSeconds": 1.0},
            ],
        },
    )

    exit_code = playback_capture_analyze.main(
        ["--audio", str(audio_path), "--sidecar", str(sidecar_path)]
    )

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert "expected count-in-click pulse near 1.000s" in captured.err


def _write_loop_capture(
    path: Path,
    *,
    marker_seconds: list[float],
    sample_rate: int = 8_000,
    repeat_loop_segment: bool = True,
) -> None:
    total_seconds = 3.4
    signal = np.zeros(int(sample_rate * total_seconds), dtype=np.float32)
    loop_t = np.arange(0, sample_rate, dtype=np.float32) / sample_rate
    loop_segment = 0.08 * np.sin(2 * np.pi * 220 * loop_t)
    restart_segment = loop_segment if repeat_loop_segment else 0.08 * np.sin(2 * np.pi * 330 * loop_t)
    signal[sample_rate : sample_rate * 2] += loop_segment
    signal[sample_rate * 2 : sample_rate * 3] += restart_segment
    _add_clicks(signal, marker_seconds=marker_seconds, sample_rate=sample_rate)
    sf.write(path, signal, sample_rate)


def _write_pulse_capture(
    path: Path,
    *,
    marker_seconds: list[float],
    sample_rate: int = 8_000,
) -> None:
    signal = np.zeros(sample_rate * 2, dtype=np.float32)
    _add_clicks(signal, marker_seconds=marker_seconds, sample_rate=sample_rate)
    sf.write(path, signal, sample_rate)


def _add_clicks(signal: np.ndarray, *, marker_seconds: list[float], sample_rate: int) -> None:
    click_frames = int(0.02 * sample_rate)
    click = (0.8 * np.hanning(click_frames)).astype(np.float32)
    for seconds in marker_seconds:
        start = int(seconds * sample_rate)
        end = min(signal.size, start + click_frames)
        signal[start:end] += click[: end - start]


def _phase(name: str, elapsed_ms: float, details: dict[str, object]) -> dict[str, object]:
    return {
        "name": name,
        "at": "2026-05-28T00:00:00.000Z",
        "elapsed_ms": elapsed_ms,
        "details": details,
    }


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")
