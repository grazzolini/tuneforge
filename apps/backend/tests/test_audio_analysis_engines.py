from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

import app.engines.analysis as analysis_engine
from app.engines.analysis import AnalysisTimingBeatPayload, AnalysisTimingPayload, analyze_track
from app.engines.audio_features import (
    ANALYSIS_HOP_LENGTH,
    ANALYSIS_SAMPLE_RATE,
    HarmonicFeatures,
    _dynamic_beat_track,
)
from app.engines.chords import ChordSegment, detect_chord_timeline

SAMPLE_RATE = 44_100
NOTE_FREQUENCIES = {
    "C": 261.63,
    "Db": 277.18,
    "D": 293.66,
    "Eb": 311.13,
    "E": 329.63,
    "F": 349.23,
    "Gb": 369.99,
    "G": 392.00,
    "Ab": 415.30,
    "A": 440.00,
    "Bb": 466.16,
    "B": 493.88,
}


def test_chord_engine_detects_major_minor_progressions(tmp_path: Path):
    path = _render_chord_file(
        tmp_path,
        [
            ("C", ["C", "E", "G"]),
            ("G", ["G", "B", "D"]),
            ("Am", ["A", "C", "E"]),
            ("F", ["F", "A", "C"]),
        ],
    )

    assert _labels(path) == ["C", "G", "Am", "F"]


def test_chord_engine_detects_minor_key_loop(tmp_path: Path):
    path = _render_chord_file(
        tmp_path,
        [
            ("Am", ["A", "C", "E"]),
            ("F", ["F", "A", "C"]),
            ("C", ["C", "E", "G"]),
            ("G", ["G", "B", "D"]),
        ],
    )

    assert _labels(path) == ["Am", "F", "C", "G"]


def test_chord_engine_detects_flat_keys(tmp_path: Path):
    path = _render_chord_file(
        tmp_path,
        [
            ("Bb", ["Bb", "D", "F"]),
            ("Eb", ["Eb", "G", "Bb"]),
            ("Gm", ["G", "Bb", "D"]),
            ("F", ["F", "A", "C"]),
        ],
    )

    assert _labels(path) == ["A#/Bb", "D#/Eb", "Gm", "F"]


def test_chord_engine_handles_noisy_percussive_mix_and_inversions(tmp_path: Path):
    path = _render_chord_file(
        tmp_path,
        [
            ("C", ["E", "G", "C"]),
            ("G", ["B", "D", "G"]),
            ("Am", ["C", "E", "A"]),
            ("F", ["A", "C", "F"]),
        ],
        noise=True,
        percussion=True,
    )

    assert _labels(path) == ["C", "G", "Am", "F"]


def test_chord_engine_favors_chords_over_passing_bass(tmp_path: Path):
    path = _render_chord_file(
        tmp_path,
        [
            ("C", ["E", "G", "C"]),
            ("G", ["G", "B", "D"]),
            ("Am", ["C", "E", "A"]),
            ("F", ["A", "C", "F"]),
        ],
        bass_notes=[None, "E", None, None],
    )

    assert _labels(path) == ["C", "G", "Am", "F"]


def test_chord_engine_detects_common_extensions(tmp_path: Path):
    path = _render_chord_file(
        tmp_path,
        [
            ("Cmaj7", ["C", "E", "G", "B"]),
            ("G7", ["G", "B", "D", "F"]),
            ("Am7", ["A", "C", "E", "G"]),
            ("Fsus4", ["F", "Bb", "C"]),
            ("Bdim", ["B", "D", "F"]),
        ],
    )

    assert _labels(path) == ["Cmaj7", "G7", "Am7", "Fsus4", "Bdim"]


