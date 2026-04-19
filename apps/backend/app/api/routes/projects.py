from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.dependencies import get_db, get_job_runner
from app.errors import AppError
from app.models import AnalysisResult, Artifact, ChordTimeline
from app.schemas import (
    AnalysisRequest,
    AnalysisResponse,
    AnalysisSchema,
    ArtifactSchema,
    ArtifactsResponse,
    ChordRequest,
    ChordResponse,
    DeleteResponse,
    ExportRequest,
    JobResponse,
    JobSchema,
    PreviewRequest,
    ProjectImportRequest,
    ProjectResponse,
    ProjectSchema,
    ProjectsResponse,
    ProjectUpdateRequest,
    RetuneRequest,
    StemRequest,
    TransposeRequest,
)
from app.services.artifacts import delete_project_artifact
from app.services.projects import (
    delete_project,
    get_project,
    import_project,
    list_projects,
    rename_project,
)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("/import", response_model=ProjectResponse)
def create_project(payload: ProjectImportRequest, session: Session = Depends(get_db)) -> ProjectResponse:
    project = import_project(
        session,
        source_path=payload.source_path,
        copy_into_project=payload.copy_into_project,
        display_name=payload.display_name,
    )
    return ProjectResponse(project=ProjectSchema.model_validate(project))


@router.get("", response_model=ProjectsResponse)
def projects(session: Session = Depends(get_db)) -> ProjectsResponse:
    projects_payload = [ProjectSchema.model_validate(project) for project in list_projects(session)]
    return ProjectsResponse(projects=projects_payload)


@router.get("/{project_id}", response_model=ProjectResponse)
def project_detail(project_id: str, session: Session = Depends(get_db)) -> ProjectResponse:
    return ProjectResponse(project=ProjectSchema.model_validate(get_project(session, project_id)))


@router.patch("/{project_id}", response_model=ProjectResponse)
def project_update(
    project_id: str,
    payload: ProjectUpdateRequest,
    session: Session = Depends(get_db),
) -> ProjectResponse:
    project = rename_project(session, project_id, display_name=payload.display_name)
    return ProjectResponse(project=ProjectSchema.model_validate(project))


@router.delete("/{project_id}", response_model=DeleteResponse)
def project_delete(project_id: str, session: Session = Depends(get_db)) -> DeleteResponse:
    delete_project(session, project_id)
    return DeleteResponse(deleted=True)


@router.post("/{project_id}/analyze", response_model=JobResponse)
def project_analyze(
    project_id: str,
    payload: AnalysisRequest,
    session: Session = Depends(get_db),
    runner=Depends(get_job_runner),
) -> JobResponse:
    get_project(session, project_id)
    job = runner.create_job(
        session,
        project_id=project_id,
        job_type="analyze",
        payload=payload.model_dump(),
    )
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return JobResponse(job=JobSchema.model_validate(job))


@router.get("/{project_id}/analysis", response_model=AnalysisResponse)
def project_analysis(project_id: str, session: Session = Depends(get_db)) -> AnalysisResponse:
    get_project(session, project_id)
    analysis = session.get(AnalysisResult, project_id)
    return AnalysisResponse(analysis=AnalysisSchema.model_validate(analysis) if analysis else None)


@router.post("/{project_id}/chords", response_model=JobResponse)
def project_chords(
    project_id: str,
    payload: ChordRequest,
    session: Session = Depends(get_db),
    runner=Depends(get_job_runner),
) -> JobResponse:
    get_project(session, project_id)
    job = runner.create_job(
        session,
        project_id=project_id,
        job_type="chords",
        payload=payload.model_dump(),
    )
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return JobResponse(job=JobSchema.model_validate(job))


@router.get("/{project_id}/chords", response_model=ChordResponse)
def project_chords_detail(project_id: str, session: Session = Depends(get_db)) -> ChordResponse:
    get_project(session, project_id)
    chords = session.get(ChordTimeline, project_id)
    if chords is None:
        return ChordResponse(project_id=project_id, timeline=[], backend=None, source_artifact_id=None, created_at=None)
    return ChordResponse.model_validate(chords)


@router.post("/{project_id}/retune", response_model=JobResponse)
def project_retune(
    project_id: str,
    payload: RetuneRequest,
    session: Session = Depends(get_db),
    runner=Depends(get_job_runner),
) -> JobResponse:
    get_project(session, project_id)
    job = runner.create_job(
        session,
        project_id=project_id,
        job_type="retune",
        payload=payload.model_dump(),
    )
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return JobResponse(job=JobSchema.model_validate(job))


@router.post("/{project_id}/transpose", response_model=JobResponse)
def project_transpose(
    project_id: str,
    payload: TransposeRequest,
    session: Session = Depends(get_db),
    runner=Depends(get_job_runner),
) -> JobResponse:
    get_project(session, project_id)
    job = runner.create_job(
        session,
        project_id=project_id,
        job_type="transpose",
        payload=payload.model_dump(),
    )
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return JobResponse(job=JobSchema.model_validate(job))


@router.post("/{project_id}/preview", response_model=JobResponse)
def project_preview(
    project_id: str,
    payload: PreviewRequest,
    session: Session = Depends(get_db),
    runner=Depends(get_job_runner),
) -> JobResponse:
    get_project(session, project_id)
    job = runner.create_job(
        session,
        project_id=project_id,
        job_type="preview",
        payload=payload.model_dump(exclude_none=True),
    )
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return JobResponse(job=JobSchema.model_validate(job))


@router.post("/{project_id}/stems", response_model=JobResponse)
def project_stems(
    project_id: str,
    payload: StemRequest,
    session: Session = Depends(get_db),
    runner=Depends(get_job_runner),
) -> JobResponse:
    get_project(session, project_id)
    job = runner.create_job(
        session,
        project_id=project_id,
        job_type="stems",
        payload=payload.model_dump(),
    )
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return JobResponse(job=JobSchema.model_validate(job))


@router.get("/{project_id}/artifacts", response_model=ArtifactsResponse)
def project_artifacts(project_id: str, session: Session = Depends(get_db)) -> ArtifactsResponse:
    get_project(session, project_id)
    stmt = select(Artifact).where(Artifact.project_id == project_id).order_by(Artifact.created_at.desc())
    artifacts = [ArtifactSchema.model_validate(artifact) for artifact in session.scalars(stmt)]
    return ArtifactsResponse(artifacts=artifacts)


@router.delete("/{project_id}/artifacts/{artifact_id}", response_model=DeleteResponse)
def project_artifact_delete(project_id: str, artifact_id: str, session: Session = Depends(get_db)) -> DeleteResponse:
    get_project(session, project_id)
    delete_project_artifact(session, project_id=project_id, artifact_id=artifact_id)
    session.commit()
    return DeleteResponse(deleted=True)


@router.post("/{project_id}/export", response_model=JobResponse)
def project_export(
    project_id: str,
    payload: ExportRequest,
    session: Session = Depends(get_db),
    runner=Depends(get_job_runner),
) -> JobResponse:
    project = get_project(session, project_id)
    for artifact_id in payload.artifact_ids:
        artifact = session.get(Artifact, artifact_id)
        if artifact is None or artifact.project_id != project.id:
            raise AppError("ARTIFACT_NOT_FOUND", "Artifact does not belong to this project.", status_code=404)
    job = runner.create_job(
        session,
        project_id=project_id,
        job_type="export",
        payload=payload.model_dump(),
    )
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return JobResponse(job=JobSchema.model_validate(job))
