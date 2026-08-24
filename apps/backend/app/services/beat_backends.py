from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.engines.beat_this import beat_this_dependency_status

BUILT_IN_BEAT_BACKEND_ID = "built-in"
BEAT_THIS_BEAT_BACKEND_ID = "beat-this"
DEFAULT_BEAT_BACKEND_ID = BEAT_THIS_BEAT_BACKEND_ID


@dataclass(frozen=True)
class BeatBackendAvailability:
    available: bool
    unavailable_reason: str | None = None


@dataclass(frozen=True)
class BeatBackendInfo:
    id: str
    label: str
    description: str
    experimental: bool
    desktop_only: bool
    runtime_device: str

    def availability(self) -> BeatBackendAvailability:
        if self.id == BEAT_THIS_BEAT_BACKEND_ID:
            available, reason = beat_this_dependency_status()
            return BeatBackendAvailability(available=available, unavailable_reason=reason)
        return BeatBackendAvailability(available=True)


_BACKENDS: dict[str, BeatBackendInfo] = {
    BUILT_IN_BEAT_BACKEND_ID: BeatBackendInfo(
        id=BUILT_IN_BEAT_BACKEND_ID,
        label="Built-in Beat Analysis",
        description="TuneForge's built-in librosa heuristic for tempo and beat timing.",
        experimental=False,
        desktop_only=False,
        runtime_device="cpu",
    ),
    BEAT_THIS_BEAT_BACKEND_ID: BeatBackendInfo(
        id=BEAT_THIS_BEAT_BACKEND_ID,
        label="Advanced Beat Analysis",
        description="Optional beat-this ML model for experimental beat timing.",
        experimental=True,
        desktop_only=True,
        runtime_device="cpu",
    ),
}


def list_beat_backend_infos() -> list[dict[str, Any]]:
    return [_backend_info(backend) for backend in _BACKENDS.values()]


def beat_backend_runtime_device(backend_id: str | None) -> str | None:
    if backend_id is None:
        return None
    return _BACKENDS.get(backend_id, _BACKENDS[DEFAULT_BEAT_BACKEND_ID]).runtime_device


def _backend_info(backend: BeatBackendInfo) -> dict[str, Any]:
    availability = backend.availability()
    return {
        "id": backend.id,
        "label": backend.label,
        "description": backend.description,
        "availability": "available" if availability.available else "unavailable",
        "available": availability.available,
        "unavailable_reason": availability.unavailable_reason,
        "experimental": backend.experimental,
        "desktopOnly": backend.desktop_only,
        "desktop_only": backend.desktop_only,
        "runtime_device": backend.runtime_device,
    }
