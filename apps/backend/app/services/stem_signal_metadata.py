from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from app.engines.audio_signal import inspect_audio_signal_file
from app.engines.stem_signal import STEM_SIGNAL_THRESHOLDS

STEM_SIGNAL_METADATA_KEY = "stem_signal"
STEM_SIGNAL_METADATA_VERSION = 1
STEM_SIGNAL_ANALYSIS_USABILITY_KEY = "analysis_usability"
STEM_SIGNAL_ANALYSIS_USABILITY_VERSION = 1
STEM_SIGNAL_ANALYSIS_MIN_RMS_RATIO = 0.10
STEM_SIGNAL_ANALYSIS_MIN_ACTIVE_RATIO = 0.20
STEM_SIGNAL_ANALYSIS_CLEAR_ABSENT_RMS_RATIO = 0.01

_STEM_SIGNAL_METADATA_FIELDS = {
    "version",
    "has_signal",
    "peak",
    "rms",
    "active_duration_seconds",
    "inspected_duration_seconds",
    "active_ratio",
    "sample_rate",
    "channels",
    "thresholds",
}
_STEM_SIGNAL_ALLOWED_METADATA_FIELDS = _STEM_SIGNAL_METADATA_FIELDS | {
    STEM_SIGNAL_ANALYSIS_USABILITY_KEY,
}
_STEM_SIGNAL_THRESHOLD_FIELDS = {
    "peak",
    "rms",
    "active_duration_seconds",
    "window_seconds",
}
_STEM_SIGNAL_ANALYSIS_USABILITY_FIELDS = {
    "version",
    "usable",
    "reason",
    "rms_ratio",
    "rms_db_below_reference",
    "active_ratio",
    "peak_ratio",
    "reference",
    "thresholds",
}
_STEM_SIGNAL_ANALYSIS_REFERENCE_FIELDS = {
    "max_rms",
    "max_active_duration_seconds",
    "max_peak",
}
_STEM_SIGNAL_ANALYSIS_THRESHOLD_FIELDS = {
    "min_rms_ratio",
    "min_active_ratio",
    "clear_absent_rms_ratio",
}
_STEM_SIGNAL_ANALYSIS_REASONS = {
    "absolute_no_signal",
    "relative_absent",
    "relative_leakage",
    "usable",
}


def build_stem_signal_metadata(path: Path) -> dict[str, Any]:
    summary = inspect_audio_signal_file(path, STEM_SIGNAL_THRESHOLDS)
    return {
        "version": STEM_SIGNAL_METADATA_VERSION,
        "has_signal": bool(summary.has_signal),
        "peak": float(summary.peak),
        "rms": float(summary.rms),
        "active_duration_seconds": float(summary.active_duration_seconds),
        "inspected_duration_seconds": float(summary.inspected_duration_seconds),
        "active_ratio": float(summary.active_ratio),
        "sample_rate": int(summary.sample_rate),
        "channels": int(summary.channels),
        "thresholds": {
            "peak": float(STEM_SIGNAL_THRESHOLDS.peak),
            "rms": float(STEM_SIGNAL_THRESHOLDS.rms),
            "active_duration_seconds": float(STEM_SIGNAL_THRESHOLDS.active_duration_seconds),
            "window_seconds": float(STEM_SIGNAL_THRESHOLDS.window_seconds),
        },
    }


def has_current_stem_signal_metadata(metadata: Mapping[str, Any]) -> bool:
    return _current_stem_signal_metadata(metadata) is not None


def stem_signal_has_signal(metadata: Mapping[str, Any]) -> bool | None:
    stem_signal = _current_stem_signal_metadata(metadata)
    if stem_signal is None:
        return None
    return bool(stem_signal["has_signal"])


def stem_signal_analysis_usable(metadata: Mapping[str, Any]) -> bool:
    usability = _current_stem_signal_analysis_usability(metadata)
    if usability is None:
        return False
    return bool(usability["usable"])