def test_chord_engine_handles_silence_and_short_audio(tmp_path: Path):
    empty_path = tmp_path / "empty.wav"
    sf.write(empty_path, np.zeros(0, dtype=np.float32), SAMPLE_RATE)
    assert detect_chord_timeline(empty_path) == []
    assert analyze_track(empty_path) == {
        "estimated_key": None,
        "key_confidence": None,
        "estimated_reference_hz": None,
        "tuning_offset_cents": None,
        "tempo_bpm": None,
        "timing": None,
    }

    silence_path = tmp_path / "silence.wav"
    sf.write(silence_path, np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)

    assert detect_chord_timeline(silence_path) == [
        {
            "start_seconds": 0.0,
            "end_seconds": 1.0,
            "label": "N.C.",
            "confidence": None,
            "pitch_class": None,
            "quality": None,
        }
    ]

    short_path = _render_chord_file(tmp_path, [("C", ["C", "E", "G"])], segment_duration=0.18)
    assert _labels(short_path) == ["C"]


def test_analysis_uses_harmonic_features_for_key_tuning_and_tempo(tmp_path: Path):
    detuned_path = _render_chord_file(
        tmp_path,
        [
            ("C", ["C", "E", "G"]),
            ("G", ["G", "B", "D"]),
            ("Am", ["A", "C", "E"]),
            ("F", ["F", "A", "C"]),
        ],
        cents=35.0,
    )

    detuned = analyze_track(detuned_path)
    assert detuned["estimated_key"] == "C major"
    assert detuned["key_confidence"] is not None
    assert detuned["key_confidence"] >= 0.5
    assert detuned["tuning_offset_cents"] is not None
    assert 25.0 <= detuned["tuning_offset_cents"] <= 45.0

    rhythmic_path = _render_chord_file(
        tmp_path,
        [("C", ["C", "E", "G"]) for _ in range(8)],
        segment_duration=1.0,
        percussion=True,
        pulse_bpm=120.0,
    )
    rhythmic = analyze_track(rhythmic_path)
    assert rhythmic["tempo_bpm"] is not None
    assert 100.0 <= rhythmic["tempo_bpm"] <= 140.0
    assert rhythmic["timing"] is not None
    assert rhythmic["timing"]["beats_per_bar"] == 4
    assert rhythmic["timing"]["source"] in {"detected", "tempo_fallback"}
    assert len(rhythmic["timing"]["beats"]) >= 4
    assert len(rhythmic["timing"]["bars"]) >= 1
    beat_seconds = [beat["seconds"] for beat in rhythmic["timing"]["beats"]]
    assert beat_seconds == sorted(beat_seconds)
    median_beat_seconds = float(np.median(np.diff(np.asarray(beat_seconds[:8]))))
    assert 0.35 <= median_beat_seconds <= 0.65
    assert rhythmic["timing"]["beats"][0]["beat_in_bar"] == 1


def test_analysis_tracks_accelerating_pulses_closer_than_static_tempo(tmp_path: Path):
    path, expected_pulses = _render_dynamic_pulse_file(
        tmp_path,
        start_bpm=80.0,
        end_bpm=150.0,
    )

    _assert_dynamic_timing_closer_than_static(path, expected_pulses)


def test_analysis_tracks_decelerating_pulses_closer_than_static_tempo(tmp_path: Path):
    path, expected_pulses = _render_dynamic_pulse_file(
        tmp_path,
        start_bpm=150.0,
        end_bpm=80.0,
    )

    _assert_dynamic_timing_closer_than_static(path, expected_pulses)


def test_dynamic_beat_tracking_keeps_slow_constant_pulses_single_time():
    duration_seconds = 10.0
    timeline = np.linspace(
        0,
        duration_seconds,
        int(ANALYSIS_SAMPLE_RATE * duration_seconds),
        endpoint=False,
    )
    pulse_times = np.arange(0.0, duration_seconds, 1.0, dtype=np.float64)
    signal = _pulse_train_at_times(timeline, pulse_times, amplitude=0.8).astype(np.float32)

    _tempo_raw, beat_frames = _dynamic_beat_track(signal)

    assert beat_frames.size >= 6
    beat_seconds = beat_frames.astype(np.float64) * (ANALYSIS_HOP_LENGTH / ANALYSIS_SAMPLE_RATE)
    median_beat_interval = float(np.median(np.diff(beat_seconds)))
    assert 0.85 <= median_beat_interval <= 1.15


