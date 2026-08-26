from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import os
import shutil
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from app.config import get_settings
from app.engines.chord_labels import chord_label_to_segment
from app.utils.model_cache import ExpectedModelFile, InvalidModelFile, invalid_model_files

MODEL_REVISION = "65af18f49af5101267fd28f15ac8c452d98b8e3d"
MODEL_FILENAME = "crema-0.2.0-opset18.onnx"
STATE_FILENAME = "crema-0.2.0-runtime-state.json"
MODEL_SHA256 = "a903f9709821fccebb31d4e93d7d783642faaa90859f45f308c0f9131cc7ca59"
STATE_SHA256 = "3744bf9ecb47de7194cb9f250fba26678ea347911af32ec4813645d5e033aca2"
MODEL_SIZE = 2_193_804
STATE_SIZE = 3_790
_BASE_URL = f"https://huggingface.co/grazzolini/tuneforge-models/resolve/{MODEL_REVISION}"
_CLASSES_SHA256 = "e319b684db4725df87ab52c8c7b6df46508af23077c4b0a7dc662a6cbe6228c1"
_OUTPUTS = ("Identity:0", "Identity_1:0", "Identity_2:0", "Identity_3:0")
_OUTPUT_WIDTHS = (170, 12, 13, 13)
_PITCHES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_DEGREES = ("1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7")
_QUALITY_INTERVALS = {
    "7": {0, 4, 7, 10}, "aug": {0, 4, 8}, "dim": {0, 3, 6}, "dim7": {0, 3, 6, 9},
    "hdim7": {0, 3, 6, 10}, "maj": {0, 4, 7}, "maj6": {0, 4, 7, 9},
    "maj7": {0, 4, 7, 11}, "min": {0, 3, 7}, "min6": {0, 3, 7, 9},
    "min7": {0, 3, 7, 10}, "minmaj7": {0, 3, 7, 11}, "sus2": {0, 2, 7},
    "sus4": {0, 5, 7},
}


def crema_onnx_cache_dir() -> Path:
    return get_settings().cache_root / "models" / "crema" / "0.2.0" / MODEL_REVISION


def expected_model_files(root: Path | None = None) -> tuple[ExpectedModelFile, ...]:
    target = root or crema_onnx_cache_dir()
    return (
        ExpectedModelFile("Crema ONNX model", target / MODEL_FILENAME, MODEL_SIZE, MODEL_SHA256),
        ExpectedModelFile("Crema ONNX runtime state", target / STATE_FILENAME, STATE_SIZE, STATE_SHA256),
    )


def invalid_crema_onnx_files(root: Path | None = None) -> tuple[InvalidModelFile, ...]:
    return invalid_model_files(expected_model_files(root))


def import_crema_onnx_model(source: Path) -> None:
    destination = crema_onnx_cache_dir()
    destination.mkdir(parents=True, exist_ok=True)
    destination_files = expected_model_files()
    cleanup_identities = {
        expected.path.name: _file_identity(expected.path) for expected in destination_files
    }
    try:
        invalid = invalid_crema_onnx_files(source)
        if invalid:
            raise RuntimeError("Crema ONNX import failed integrity verification.")
        for expected in expected_model_files(source):
            destination_path = destination / expected.path.name
            _promote_local_file(expected.path, destination_path)
            cleanup_identities[expected.path.name] = _file_identity(destination_path)
        if invalid_crema_onnx_files():
            raise RuntimeError("Crema ONNX cache failed integrity verification.")
    except Exception:
        for expected in destination_files:
            _remove_if_still_invalid(expected, cleanup_identities[expected.path.name])
        raise


def ensure_crema_onnx_files() -> tuple[Path, Path]:
    root = crema_onnx_cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    for expected in expected_model_files():
        if invalid_model_files((expected,)):
            _download_file(f"{_BASE_URL}/{expected.path.name}", expected)
    if invalid_crema_onnx_files():
        raise RuntimeError("Crema ONNX model cache failed integrity verification.")
    return root / MODEL_FILENAME, root / STATE_FILENAME


