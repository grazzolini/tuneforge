from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Any

from app.benchmarks.chords import main as benchmark_main
from app.engines.chord_labels import chord_label_to_segment, parse_chord_label
from app.engines.crema_chords import crema_annotation_to_timeline, detect_crema_chord_timeline
from app.services.chord_backends import list_chord_backend_infos, resolve_chord_backend


class FakeDataFrame:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def to_dict(self, orient: str) -> list[dict[str, Any]]:
        assert orient == "records"
        return self.rows


class FakeAnnotation:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def to_dataframe(self) -> FakeDataFrame:
        return FakeDataFrame(self.rows)


def test_chord_label_parser_handles_harte_sevenths_and_inversions():
    parsed = parse_chord_label("D:maj/3")
    assert parsed.root_pitch_class == 2
    assert parsed.quality == "major"
    assert parsed.bass_pitch_class == 6
    assert parsed.bass_degree == "3"
    assert parsed.display_label == "D/F#"

    segment = chord_label_to_segment("C:min/5", start_seconds=0, end_seconds=2, confidence=0.72)
    assert segment["label"] == "Cm/G"
    assert segment["quality"] == "minor"
    assert segment["bass_pitch_class"] == 7
    assert segment["raw_label"] == "C:min/5"

    assert chord_label_to_segment("C:maj7", start_seconds=0, end_seconds=1)["quality"] == "maj7"
    assert chord_label_to_segment("C:min7", start_seconds=0, end_seconds=1)["label"] == "Cm7"
    assert chord_label_to_segment("C:min7(b5)", start_seconds=0, end_seconds=1)["label"] == "Cm7b5"


def test_chord_label_parser_handles_no_chord_and_unknown():
    no_chord = chord_label_to_segment("N", start_seconds=1.0, end_seconds=2.0)
    assert no_chord["label"] == "N.C."
    assert no_chord["quality"] == "no_chord"
    assert no_chord["pitch_class"] is None

    unknown = chord_label_to_segment("X", start_seconds=1.0, end_seconds=2.0)
    assert unknown["label"] == "X"
    assert unknown["quality"] is None


def test_crema_annotation_conversion_preserves_confidence_and_bass():
    annotation = FakeAnnotation(
        [
            {"time": 0.0, "duration": 1.5, "value": "D:maj/3", "confidence": 0.81},
            {"time": 1.5, "duration": 1.0, "value": "N", "confidence": 0.2},
        ]
    )

    timeline = crema_annotation_to_timeline(annotation)

    assert timeline[0] == {
        "start_seconds": 0.0,
        "end_seconds": 1.5,
        "label": "D/F#",
        "display_label": "D/F#",
        "raw_label": "D:maj/3",
        "confidence": 0.81,
        "pitch_class": 2,
        "root_pitch_class": 2,
        "quality": "major",
        "bass_pitch_class": 6,
        "bass_degree": "3",
    }
    assert timeline[1]["label"] == "N.C."
    assert timeline[1]["quality"] == "no_chord"


def test_crema_detection_suppresses_known_runtime_noise(monkeypatch, capsys, recwarn):
    class FakeModel:
        def predict(self, filename: str):
            assert filename == "/tmp/source.wav"
            print("1/1 [==============================] - 1s 512ms/step")
            warnings.warn(
                "get_duration() keyword argument 'filename' has been renamed to 'path' in version 0.10.0.",
                FutureWarning,
                stacklevel=2,
            )
            return FakeAnnotation([{"time": 0.0, "duration": 1.0, "value": "C:maj", "confidence": 0.7}])

    monkeypatch.setattr("app.engines.crema_chords._get_crema_model", lambda: FakeModel())

    timeline = detect_crema_chord_timeline(Path("/tmp/source.wav"))

    captured = capsys.readouterr()
    assert captured.out == ""
    assert len(recwarn) == 0
    assert timeline[0]["label"] == "C"