def test_analysis_ignores_weak_offbeat_subdivisions_for_slow_pulses(tmp_path: Path):
    duration_seconds = 10.0
    timeline = np.linspace(
        0,
        duration_seconds,
        int(ANALYSIS_SAMPLE_RATE * duration_seconds),
        endpoint=False,
    )
    main_pulses = np.arange(0.0, duration_seconds, 1.0, dtype=np.float64)
    offbeat_pulses = main_pulses + 0.5
    offbeat_pulses = offbeat_pulses[offbeat_pulses < duration_seconds]
    signal = (
        _pulse_train_at_times(timeline, main_pulses, amplitude=0.8)
        + _pulse_train_at_times(timeline, offbeat_pulses, amplitude=0.03)
    ).astype(np.float32)

    output_path = tmp_path / "slow_pulses_with_weak_offbeats.wav"
    sf.write(output_path, signal, ANALYSIS_SAMPLE_RATE)

    analysis = analyze_track(output_path)

    assert analysis["timing"] is not None
    assert analysis["timing"]["source"] == "detected"
    beat_seconds = np.asarray(
        [beat["seconds"] for beat in analysis["timing"]["beats"]],
        dtype=np.float64,
    )
    assert beat_seconds.size >= 6
    median_beat_interval = float(np.median(np.diff(beat_seconds)))
    assert 0.85 <= median_beat_interval <= 1.15


def test_analysis_infers_downbeat_offset_from_chord_changes_and_accents(monkeypatch):
    beat_times = 0.25 + np.arange(16, dtype=np.float64) * 0.5
    features = _synthetic_timing_features(
        beat_times,
        accent_indices={1, 5, 9, 13},
    )
    chord_timeline = _synthetic_chord_timeline(
        beat_times,
        downbeat_offset=1,
        duration_seconds=features.duration_seconds,
    )
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_offset_downbeat.wav"))

    timing = analysis["timing"]
    assert timing is not None
    assert timing["source"] == "detected"
    assert [beat["beat_in_bar"] for beat in timing["beats"][:10]] == [
        4,
        1,
        2,
        3,
        4,
        1,
        2,
        3,
        4,
        1,
    ]
    assert [beat["bar_index"] for beat in timing["beats"][:10]] == [
        0,
        1,
        1,
        1,
        1,
        2,
        2,
        2,
        2,
        3,
    ]
    assert timing["bars"][0] == {
        "index": 0,
        "start_seconds": timing["beats"][0]["seconds"],
        "end_seconds": timing["beats"][1]["seconds"],
    }
    assert timing["bars"][1] == {
        "index": 1,
        "start_seconds": timing["beats"][1]["seconds"],
        "end_seconds": timing["beats"][5]["seconds"],
    }
    assert timing["bars"][2] == {
        "index": 2,
        "start_seconds": timing["beats"][5]["seconds"],
        "end_seconds": timing["beats"][9]["seconds"],
    }
    _assert_beats_map_to_bar_spans(timing)


def test_analysis_infers_pickup_bar_for_two_beat_downbeat_offset(monkeypatch):
    beat_times = 0.25 + np.arange(16, dtype=np.float64) * 0.5
    features = _synthetic_timing_features(
        beat_times,
        accent_indices={2, 6, 10, 14},
    )
    chord_timeline = _synthetic_chord_timeline(
        beat_times,
        downbeat_offset=2,
        duration_seconds=features.duration_seconds,
    )
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_two_beat_pickup.wav"))

    timing = analysis["timing"]
    assert timing is not None
    assert timing["source"] == "detected"
    assert [beat["beat_in_bar"] for beat in timing["beats"][:10]] == [
        3,
        4,
        1,
        2,
        3,
        4,
        1,
        2,
        3,
        4,
    ]
    assert [beat["bar_index"] for beat in timing["beats"][:10]] == [
        0,
        0,
        1,
        1,
        1,
        1,
        2,
        2,
        2,
        2,
    ]
    assert timing["bars"][0] == {
        "index": 0,
        "start_seconds": timing["beats"][0]["seconds"],
        "end_seconds": timing["beats"][2]["seconds"],
    }
    assert timing["bars"][1] == {
        "index": 1,
        "start_seconds": timing["beats"][2]["seconds"],
        "end_seconds": timing["beats"][6]["seconds"],
    }
    _assert_beats_map_to_bar_spans(timing)


