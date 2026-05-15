from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.schemas import SyncMetadataResponse, SyncPreflightResponse
from app.services.sync_identity import run_sync_preflight
from app.services.sync_metadata import get_sync_metadata

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/preflight", response_model=SyncPreflightResponse)
def sync_preflight(session: Session = Depends(get_db)) -> SyncPreflightResponse:
    return SyncPreflightResponse.model_validate(run_sync_preflight(session))


@router.get("/metadata", response_model=SyncMetadataResponse)
def sync_metadata(session: Session = Depends(get_db)) -> SyncMetadataResponse:
    return SyncMetadataResponse.model_validate(get_sync_metadata(session))
