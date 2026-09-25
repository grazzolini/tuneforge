from __future__ import annotations

from fastapi import APIRouter

from app.schemas import DrumSubstemCapabilitiesResponse
from app.services.drum_substem_model import drumsep_capabilities

router = APIRouter(prefix="/drum-substems", tags=["drum-substems"])


@router.get("/capabilities", response_model=DrumSubstemCapabilitiesResponse)
def drum_substem_capabilities() -> DrumSubstemCapabilitiesResponse:
    return DrumSubstemCapabilitiesResponse.model_validate(drumsep_capabilities())
