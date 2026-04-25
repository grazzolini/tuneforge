from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from app.engines.analysis import analyze_track
from app.engines.chords import detect_chord_timeline

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
