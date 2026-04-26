from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy.orm import Session

from app.engines.analysis import analyze_track
from app.models import AnalysisResult, Artifact, Project
from app.services.artifacts import refresh_artifact_file_metadata, register_artifact
from app.services.paths import project_analysis_dir


def analyze_project(session: Session, project: Project) -> AnalysisResult:
    results = analyze_track(Path(project.imported_path))
    analysis = session.get(AnalysisResult, project.id)
    source_artifact = next((artifact for artifact in project.artifacts if artifact.type == "source_audio"), None)
    if analysis is None:
        analysis = AnalysisResult(project_id=project.id)
        session.add(analysis)

    analysis.source_artifact_id = source_artifact.id if isinstance(source_artifact, Artifact) else None
    analysis.estimated_key = results["estimated_key"]  # type: ignore[assignment]
    analysis.key_confidence = results["key_confidence"]  # type: ignore[assignment]
    analysis.estimated_reference_hz = results["estimated_reference_hz"]  # type: ignore[assignment]
    analysis.tuning_offset_cents = results["tuning_offset_cents"]  # type: ignore[assignment]
    analysis.tempo_bpm = results["tempo_bpm"]  # type: ignore[assignment]
    analysis.analysis_version = "v2"
    session.flush()

    analysis_path = project_analysis_dir(project.id) / "analysis.json"
    analysis_path.write_text(
        json.dumps(
            {
                "project_id": project.id,
                "source_artifact_id": analysis.source_artifact_id,
                "estimated_key": analysis.estimated_key,
                "key_confidence": analysis.key_confidence,
                "estimated_reference_hz": analysis.estimated_reference_hz,
                "tuning_offset_cents": analysis.tuning_offset_cents,
                "tempo_bpm": analysis.tempo_bpm,
                "analysis_version": analysis.analysis_version,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    existing_artifact = None
    for artifact in project.artifacts:
        if artifact.type == "analysis_json":
            existing_artifact = artifact
            break
    if existing_artifact is None:
        register_artifact(
            session,
            project_id=project.id,
            artifact_type="analysis_json",
            artifact_format="json",
            path=analysis_path,
            metadata={
                "analysis_version": analysis.analysis_version,
                "source_artifact_id": analysis.source_artifact_id,
            },
            generated_by="analysis",
        )
    else:
        refresh_artifact_file_metadata(existing_artifact, analysis_path)
        existing_artifact.generated_by = "analysis"
        existing_artifact.can_delete = True
        existing_artifact.can_regenerate = True
        existing_artifact.metadata_json = {
            "analysis_version": analysis.analysis_version,
            "source_artifact_id": analysis.source_artifact_id,
        }

    return analysis