def has_current_stem_signal_analysis_usability(metadata: Mapping[str, Any]) -> bool:
    return _current_stem_signal_analysis_usability(metadata) is not None


def add_analysis_usability_to_stem_signal_metadatas(
    metadatas: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    stem_signals: list[Mapping[str, Any]] = []
    for metadata in metadatas:
        stem_signal = _current_stem_signal_metadata(metadata)
        if stem_signal is None:
            raise ValueError("Current stem_signal metadata is required for analysis usability.")
        stem_signals.append(stem_signal)

    usabilities = _build_stem_signal_analysis_usabilities(stem_signals)
    updated_metadatas: list[dict[str, Any]] = []
    for metadata, stem_signal_metadata, usability in zip(metadatas, stem_signals, usabilities, strict=True):
        updated_metadata = dict(metadata)
        stem_signal = dict(stem_signal_metadata)
        stem_signal[STEM_SIGNAL_ANALYSIS_USABILITY_KEY] = usability
        updated_metadata[STEM_SIGNAL_METADATA_KEY] = stem_signal
        updated_metadatas.append(updated_metadata)
    return updated_metadatas


def _current_stem_signal_metadata(metadata: Mapping[str, Any]) -> Mapping[str, Any] | None:
    stem_signal = metadata.get(STEM_SIGNAL_METADATA_KEY)
    if not isinstance(stem_signal, Mapping):
        return None
    stem_signal_keys = set(stem_signal.keys())
    if not _STEM_SIGNAL_METADATA_FIELDS.issubset(stem_signal_keys):
        return None
    if stem_signal_keys - _STEM_SIGNAL_ALLOWED_METADATA_FIELDS:
        return None
    if not _is_current_metadata_version(stem_signal.get("version")):
        return None
    if not isinstance(stem_signal.get("has_signal"), bool):
        return None
    if not _has_signal_metrics(stem_signal):
        return None

    thresholds = stem_signal.get("thresholds")
    if not isinstance(thresholds, Mapping):
        return None
    if set(thresholds.keys()) != _STEM_SIGNAL_THRESHOLD_FIELDS:
        return None
    if not all(_is_non_negative_number(thresholds.get(key)) for key in _STEM_SIGNAL_THRESHOLD_FIELDS):
        return None
    if not _is_positive_number(thresholds.get("window_seconds")):
        return None

    return stem_signal


def _current_stem_signal_analysis_usability(metadata: Mapping[str, Any]) -> Mapping[str, Any] | None:
    stem_signal = _current_stem_signal_metadata(metadata)
    if stem_signal is None:
        return None
    usability = stem_signal.get(STEM_SIGNAL_ANALYSIS_USABILITY_KEY)
    if not isinstance(usability, Mapping):
        return None
    if set(usability.keys()) != _STEM_SIGNAL_ANALYSIS_USABILITY_FIELDS:
        return None
    if not _is_current_analysis_usability_version(usability.get("version")):
        return None
    if not isinstance(usability.get("usable"), bool):
        return None
    if usability.get("reason") not in _STEM_SIGNAL_ANALYSIS_REASONS:
        return None
    if not all(
        _is_non_negative_number(usability.get(field))
        for field in ("rms_ratio", "active_ratio", "peak_ratio")
    ):
        return None
    rms_db_below_reference = usability.get("rms_db_below_reference")
    if rms_db_below_reference is not None and not _is_finite_number(rms_db_below_reference):
        return None

    reference = usability.get("reference")
    if not isinstance(reference, Mapping):
        return None
    if set(reference.keys()) != _STEM_SIGNAL_ANALYSIS_REFERENCE_FIELDS:
        return None
    if not all(_is_non_negative_number(reference.get(key)) for key in _STEM_SIGNAL_ANALYSIS_REFERENCE_FIELDS):
        return None

    thresholds = usability.get("thresholds")
    if not isinstance(thresholds, Mapping):
        return None
    if set(thresholds.keys()) != _STEM_SIGNAL_ANALYSIS_THRESHOLD_FIELDS:
        return None
    if not all(_is_non_negative_number(thresholds.get(key)) for key in _STEM_SIGNAL_ANALYSIS_THRESHOLD_FIELDS):
        return None
    if not _has_current_analysis_thresholds(thresholds):
        return None
    if not _is_consistent_analysis_usability(stem_signal, usability, reference, thresholds):
        return None

    return usability


def _build_stem_signal_analysis_usabilities(
    stem_signals: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    max_rms = max((float(stem_signal["rms"]) for stem_signal in stem_signals), default=0.0)
    max_active_duration = max(
        (float(stem_signal["active_duration_seconds"]) for stem_signal in stem_signals),
        default=0.0,
    )
    max_peak = max((float(stem_signal["peak"]) for stem_signal in stem_signals), default=0.0)
    reference = {
        "max_rms": float(max_rms),
        "max_active_duration_seconds": float(max_active_duration),
        "max_peak": float(max_peak),
    }
    thresholds = {
        "min_rms_ratio": float(STEM_SIGNAL_ANALYSIS_MIN_RMS_RATIO),
        "min_active_ratio": float(STEM_SIGNAL_ANALYSIS_MIN_ACTIVE_RATIO),
        "clear_absent_rms_ratio": float(STEM_SIGNAL_ANALYSIS_CLEAR_ABSENT_RMS_RATIO),
    }

    return [
        _build_stem_signal_analysis_usability(
            stem_signal,
            reference=reference,
            thresholds=thresholds,
        )
        for stem_signal in stem_signals
    ]


def _build_stem_signal_analysis_usability(
    stem_signal: Mapping[str, Any],
    *,
    reference: Mapping[str, float],
    thresholds: Mapping[str, float],
) -> dict[str, Any]:
    rms_ratio = _safe_ratio(float(stem_signal["rms"]), reference["max_rms"])
    active_ratio = _safe_ratio(
        float(stem_signal["active_duration_seconds"]),
        reference["max_active_duration_seconds"],
    )
    peak_ratio = _safe_ratio(float(stem_signal["peak"]), reference["max_peak"])
    if stem_signal["has_signal"] is not True:
        usable = False
        reason = "absolute_no_signal"
    elif rms_ratio < thresholds["clear_absent_rms_ratio"]:
        usable = False
        reason = "relative_absent"
    elif rms_ratio < thresholds["min_rms_ratio"] and active_ratio < thresholds["min_active_ratio"]:
        usable = False
        reason = "relative_leakage"
    else:
        usable = True
        reason = "usable"

    rms_db_below_reference = 20.0 * math.log10(rms_ratio) if rms_ratio > 0.0 else None
    return {
        "version": STEM_SIGNAL_ANALYSIS_USABILITY_VERSION,
        "usable": usable,
        "reason": reason,
        "rms_ratio": float(rms_ratio),
        "rms_db_below_reference": rms_db_below_reference,
        "active_ratio": float(active_ratio),
        "peak_ratio": float(peak_ratio),
        "reference": dict(reference),
        "thresholds": dict(thresholds),
    }


def _has_signal_metrics(stem_signal: Mapping[str, Any]) -> bool:
    float_fields = (
        "peak",
        "rms",
        "active_duration_seconds",
        "inspected_duration_seconds",
        "active_ratio",
    )
    if not all(_is_non_negative_number(stem_signal.get(field)) for field in float_fields):
        return False
    if not _is_positive_int(stem_signal.get("sample_rate")):
        return False
    return _is_positive_int(stem_signal.get("channels"))


def _is_non_negative_number(value: object) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and float(value) >= 0.0
    )


def _is_finite_number(value: object) -> bool:
    return _finite_float(value) is not None


def _has_current_analysis_thresholds(thresholds: Mapping[str, Any]) -> bool:
    return (
        _is_close_float(thresholds.get("min_rms_ratio"), STEM_SIGNAL_ANALYSIS_MIN_RMS_RATIO)
        and _is_close_float(thresholds.get("min_active_ratio"), STEM_SIGNAL_ANALYSIS_MIN_ACTIVE_RATIO)
        and _is_close_float(
            thresholds.get("clear_absent_rms_ratio"),
            STEM_SIGNAL_ANALYSIS_CLEAR_ABSENT_RMS_RATIO,
        )
    )


def _is_consistent_analysis_usability(
    stem_signal: Mapping[str, Any],
    usability: Mapping[str, Any],
    reference: Mapping[str, Any],
    thresholds: Mapping[str, Any],
) -> bool:
    if not _reference_covers_stem_signal(stem_signal, reference):
        return False
    expected_rms_ratio = _safe_ratio(float(stem_signal["rms"]), float(reference["max_rms"]))
    expected_active_ratio = _safe_ratio(
        float(stem_signal["active_duration_seconds"]),
        float(reference["max_active_duration_seconds"]),
    )
    expected_peak_ratio = _safe_ratio(float(stem_signal["peak"]), float(reference["max_peak"]))
    if not (
        _is_close_float(usability.get("rms_ratio"), expected_rms_ratio)
        and _is_close_float(usability.get("active_ratio"), expected_active_ratio)
        and _is_close_float(usability.get("peak_ratio"), expected_peak_ratio)
    ):
        return False

    expected_rms_db = 20.0 * math.log10(expected_rms_ratio) if expected_rms_ratio > 0.0 else None
    rms_db_below_reference = usability.get("rms_db_below_reference")
    if expected_rms_db is None:
        if rms_db_below_reference is not None:
            return False
    elif not _is_close_float(rms_db_below_reference, expected_rms_db):
        return False

    expected_usable, expected_reason = _analysis_usability_decision(
        stem_signal,
        rms_ratio=expected_rms_ratio,
        active_ratio=expected_active_ratio,
        thresholds=thresholds,
    )
    return usability.get("usable") is expected_usable and usability.get("reason") == expected_reason


def _analysis_usability_decision(
    stem_signal: Mapping[str, Any],
    *,
    rms_ratio: float,
    active_ratio: float,
    thresholds: Mapping[str, Any],
) -> tuple[bool, str]:
    if stem_signal["has_signal"] is not True:
        return False, "absolute_no_signal"
    if rms_ratio < float(thresholds["clear_absent_rms_ratio"]):
        return False, "relative_absent"
    if rms_ratio < float(thresholds["min_rms_ratio"]) and active_ratio < float(thresholds["min_active_ratio"]):
        return False, "relative_leakage"
    return True, "usable"


def _reference_covers_stem_signal(stem_signal: Mapping[str, Any], reference: Mapping[str, Any]) -> bool:
    return (
        _is_at_least(reference.get("max_rms"), float(stem_signal["rms"]))
        and _is_at_least(
            reference.get("max_active_duration_seconds"),
            float(stem_signal["active_duration_seconds"]),
        )
        and _is_at_least(reference.get("max_peak"), float(stem_signal["peak"]))
    )


def _is_at_least(value: object, expected_minimum: float) -> bool:
    finite_value = _finite_float(value)
    return finite_value is not None and finite_value + 1e-12 >= expected_minimum


def _is_close_float(value: object, expected: float) -> bool:
    finite_value = _finite_float(value)
    return finite_value is not None and math.isclose(finite_value, expected, rel_tol=1e-9, abs_tol=1e-12)


def _finite_float(value: object) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(float(value)):
        return float(value)
    return None


def _is_positive_number(value: object) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and float(value) > 0.0
    )


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_current_metadata_version(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value == STEM_SIGNAL_METADATA_VERSION
    )


def _is_current_analysis_usability_version(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value == STEM_SIGNAL_ANALYSIS_USABILITY_VERSION
    )


def _safe_ratio(value: float, reference: float) -> float:
    if reference <= 0.0:
        return 0.0
    return value / reference