def test_analysis_keeps_ambiguous_downbeat_alignment(monkeypatch):
    beat_times = 0.25 + np.arange(12, dtype=np.float64) * 0.5
    features = _synthetic_timing_features(beat_times, accent_indices=set())
    chord_timeline = [
        _synthetic_chord_segment(
            0.0,
            features.duration_seconds,
            label="C",
            pitch_class=0,
        )
    ]
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_ambiguous_downbeat.wav"))

    timing = analysis["timing"]
    assert timing is not None
    assert timing["source"] == "detected"
    assert [beat["beat_in_bar"] for beat in timing["beats"][:8]] == [1, 2, 3, 4, 1, 2, 3, 4]
    assert [beat["bar_index"] for beat in timing["beats"][:8]] == [0, 0, 0, 0, 1, 1, 1, 1]
    assert timing["bars"][0] == {
        "index": 0,
        "start_seconds": timing["beats"][0]["seconds"],
        "end_seconds": timing["beats"][4]["seconds"],
    }
    _assert_beats_map_to_bar_spans(timing)


def test_analysis_keeps_phase_after_short_mid_song_half_beat_burst(monkeypatch):
    stable_beat_times = 0.25 + np.arange(24, dtype=np.float64) * 0.5
    beat_times = np.concatenate(
        [
            stable_beat_times[:8],
            np.asarray([4.0], dtype=np.float64),
            stable_beat_times[8:],
        ]
    )
    features = _synthetic_timing_features(beat_times, accent_indices=set())
    chord_timeline = [
        _synthetic_chord_segment(
            0.0,
            features.duration_seconds,
            label="C",
            pitch_class=0,
        )
    ]
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_mid_song_half_beat_burst.wav"))

    timing = _assert_detected_sorted_timing(analysis["timing"])
    assert [_beat_near(timing, seconds)["beat_in_bar"] for seconds in stable_beat_times[8:12]] == [
        1,
        2,
        3,
        4,
    ]
    assert _beat_near(timing, stable_beat_times[12])["beat_in_bar"] == 1
    assert abs(timing["bars"][2]["start_seconds"] - stable_beat_times[8]) <= 0.035


def test_analysis_recovers_early_fast_start_burst_without_shifting_downbeat_offset(
    monkeypatch,
):
    stable_beat_times = 0.25 + np.arange(24, dtype=np.float64) * 0.5
    beat_times = np.concatenate(
        [
            stable_beat_times[:1],
            np.asarray([0.5], dtype=np.float64),
            stable_beat_times[1:],
        ]
    )
    accent_times = stable_beat_times[1::4]
    accent_indices = {
        int(np.argmin(np.abs(beat_times - seconds))) for seconds in accent_times.tolist()
    }
    features = _synthetic_timing_features(beat_times, accent_indices=accent_indices)
    chord_timeline = _synthetic_chord_timeline(
        stable_beat_times,
        downbeat_offset=1,
        duration_seconds=features.duration_seconds,
    )
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_fast_start_recovery.wav"))

    timing = _assert_detected_sorted_timing(analysis["timing"])
    assert _beat_near(timing, stable_beat_times[0])["beat_in_bar"] == 4
    assert [_beat_near(timing, seconds)["beat_in_bar"] for seconds in accent_times[:4]] == [
        1,
        1,
        1,
        1,
    ]
    assert abs(timing["bars"][0]["end_seconds"] - stable_beat_times[1]) <= 0.035


