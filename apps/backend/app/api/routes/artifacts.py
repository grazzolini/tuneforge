from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.errors import AppError
from app.models import Artifact

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


@router.get("/{artifact_id}/stream")
def stream_artifact(artifact_id: str, session: Session = Depends(get_db)) -> FileResponse:
    artifact = session.get(Artifact, artifact_id)
    if artifact is None:
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact not found.", status_code=404)
    path = Path(artifact.path)
    if not path.exists():
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact file no longer exists.", status_code=404)
    return FileResponse(path=path, media_type=f"audio/{artifact.format}", filename=path.name)

