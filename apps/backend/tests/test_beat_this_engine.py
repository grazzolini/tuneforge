from __future__ import annotations

import sys
import types
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest

from app.engines import beat_this as beat_this_engine


@pytest.fixture(autouse=True)
def clear_file2beats_cache() -> Iterator[None]:
    _clear_file2beats_cache()
    yield
    _clear_file2beats_cache()


def test_detect_beat_this_timing_uses_stubbed_file2beats(monkeypatch) -> None:
    calls: list[str] = []

    def fake_get_file2beats(*, checkpoint: str = beat_this_engine.BEAT_THIS_CHECKPOINT):
        calls.append(checkpoint)

        def fake_file2beats(_source_path: str):
            return np.arange(0.0, 6.5, 0.5), np.asarray([0.0, 2.0, 4.0, 6.0])

        return fake_file2beats

    monkeypatch.setattr(beat_this_engine, "_get_file2beats", fake_get_file2beats)

    timing = beat_this_engine.detect_beat_this_timing(
        Path("synthetic_beat_this.wav"),
        duration_seconds=6.5,
    )

    assert timing is not None
    assert timing["source"] == "beat-this"
    assert timing["beats_per_bar"] == 4
    assert timing["meter"] == "4/4"
    assert timing["meter_confidence"] == 1.0
    assert timing["downbeat_confidence"] == 1.0
    assert calls == ["small0"]
    assert timing["beats"][0] == {
        "index": 0,
        "seconds": 0.0,
        "bar_index": 0,
        "beat_in_bar": 1,
    }
    assert timing["beats"][4]["bar_index"] == 1
    assert timing["beats"][4]["beat_in_bar"] == 1
    assert timing["bars"][0] == {"index": 0, "start_seconds": 0.0, "end_seconds": 2.0}


def test_detect_beat_this_timing_accepts_checkpoint_override(monkeypatch) -> None:
    calls: list[str] = []

    def fake_get_file2beats(*, checkpoint: str = beat_this_engine.BEAT_THIS_CHECKPOINT):
        calls.append(checkpoint)

        def fake_file2beats(_source_path: str):
            return np.arange(0.0, 4.5, 0.5), np.asarray([0.0, 2.0, 4.0])

        return fake_file2beats

    monkeypatch.setattr(beat_this_engine, "_get_file2beats", fake_get_file2beats)

    timing = beat_this_engine.detect_beat_this_timing(
        Path("synthetic_beat_this.wav"),
        duration_seconds=4.5,
        checkpoint="final0",
    )

    assert timing is not None
    assert timing["source"] == "beat-this"
    assert calls == ["final0"]


def test_analyze_track_with_beat_this_replaces_timing_and_tempo(monkeypatch) -> None:
    def fake_analyze_track(_source_path: Path, *, source_stem_paths=None):
        assert source_stem_paths is None
        return {
            "estimated_key": "C major",
            "key_confidence": 0.8,
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
            "tempo_bpm": 120.0,
            "timing": None,
        }

    def fake_detect_beat_this_timing(source_path: Path, *, duration_seconds: float | None = None):
        assert source_path == Path("synthetic_beat_this.wav")
        assert duration_seconds == 4.0
        return {
            "beats_per_bar": 4,
            "source": "beat-this",
            "meter": "4/4",
            "meter_confidence": 1.0,
            "downbeat_source": "beat-this",
            "downbeat_confidence": 1.0,
            "beats": [
                {"index": 0, "seconds": 0.0, "bar_index": 1, "beat_in_bar": 1},
                {"index": 1, "seconds": 0.75, "bar_index": 1, "beat_in_bar": 2},
                {"index": 2, "seconds": 1.5, "bar_index": 1, "beat_in_bar": 3},
            ],
            "bars": [{"index": 1, "start_seconds": 0.0, "end_seconds": 4.0}],
        }

    monkeypatch.setattr(beat_this_engine, "analyze_track", fake_analyze_track)
    monkeypatch.setattr(beat_this_engine, "detect_beat_this_timing", fake_detect_beat_this_timing)

    payload = beat_this_engine.analyze_track_with_beat_this(
        Path("synthetic_beat_this.wav"),
        duration_seconds=4.0,
    )

    assert payload["timing"] is not None
    assert payload["timing"]["source"] == "beat-this"
    assert payload["tempo_bpm"] == 80.0


def test_get_file2beats_initializes_beat_this_with_small_cpu_model(monkeypatch) -> None:
    calls: list[tuple[str, str, bool]] = []

    class FakeFile2Beats:
        def __init__(self, checkpoint_path: str, *, device: str, dbn: bool) -> None:
            calls.append((checkpoint_path, device, dbn))

        def __call__(self, _source_path: str):
            return np.asarray([0.0, 1.0]), np.asarray([0.0])

    _install_fake_beat_this(monkeypatch, FakeFile2Beats)
    beat_this_engine._get_file2beats.cache_clear()

    file2beats = beat_this_engine._get_file2beats()

    beats, downbeats = file2beats("song.wav")
    np.testing.assert_array_equal(beats, np.asarray([0.0, 1.0]))
    np.testing.assert_array_equal(downbeats, np.asarray([0.0]))
    assert calls == [("small0", "cpu", False)]


def test_get_file2beats_initializes_beat_this_with_requested_checkpoint(monkeypatch) -> None:
    calls: list[tuple[str, str, bool]] = []

    class FakeFile2Beats:
        def __init__(self, checkpoint_path: str, *, device: str, dbn: bool) -> None:
            calls.append((checkpoint_path, device, dbn))

        def __call__(self, _source_path: str):
            return np.asarray([0.0, 1.0]), np.asarray([0.0])

    _install_fake_beat_this(monkeypatch, FakeFile2Beats)
    beat_this_engine._get_file2beats.cache_clear()

    file2beats = beat_this_engine._get_file2beats(checkpoint="final0")

    beats, downbeats = file2beats("song.wav")
    np.testing.assert_array_equal(beats, np.asarray([0.0, 1.0]))
    np.testing.assert_array_equal(downbeats, np.asarray([0.0]))
    assert calls == [("final0", "cpu", False)]


def _install_fake_beat_this(monkeypatch, file2beats_class: type) -> None:
    beat_this_module = types.ModuleType("beat_this")
    beat_this_module.__path__ = []
    inference_module = types.ModuleType("beat_this.inference")
    inference_module.File2Beats = file2beats_class
    beat_this_module.inference = inference_module
    monkeypatch.setitem(sys.modules, "beat_this", beat_this_module)
    monkeypatch.setitem(sys.modules, "beat_this.inference", inference_module)


def _clear_file2beats_cache() -> None:
    cache_clear = getattr(beat_this_engine._get_file2beats, "cache_clear", None)
    if cache_clear is not None:
        cache_clear()
