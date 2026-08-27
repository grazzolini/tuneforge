from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from app.benchmarks.chord_evaluation import SYNTHETIC_VERSION, _write_synthetic_wav, score_timeline
from app.engines import crema_onnx
from app.engines.crema_chords import merge_adjacent_chord_segments
from app.utils.model_cache import ExpectedModelFile


def _state() -> dict[str, Any]:
    pitches = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    qualities = (
        "min", "maj", "dim", "aug", "min6", "maj6", "min7", "maj7", "7", "dim7",
        "hdim7", "minmaj7", "sus2", "sus4",
    )
    labels = sorted(["N", "X", *(f"{pitch}:{quality}" for pitch in pitches for quality in qualities)])
    return {
        "schema_version": 1,
        "source": {"name": "crema", "version": "0.2.0"},
        "preprocessing": {
            "sample_rate": 44_100,
            "hop_length": 4_096,
            "fmin": 32.70319566257483,
            "harmonics": [1, 2],
            "octaves": 6,
            "oversample": 3,
            "output_shape": [None, 216, 2],
        },
        "decoder": {
            "sample_rate": 44_100,
            "hop_length": 4_096,
            "labels": labels,
            "classes_sha256": hashlib.sha256("\n".join(labels).encode()).hexdigest(),
            "transition": {
                "encoding": "uniform-off-diagonal",
                "shape": [170, 170],
                "diagonal": 0.957154635467057,
                "off_diagonal": 0.00025352286705883413,
            },
        },
    }


class _Response(io.BytesIO):
    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def test_download_streams_verifies_and_atomically_promotes(tmp_path: Path, monkeypatch) -> None:
    payload = b"verified model"
    expected = ExpectedModelFile(
        "fixture", tmp_path / "model.onnx", len(payload), hashlib.sha256(payload).hexdigest()
    )
    monkeypatch.setattr(crema_onnx.urllib.request, "urlopen", lambda *_args, **_kwargs: _Response(payload))

    crema_onnx._download_file("https://example.invalid/model", expected)

    assert expected.path.read_bytes() == payload
    assert list(tmp_path.glob("*.tmp")) == []


@pytest.mark.parametrize("payload", [b"short", b"wrong size", b"too long for fixture"])
def test_download_rejects_bad_integrity_and_cleans_partial(tmp_path: Path, monkeypatch, payload: bytes) -> None:
    expected_payload = b"right size"
    expected = ExpectedModelFile(
        "fixture",
        tmp_path / "model.onnx",
        len(expected_payload),
        hashlib.sha256(expected_payload).hexdigest(),
    )
    monkeypatch.setattr(crema_onnx.urllib.request, "urlopen", lambda *_args, **_kwargs: _Response(payload))

    with pytest.raises(RuntimeError, match="integrity|expected size"):
        crema_onnx._download_file("https://example.invalid/model", expected)

    assert not expected.path.exists()
    assert list(tmp_path.glob("*.tmp")) == []


def test_download_failure_is_sanitized_and_cleans_partial(tmp_path: Path, monkeypatch) -> None:
    class PartialResponse(_Response):
        def read(self, size: int = -1) -> bytes:
            value = super().read(size)
            if value:
                return value
            raise urllib.error.URLError("private fixture detail")

    payload = b"partial"
    expected = ExpectedModelFile(
        "fixture", tmp_path / "model.onnx", len(payload) + 1, hashlib.sha256(payload).hexdigest()
    )
    monkeypatch.setattr(
        crema_onnx.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: PartialResponse(payload),
    )

    with pytest.raises(RuntimeError, match="seed the verified model cache") as error:
        crema_onnx._download_file("https://example.invalid/private-name", expected)

    assert "private-name" not in str(error.value)
    assert not expected.path.exists()
    assert list(tmp_path.glob("*.tmp")) == []


def test_failed_download_removes_unchanged_corrupt_destination(tmp_path: Path, monkeypatch) -> None:
    destination = tmp_path / "model.onnx"
    destination.write_bytes(b"corrupt")
    expected = ExpectedModelFile(
        "fixture", destination, 5, hashlib.sha256(b"model").hexdigest()
    )
    monkeypatch.setattr(
        crema_onnx.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError("offline")),
    )

    with pytest.raises(RuntimeError, match="seed the verified model cache"):
        crema_onnx._download_file("https://example.invalid/model", expected)

    assert not destination.exists()


