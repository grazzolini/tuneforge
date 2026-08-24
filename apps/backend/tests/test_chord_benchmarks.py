from __future__ import annotations

import hashlib
import json
import math
import wave
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.benchmarks.chord_evaluation import (
    ManifestError,
    QualityTrack,
    aggregate_scores,
    cleanup_synthetic_tracks,
    load_manifest,
    load_public_manifest,
    match_boundaries,
    project_chord,
    score_sequence,
    score_timeline,
    synthetic_tracks,
)
from app.benchmarks.chords import build_quality_report, main


def _timeline(*labels: str) -> list[dict[str, Any]]:
    return [
        {"start_seconds": float(index), "end_seconds": float(index + 1), "label": label}
        for index, label in enumerate(labels)
    ]


def test_projection_is_scorer_owned_and_normalizes_chord_equivalences() -> None:
    assert project_chord("C13") == project_chord("C:13")
    assert project_chord("Cmaj9") == project_chord("C:maj9")
    assert project_chord("Cm9") == project_chord("C:min9")
    assert project_chord("C5") == project_chord("C:(5)")
    assert project_chord("C:maj/3").bass == 4
    assert project_chord("Cadd9/E").bass == 4
    assert project_chord("C:hdim7") == project_chord("Cm7b5")
    assert project_chord("C:(1,b3,b5,b7)") == project_chord("C:hdim7")
    assert project_chord("N.C.").no_chord is True
    assert project_chord("not-a-chord").root is None


def test_timeline_scoring_clamps_predictions_and_matches_boundaries() -> None:
    score = score_timeline(
        _timeline("C", "G"),
        [{"start_seconds": -2, "end_seconds": 1, "label": "C"}, {"start_seconds": 1, "end_seconds": 9, "label": "G"}],
    )
    assert score["root"] == 1.0
    assert score["boundary"] == {"matched": 1, "reference": 1, "prediction": 1}
    assert match_boundaries([1.0], [1.24]) == (1, 0, 0)
    assert match_boundaries([1.0], [1.251]) == (0, 1, 1)
    assert match_boundaries([0.2, 0.5], [0.0, 0.3]) == (2, 0, 0)


def test_prediction_nonfinite_times_fail_before_clamping() -> None:
    with pytest.raises(ManifestError, match="prediction_timing_invalid"):
        score_timeline(_timeline("C"), [{"start_seconds": math.nan, "end_seconds": math.inf, "label": "C"}])


def test_reference_rejects_gaps_except_explicit_no_chord_segments() -> None:
    with pytest.raises(ManifestError, match="reference_timeline_invalid"):
        score_timeline(
            [
                {"start_seconds": 0, "end_seconds": 1, "label": "C"},
                {"start_seconds": 1.1, "end_seconds": 2, "label": "N.C."},
            ],
            _timeline("C", "N.C."),
        )


def test_no_chord_and_source_unsupported_capabilities_are_explicit() -> None:
    score = score_timeline(
        _timeline("N.C.", "C"),
        _timeline("N.C.", "C"),
        bass_scoreable=False,
        extension_scoreable=False,
    )
    assert score["nc"]["correct_seconds"] == 1.0
    assert score["bass"] is None and score["bass_reason"]
    assert score["seventh_extension"] is None and score["seventh_extension_reason"]
    aggregate = aggregate_scores([score])
    assert aggregate["nc_precision"] == aggregate["nc_recall"] == 1.0


def test_capability_limited_backend_is_still_scored_and_unknown_is_not_no_chord() -> None:
    score = score_timeline(_timeline("N.C.", "C13"), [{"start_seconds": 0, "end_seconds": 2, "label": "X"}])
    assert score["root"] == 0.0
    assert score["seventh_extension"] == 0.0
    assert score["bass"] == 0.0


def test_projection_mapping_raw_labels_and_harte_degree_sets_preserve_extensions() -> None:
    for label, coarse in (("C13", "major"), ("Cmaj9", "major"), ("Cm9", "minor"), ("C5", "major")):
        assert project_chord({"raw_label": label, "quality": coarse, "root_pitch_class": 0}) == project_chord(label)
    assert project_chord("C:(1,3,5,b7,9,13)") == project_chord("C13")
    assert project_chord("C:(1,3,5,7,9)") == project_chord("Cmaj9")
    assert project_chord("C:(1,b3,5,b7,9)") == project_chord("Cm9")
    assert project_chord("C:(1,5)") == project_chord("C5")
    assert project_chord("C:(1,5,b7)").extension == "7"
    assert project_chord("C:13/13").bass == 9
    assert project_chord("C:maj/#11").bass == 6
    assert project_chord("C:maj/b10").bass == 3


