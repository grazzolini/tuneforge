from __future__ import annotations

import json
from pathlib import Path

from app.benchmarks.chords import main as benchmark_main
from app.engines.chord_labels import chord_label_to_segment, parse_chord_label
from app.engines.crema_chords import detect_crema_chord_timeline
from app.services.chord_backends import (
    list_chord_backend_infos,
    resolve_chord_backend,
    resolve_chord_backend_id,
)


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


def test_crema_detection_uses_onnx_and_reports_cpu(monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords._module_available", lambda _name: True)
    monkeypatch.setattr(
        "app.engines.crema_chords.detect_crema_onnx_timeline",
        lambda path: [{"start_seconds": 0.0, "end_seconds": 1.0, "label": path.stem}],
    )
    assert detect_crema_chord_timeline(Path("/tmp/source.wav"))[0]["label"] == "source"
    backend = resolve_chord_backend("crema-advanced", require_available=True)
    monkeypatch.setattr(
        "app.services.chord_backends.detect_crema_chord_timeline",
        lambda _: [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    )
    monkeypatch.setattr(
        "app.services.chord_backends.crema_model_metadata",
        lambda: {"implementation": "crema-onnx"},
    )
    result = backend.detect(Path("/tmp/source.wav"))
    assert result.runtime_device == "cpu"
    assert result.metadata["implementation"] == "crema-onnx"
    assert result.metadata["runtime_device"] == "cpu"


def test_backend_registry_reports_fast_and_missing_crema(monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords._module_available", lambda _name: False)

    backends = {backend["id"]: backend for backend in list_chord_backend_infos()}

    assert backends["tuneforge-fast"]["availability"] == "available"
    assert backends["tuneforge-fast"]["capabilities"]["supports_sevenths"] is True
    assert backends["crema-advanced"]["availability"] == "unavailable"
    assert backends["crema-advanced"]["unavailable_reason"] == "ONNX Runtime is not installed"


def test_crema_backend_labels_onnx_when_runtime_is_available(monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords._module_available", lambda _name: True)
    onnx = {backend["id"]: backend for backend in list_chord_backend_infos()}["crema-advanced"]
    assert onnx["availability"] == "available"
    assert onnx["label"] == "Advanced Chords — Crema ONNX"


def test_default_chord_backend_prefers_crema_when_available(monkeypatch):
    monkeypatch.setattr("app.services.chord_backends.crema_dependency_status", lambda **_kwargs: (True, None))

    assert resolve_chord_backend_id("default") == "crema-advanced"
    assert resolve_chord_backend_id(None) == "crema-advanced"


def test_default_chord_backend_falls_back_when_crema_unavailable(monkeypatch):
    monkeypatch.setattr(
        "app.services.chord_backends.crema_dependency_status",
        lambda **_kwargs: (False, "crema is not installed"),
    )

    assert resolve_chord_backend_id("default") == "tuneforge-fast"
    assert resolve_chord_backend_id(None) == "tuneforge-fast"


def test_lv_chordia_alias_resolves_without_changing_default(monkeypatch):
    monkeypatch.setattr(
        "app.services.chord_backends.crema_dependency_status",
        lambda **_kwargs: (True, None),
    )
    monkeypatch.setattr(
        "app.services.chord_backends.lv_chordia_dependency_status",
        lambda **_kwargs: (True, None),
    )

    assert resolve_chord_backend_id("lv-chordia") == "lv-chordia-submission"
    assert resolve_chord_backend("lv-chordia", require_available=True).id == "lv-chordia-submission"
    assert resolve_chord_backend_id("default") == "crema-advanced"


def test_lv_chordia_registry_reports_damaged_bundle(monkeypatch):
    monkeypatch.setattr(
        "app.services.chord_backends.lv_chordia_dependency_status",
        lambda **_kwargs: (False, "Bundled LV Chordia checkpoint is sha256; reinstall TuneForge"),
    )

    backends = {backend["id"]: backend for backend in list_chord_backend_infos()}

    assert backends["lv-chordia-submission"]["availability"] == "unavailable"
    assert "reinstall TuneForge" in backends["lv-chordia-submission"]["unavailable_reason"]


def test_resolving_missing_advanced_backend_returns_structured_error(monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords._module_available", lambda _name: False)

    backend = resolve_chord_backend("crema-advanced")
    assert backend.availability().available is False


def test_chord_backends_api_marks_crema_unavailable(client, monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords._module_available", lambda _name: False)

    response = client.get("/api/v1/chord-backends")

    assert response.status_code == 200
    payload = response.json()
    backends = {backend["id"]: backend for backend in payload["backends"]}
    assert backends["tuneforge-fast"]["availability"] == "available"
    assert backends["crema-advanced"]["availability"] == "unavailable"
    assert backends["crema-advanced"]["unavailable_reason"] == "ONNX Runtime is not installed"
    assert backends["crema-advanced"]["capabilities"]["supportsSevenths"] is True
    assert backends["crema-advanced"]["desktopOnly"] is True


def test_advanced_chords_request_fails_if_crema_missing(client, sample_chord_audio_file: Path, monkeypatch):
    monkeypatch.setattr("app.engines.crema_chords._module_available", lambda _name: False)
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
    assert payload["error"]["message"] == "ONNX Runtime is not installed"


def test_explicit_lv_chordia_request_fails_if_bundle_is_unavailable(
    client,
    sample_chord_audio_file: Path,
    monkeypatch,
):
    monkeypatch.setattr(
        "app.services.chord_backends.lv_chordia_dependency_status",
        lambda **_kwargs: (False, "Bundled LV Chordia checkpoint is sha256; reinstall TuneForge"),
    )
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.post(
        f"/api/v1/projects/{project['id']}/chords",
        json={"backend": "lv-chordia-submission", "force": True},
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["error"]["code"] == "CHORD_BACKEND_UNAVAILABLE"
    assert payload["error"]["details"]["backend"] == "lv-chordia-submission"


def test_chord_benchmark_command_emits_json(sample_chord_audio_file: Path, capsys):
    exit_code = benchmark_main(["--audio", str(sample_chord_audio_file), "--backend", "tuneforge-fast", "--json-only"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert exit_code == 0
    assert payload["results"][0]["backend_id"] == "tuneforge-fast"
    assert payload["results"][0]["available"] is True
    assert payload["results"][0]["number_of_chord_segments"] >= 1
