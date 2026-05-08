from __future__ import annotations

from fastapi import APIRouter

from app.config import get_settings
from app.schemas import HealthResponse, VersionInfo
from app.version import get_build_versions

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    settings = get_settings()
    versions = get_build_versions()
    return HealthResponse(
        name=settings.app_name,
        version=versions.backend.git_ref,
        backend_version=VersionInfo(
            package_version=versions.backend.package_version,
            git_ref=versions.backend.git_ref,
        ),
        frontend_version=VersionInfo(
            package_version=versions.frontend.package_version,
            git_ref=versions.frontend.git_ref,
        ),
        status="ok",
        api_base_url=f"{settings.base_url}{settings.api_prefix}",
        data_root=str(settings.data_root),
        default_export_format=settings.default_export_format,
        preview_format=settings.preview_format,
    )