def test_untimed_sequence_is_separate_from_timeline_metrics() -> None:
    score = score_sequence(["C", "C", "G"], ["C", "G"])
    assert score["sequence_edit_similarity"] == 1.0
    assert score["root"] is None
    assert score["timeline_reason"] == "untimed_reference"


def test_pooled_aggregation_and_metric_bounds() -> None:
    perfect = score_timeline(_timeline("C"), _timeline("C"))
    wrong = score_timeline(_timeline("C", "G"), _timeline("F", "F"))
    aggregate = aggregate_scores([perfect, wrong, score_sequence(["C"], ["G"])])
    assert aggregate["timeline_track_count"] == 2
    assert aggregate["sequence_track_count"] == 1
    for value in (
        aggregate["root"],
        aggregate["quality"],
        aggregate["boundary_f1_250ms"],
        aggregate["nc_precision"],
        aggregate["nc_recall"],
        aggregate["sequence_edit_similarity"],
    ):
        assert value is None or 0 <= value <= 1
    assert aggregate["correction_proxy_per_minute"] is not None


def test_external_manifest_fails_closed_on_bad_hash_and_preserves_source(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    data_root.mkdir()
    audio = data_root / "secret-input.wav"
    audio.write_bytes(b"source bytes")
    before = audio.stat().st_mtime_ns
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "chord-quality-manifest-v1",
                "dataset": "external",
                "tracks": [
                    {
                        "audio": "secret-input.wav",
                        "sha256": "0" * 64,
                        "strata": ["full-mix"],
                        "timeline": _timeline("C"),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ManifestError, match="manifest_audio_hash_invalid"):
        load_manifest(manifest, data_root)
    assert audio.read_bytes() == b"source bytes"
    assert audio.stat().st_mtime_ns == before


def test_quality_cli_hides_manifest_identifiers_and_labels(tmp_path: Path, monkeypatch, capsys) -> None:
    data_root = tmp_path / "data"
    data_root.mkdir()
    audio = data_root / "very-secret-input.wav"
    audio.write_bytes(b"source bytes")
    digest = hashlib.sha256(audio.read_bytes()).hexdigest()
    manifest = tmp_path / "private-manifest-name.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "chord-quality-manifest-v1",
                "dataset": "external",
                "tracks": [{"audio": audio.name, "sha256": digest, "strata": ["full-mix"], "timeline": _timeline("C")}],
            }
        ),
        encoding="utf-8",
    )
    _patch_quality_backend(monkeypatch)
    assert (
        main(["--quality-manifest", str(manifest), "--data-root", str(data_root), "--backend", "fast", "--json-only"])
        == 0
    )
    captured = capsys.readouterr()
    assert "secret" not in captured.out.lower()
    assert "private" not in captured.out.lower()
    assert "very-secret" not in captured.err.lower()
    assert "audio_path" not in captured.out
    assert "dataset_001" in captured.out
    assert '"external"' not in captured.out


def test_quality_cli_non_json_summary_is_anonymous(monkeypatch, capsys) -> None:
    _patch_quality_backend(monkeypatch)
    assert main(["--quality-synthetic", "--backend", "fast"]) == 0
    captured = capsys.readouterr()
    assert "Chord quality benchmark" in captured.err
    assert "fixture" not in captured.out.lower()


def test_quality_materializes_once_per_track_and_cleans_synthetic_pcm(monkeypatch) -> None:
    seen: list[Path] = []

    @contextmanager
    def materialize(path: Path):
        seen.append(path)
        yield path

    _patch_quality_backend(monkeypatch)
    monkeypatch.setattr("app.benchmarks.chords.materialize_pcm_wav", materialize)
    first = build_quality_report(synthetic=True, manifest_paths=[], data_root=None, backend_ids=["tuneforge-fast"])
    second = build_quality_report(synthetic=True, manifest_paths=[], data_root=None, backend_ids=["tuneforge-fast"])
    assert first == second
    assert len(seen) == 6
    assert all(not path.exists() for path in seen)


def test_synthetic_chords_render_distinct_harmonic_windows() -> None:
    tracks = synthetic_tracks()
    try:
        with wave.open(str(tracks[1].audio_path), "rb") as handle:
            c13 = handle.readframes(400)
            handle.setpos(3 * 8_000)
            power = handle.readframes(400)
        assert c13 != power
    finally:
        cleanup_synthetic_tracks(tracks)