def test_crema_backend_reports_tensorflow_runtime_device(monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords.importlib.util.find_spec", lambda _: object())
    monkeypatch.setattr(
        "app.services.chord_backends.detect_crema_chord_timeline",
        lambda _: [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    )
    monkeypatch.setattr("app.services.chord_backends.crema_runtime_device", lambda: "cuda")

    backend = resolve_chord_backend("crema-advanced", require_available=True)
    result = backend.detect(Path("/tmp/source.wav"))

    assert result.runtime_device == "cuda"
    assert result.metadata["runtime_device"] == "cuda"


def test_backend_registry_reports_fast_and_missing_crema(monkeypatch):
    def fake_find_spec(module_name: str):
        return None if module_name == "crema" else object()

    monkeypatch.setattr("app.engines.crema_chords.importlib.util.find_spec", fake_find_spec)

    backends = {backend["id"]: backend for backend in list_chord_backend_infos()}

    assert backends["tuneforge-fast"]["availability"] == "available"
    assert backends["tuneforge-fast"]["capabilities"]["supports_sevenths"] is True
    assert backends["crema-advanced"]["availability"] == "unavailable"
    assert backends["crema-advanced"]["unavailable_reason"] == "crema is not installed"


def test_resolving_missing_advanced_backend_returns_structured_error(monkeypatch):
    def fake_find_spec(module_name: str):
        return None if module_name == "crema" else object()

    monkeypatch.setattr("app.engines.crema_chords.importlib.util.find_spec", fake_find_spec)

    backend = resolve_chord_backend("crema-advanced")
    assert backend.availability().available is False


def test_crema_backend_detects_keras_three_incompatibility(monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords.importlib.util.find_spec", lambda _: object())

    def fake_version(package_name: str) -> str:
        versions = {"keras": "3.14.0", "scikit-learn": "1.5.2"}
        return versions.get(package_name, "0.2.0")

    monkeypatch.setattr(
        "app.engines.crema_chords.importlib.metadata.version",
        fake_version,
    )

    backend = resolve_chord_backend("crema-advanced")
    availability = backend.availability()

    assert availability.available is False
    assert availability.unavailable_reason == (
        "crema 0.2.0 is incompatible with installed Keras 3.14.0; install Keras < 3"
    )


def test_crema_backend_detects_scikit_learn_incompatibility(monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords.importlib.util.find_spec", lambda _: object())

    def fake_version(package_name: str) -> str:
        versions = {"keras": "2.15.0", "scikit-learn": "1.8.0"}
        return versions.get(package_name, "0.2.0")

    monkeypatch.setattr(
        "app.engines.crema_chords.importlib.metadata.version",
        fake_version,
    )

    backend = resolve_chord_backend("crema-advanced")
    availability = backend.availability()

    assert availability.available is False
    assert availability.unavailable_reason == (
        "crema 0.2.0 is incompatible with installed scikit-learn 1.8.0; install scikit-learn < 1.6"
    )


def test_chord_backends_api_marks_crema_unavailable(client, monkeypatch):
    def fake_find_spec(module_name: str):
        return None if module_name == "crema" else object()

    monkeypatch.setattr("app.engines.crema_chords.importlib.util.find_spec", fake_find_spec)

    response = client.get("/api/v1/chord-backends")

    assert response.status_code == 200
    payload = response.json()
    backends = {backend["id"]: backend for backend in payload["backends"]}
    assert backends["tuneforge-fast"]["availability"] == "available"
    assert backends["crema-advanced"]["availability"] == "unavailable"
    assert backends["crema-advanced"]["unavailable_reason"] == "crema is not installed"
    assert backends["crema-advanced"]["capabilities"]["supportsSevenths"] is True
    assert backends["crema-advanced"]["desktopOnly"] is True


def test_advanced_chords_request_fails_if_crema_missing(client, sample_chord_audio_file: Path, monkeypatch):
    def fake_find_spec(module_name: str):
        return None if module_name == "crema" else object()

    monkeypatch.setattr("app.engines.crema_chords.importlib.util.find_spec", fake_find_spec)
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.post(
        f"/api/v1/projects/{project['id']}/chords",
        json={"backend": "crema-advanced", "force": True},
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["error"]["code"] == "ADVANCED_CHORD_BACKEND_UNAVAILABLE"
    assert payload["error"]["message"] == "crema is not installed"


def test_chord_benchmark_command_emits_json(sample_chord_audio_file: Path, capsys):
    exit_code = benchmark_main(["--audio", str(sample_chord_audio_file), "--backend", "tuneforge-fast", "--json-only"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert exit_code == 0
    assert payload["results"][0]["backend_id"] == "tuneforge-fast"
    assert payload["results"][0]["available"] is True
    assert payload["results"][0]["number_of_chord_segments"] >= 1
