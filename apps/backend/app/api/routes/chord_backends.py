from __future__ import annotations

from fastapi import APIRouter

from app.schemas import ChordBackendSchema, ChordBackendsResponse
from app.services.chord_backends import list_chord_backend_infos

router = APIRouter(prefix="/chord-backends", tags=["chord-backends"])


@router.get("", response_model=ChordBackendsResponse)
def chord_backends() -> ChordBackendsResponse:
    return ChordBackendsResponse(
        backends=[ChordBackendSchema.model_validate(backend) for backend in list_chord_backend_infos()]
    )