def test_analysis_preserves_sustained_local_tempo_change(monkeypatch):
    beat_times = np.concatenate(
        [
            0.25 + np.arange(8, dtype=np.float64) * 0.5,
            4.0 + np.arange(12, dtype=np.float64) * 0.25,
            7.25 + np.arange(8, dtype=np.float64) * 0.5,
        ]
    )
    features = _synthetic_timing_features(beat_times, accent_indices=set())
    chord_timeline = [
        _synthetic_chord_segment(
            0.0,
            features.duration_seconds,
            label="C",
            pitch_class=0,
        )
    ]
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_sustained_local_tempo_change.wav"))

    timing = _assert_detected_sorted_timing(analysis["timing"])
    assert len(timing["beats"]) == beat_times.size
    local_tempo_beats = [_beat_near(timing, seconds) for seconds in beat_times[8:12]]
    assert [beat["beat_in_bar"] for beat in local_tempo_beats] == [1, 2, 3, 4]
    assert max(np.diff([beat["seconds"] for beat in local_tempo_beats])) < 0.35


def test_analysis_preserves_one_bar_double_time_phrase(monkeypatch):
    beat_times = np.concatenate(
        [
            0.25 + np.arange(8, dtype=np.float64) * 0.5,
            4.0 + np.arange(8, dtype=np.float64) * 0.25,
            6.25 + np.arange(9, dtype=np.float64) * 0.5,
        ]
    )
    features = _synthetic_timing_features(beat_times, accent_indices=set())
    chord_timeline = [
        _synthetic_chord_segment(
            0.0,
            features.duration_seconds,
            label="C",
            pitch_class=0,
        )
    ]
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_one_bar_double_time_phrase.wav"))

    timing = _assert_detected_sorted_timing(analysis["timing"])
    assert len(timing["beats"]) == beat_times.size
    double_time_beats = [_beat_near(timing, seconds) for seconds in beat_times[8:16]]
    assert [beat["beat_in_bar"] for beat in double_time_beats] == [
        1,
        2,
        3,
        4,
        1,
        2,
        3,
        4,
    ]
    assert max(np.diff([beat["seconds"] for beat in double_time_beats])) < 0.35


def test_analysis_timing_payload_keeps_consumer_fields(monkeypatch):
    beat_times = 0.25 + np.arange(8, dtype=np.float64) * 0.5
    features = _synthetic_timing_features(beat_times, accent_indices=set())
    chord_timeline = [
        _synthetic_chord_segment(
            0.0,
            features.duration_seconds,
            label="C",
            pitch_class=0,
        )
    ]
    _patch_synthetic_analysis(monkeypatch, features, chord_timeline)

    analysis = analyze_track(Path("synthetic_timing_payload.wav"))

    timing = analysis["timing"]
    assert timing is not None
    assert set(timing) == {"beats_per_bar", "source", "beats", "bars"}
    assert timing["beats_per_bar"] == 4
    assert timing["source"] == "detected"
    assert timing["beats"]
    assert timing["bars"]
    assert set(timing["beats"][0]) == {"index", "seconds", "bar_index", "beat_in_bar"}
    assert set(timing["bars"][0]) == {"index", "start_seconds", "end_seconds"}
    assert isinstance(timing["beats"][0]["seconds"], float)
    assert isinstance(timing["beats"][0]["bar_index"], int)
    assert isinstance(timing["beats"][0]["beat_in_bar"], int)
    assert isinstance(timing["bars"][0]["start_seconds"], float)
    _assert_beats_map_to_bar_spans(timing)


def test_analysis_keeps_common_borrowed_chords_in_major_context(tmp_path: Path):
    path = _render_chord_file(
        tmp_path,
        [
            ("F", ["F", "A", "C"]),
            ("Dm", ["D", "F", "A"]),
            ("Gm", ["G", "Bb", "D"]),
            ("C", ["C", "E", "G"]),
            ("F", ["F", "A", "C"]),
            ("Bbm", ["Bb", "Db", "F"]),
        ],
    )

    analysis = analyze_track(path)

    assert analysis["estimated_key"] == "F major"
    assert analysis["key_confidence"] is not None
    assert analysis["key_confidence"] >= 0.5


def _labels(path: Path) -> list[str]:
    return [segment["label"] for segment in detect_chord_timeline(path) if segment["label"] != "N.C."]


