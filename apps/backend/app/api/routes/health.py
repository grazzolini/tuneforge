from __future__ import annotations

from fastapi import APIRouter

from app import __version__
from app.config import get_settings
from app.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(
        name=settings.app_name,
        version=__version__,
        status="ok",
        api_base_url=f"{settings.base_url}{settings.api_prefix}",
        data_root=str(settings.data_root),
        default_export_format=settings.default_export_format,
        preview_format=settings.preview_format,
    )

