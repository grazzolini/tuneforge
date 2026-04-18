from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.dependencies import get_db, get_job_runner
from app.errors import AppError
from app.models import Job
from app.schemas import JobResponse, JobSchema, JobsResponse

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=JobsResponse)
def list_jobs(session: Session = Depends(get_db)) -> JobsResponse:
    stmt = select(Job).order_by(Job.updated_at.desc())
    jobs = [JobSchema.model_validate(job) for job in session.scalars(stmt)]
    return JobsResponse(jobs=jobs)


@router.get("/{job_id}", response_model=JobResponse)
def get_job(job_id: str, session: Session = Depends(get_db)) -> JobResponse:
    job = session.get(Job, job_id)
    if job is None:
        raise AppError("JOB_NOT_FOUND", "Job not found.", status_code=404)
    return JobResponse(job=JobSchema.model_validate(job))


@router.post("/{job_id}/cancel", response_model=JobResponse)
def cancel_job(job_id: str, runner=Depends(get_job_runner)) -> JobResponse:
    return JobResponse(job=JobSchema.model_validate(runner.cancel(job_id)))
