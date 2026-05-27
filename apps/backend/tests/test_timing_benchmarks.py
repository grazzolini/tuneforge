from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.benchmarks.timing import (
    _checkpoint_cache_summary,
    build_benchmark_report,
    summarize_report,
)
from app.benchmarks.timing import (
    main as benchmark_main,
)


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


def test_timing_benchmark_marks_first_checkpoint_download():
    summary = _checkpoint_cache_summary(
        "small0",
        {"available": False, "checkpoint_file": "beat_this-small0.ckpt", "size_bytes": None},
        {"available": True, "checkpoint_file": "beat_this-small0.ckpt", "size_bytes": 8_451_101},
    )

    assert summary["available"] is True
    assert summary["cache_size_bytes_before"] is None
    assert summary["cache_size_bytes_after"] == 8_451_101
    assert summary["downloaded_during_run"] is True
    assert summary["behavior"] == "downloaded_or_cache_grew"


def test_timing_benchmark_compares_backends_without_exposing_absolute_paths(
    monkeypatch: pytest.MonkeyPatch,
):
    private_audio_path = Path("/Users/example/Music/Private Session/Secret Take.wav")
    ticks = iter(
        [
            0.0,
            2.0,
            2.0,
            3.0,
            3.0,
            4.5,
            4.5,
            5.1,
            5.1,
            7.1,
            7.1,
            7.8,
        ]
    )
    checkpoints: list[str] = []

    monkeypatch.setattr("app.benchmarks.timing.time.perf_counter", lambda: next(ticks))
    monkeypatch.setattr(
        "app.benchmarks.timing._track_metadata",
        lambda _audio_path: {
            "track_duration_seconds": 10.0,
            "sample_rate": 44_100,
            "channels": 2,
        },
    )
    monkeypatch.setattr(
        "app.benchmarks.timing._checkpoint_cache_snapshot",
        lambda checkpoint: None
        if checkpoint is None
        else {"available": True, "size_bytes": 100 if checkpoint == "small0" else 400},
    )

    def fake_analyze_track(_audio_path: Path):
        return {
            "estimated_key": None,
            "key_confidence": None,
            "estimated_reference_hz": None,
            "tuning_offset_cents": None,
            "tempo_bpm": 120.0,
            "timing": _timing_payload("detected", [0.0, 0.5, 1.0, 1.5, 2.0]),
        }

    def fake_detect_beat_this_timing(
        _audio_path: Path,
        *,
        duration_seconds: float | None = None,
        checkpoint: str,
    ):
        assert duration_seconds == 10.0
        checkpoints.append(checkpoint)
        if checkpoint == "small0":
            return _timing_payload("beat-this", [0.0, 0.5, 1.0, 1.5, 2.4])
        return _timing_payload("beat-this", [0.0, 0.5, 1.05, 1.55, 2.05])

    monkeypatch.setattr("app.benchmarks.timing.analyze_track", fake_analyze_track)
    monkeypatch.setattr(
        "app.benchmarks.timing.beat_this_engine.detect_beat_this_timing",
        fake_detect_beat_this_timing,
    )

    report = build_benchmark_report(
        [private_audio_path],
        audio_root=Path("/Users/example/Music"),
        include_relative_paths=True,
        backend_ids=["built-in", "beat-this-small0", "beat-this-final0"],
        include_warm_runs=True,
    )
    rendered = json.dumps(report, indent=2)
    summary = summarize_report(report)
    track = report["tracks"][0]
    results = {result["backend_id"]: result for result in track["backend_results"]}

    assert report["selected_backends"] == ["built-in", "beat-this-small0", "beat-this-final0"]
    assert track["relative_path"] == "Private_Session/Secret_Take.wav"
    assert track["analysis_runtime_seconds"] == 1.0
    assert results["built-in"]["cold_runtime_seconds"] == 2.0
    assert results["built-in"]["warm_runtime_seconds"] == 1.0
    assert results["built-in"]["model_load_runtime_seconds"] == 1.0
    assert results["built-in"]["reference_alignment_to_built_in"] is None
    assert results["built-in"]["timing"]["single_anchor_drift_seconds"] == {
        "median_absolute_residual_seconds": 0.0,
        "p95_absolute_residual_seconds": 0.0,
        "max_absolute_residual_seconds": 0.0,
    }
    assert results["beat-this-small0"]["checkpoint"] == "small0"
    assert results["beat-this-small0"]["runtime_ratio"] == 0.06
    assert results["beat-this-small0"]["timing"]["beat_count"] == 5
    assert results["beat-this-small0"]["timing"]["downbeat_count"] == 2
    assert results["beat-this-small0"]["timing"]["meter"] == "4/4"
    assert results["beat-this-small0"]["timing"]["first_beat_numbers"] == [1, 2, 3, 4, 1]
    assert results["beat-this-small0"]["timing"]["large_gap_count"] == 1
    assert results["beat-this-small0"]["timing"]["beat_interval_cv"] is not None
    assert results["beat-this-small0"]["timing"]["beat_interval_mad_ratio"] is not None
    assert results["beat-this-small0"]["timing"]["single_anchor_drift_seconds"] == {
        "median_absolute_residual_seconds": 0.0,
        "p95_absolute_residual_seconds": 0.32,
        "max_absolute_residual_seconds": 0.4,
    }
    assert results["beat-this-small0"]["reference_alignment_to_built_in"] == {
        "reference_backend_id": "built-in",
        "median_nearest_beat_delta_seconds": 0.0,
        "p95_nearest_beat_delta_seconds": 0.32,
        "max_nearest_beat_delta_seconds": 0.4,
        "beat_count_delta": 0,
    }
    assert results["beat-this-small0"]["checkpoint_cache"]["cache_size_bytes_after"] == 100
    assert results["beat-this-small0"]["checkpoint_cache"]["downloaded_during_run"] is False
    assert results["beat-this-final0"]["checkpoint"] == "final0"
    assert results["beat-this-final0"]["reference_alignment_to_built_in"] == {
        "reference_backend_id": "built-in",
        "median_nearest_beat_delta_seconds": 0.05,
        "p95_nearest_beat_delta_seconds": 0.05,
        "max_nearest_beat_delta_seconds": 0.05,
        "beat_count_delta": 0,
    }
    assert checkpoints == ["small0", "small0", "final0", "final0"]
    assert "beat-this small0" in summary
    assert "beat-this final0" in summary
    assert "CV" in summary
    assert "MAD" in summary
    assert "anchor drift" in summary
    assert "alignment built-in" in summary
    assert "_reference_beat_seconds" not in rendered
    assert str(private_audio_path) not in rendered
    assert str(private_audio_path) not in summary
    assert "/Users/" not in rendered
    assert "/Users/" not in summary


def _timing_payload(source: str, seconds: list[float]) -> dict:
    beats = [
        {
            "index": index,
            "seconds": second,
            "bar_index": index // 4,
            "beat_in_bar": (index % 4) + 1,
        }
        for index, second in enumerate(seconds)
    ]
    return {
        "beats_per_bar": 4,
        "source": source,
        "meter": "4/4",
        "meter_confidence": 1.0,
        "downbeat_source": source,
        "downbeat_confidence": 1.0,
        "beats": beats,
        "bars": [
            {
                "index": 0,
                "start_seconds": 0.0,
                "end_seconds": seconds[-1] if seconds else 0.0,
            }
        ],
    }
