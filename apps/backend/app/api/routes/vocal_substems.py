from fastapi import APIRouter

from app.schemas import VocalSubstemCapabilitiesResponse
from app.services.vocal_substem_model import vocal_substem_capabilities

router = APIRouter(prefix="/vocal-substems", tags=["vocal-substems"])


@router.get("/capabilities", response_model=VocalSubstemCapabilitiesResponse)
def vocal_capabilities() -> VocalSubstemCapabilitiesResponse:
    return VocalSubstemCapabilitiesResponse.model_validate(vocal_substem_capabilities())