def _promote_local_file(source: Path, destination: Path) -> None:
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        with source.open("rb") as input_file, temporary.open("xb") as output_file:
            shutil.copyfileobj(input_file, output_file, length=1024 * 1024)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _download_file(url: str, expected: ExpectedModelFile) -> None:
    cleanup_identity = _file_identity(expected.path)
    temporary = expected.path.with_name(f".{expected.path.name}.{uuid.uuid4().hex}.tmp")
    digest = hashlib.sha256()
    size = 0
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "TuneForge/1"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("xb") as output_file:
            while chunk := response.read(min(1024 * 1024, expected.size + 1 - size)):
                size += len(chunk)
                if size > expected.size:
                    raise RuntimeError("Crema ONNX download exceeded the expected size.")
                digest.update(chunk)
                output_file.write(chunk)
            output_file.flush()
            os.fsync(output_file.fileno())
        if size != expected.size or digest.hexdigest() != expected.sha256:
            raise RuntimeError("Crema ONNX download failed integrity verification.")
        os.replace(temporary, expected.path)
    except (OSError, urllib.error.URLError) as error:
        raise RuntimeError("Crema ONNX download failed; seed the verified model cache and retry.") from error
    finally:
        temporary.unlink(missing_ok=True)
        _remove_if_still_invalid(expected, cleanup_identity)


