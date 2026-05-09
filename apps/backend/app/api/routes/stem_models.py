from __future__ import annotations

from fastapi import APIRouter

from app.schemas import StemModelSchema, StemModelsResponse
from app.services.stem_models import list_stem_model_infos

router = APIRouter(prefix="/stem-models", tags=["stem-models"])


@router.get("", response_model=StemModelsResponse)
def stem_models() -> StemModelsResponse:
    return StemModelsResponse(
        models=[StemModelSchema.model_validate(model) for model in list_stem_model_infos()]
    )