def _assert_dynamic_timing_closer_than_static(path: Path, expected_pulses: np.ndarray) -> None:
    analysis = analyze_track(path)
    assert analysis["tempo_bpm"] is not None
    assert analysis["tempo_bpm"] > 0.0
    assert analysis["timing"] is not None
    assert analysis["timing"]["source"] in {"detected", "tempo_fallback"}

    beat_seconds = np.asarray(
        [beat["seconds"] for beat in analysis["timing"]["beats"]],
        dtype=np.float64,
    )
    assert beat_seconds.size >= 8
    assert np.all(np.diff(beat_seconds) > 0.0)

    comparison_pulses = expected_pulses[
        (expected_pulses >= beat_seconds[0] - 0.12)
        & (expected_pulses <= beat_seconds[-1] + 0.12)
    ]
    assert comparison_pulses.size >= 8

    static_beats = _static_tempo_grid(
        tempo_bpm=analysis["tempo_bpm"],
        duration_seconds=float(expected_pulses[-1]),
        start_seconds=float(beat_seconds[0]),
    )
    observed_error = _mean_nearest_beat_error(beat_seconds, comparison_pulses)
    static_error = _mean_nearest_beat_error(static_beats, comparison_pulses)

    assert observed_error + 0.02 < static_error


def _static_tempo_grid(
    *,
    tempo_bpm: float,
    duration_seconds: float,
    start_seconds: float,
) -> np.ndarray:
    beat_interval = 60.0 / tempo_bpm
    return np.arange(
        start_seconds,
        duration_seconds + beat_interval * 0.5,
        beat_interval,
        dtype=np.float64,
    )


def _mean_nearest_beat_error(beat_seconds: np.ndarray, expected_pulses: np.ndarray) -> float:
    return float(
        np.mean([np.min(np.abs(beat_seconds - pulse_time)) for pulse_time in expected_pulses])
    )


def _assert_detected_sorted_timing(
    timing: AnalysisTimingPayload | None,
) -> AnalysisTimingPayload:
    assert timing is not None
    assert timing["source"] == "detected"
    beat_seconds = [beat["seconds"] for beat in timing["beats"]]
    assert beat_seconds == sorted(beat_seconds)
    _assert_beats_map_to_bar_spans(timing)
    return timing


def _beat_near(
    timing: AnalysisTimingPayload,
    seconds: float,
    *,
    tolerance_seconds: float = 0.035,
) -> AnalysisTimingBeatPayload:
    beat = min(timing["beats"], key=lambda candidate: abs(candidate["seconds"] - seconds))
    assert abs(beat["seconds"] - seconds) <= tolerance_seconds
    return beat


def _assert_beats_map_to_bar_spans(timing: AnalysisTimingPayload) -> None:
    assert [bar["index"] for bar in timing["bars"]] == list(range(len(timing["bars"])))
    for beat in timing["beats"]:
        assert beat["bar_index"] >= 0
        assert beat["bar_index"] < len(timing["bars"])
        bar = timing["bars"][beat["bar_index"]]
        assert bar["index"] == beat["bar_index"]
        assert bar["start_seconds"] <= beat["seconds"]
        if beat["bar_index"] == timing["bars"][-1]["index"]:
            assert beat["seconds"] <= bar["end_seconds"]
        else:
            assert beat["seconds"] < bar["end_seconds"]


def _patch_synthetic_analysis(
    monkeypatch,
    features: HarmonicFeatures,
    chord_timeline: list[ChordSegment],
) -> None:
    monkeypatch.setattr(analysis_engine, "extract_harmonic_features", lambda _path: features)
    monkeypatch.setattr(
        analysis_engine,
        "detect_chords_from_features",
        lambda _features: chord_timeline,
    )