def _file_identity(path: Path) -> tuple[int, int, int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def _remove_if_still_invalid(
    expected: ExpectedModelFile,
    cleanup_identity: tuple[int, int, int, int] | None,
) -> None:
    if cleanup_identity is None or _file_identity(expected.path) != cleanup_identity:
        return
    if invalid_model_files((expected,)):
        try:
            expected.path.unlink(missing_ok=True)
        except OSError:
            pass


def load_runtime_state(path: Path) -> dict[str, Any]:
    try:
        state: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        decoder = state["decoder"]
        preprocessing = state["preprocessing"]
        labels = decoder["labels"]
        transition = decoder["transition"]
        classes_sha256 = hashlib.sha256("\n".join(labels).encode()).hexdigest()
        valid = (
            state["schema_version"] == 1
            and state["source"]["name"] == "crema"
            and state["source"]["version"] == "0.2.0"
            and len(labels) == 170
            and classes_sha256 == decoder["classes_sha256"] == _CLASSES_SHA256
            and decoder["sample_rate"] == 44_100
            and decoder["hop_length"] == 4_096
            and transition["shape"] == [170, 170]
            and transition["encoding"] == "uniform-off-diagonal"
            and preprocessing["output_shape"] == [None, 216, 2]
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("Crema ONNX runtime state is invalid.") from error
    if not valid:
        raise RuntimeError("Crema ONNX runtime state is unsupported.")
    return state


def preprocess_audio(source_path: Path, state: dict[str, Any]) -> npt.NDArray[np.float32]:
    import librosa

    spec = state["preprocessing"]
    sample_rate = int(spec["sample_rate"])
    audio, native_sample_rate = librosa.load(source_path, sr=None, mono=True)
    if native_sample_rate != sample_rate:
        audio = librosa.resample(audio, orig_sr=native_sample_rate, target_sr=sample_rate)
    duration = librosa.get_duration(y=audio, sr=sample_rate)
    frames = int(librosa.time_to_frames(duration, sr=sample_rate, hop_length=int(spec["hop_length"])))
    channels = []
    for harmonic in spec["harmonics"]:
        cqt = librosa.cqt(
            audio,
            sr=sample_rate,
            hop_length=int(spec["hop_length"]),
            fmin=float(spec["fmin"]) * int(harmonic),
            n_bins=int(spec["octaves"]) * 12 * int(spec["oversample"]),
            bins_per_octave=12 * int(spec["oversample"]),
        )
        magnitude = np.abs(librosa.util.fix_length(cqt, size=frames, axis=-1))
        channels.append(librosa.amplitude_to_db(magnitude, ref=np.max).astype(np.float32))
    return np.transpose(np.asarray(channels, dtype=np.float32), (2, 1, 0))[np.newaxis, ...]


def run_inference(model_path: Path, features: npt.NDArray[np.float32]) -> tuple[npt.NDArray[np.float32], ...]:
    os.environ["ORT_DISABLE_TELEMETRY"] = "1"
    import onnxruntime as ort

    if hasattr(ort, "disable_telemetry_events"):
        ort.disable_telemetry_events()
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    if [value.name for value in session.get_inputs()] != ["cqt_mag"]:
        raise RuntimeError("Crema ONNX model input does not match the pinned specification.")
    outputs = session.run(list(_OUTPUTS), {"cqt_mag": features})
    normalized = tuple(np.asarray(value[0], dtype=np.float32) for value in outputs)
    invalid_shape = any(
        value.ndim != 2 or value.shape[1] != width
        for value, width in zip(normalized, _OUTPUT_WIDTHS, strict=True)
    )
    if len(normalized) != 4 or invalid_shape:
        raise RuntimeError("Crema ONNX model outputs do not match the pinned specification.")
    return normalized


def _viterbi(probabilities: npt.NDArray[np.float32], state: dict[str, Any]) -> npt.NDArray[np.int64]:
    count = probabilities.shape[1]
    transition = state["decoder"]["transition"]
    matrix = np.full((count, count), transition["off_diagonal"], dtype=np.float64)
    np.fill_diagonal(matrix, transition["diagonal"])
    tiny = np.finfo(probabilities.dtype).tiny
    log_prob = np.log(probabilities + tiny) - math.log(1.0 / count)
    log_transition = np.log(matrix + tiny)
    values = np.zeros(probabilities.shape, dtype=np.float64)
    pointers = np.zeros(probabilities.shape, dtype=np.int64)
    values[0] = log_prob[0] + math.log(1.0 / count)
    for frame in range(1, probabilities.shape[0]):
        candidates = values[frame - 1][:, np.newaxis] + log_transition
        pointers[frame] = np.argmax(candidates, axis=0)
        values[frame] = log_prob[frame] + candidates[pointers[frame], np.arange(count)]
    path = np.zeros(probabilities.shape[0], dtype=np.int64)
    path[-1] = int(np.argmax(values[-1]))
    for frame in range(probabilities.shape[0] - 2, -1, -1):
        path[frame] = pointers[frame + 1, path[frame + 1]]
    return path


def decode_timeline(
    tag: npt.NDArray[np.float32], bass: npt.NDArray[np.float32], state: dict[str, Any]
) -> list[dict[str, Any]]:
    labels = state["decoder"]["labels"]
    hop = int(state["decoder"]["hop_length"])
    sample_rate = int(state["decoder"]["sample_rate"])
    path = _viterbi(tag, state)
    changes = np.where(path[1:] != path[:-1])[0]
    ends = np.unique(np.append(changes, len(path)))
    lengths = np.diff(np.append(-1, ends))
    starts = np.cumsum(np.append(0, lengths))[:-1]
    timeline: list[dict[str, Any]] = []
    for start, length in zip(starts, lengths, strict=True):
        end = int(start + length)
        label_index = int(path[start])
        label = labels[label_index]
        confidence = float(np.mean(tag[start : end + 1, label_index]))
        if label not in {"N", "X"}:
            root, quality = label.split(":", 1)
            stabilized = np.maximum(bass[start : end + 1], np.finfo(np.float32).tiny)
            bass_index = int(np.argmax(np.exp(np.mean(np.log(stabilized), axis=0))))
            relative = (bass_index - _PITCHES.index(root)) % 12 if bass_index < 12 else 0
            if relative and relative in _QUALITY_INTERVALS[quality]:
                label = f"{label}/{_DEGREES[relative]}"
        timeline.append(chord_label_to_segment(
            label,
            start_seconds=float(start * hop / sample_rate),
            end_seconds=float(end * hop / sample_rate),
            confidence=round(confidence, 3),
        ))
    return timeline


def detect_crema_onnx_timeline(source_path: Path) -> list[dict[str, Any]]:
    try:
        model_path, state_path = ensure_crema_onnx_files()
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("Crema ONNX model preparation failed.") from error
    try:
        state = load_runtime_state(state_path)
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("Crema ONNX runtime state could not be loaded.") from error
    try:
        features = preprocess_audio(source_path, state)
    except Exception as error:
        raise RuntimeError("Crema ONNX audio preprocessing failed.") from error
    try:
        tag, _pitch, _root, bass = run_inference(model_path, features)
    except Exception as error:
        raise RuntimeError("Crema ONNX inference failed.") from error
    try:
        return decode_timeline(tag, bass, state)
    except Exception as error:
        raise RuntimeError("Crema ONNX timeline decoding failed.") from error


def crema_onnx_metadata() -> dict[str, Any]:
    return {
        "backend_id": "crema-advanced",
        "implementation": "crema-onnx",
        "source_crema_version": "0.2.0",
        "model_revision": MODEL_REVISION,
        "model_sha256": MODEL_SHA256,
        "runtime_state_sha256": STATE_SHA256,
        "onnxruntime_version": importlib.metadata.version("onnxruntime"),
        "provider": "CPUExecutionProvider",
    }
