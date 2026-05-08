from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.errors import AppError
from app.models import Artifact

router = APIRouter(prefix="/artifacts", tags=["artifacts"])

AUDIO_MEDIA_TYPES = {
    "aac": "audio/aac",
    "flac": "audio/flac",
    "m4a": "audio/mp4",
    "mka": "audio/x-matroska",
    "mkv": "video/x-matroska",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "wav": "audio/wav",
    "webm": "audio/webm",
}


@router.get("/{artifact_id}/stream")
def stream_artifact(artifact_id: str, session: Session = Depends(get_db)) -> FileResponse:
    artifact = session.get(Artifact, artifact_id)
    if artifact is None:
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact not found.", status_code=404)
    path = Path(artifact.path)
    if not path.exists():
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact file no longer exists.", status_code=404)
    media_type = AUDIO_MEDIA_TYPES.get(artifact.format.lower(), f"audio/{artifact.format}")
    return FileResponse(path=path, media_type=media_type, filename=path.name)
