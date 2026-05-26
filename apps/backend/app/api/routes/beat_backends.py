from __future__ import annotations

from fastapi import APIRouter

from app.schemas import BeatBackendSchema, BeatBackendsResponse
from app.services.beat_backends import list_beat_backend_infos

router = APIRouter(prefix="/beat-backends", tags=["beat-backends"])


@router.get("", response_model=BeatBackendsResponse)
def beat_backends() -> BeatBackendsResponse:
    return BeatBackendsResponse(
        backends=[BeatBackendSchema.model_validate(backend) for backend in list_beat_backend_infos()]
    )