def _synthetic_timing_features(
    beat_times: np.ndarray,
    *,
    accent_indices: set[int],
) -> HarmonicFeatures:
    duration_seconds = float(beat_times[-1] + 0.6)
    frame_seconds = ANALYSIS_HOP_LENGTH / ANALYSIS_SAMPLE_RATE
    frame_count = int(np.ceil(duration_seconds / frame_seconds)) + 1
    times = np.arange(frame_count, dtype=np.float64) * frame_seconds
    beat_frames = np.asarray(
        [int(np.argmin(np.abs(times - seconds))) for seconds in beat_times],
        dtype=np.int64,
    )
    rms = np.full(frame_count, 0.12, dtype=np.float32)
    for index, beat_frame in enumerate(beat_frames.tolist()):
        start_frame = max(0, beat_frame - 1)
        end_frame = min(frame_count, beat_frame + 2)
        rms[start_frame:end_frame] = 0.85 if index in accent_indices else 0.28

    timeline = np.linspace(
        0.0,
        duration_seconds,
        int(ANALYSIS_SAMPLE_RATE * duration_seconds),
        endpoint=False,
    )
    accent_times = (
        beat_times[sorted(accent_indices)] if accent_indices else np.zeros(0, dtype=np.float64)
    )
    percussive_signal = (
        _pulse_train_at_times(timeline, beat_times, amplitude=0.18)
        + _pulse_train_at_times(timeline, accent_times, amplitude=0.48)
    ).astype(np.float32)
    chroma = np.zeros((12, frame_count), dtype=np.float32)

    return HarmonicFeatures(
        signal=percussive_signal,
        harmonic_signal=np.zeros_like(percussive_signal),
        percussive_signal=percussive_signal,
        sample_rate=ANALYSIS_SAMPLE_RATE,
        hop_length=ANALYSIS_HOP_LENGTH,
        duration_seconds=duration_seconds,
        chroma_cqt=chroma,
        chroma_cens=chroma,
        rms=rms,
        times=times,
        active_frame_mask=np.ones(frame_count, dtype=bool),
        beat_frames=beat_frames,
        tempo_bpm=120.0,
        estimated_reference_hz=None,
        tuning_offset_cents=None,
        tuning_bins=None,
    )


def _synthetic_chord_timeline(
    beat_times: np.ndarray,
    *,
    downbeat_offset: int,
    duration_seconds: float,
) -> list[ChordSegment]:
    downbeat_times = beat_times[downbeat_offset::4]
    boundaries = [0.0, *downbeat_times.tolist(), duration_seconds]
    chords = [
        ("G", 7),
        ("C", 0),
        ("F", 5),
        ("G", 7),
        ("C", 0),
        ("F", 5),
    ]
    return [
        _synthetic_chord_segment(
            float(start_seconds),
            float(end_seconds),
            label=chords[index % len(chords)][0],
            pitch_class=chords[index % len(chords)][1],
        )
        for index, (start_seconds, end_seconds) in enumerate(
            zip(boundaries[:-1], boundaries[1:], strict=True)
        )
        if end_seconds > start_seconds
    ]


def _synthetic_chord_segment(
    start_seconds: float,
    end_seconds: float,
    *,
    label: str,
    pitch_class: int,
) -> ChordSegment:
    return {
        "start_seconds": round(start_seconds, 6),
        "end_seconds": round(end_seconds, 6),
        "label": label,
        "confidence": 0.95,
        "pitch_class": pitch_class,
        "quality": "major",
    }