def test_materialization_failures_are_sanitized_and_continue(monkeypatch, capsys) -> None:
    @contextmanager
    def broken_materialize(path: Path):
        raise RuntimeError(f"private-source-sentinel:{path}")
        yield path

    _patch_quality_backend(monkeypatch)
    monkeypatch.setattr("app.benchmarks.chords.materialize_pcm_wav", broken_materialize)
    assert main(["--quality-synthetic", "--backend", "fast", "--json-only"]) == 0
    captured = capsys.readouterr()
    assert "private-source-sentinel" not in captured.out + captured.err
    assert json.loads(captured.out)["results"][0]["error_count"] == 3


def test_report_has_overall_dataset_and_stratum_aggregates(monkeypatch) -> None:
    tracks = [
        QualityTrack(
            "alpha",
            "track_001",
            ("synthetic",),
            Path("/tmp/a.wav"),
            _timeline("C"),
            True,
            True,
            True,
            public_provenance={"dataset": "alpha", "version": "1", "license": "CC BY 4.0", "source": "https://safe"},
        ),
        QualityTrack("beta", "track_002", ("full-mix",), Path("/tmp/b.wav"), _timeline("G"), True, True, False),
    ]

    @contextmanager
    def materialize(path: Path):
        yield path

    _patch_quality_backend(monkeypatch)
    monkeypatch.setattr("app.benchmarks.chords.synthetic_tracks", lambda: tracks)
    monkeypatch.setattr("app.benchmarks.chords.cleanup_synthetic_tracks", lambda _: None)
    monkeypatch.setattr("app.benchmarks.chords.materialize_pcm_wav", materialize)
    report = build_quality_report(synthetic=True, manifest_paths=[], data_root=None, backend_ids=["tuneforge-fast"])
    result = report["results"][0]
    assert result["aggregate"]["track_count"] == 2
    assert set(result["datasets"]) == {"alpha", "beta"}
    assert result["datasets"]["alpha"]["strata"]["synthetic"]["track_count"] == 1
    assert result["datasets"]["alpha"]["provenance"]["license"] == "CC BY 4.0"
    aggregate = result["aggregate"]
    assert aggregate["bass_reason"] == "partial_metric_support"
    assert aggregate["bass_support_track_count"] == 1
    assert aggregate["segment_count_absolute_error"] >= 0


def test_unsafe_backend_provenance_is_dropped_from_quality_report(monkeypatch) -> None:
    _patch_quality_backend(monkeypatch)
    monkeypatch.setattr(
        "app.benchmarks.chords.detect_with_chord_backend",
        lambda *_args, **_kwargs: SimpleNamespace(
            segments=_timeline("C", "G", "Am", "F"),
            metadata={"engine": "/private/source/path", "crema_version": "secret-build"},
        ),
    )
    report = build_quality_report(synthetic=True, manifest_paths=[], data_root=None, backend_ids=["tuneforge-fast"])
    assert report["results"][0]["provenance"] == {}


def test_vendored_public_manifest_pins_are_strict() -> None:
    root = Path(__file__).parents[1] / "app" / "benchmarks" / "manifests"
    for name in ("guitarset-1.1.0.json", "tiny-aam-1.1.0.json"):
        payload = json.loads((root / name).read_text(encoding="utf-8"))
        assert payload["schema_version"] == "chord-public-manifest-v1"
        assert payload["dataset_version"] == "1.1.0"
        assert payload["license"] == "CC BY 4.0"
        assert payload["data_subdir"] in {"guitarset", "tiny-aam"}
        assert payload["selection"]["count"] == 6
        assert all(len(pin["checksum"]) == 32 for pin in payload["archive_pins"])
        selected = payload["selection"].get("selected_annotations", payload["selection"].get("selected_assets"))
        assert isinstance(selected, list) and len(selected) == 6
        for asset in selected:
            assert all(len(value) == 64 for key, value in asset.items() if key.endswith("sha256"))
    guitarset = json.loads((root / "guitarset-1.1.0.json").read_text(encoding="utf-8"))
    assert guitarset["safe_strata"] == ["solo-guitar", "accompaniment"]