def test_failed_download_preserves_concurrently_promoted_valid_file(tmp_path: Path, monkeypatch) -> None:
    destination = tmp_path / "model.onnx"
    destination.write_bytes(b"corrupt")
    payload = b"model"
    expected = ExpectedModelFile(
        "fixture", destination, len(payload), hashlib.sha256(payload).hexdigest()
    )

    def promote_then_fail(*_args, **_kwargs):
        temporary = tmp_path / "concurrent.tmp"
        temporary.write_bytes(payload)
        temporary.replace(destination)
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(crema_onnx.urllib.request, "urlopen", promote_then_fail)

    with pytest.raises(RuntimeError, match="seed the verified model cache"):
        crema_onnx._download_file("https://example.invalid/model", expected)

    assert destination.read_bytes() == payload


def test_concurrent_downloads_use_unique_temporary_files(tmp_path: Path, monkeypatch) -> None:
    payload = b"same verified bytes"
    expected = ExpectedModelFile(
        "fixture", tmp_path / "model.onnx", len(payload), hashlib.sha256(payload).hexdigest()
    )
    monkeypatch.setattr(
        crema_onnx.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _Response(payload),
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(crema_onnx._download_file, "https://example.invalid/model", expected)
            for _ in range(2)
        ]
        for future in futures:
            future.result()

    assert expected.path.read_bytes() == payload
    assert list(tmp_path.glob("*.tmp")) == []


def test_verified_cache_is_reused_without_network(tmp_path: Path, monkeypatch) -> None:
    model = tmp_path / crema_onnx.MODEL_FILENAME
    state = tmp_path / crema_onnx.STATE_FILENAME
    model.write_bytes(b"model")
    state.write_bytes(b"state")
    expected = (
        ExpectedModelFile("model", model, 5, hashlib.sha256(b"model").hexdigest()),
        ExpectedModelFile("state", state, 5, hashlib.sha256(b"state").hexdigest()),
    )
    monkeypatch.setattr(crema_onnx, "crema_onnx_cache_dir", lambda: tmp_path)
    monkeypatch.setattr(crema_onnx, "expected_model_files", lambda root=None: expected)
    monkeypatch.setattr(
        crema_onnx.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: pytest.fail("verified cache must remain offline"),
    )

    assert crema_onnx.ensure_crema_onnx_files() == (model, state)


def test_verified_offline_import_promotes_both_files(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "download"
    destination = tmp_path / "cache"
    source.mkdir()
    destination.mkdir()
    payloads = {
        crema_onnx.MODEL_FILENAME: b"model",
        crema_onnx.STATE_FILENAME: b"state",
    }
    for name, payload in payloads.items():
        (source / name).write_bytes(payload)

    def expected(root: Path | None = None) -> tuple[ExpectedModelFile, ...]:
        target = root or destination
        return tuple(
            ExpectedModelFile(name, target / name, len(payload), hashlib.sha256(payload).hexdigest())
            for name, payload in payloads.items()
        )

    monkeypatch.setattr(crema_onnx, "crema_onnx_cache_dir", lambda: destination)
    monkeypatch.setattr(crema_onnx, "expected_model_files", expected)

    crema_onnx.import_crema_onnx_model(source)

    assert {path.name: path.read_bytes() for path in destination.iterdir()} == payloads


def test_failed_offline_import_removes_known_corrupt_cache_files(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "download"
    destination = tmp_path / "cache"
    source.mkdir()
    destination.mkdir()
    payloads = {
        crema_onnx.MODEL_FILENAME: b"model",
        crema_onnx.STATE_FILENAME: b"state",
    }
    for name in payloads:
        (source / name).write_bytes(b"invalid")
        (destination / name).write_bytes(b"corrupt")

    def expected(root: Path | None = None) -> tuple[ExpectedModelFile, ...]:
        target = root or destination
        return tuple(
            ExpectedModelFile(name, target / name, len(payload), hashlib.sha256(payload).hexdigest())
            for name, payload in payloads.items()
        )

    monkeypatch.setattr(crema_onnx, "crema_onnx_cache_dir", lambda: destination)
    monkeypatch.setattr(crema_onnx, "expected_model_files", expected)

    with pytest.raises(RuntimeError, match="import failed integrity"):
        crema_onnx.import_crema_onnx_model(source)

    assert list(destination.iterdir()) == []


def test_runtime_state_rejects_wrong_schema(tmp_path: Path) -> None:
    state = _state()
    state["schema_version"] = 2
    path = tmp_path / "state.json"
    path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(RuntimeError, match="unsupported"):
        crema_onnx.load_runtime_state(path)


def test_runtime_state_rejects_wrong_source_version(tmp_path: Path) -> None:
    state = _state()
    state["source"]["version"] = "unexpected"
    path = tmp_path / "state.json"
    path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(RuntimeError, match="unsupported"):
        crema_onnx.load_runtime_state(path)


def test_four_named_heads_are_mapped_in_order(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], dict[str, np.ndarray]]] = []

    class Session:
        def __init__(self, _path: str, *, providers: list[str]) -> None:
            assert providers == ["CPUExecutionProvider"]

        def get_inputs(self) -> list[SimpleNamespace]:
            return [SimpleNamespace(name="cqt_mag")]

        def run(self, outputs: list[str], inputs: dict[str, np.ndarray]) -> list[np.ndarray]:
            calls.append((outputs, inputs))
            return [np.zeros((1, 3, width), dtype=np.float32) for width in (170, 12, 13, 13)]

    module = ModuleType("onnxruntime")
    telemetry_disabled: list[bool] = []
    module.disable_telemetry_events = lambda: telemetry_disabled.append(True)  # type: ignore[attr-defined]
    module.InferenceSession = Session  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "onnxruntime", module)
    features = np.zeros((1, 3, 216, 2), dtype=np.float32)

    heads = crema_onnx.run_inference(tmp_path / "model.onnx", features)

    assert [head.shape for head in heads] == [(3, 170), (3, 12), (3, 13), (3, 13)]
    assert calls[0][0] == ["Identity:0", "Identity_1:0", "Identity_2:0", "Identity_3:0"]
    assert calls[0][1] == {"cqt_mag": features}
    assert telemetry_disabled == [True]


