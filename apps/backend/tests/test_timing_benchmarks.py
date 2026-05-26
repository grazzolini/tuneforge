from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.benchmarks.timing import build_benchmark_report
from app.benchmarks.timing import main as benchmark_main


def test_timing_benchmark_command_emits_json_without_paths(sample_rhythmic_audio_file: Path, capsys):
    exit_code = benchmark_main(["--audio", str(sample_rhythmic_audio_file), "--json-only"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    track = payload["tracks"][0]

    assert exit_code == 0
    assert payload["benchmark"] == "tuneforge-timing-grid-heuristic"
    assert track["track_id"] == "track_001"
    assert "track_hash" not in track
    assert track["relative_path"] is None
    assert str(sample_rhythmic_audio_file) not in captured.out
    assert track["available"] is True
    assert track["analysis_runtime_seconds"] is not None
    assert track["timing"]["available"] is True
    assert track["timing"]["beat_count"] >= 4
    assert track["timing"]["bar_count"] >= 1
    assert track["timing"]["first_beat_numbers"]


def test_timing_benchmark_collects_relative_paths_when_requested(sample_rhythmic_audio_file: Path):
    report = build_benchmark_report(
        [sample_rhythmic_audio_file],
        audio_root=sample_rhythmic_audio_file.parent,
        include_relative_paths=True,
    )

    assert report["tracks"][0]["relative_path"] == sample_rhythmic_audio_file.name


def test_timing_benchmark_sanitizes_failed_track_errors(
    sample_rhythmic_audio_file: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
):
    def fail_analysis(audio_path: Path):
        raise RuntimeError(f"cannot decode {audio_path}")

    monkeypatch.setattr("app.benchmarks.timing.analyze_track", fail_analysis)

    exit_code = benchmark_main(["--audio", str(sample_rhythmic_audio_file)])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    track = payload["tracks"][0]

    assert exit_code == 0
    assert track["track_id"] == "track_001"
    assert track["available"] is False
    assert track["error"] == "RuntimeError: analysis failed"
    assert str(sample_rhythmic_audio_file) not in captured.out
    assert str(sample_rhythmic_audio_file) not in captured.err


def test_timing_benchmark_rejects_missing_audio_dir(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    missing_audio_dir = tmp_path / "missing-tracks"

    with pytest.raises(SystemExit) as exc_info:
        benchmark_main(["--audio-dir", str(missing_audio_dir), "--json-only"])

    captured = capsys.readouterr()

    assert exc_info.value.code == 2
    assert captured.out == ""
    assert "track_count" not in captured.out
    assert "--audio-dir must be an existing directory" in captured.err
    assert str(missing_audio_dir) not in captured.err