def test_public_manifest_data_subdirs_resolve_two_fake_corpora_with_timed_aam(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "corpora"
    guitar = root / "guitarset"
    tiny = root / "tiny-aam"
    guitar_annotations, guitar_audio = guitar / "annotations", guitar / "audio"
    tiny_audio, tiny_annotations = tiny / "audio-mixes-mp3", tiny / "annotations"
    for directory in (guitar_annotations, guitar_audio, tiny_audio, tiny_annotations):
        directory.mkdir(parents=True, exist_ok=True)
    guitar_names = ["a_solo", "b_comp", "c_solo", "d_comp", "e_solo", "f_comp"]
    for name in guitar_names:
        (guitar_annotations / f"{name}.jams").write_text(
            json.dumps(
                {
                    "annotations": [
                        {
                            "namespace": "chord",
                            "annotation_metadata": {"data_source": "manual verification"},
                            "data": [{"time": 0, "duration": 1, "value": "C"}],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        _write_fake_wav(guitar_audio / f"{name}_mic.wav")
    tiny_ids = ["0001", "0002", "0003", "0004", "0005", "0006"]
    for identifier in tiny_ids:
        _write_fake_wav(tiny_audio / f"{identifier}_mix.mp3")
        (tiny_annotations / f"{identifier}_beatinfo.arff").write_text("0,x,x,C\n0.5,x,x,G\n", encoding="utf-8")
        (tiny_annotations / f"{identifier}_segments.arff").write_text("", encoding="utf-8")
    monkeypatch.setattr("app.benchmarks.chord_evaluation._sha256", lambda _: "pinned")
    guitar_paths = sorted(
        guitar_annotations.glob("*.jams"), key=lambda path: hashlib.sha256(path.name.encode()).digest()
    )
    tiny_paths = sorted(tiny_audio.glob("*_mix.mp3"), key=lambda path: hashlib.sha256(path.name.encode()).digest())
    monkeypatch.setattr(
        "app.benchmarks.chord_evaluation._public_selection_pins",
        lambda _payload, name, _keys: (
            [{"basename": path.stem, "sha256": "pinned", "audio_sha256": "pinned"} for path in guitar_paths]
            if name == "selected_annotations"
            else [
                {
                    "id": path.stem.removesuffix("_mix"),
                    "audio_sha256": "pinned",
                    "beatinfo_sha256": "pinned",
                    "segments_sha256": "pinned",
                }
                for path in tiny_paths
            ]
        ),
    )
    guitar_manifest = _fake_public_manifest("guitarset", "guitarset-jams-v1")
    tiny_manifest = _fake_public_manifest("tiny-aam", "tiny-aam-arff-v1")
    guitar_path, tiny_path = tmp_path / "guitar.json", tmp_path / "tiny.json"
    guitar_path.write_text(json.dumps(guitar_manifest), encoding="utf-8")
    tiny_path.write_text(json.dumps(tiny_manifest), encoding="utf-8")
    guitar_tracks = load_public_manifest(guitar_path, root)
    tiny_tracks = load_public_manifest(tiny_path, root)
    assert {track.strata[0] for track in guitar_tracks} == {"solo-guitar", "accompaniment"}
    assert all(track.timeline and not track.bass_scoreable for track in tiny_tracks)
    assert all(track.reference[-1]["end_seconds"] == 1.0 for track in tiny_tracks)


def _fake_public_manifest(subdir: str, adapter: str) -> dict[str, Any]:
    return {
        "schema_version": "chord-public-manifest-v1",
        "dataset": subdir,
        "dataset_version": "1.1.0",
        "license": "CC BY 4.0",
        "official_source": "https://doi.org/10.5281/zenodo.1",
        "adapter": adapter,
        "data_subdir": subdir,
        "archive_pins": [{"checksum_algorithm": "md5", "checksum": "0" * 32, "bytes": 1}],
        "selection": {"count": 6, "rule": "fake"},
    }


def _write_fake_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8_000)
        handle.writeframes(b"\0\0" * 8_000)


def _patch_quality_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = SimpleNamespace(
        id="tuneforge-fast",
        label="Built-in Chords",
        capabilities=SimpleNamespace(supports_sevenths=True, supports_inversions=False),
        availability=lambda: SimpleNamespace(available=True),
    )
    monkeypatch.setattr("app.benchmarks.chords.resolve_chord_backend", lambda *_args, **_kwargs: backend)
    monkeypatch.setattr(
        "app.benchmarks.chords.detect_with_chord_backend",
        lambda *_args, **_kwargs: SimpleNamespace(segments=_timeline("C", "G", "Am", "F"), metadata={"engine": "test"}),
    )