def test_preprocessing_builds_exact_hcqt_layout(monkeypatch, tmp_path: Path) -> None:
    cqt_calls: list[dict[str, Any]] = []
    module = ModuleType("librosa")
    module.load = lambda *_args, **_kwargs: (np.ones(44_100, dtype=np.float32), 44_100)  # type: ignore[attr-defined]
    module.resample = lambda value, **_kwargs: value  # type: ignore[attr-defined]
    module.get_duration = lambda **_kwargs: 1.0  # type: ignore[attr-defined]
    module.time_to_frames = lambda *_args, **_kwargs: 10  # type: ignore[attr-defined]

    def cqt(_audio: np.ndarray, **kwargs: Any) -> np.ndarray:
        cqt_calls.append(kwargs)
        return np.ones((216, 10), dtype=np.complex64)

    module.cqt = cqt  # type: ignore[attr-defined]
    module.util = SimpleNamespace(fix_length=lambda value, **_kwargs: value)  # type: ignore[attr-defined]
    module.amplitude_to_db = lambda value, **_kwargs: value  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "librosa", module)

    features = crema_onnx.preprocess_audio(tmp_path / "source.wav", _state())

    assert features.shape == (1, 10, 216, 2)
    assert features.dtype == np.float32
    assert [call["fmin"] for call in cqt_calls] == [32.70319566257483, 65.40639132514966]
    assert all(call["hop_length"] == 4_096 for call in cqt_calls)
    assert all(call["n_bins"] == 216 and call["bins_per_octave"] == 36 for call in cqt_calls)


def test_preprocessing_matches_frozen_quality_synthetic_reference(tmp_path: Path) -> None:
    assert SYNTHETIC_VERSION == "synthetic-chords-v1"
    source = tmp_path / "fixture.wav"
    _write_synthetic_wav(source, ("C",))

    features = crema_onnx.preprocess_audio(source, _state())

    assert features.shape == (1, 10, 216, 2)
    # Frozen from Crema 0.2.0 pumpp HCQT output during the conversion checkpoint.
    np.testing.assert_allclose(
        features[0, [0, 1, 5, 9], [0, 36, 108, 215], [0, 1, 0, 1]],
        np.asarray([-59.071804, -4.4513607, -80.0, -80.0], dtype=np.float32),
        atol=2e-3,
    )
    np.testing.assert_allclose(
        [features.min(), features.max(), features.mean(), features.std()],
        [-80.0, 0.0, -67.447784, 20.998577],
        atol=2e-3,
    )


