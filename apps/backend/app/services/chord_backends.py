from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, cast

from app.config import get_settings
from app.engines.chords import detect_chord_timeline
from app.engines.crema_chords import (
    crema_dependency_status,
    crema_model_metadata,
    detect_crema_chord_timeline,
)
from app.errors import AppError

ChordBackendSpeed = Literal["fast", "medium", "slow"]

FAST_CHORD_BACKEND_ID = "tuneforge-fast"
CREMA_CHORD_BACKEND_ID = "crema-advanced"
DEFAULT_CHORD_BACKEND_ID = FAST_CHORD_BACKEND_ID


@dataclass(frozen=True)
class ChordBackendCapabilities:
    supports_sevenths: bool
    supports_inversions: bool
    supports_confidence: bool
    supports_no_chord: bool
    estimated_speed: ChordBackendSpeed
    desktop_only: bool
    experimental: bool


@dataclass(frozen=True)
class ChordBackendAvailability:
    available: bool
    unavailable_reason: str | None = None


@dataclass(frozen=True)
class ChordDetectionResult:
    segments: list[dict[str, Any]]
    backend_id: str
    metadata: dict[str, Any]


class ChordDetectionBackend(Protocol):
    id: str
    label: str
    description: str
    capabilities: ChordBackendCapabilities

    def availability(self) -> ChordBackendAvailability:
        ...

    def detect(self, source_path: Path) -> ChordDetectionResult:
        ...


@dataclass(frozen=True)
class FastChordBackend:
    id: str = FAST_CHORD_BACKEND_ID
    label: str = "Built-in Chords"
    description: str = "TuneForge's built-in librosa/chroma chord detector. Default and lightweight."
    capabilities: ChordBackendCapabilities = ChordBackendCapabilities(
        supports_sevenths=True,
        supports_inversions=False,
        supports_confidence=True,
        supports_no_chord=True,
        estimated_speed="medium",
        desktop_only=False,
        experimental=False,
    )

    def availability(self) -> ChordBackendAvailability:
        return ChordBackendAvailability(available=True)

    def detect(self, source_path: Path) -> ChordDetectionResult:
        segments = [_normalize_fast_segment(segment) for segment in detect_chord_timeline(source_path)]
        return ChordDetectionResult(
            segments=segments,
            backend_id=self.id,
            metadata={
                "backend_id": self.id,
                "engine": "librosa-chroma-template-viterbi",
                "analysis_version": "v2",
            },
        )


@dataclass(frozen=True)
class CremaChordBackend:
    id: str = CREMA_CHORD_BACKEND_ID
    label: str = "Advanced Chords"
    description: str = "Optional crema chord detector with richer chord vocabulary and inversion estimates."
    capabilities: ChordBackendCapabilities = ChordBackendCapabilities(
        supports_sevenths=True,
        supports_inversions=True,
        supports_confidence=True,
        supports_no_chord=True,
        estimated_speed="slow",
        desktop_only=True,
        experimental=True,
    )

    def availability(self) -> ChordBackendAvailability:
        available, reason = crema_dependency_status(runtime_platform=get_settings().runtime_platform)
        return ChordBackendAvailability(available=available, unavailable_reason=reason)

    def detect(self, source_path: Path) -> ChordDetectionResult:
        availability = self.availability()
        if not availability.available:
            raise AppError(
                "ADVANCED_CHORD_BACKEND_UNAVAILABLE",
                availability.unavailable_reason or "Advanced chord backend is unavailable.",
                status_code=409,
            )
        return ChordDetectionResult(
            segments=detect_crema_chord_timeline(source_path),
            backend_id=self.id,
            metadata=crema_model_metadata(),
        )


_BACKENDS: dict[str, ChordDetectionBackend] = {
    FAST_CHORD_BACKEND_ID: cast(ChordDetectionBackend, FastChordBackend()),
    CREMA_CHORD_BACKEND_ID: cast(ChordDetectionBackend, CremaChordBackend()),
}

