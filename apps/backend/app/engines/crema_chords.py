from __future__ import annotations

import importlib.metadata
import importlib.util
import io
import warnings
from collections.abc import Iterator
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from typing import Any

from app.engines.chord_labels import chord_label_to_segment

CREMA_BACKEND_ID = "crema-advanced"
_CREMA_MODEL: Any | None = None


def crema_dependency_status(*, runtime_platform: str = "desktop") -> tuple[bool, str | None]:
    if runtime_platform in {"android", "ios", "mobile"}:
        return False, "advanced chord backend is disabled on mobile"
    for module_name, display_name in (
        ("crema", "crema"),
        ("tensorflow", "TensorFlow backend"),
        ("keras", "Keras"),
        ("jams", "JAMS"),
    ):
        if importlib.util.find_spec(module_name) is None:
            return False, f"{display_name} is not installed"
    keras_version = _package_version("keras")
    keras_major_version = _major_version(keras_version)
    if keras_major_version is not None and keras_major_version >= 3:
        return False, f"crema 0.2.0 is incompatible with installed Keras {keras_version}; install Keras < 3"
    scikit_learn_version = _package_version("scikit-learn")
    scikit_learn_major_minor = _major_minor_version(scikit_learn_version)
    if scikit_learn_major_minor is not None and scikit_learn_major_minor >= (1, 6):
        return (
            False,
            "crema 0.2.0 is incompatible with installed scikit-learn "
            f"{scikit_learn_version}; install scikit-learn < 1.6",
        )
    return True, None


def detect_crema_chord_timeline(
    source_path: Path,
    *,
    merge_adjacent: bool = True,
    min_segment_seconds: float = 0.0,
) -> list[dict[str, Any]]:
    model = _get_crema_model()
    with _suppress_crema_runtime_noise(), redirect_stdout(io.StringIO()):
        annotation = model.predict(filename=str(source_path))
    segments = crema_annotation_to_timeline(annotation)
    if min_segment_seconds > 0:
        segments = _drop_short_segments(segments, min_segment_seconds=min_segment_seconds)
    if merge_adjacent:
        segments = merge_adjacent_chord_segments(segments)
    return segments


def crema_annotation_to_timeline(annotation: Any) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for row in _annotation_rows(annotation):
        start_seconds = _float_or_none(row.get("time"))
        duration_seconds = _float_or_none(row.get("duration"))
        raw_label = row.get("value")
        if start_seconds is None or duration_seconds is None or raw_label is None:
            continue
        end_seconds = start_seconds + duration_seconds
        if end_seconds <= start_seconds:
            continue
        confidence = _float_or_none(row.get("confidence"))
        segments.append(
            chord_label_to_segment(
                str(raw_label),
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                confidence=round(confidence, 3) if confidence is not None else None,
            )
        )
    return segments


def merge_adjacent_chord_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []
    merged = [dict(segments[0])]
    for segment in segments[1:]:
        previous = merged[-1]
        if not _same_internal_chord(previous, segment):
            merged.append(dict(segment))
            continue
        previous["end_seconds"] = segment["end_seconds"]
        previous["confidence"] = _weighted_confidence(previous, segment)
    return merged


def clear_crema_model_cache() -> None:
    global _CREMA_MODEL
    _CREMA_MODEL = None


def crema_model_metadata() -> dict[str, Any]:
    return {
        "backend_id": CREMA_BACKEND_ID,
        "output_format": "jams",
        "model": "crema.models.chord.ChordModel",
        "crema_version": _package_version("crema"),
        "tensorflow_version": _package_version("tensorflow"),
        "license_note": "PyPI metadata lists ISC; upstream LICENSE.md is BSD-2-Clause.",
    }


def _get_crema_model() -> Any:
    global _CREMA_MODEL
    if _CREMA_MODEL is None:
        with _suppress_crema_runtime_noise():
            from crema.models.chord import ChordModel

            _CREMA_MODEL = ChordModel()
    return _CREMA_MODEL


@contextmanager
def _suppress_crema_runtime_noise() -> Iterator[None]:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="pkg_resources is deprecated as an API.*",
            category=UserWarning,
        )
        warnings.filterwarnings(
            "ignore",
            message=r"get_duration\(\) keyword argument 'filename' has been renamed.*",
            category=FutureWarning,
        )
        yield


def _annotation_rows(annotation: Any) -> list[dict[str, Any]]:
    if hasattr(annotation, "to_dataframe"):
        dataframe = annotation.to_dataframe()
        records = dataframe.to_dict("records")
        return [dict(record) for record in records]

    data = getattr(annotation, "data", None)
    if data is not None:
        return [_observation_to_row(observation) for observation in data]

    try:
        return [_observation_to_row(observation) for observation in annotation]
    except TypeError:
        return []


def _observation_to_row(observation: Any) -> dict[str, Any]:
    if isinstance(observation, dict):
        return observation
    return {
        "time": getattr(observation, "time", None),
        "duration": getattr(observation, "duration", None),
        "value": getattr(observation, "value", None),
        "confidence": getattr(observation, "confidence", None),
    }


def _drop_short_segments(segments: list[dict[str, Any]], *, min_segment_seconds: float) -> list[dict[str, Any]]:
    if len(segments) <= 1:
        return segments
    return [
        segment
        for segment in segments
        if float(segment["end_seconds"]) - float(segment["start_seconds"]) >= min_segment_seconds
    ]


def _same_internal_chord(first: dict[str, Any], second: dict[str, Any]) -> bool:
    return (
        first.get("root_pitch_class", first.get("pitch_class"))
        == second.get("root_pitch_class", second.get("pitch_class"))
        and first.get("quality") == second.get("quality")
        and first.get("bass_pitch_class") == second.get("bass_pitch_class")
    )


def _weighted_confidence(first: dict[str, Any], second: dict[str, Any]) -> float | None:
    first_confidence = _float_or_none(first.get("confidence"))
    second_confidence = _float_or_none(second.get("confidence"))
    if first_confidence is None:
        return second_confidence
    if second_confidence is None:
        return first_confidence
    first_duration = float(first["end_seconds"]) - float(first["start_seconds"])
    second_duration = float(second["end_seconds"]) - float(second["start_seconds"])
    total_duration = max(first_duration + second_duration, 1e-6)
    return round((first_confidence * first_duration + second_confidence * second_duration) / total_duration, 3)


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    return None


def _package_version(package_name: str) -> str | None:
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _major_version(version: str | None) -> int | None:
    if version is None:
        return None
    try:
        return int(version.split(".", 1)[0])
    except ValueError:
        return None


def _major_minor_version(version: str | None) -> tuple[int, int] | None:
    if version is None:
        return None
    parts = version.split(".", 2)
    if len(parts) < 2:
        return None
    try:
        return int(parts[0]), int(parts[1])
    except ValueError:
        return None
