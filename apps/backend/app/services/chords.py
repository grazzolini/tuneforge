from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from sqlalchemy.orm import Session

from app.engines.chords import detect_chord_timeline
from app.models import Artifact, ChordTimeline, Project, utcnow
from app.services.paths import project_analysis_dir


def detect_project_chords(session: Session, project: Project, *, force: bool = False) -> ChordTimeline:
    existing = session.get(ChordTimeline, project.id)
    if existing is not None and existing.timeline_json and not force:
        return existing

    source_artifact = next((artifact for artifact in project.artifacts if artifact.type == "source_audio"), None)
    timeline = detect_chord_timeline(Path(project.imported_path))
    created_at = utcnow()

    if existing is None:
        existing = ChordTimeline(project_id=project.id)
        session.add(existing)

    existing.backend = "default"
    existing.source_artifact_id = source_artifact.id if isinstance(source_artifact, Artifact) else None
    existing.timeline_json = cast(list[dict[str, Any]], timeline)
    existing.created_at = created_at
    session.flush()

    chord_path = project_analysis_dir(project.id) / "chords.json"
    chord_path.write_text(
        json.dumps(
            {
                "project_id": project.id,
                "backend": existing.backend,
                "source_artifact_id": existing.source_artifact_id,
                "timeline": existing.timeline_json,
                "created_at": existing.created_at.isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    return existing