_ALIASES = {
    "default": "default",
    "fast": FAST_CHORD_BACKEND_ID,
    "librosa": FAST_CHORD_BACKEND_ID,
    "tuneforge-fast": FAST_CHORD_BACKEND_ID,
    "advanced": CREMA_CHORD_BACKEND_ID,
    "crema": CREMA_CHORD_BACKEND_ID,
    "crema-advanced": CREMA_CHORD_BACKEND_ID,
}


def list_chord_backend_infos() -> list[dict[str, Any]]:
    return [_backend_info(backend) for backend in _BACKENDS.values()]


def resolve_chord_backend(requested_backend: str | None, *, require_available: bool = False) -> ChordDetectionBackend:
    backend_id = resolve_chord_backend_id(requested_backend)
    backend = _BACKENDS[backend_id]
    availability = backend.availability()
    if require_available and not availability.available:
        _raise_unavailable(backend, availability)
    return backend


def resolve_chord_backend_id(requested_backend: str | None) -> str:
    requested = (requested_backend or "default").strip()
    alias = _ALIASES.get(requested)
    if alias is None:
        raise AppError(
            "UNSUPPORTED_CHORD_BACKEND",
            f"Unsupported chord backend: {requested}.",
            status_code=422,
            details={"supported_backends": sorted(_ALIASES)},
        )
    if alias != "default":
        return alias

    configured = _ALIASES.get(get_settings().default_chord_backend, DEFAULT_CHORD_BACKEND_ID)
    if configured == "default":
        configured = DEFAULT_CHORD_BACKEND_ID
    backend = _BACKENDS.get(configured, _BACKENDS[DEFAULT_CHORD_BACKEND_ID])
    availability = backend.availability()
    if availability.available:
        return backend.id
    return DEFAULT_CHORD_BACKEND_ID


def detect_with_chord_backend(source_path: Path, backend_id: str) -> ChordDetectionResult:
    backend = resolve_chord_backend(backend_id, require_available=True)
    return backend.detect(source_path)


def chord_backend_is_fast(backend_id: str) -> bool:
    return resolve_chord_backend_id(backend_id) == FAST_CHORD_BACKEND_ID


def chord_backend_uses_source_instrumental_stem(backend_id: str) -> bool:
    return resolve_chord_backend_id(backend_id) in {
        FAST_CHORD_BACKEND_ID,
        CREMA_CHORD_BACKEND_ID,
    }


def _backend_info(backend: ChordDetectionBackend) -> dict[str, Any]:
    availability = backend.availability()
    capabilities = asdict(backend.capabilities)
    return {
        "id": backend.id,
        "label": backend.label,
        "description": backend.description,
        "availability": "available" if availability.available else "unavailable",
        "available": availability.available,
        "unavailable_reason": availability.unavailable_reason,
        "capabilities": capabilities,
        "experimental": backend.capabilities.experimental,
        "desktopOnly": backend.capabilities.desktop_only,
        "desktop_only": backend.capabilities.desktop_only,
    }


def _raise_unavailable(backend: ChordDetectionBackend, availability: ChordBackendAvailability) -> None:
    code = (
        "ADVANCED_CHORD_BACKEND_UNAVAILABLE"
        if backend.id == CREMA_CHORD_BACKEND_ID
        else "CHORD_BACKEND_UNAVAILABLE"
    )
    raise AppError(
        code,
        availability.unavailable_reason or f"{backend.label} is unavailable.",
        status_code=409,
        details={"backend": backend.id},
    )


def _normalize_fast_segment(segment: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(segment)
    pitch_class = normalized.get("pitch_class")
    normalized["root_pitch_class"] = pitch_class if isinstance(pitch_class, int) else None
    normalized["bass_pitch_class"] = None
    normalized["bass_degree"] = None
    normalized["display_label"] = normalized.get("label")
    normalized["raw_label"] = normalized.get("label")
    return cast(dict[str, Any], normalized)
