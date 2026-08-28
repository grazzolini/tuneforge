from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

from app.engines.crema_onnx import (
    crema_onnx_metadata,
    detect_crema_onnx_timeline,
    ensure_crema_onnx_files,
    invalid_crema_onnx_files,
)
from app.utils.model_cache import InvalidModelFile

CREMA_BACKEND_ID = "crema-advanced"


def crema_dependency_status(*, runtime_platform: str = "desktop") -> tuple[bool, str | None]:
    if runtime_platform in {"android", "ios", "mobile"}:
        return False, "advanced chord backend is disabled on mobile"
    if _module_available("onnxruntime"):
        return True, None
    return False, "ONNX Runtime is not installed"


def detect_crema_chord_timeline(
    source_path: Path,
    *,
    merge_adjacent: bool = True,
    min_segment_seconds: float = 0.0,
) -> list[dict[str, Any]]:
    available, reason = crema_dependency_status()
    if not available:
        raise RuntimeError(reason or "Advanced chord backend is unavailable.")
    segments = detect_crema_onnx_timeline(source_path)
    if min_segment_seconds > 0:
        segments = _drop_short_segments(segments, min_segment_seconds=min_segment_seconds)
    if merge_adjacent:
        segments = merge_adjacent_chord_segments(segments)
    return segments


def crema_runtime_device() -> str:
    return "cpu"


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
    return None


def preload_crema_model() -> None:
    available, reason = crema_dependency_status()
    if not available:
        raise RuntimeError(reason or "Advanced chord backend is unavailable.")
    ensure_crema_onnx_files()


def invalid_crema_model_asset_files() -> tuple[InvalidModelFile, ...]:
    return invalid_crema_onnx_files()


def crema_model_metadata() -> dict[str, Any]:
    available, reason = crema_dependency_status()
    if not available:
        raise RuntimeError(reason or "Advanced chord backend is unavailable.")
    return crema_onnx_metadata()


def crema_backend_label() -> str:
    return "Advanced Chords — Crema ONNX"


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return module_name in __import__("sys").modules


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