def _render_chord_file(
    tmp_path: Path,
    chords: list[tuple[str, list[str]]],
    *,
    segment_duration: float = 1.5,
    cents: float = 0.0,
    noise: bool = False,
    percussion: bool = False,
    pulse_bpm: float | None = None,
    bass_notes: list[str | None] | None = None,
) -> Path:
    ratio = 2.0 ** (cents / 1200.0)
    rng = np.random.default_rng(7)
    rendered_segments: list[np.ndarray] = []
    for index, (label, notes) in enumerate(chords):
        timeline = np.linspace(
            0,
            segment_duration,
            int(SAMPLE_RATE * segment_duration),
            endpoint=False,
        )
        envelope = np.ones_like(timeline)
        fade_in = min(int(SAMPLE_RATE * 0.03), max(1, envelope.size // 4))
        fade_out = min(int(SAMPLE_RATE * 0.08), max(1, envelope.size // 4))
        envelope[:fade_in] = np.linspace(0.0, 1.0, fade_in, endpoint=False)
        envelope[-fade_out:] = np.linspace(1.0, 0.0, fade_out, endpoint=False)

        signal = np.zeros_like(timeline)
        bass_note = bass_notes[index] if bass_notes and index < len(bass_notes) else _root_note(label, notes)
        if bass_note:
            root_frequency = NOTE_FREQUENCIES[bass_note] * ratio
            signal += 0.12 * np.sin(2 * np.pi * (root_frequency / 2.0) * timeline)
        for note in notes:
            frequency = NOTE_FREQUENCIES[note] * ratio
            signal += 0.16 * np.sin(2 * np.pi * frequency * timeline)
            signal += 0.05 * np.sin(2 * np.pi * frequency * 2.0 * timeline)
            signal += 0.02 * np.sin(2 * np.pi * frequency * 3.0 * timeline)
        if percussion:
            signal += _pulse_train(timeline, pulse_bpm or 120.0)
        if noise:
            signal += 0.025 * rng.normal(size=timeline.shape)
        rendered_segments.append((signal * envelope).astype(np.float32))

    output_path = tmp_path / "analysis_fixture.wav"
    sf.write(output_path, np.concatenate(rendered_segments), SAMPLE_RATE)
    return output_path


def _render_dynamic_pulse_file(
    tmp_path: Path,
    *,
    start_bpm: float,
    end_bpm: float,
    duration_seconds: float = 10.0,
) -> tuple[Path, np.ndarray]:
    timeline = np.linspace(
        0,
        duration_seconds,
        int(SAMPLE_RATE * duration_seconds),
        endpoint=False,
    )
    expected_pulses = _dynamic_pulse_times(
        start_bpm=start_bpm,
        end_bpm=end_bpm,
        duration_seconds=duration_seconds,
    )

    signal = np.zeros_like(timeline)
    for note in ("C", "E", "G"):
        frequency = NOTE_FREQUENCIES[note]
        signal += 0.035 * np.sin(2 * np.pi * frequency * timeline)
        signal += 0.012 * np.sin(2 * np.pi * frequency * 2.0 * timeline)
    signal += _pulse_train_at_times(timeline, expected_pulses, amplitude=0.5)

    peak = float(np.max(np.abs(signal)))
    if peak > 0.0:
        signal = 0.85 * signal / peak

    output_path = tmp_path / f"dynamic_tempo_{int(start_bpm)}_{int(end_bpm)}.wav"
    sf.write(output_path, signal.astype(np.float32), SAMPLE_RATE)
    return output_path, expected_pulses


def _dynamic_pulse_times(
    *,
    start_bpm: float,
    end_bpm: float,
    duration_seconds: float,
) -> np.ndarray:
    pulse_times: list[float] = []
    current_seconds = 0.0
    while current_seconds <= duration_seconds:
        pulse_times.append(current_seconds)
        progress = min(1.0, current_seconds / duration_seconds)
        bpm = start_bpm + (end_bpm - start_bpm) * progress
        current_seconds += 60.0 / bpm
    return np.asarray(pulse_times, dtype=np.float64)


def _root_note(label: str, notes: list[str]) -> str:
    for note in NOTE_FREQUENCIES:
        if label.startswith(note):
            return note
    return notes[0]


def _pulse_train(timeline: np.ndarray, bpm: float) -> np.ndarray:
    interval = 60.0 / bpm
    pulse = np.zeros_like(timeline)
    for start in np.arange(0.0, float(timeline[-1]) + interval, interval):
        distance = np.abs(timeline - start)
        pulse += 0.18 * np.exp(-((distance / 0.012) ** 2))
    return pulse


def _pulse_train_at_times(
    timeline: np.ndarray,
    pulse_times: np.ndarray,
    *,
    amplitude: float = 0.18,
) -> np.ndarray:
    pulse = np.zeros_like(timeline)
    for start in pulse_times:
        distance = np.abs(timeline - start)
        pulse += amplitude * np.exp(-((distance / 0.012) ** 2))
    return pulse
