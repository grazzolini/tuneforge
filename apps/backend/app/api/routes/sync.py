from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.schemas import (
    ErrorResponse,
    ProjectSchema,
    SyncMetadataResponse,
    SyncPreflightResponse,
    SyncProjectImportResponse,
    SyncProjectManifestResponse,
    SyncProjectStagedImportRequest,
)
from app.services.sync_identity import run_sync_preflight
from app.services.sync_metadata import get_sync_metadata

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/preflight", response_model=SyncPreflightResponse)
def sync_preflight(session: Session = Depends(get_db)) -> SyncPreflightResponse:
    return SyncPreflightResponse.model_validate(run_sync_preflight(session))


@router.get("/metadata", response_model=SyncMetadataResponse)
def sync_metadata(session: Session = Depends(get_db)) -> SyncMetadataResponse:
    return SyncMetadataResponse.model_validate(get_sync_metadata(session))


@router.get("/projects/{project_id}/manifest", response_model=SyncProjectManifestResponse)
def sync_project_manifest(
    project_id: str,
    session: Session = Depends(get_db),
) -> SyncProjectManifestResponse:
    from app.services.sync_manifest import export_project_manifest

    project_manifest = export_project_manifest(session, project_id=project_id)
    return SyncProjectManifestResponse.model_validate({"project_manifest": project_manifest})


@router.post(
    "/projects/import",
    response_model=SyncProjectImportResponse,
    responses={409: {"model": ErrorResponse, "description": "Duplicate sync project source."}},
)
def sync_project_import(
    payload: SyncProjectStagedImportRequest,
    session: Session = Depends(get_db),
) -> SyncProjectImportResponse:
    from app.services.sync_manifest import import_staged_project_manifest

    project = import_staged_project_manifest(
        session,
        manifest=payload.manifest.model_dump(mode="python"),
        staging_root=payload.staging_root,
    )
    session.commit()
    session.refresh(project)
    return SyncProjectImportResponse(project=ProjectSchema.model_validate(project))