def test_decoder_preserves_inversion_confidence_and_repeat_determinism() -> None:
    state = _state()
    tag = np.full((4, 170), 1e-8, dtype=np.float32)
    chord_index = state["decoder"]["labels"].index("C:maj")
    tag[:, chord_index] = 1.0
    tag /= tag.sum(axis=1, keepdims=True)
    bass = np.full((4, 13), 1e-8, dtype=np.float32)
    bass[:, 4] = 1.0

    first = crema_onnx.decode_timeline(tag, bass, state)
    second = crema_onnx.decode_timeline(tag, bass, state)

    assert first == second
    assert first[0]["label"] == "C/E"
    assert first[0]["display_label"] == "C/E"
    assert first[0]["bass_degree"] == "3"
    assert first[0]["confidence"] == 1.0
    assert first[0]["end_seconds"] == 0.464


def test_decoder_matches_frozen_tensorflow_timeline_and_scorer_fixture() -> None:
    state = _state()
    labels = state["decoder"]["labels"]
    tag = np.full((9, 170), 1e-8, dtype=np.float32)
    for frames, label, confidence in (
        ((0, 1), "C:maj7", 0.9),
        ((2, 3), "G:7", 0.8),
        ((4, 5), "N", 0.99),
        ((6, 7, 8), "C:maj7", 0.85),
    ):
        tag[list(frames), labels.index(label)] = confidence
    tag /= tag.sum(axis=1, keepdims=True)
    bass = np.full((9, 13), 1e-8, dtype=np.float32)
    for frames, bass_index in (((0, 1), 4), ((2, 3), 5), ((4, 5), 12), ((6, 7, 8), 4)):
        bass[list(frames), bass_index] = 1.0

    timeline = crema_onnx.decode_timeline(tag, bass, state)
    projection = [
        {
            key: segment[key]
            for key in (
                "start_seconds", "end_seconds", "label", "raw_label", "confidence", "quality", "bass_degree"
            )
        }
        for segment in timeline
    ]

    # Frozen TensorFlow Crema reference produced from the same head tensors.
    assert projection == [
        {
            "start_seconds": 0.0, "end_seconds": 0.186, "label": "Cmaj7/E",
            "raw_label": "C:maj7/3", "confidence": 0.667, "quality": "maj7", "bass_degree": "3",
        },
        {
            "start_seconds": 0.186, "end_seconds": 0.372, "label": "G7/F",
            "raw_label": "G:7/b7", "confidence": 0.667, "quality": "7", "bass_degree": "b7",
        },
        {
            "start_seconds": 0.372, "end_seconds": 0.557, "label": "N.C.",
            "raw_label": "N", "confidence": 0.667, "quality": "no_chord", "bass_degree": None,
        },
        {
            "start_seconds": 0.557, "end_seconds": 0.929, "label": "Cmaj7/E",
            "raw_label": "C:maj7/3", "confidence": 1.0, "quality": "maj7", "bass_degree": "3",
        },
    ]
    split = [
        {**timeline[0], "end_seconds": 0.093},
        {**timeline[0], "start_seconds": 0.093},
        *timeline[1:],
    ]
    assert merge_adjacent_chord_segments(split) == timeline
    score = score_timeline(timeline, timeline)
    assert score["root"] == score["quality"] == score["seventh_extension"] == 1.0
    assert score["bass"] == score["full"] == 1.0
    assert score["boundary"] == {"matched": 3, "reference": 3, "prediction": 3}


def test_metadata_records_immutable_model_and_cpu_runtime(monkeypatch) -> None:
    monkeypatch.setattr(crema_onnx.importlib.metadata, "version", lambda name: "1.29.0")

    metadata = crema_onnx.crema_onnx_metadata()

    assert metadata == {
        "backend_id": "crema-advanced",
        "implementation": "crema-onnx",
        "source_crema_version": "0.2.0",
        "model_revision": crema_onnx.MODEL_REVISION,
        "model_sha256": crema_onnx.MODEL_SHA256,
        "runtime_state_sha256": crema_onnx.STATE_SHA256,
        "onnxruntime_version": "1.29.0",
        "provider": "CPUExecutionProvider",
    }


def test_detection_boundary_sanitizes_preprocessing_failures(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        crema_onnx,
        "ensure_crema_onnx_files",
        lambda: (tmp_path / "model.onnx", tmp_path / "state.json"),
    )
    monkeypatch.setattr(crema_onnx, "load_runtime_state", lambda _path: _state())
    monkeypatch.setattr(
        crema_onnx,
        "preprocess_audio",
        lambda *_args: (_ for _ in ()).throw(ValueError("failed at /private/library/song.wav")),
    )

    with pytest.raises(RuntimeError) as captured:
        crema_onnx.detect_crema_onnx_timeline(Path("/private/library/song.wav"))

    assert str(captured.value) == "Crema ONNX audio preprocessing failed."
    assert "/private" not in str(captured.value)
