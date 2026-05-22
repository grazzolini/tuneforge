from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.pagination import PaginationQuery, pagination_metadata
from app.dependencies import get_db, get_job_runner
from app.errors import AppError
from app.models import Job
from app.schemas import JobResponse, JobSchema, JobsResponse
from app.services.jobs import JobSortBy, JobSortOrder
from app.services.jobs import list_jobs as list_jobs_service

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=JobsResponse)
def list_jobs(
    pagination: PaginationQuery,
    status: list[str] | None = Query(default=None, description="Filter jobs by status. May be repeated."),
    project_id: str | None = Query(default=None, description="Filter jobs by project ID."),
    search: str | None = Query(default=None, description="Filter jobs by project display name."),
    sort_by: JobSortBy = Query(default="activity", description="Sort jobs by activity, timestamp, or status."),
    sort_order: JobSortOrder | None = Query(default=None, description="Sort direction. Not valid with activity sort."),
    session: Session = Depends(get_db),
) -> JobsResponse:
    listed_jobs = list_jobs_service(
        session,
        limit=pagination.limit,
        offset=pagination.offset,
        statuses=status,
        project_id=project_id,
        search=search,
        sort_by=sort_by,
        sort_order=sort_order,
    )
    jobs = [JobSchema.model_validate(job) for job in listed_jobs.jobs]
    metadata = pagination_metadata(
        total=listed_jobs.total,
        limit=pagination.limit,
        offset=pagination.offset,
        number_of_returned_items=len(jobs),
    )
    return JobsResponse(jobs=jobs, **metadata)


@router.get("/{job_id}", response_model=JobResponse)
def get_job(job_id: str, session: Session = Depends(get_db)) -> JobResponse:
    job = session.get(Job, job_id)
    if job is None:
        raise AppError("JOB_NOT_FOUND", "Job not found.", status_code=404)
    return JobResponse(job=JobSchema.model_validate(job))


@router.post("/{job_id}/cancel", response_model=JobResponse)
def cancel_job(job_id: str, runner=Depends(get_job_runner)) -> JobResponse:
    return JobResponse(job=JobSchema.model_validate(runner.cancel(job_id)))
