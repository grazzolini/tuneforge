from __future__ import annotations

import queue
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from subprocess import Popen, TimeoutExpired
from typing import Any, Literal, cast

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.errors import AppError, JobCancelledError
from app.models import Artifact, ChordTimeline, Job, Project, utcnow
from app.schemas import AnalysisRequest, BulkJobRequest, ChordRequest, LyricsGenerateRequest, StemRequest
from app.services.analysis import analyze_project
from app.services.beat_backends import beat_backend_runtime_device
from app.services.chord_backends import resolve_chord_backend
from app.services.chords import detect_project_chords, project_chord_detection_source
from app.services.lyrics import generate_project_lyrics
from app.services.projects import get_mutable_project, get_project
from app.services.stem_models import (
    NON_VOCAL_SIX_STEM_SOURCES,
    STEM_ARTIFACT_TYPE_SOURCES,
    STEM_ARTIFACT_TYPES,
    TWO_STEMS_MODEL_ID,
    resolve_stem_model,
)
from app.services.stem_signal_metadata import stem_signal_analysis_usable
from app.services.stems import generate_stems, resolve_stem_source_artifact
from app.services.transformations import (
    build_preview_plan,
    build_single_transform_plan,
    execute_transform_plan,
    export_artifacts,
)
from app.utils.ids import new_id


@dataclass(frozen=True)
class JobExecutionResult:
    artifact_ids: list[str]
    runtime_device: str | None = None


@dataclass(frozen=True, slots=True)
class ListedJobs:
    jobs: list[Job]
    total: int


JobHandler = Callable[["JobExecutionContext", Session, Job], JobExecutionResult]
JobSortBy = Literal["activity", "created_at", "started_at", "updated_at", "status"]
JobSortOrder = Literal["asc", "desc"]
JobTimestampSortBy = Literal["created_at", "started_at", "updated_at"]
BulkActivityJobType = Literal["analyze", "chords", "lyrics", "stems"]
BulkActivityJobSkipReason = Literal["active_job", "locked", "creation_failed", "no_existing_stems"]
ProjectActivityJobPayload = AnalysisRequest | ChordRequest | LyricsGenerateRequest | StemRequest

_ACTIVE_JOB_STATUSES = ("pending", "running")
_BULK_ACTIVITY_JOB_TYPES = frozenset({"analyze", "chords", "lyrics", "stems"})
_TERMINAL_JOB_STATUSES = ("completed", "cancelled", "failed")
_PROCESS_TERMINATION_GRACE_SECONDS = 1.0


@dataclass(frozen=True, slots=True)
class BulkActivityJobSkippedProject:
    project_id: str
    project_name: str
    reason: BulkActivityJobSkipReason


@dataclass(frozen=True, slots=True)
class BulkActivityJobCreationResult:
    jobs: list[Job]
    total_projects: int
    skipped: list[BulkActivityJobSkippedProject]


def _job_activity_tie_breakers() -> tuple[Any, ...]:
    running_timestamp = case(
        (Job.status == "running", func.coalesce(Job.started_at, Job.created_at)),
        else_=None,
    )
    running_id = case((Job.status == "running", Job.id), else_=None)
    pending_created_at = case((Job.status == "pending", Job.created_at), else_=None)
    pending_id = case((Job.status == "pending", Job.id), else_=None)
    terminal_timestamp = case(
        (Job.status.in_(_TERMINAL_JOB_STATUSES), func.coalesce(Job.completed_at, Job.updated_at)),
        else_=None,
    )
    terminal_id = case((Job.status.in_(_TERMINAL_JOB_STATUSES), Job.id), else_=None)
    return (
        running_timestamp.asc(),
        running_id.asc(),
        pending_created_at.asc(),
        pending_id.asc(),
        terminal_timestamp.desc(),
        terminal_id.desc(),
        Job.updated_at.desc(),
        Job.id.desc(),
    )


def _job_ordering() -> tuple[Any, ...]:
    status_rank = case(
        (Job.status == "running", 0),
        (Job.status == "pending", 1),
        (Job.status.in_(_TERMINAL_JOB_STATUSES), 2),
        else_=3,
    )
    return (status_rank.asc(), *_job_activity_tie_breakers())


def _job_timestamp_ordering(sort_by: JobTimestampSortBy, sort_order: JobSortOrder | None) -> tuple[Any, ...]:
    timestamp_column: Any
    if sort_by == "created_at":
        timestamp_column = Job.created_at
    elif sort_by == "started_at":
        timestamp_column = Job.started_at
    else:
        timestamp_column = Job.updated_at
    direction = sort_order or "desc"
    timestamp_ordering = timestamp_column.asc() if direction == "asc" else timestamp_column.desc()
    return (timestamp_column.is_(None).asc(), timestamp_ordering, Job.id.asc())


def _job_status_ordering(sort_order: JobSortOrder | None) -> tuple[Any, ...]:
    status_rank = case(
        (Job.status == "running", 0),
        (Job.status == "pending", 1),
        (Job.status == "completed", 2),
        (Job.status == "cancelled", 3),
        (Job.status == "failed", 4),
        else_=5,
    )
    status_ordering = status_rank.desc() if sort_order == "desc" else status_rank.asc()
    return (status_ordering, *_job_activity_tie_breakers())


def _list_jobs_ordering(sort_by: JobSortBy, sort_order: JobSortOrder | None) -> tuple[Any, ...]:
    if sort_by == "activity":
        if sort_order is not None:
            raise AppError(
                "INVALID_REQUEST",
                "sort_order is not valid when sort_by is activity.",
                status_code=422,
            )
        return _job_ordering()
    if sort_by == "status":
        return _job_status_ordering(sort_order)
    if sort_by == "created_at":
        return _job_timestamp_ordering("created_at", sort_order)
    if sort_by == "started_at":
        return _job_timestamp_ordering("started_at", sort_order)
    return _job_timestamp_ordering("updated_at", sort_order)


def list_jobs(
    session: Session,
    *,
    limit: int,
    offset: int,
    statuses: Sequence[str] | None = None,
    project_id: str | None = None,
    search: str | None = None,
    sort_by: JobSortBy = "activity",
    sort_order: JobSortOrder | None = None,
) -> ListedJobs:
    filters: list[Any] = []
    status_filters = tuple(statuses or ())
    if status_filters:
        filters.append(Job.status.in_(status_filters))
    if project_id is not None:
        filters.append(Job.project_id == project_id)
    normalized_search = (search or "").strip().lower()
    search_projects = bool(normalized_search)
    if search_projects:
        filters.append(func.lower(Project.display_name).contains(normalized_search, autoescape=True))

    total_statement = select(func.count()).select_from(Job)
    jobs_statement = select(Job)
    if search_projects:
        total_statement = total_statement.join(Project, Project.id == Job.project_id)
        jobs_statement = jobs_statement.join(Project, Project.id == Job.project_id)
    if filters:
        total_statement = total_statement.where(*filters)
        jobs_statement = jobs_statement.where(*filters)

    total = session.scalar(total_statement) or 0
    jobs = list(
        session.scalars(
            jobs_statement.order_by(*_list_jobs_ordering(sort_by, sort_order)).limit(limit).offset(offset)
        )
    )
    return ListedJobs(jobs=jobs, total=total)


def validate_bulk_activity_job_type(job_type: str) -> BulkActivityJobType:
    if job_type not in _BULK_ACTIVITY_JOB_TYPES:
        raise AppError(
            "INVALID_REQUEST",
            "Unsupported bulk job type.",
            status_code=422,
            details={"supported_job_types": sorted(_BULK_ACTIVITY_JOB_TYPES)},
        )
    return cast(BulkActivityJobType, job_type)


def create_project_activity_job(
    session: Session,
    runner: InProcessJobRunner,
    *,
    project_id: str,
    job_type: BulkActivityJobType,
    payload: ProjectActivityJobPayload,
) -> Job:
    project = get_mutable_project(session, project_id)
    job = _create_project_activity_job(session, runner, project=project, job_type=job_type, payload=payload)
    session.commit()
    session.refresh(job)
    runner.enqueue(job.id)
    return job


def create_bulk_activity_jobs(
    session: Session,
    runner: InProcessJobRunner,
    *,
    payload: BulkJobRequest,
) -> BulkActivityJobCreationResult:
    validated_job_type = validate_bulk_activity_job_type(payload.job_type)
    projects = list(
        session.scalars(
            select(Project)
            .where(Project.sync_status != "deleted")
            .order_by(Project.updated_at.desc(), Project.id.desc())
        )
    )
    created_jobs: list[Job] = []
    skipped: list[BulkActivityJobSkippedProject] = []
    for project in projects:
        if _has_active_project_job(session, project_id=project.id, job_type=validated_job_type):
            skipped.append(
                BulkActivityJobSkippedProject(
                    project_id=project.id,
                    project_name=project.display_name,
                    reason="active_job",
                )
            )
            continue
        if not project.sync_editable:
            skipped.append(
                BulkActivityJobSkippedProject(
                    project_id=project.id,
                    project_name=project.display_name,
                    reason="locked",
                )
            )
            continue
        try:
            project_jobs: list[Job] = []
            for job_payload in _bulk_activity_job_payloads(
                session,
                project=project,
                request=payload,
                job_type=validated_job_type,
            ):
                job = _create_project_activity_job(
                    session,
                    runner,
                    project=project,
                    job_type=validated_job_type,
                    payload=job_payload,
                )
                session.flush()
                project_jobs.append(job)
            session.commit()
            for job in project_jobs:
                session.refresh(job)
            created_jobs.extend(project_jobs)
        except AppError as exc:
            session.rollback()
            if exc.code == "PROJECT_SYNC_LOCKED":
                reason: BulkActivityJobSkipReason = "locked"
            elif exc.code == "NO_EXISTING_STEMS":
                reason = "no_existing_stems"
            else:
                reason = "creation_failed"
            skipped.append(
                BulkActivityJobSkippedProject(
                    project_id=project.id,
                    project_name=project.display_name,
                    reason=reason,
                )
            )

    for job in created_jobs:
        runner.enqueue(job.id)

    return BulkActivityJobCreationResult(
        jobs=created_jobs,
        total_projects=len(projects),
        skipped=skipped,
    )


def _has_active_project_job(session: Session, *, project_id: str, job_type: BulkActivityJobType) -> bool:
    return (
        session.scalar(
            select(Job.id)
            .where(
                Job.project_id == project_id,
                Job.type == job_type,
                Job.status.in_(_ACTIVE_JOB_STATUSES),
            )
            .limit(1)
        )
        is not None
    )


def _bulk_activity_job_payloads(
    session: Session,
    *,
    project: Project,
    request: BulkJobRequest,
    job_type: BulkActivityJobType,
) -> list[ProjectActivityJobPayload]:
    if job_type == "stems":
        source_artifact_ids = _existing_stem_source_artifact_ids(session, project_id=project.id)
        if not source_artifact_ids:
            raise AppError("NO_EXISTING_STEMS", "Project has no existing stems to refresh.")
        return [
            StemRequest(
                mode="stems",
                output_format="wav",
                force=True,
                source_artifact_id=source_artifact_id,
                stem_model=request.stem_model,
                chord_backend=request.chord_backend or "default",
                chord_backend_fallback_from=request.chord_backend_fallback_from,
                overwrite_chord_edits=False,
            )
            for source_artifact_id in source_artifact_ids
        ]
    return [_default_bulk_activity_job_payload(job_type, request=request)]


def _default_bulk_activity_job_payload(
    job_type: BulkActivityJobType,
    *,
    request: BulkJobRequest,
) -> ProjectActivityJobPayload:
    if job_type == "analyze":
        return AnalysisRequest(include_tempo=False, force=True, beat_backend=request.beat_backend)
    if job_type == "chords":
        return ChordRequest(
            backend=request.chord_backend or "default",
            backend_fallback_from=request.chord_backend_fallback_from,
            force=True,
            overwrite_user_edits=True,
        )
    if job_type == "lyrics":
        return LyricsGenerateRequest(force=True)
    raise AppError("INVALID_REQUEST", "Job payload does not match job type.", status_code=422)


def _existing_stem_source_artifact_ids(session: Session, *, project_id: str) -> list[str]:
    seen: set[str] = set()
    source_artifact_ids: list[str] = []
    stmt = (
        select(Artifact)
        .where(
            Artifact.project_id == project_id,
            Artifact.type.in_(tuple(STEM_ARTIFACT_TYPES)),
        )
        .order_by(Artifact.created_at.asc(), Artifact.id.asc())
    )
    for artifact in session.scalars(stmt):
        source_artifact_id = artifact.metadata_json.get("source_artifact_id")
        if not isinstance(source_artifact_id, str) or source_artifact_id in seen:
            continue
        seen.add(source_artifact_id)
        source_artifact_ids.append(source_artifact_id)
    return source_artifact_ids


def _create_project_activity_job(
    session: Session,
    runner: InProcessJobRunner,
    *,
    project: Project,
    job_type: BulkActivityJobType,
    payload: ProjectActivityJobPayload,
) -> Job:
    job_payload = _project_activity_job_payload(session, project=project, job_type=job_type, payload=payload)
    return runner.create_job(
        session,
        project_id=project.id,
        job_type=job_type,
        payload=job_payload,
    )


def _project_activity_job_payload(
    session: Session,
    *,
    project: Project,
    job_type: BulkActivityJobType,
    payload: ProjectActivityJobPayload,
) -> dict[str, Any]:
    if job_type == "analyze" and isinstance(payload, AnalysisRequest):
        return payload.model_dump()
    if job_type == "chords" and isinstance(payload, ChordRequest):
        selected_backend = resolve_chord_backend(payload.backend, require_available=True)
        job_payload = payload.model_dump()
        job_payload["chord_backend"] = selected_backend.id
        job_payload["chord_source"] = project_chord_detection_source(project, backend=selected_backend.id)
        return job_payload
    if job_type == "lyrics" and isinstance(payload, LyricsGenerateRequest):
        return payload.model_dump()
    if job_type == "stems" and isinstance(payload, StemRequest):
        source_artifact = resolve_stem_source_artifact(
            session,
            project=project,
            source_artifact_id=payload.source_artifact_id,
        )
        selected_chord_backend = resolve_chord_backend(payload.chord_backend, require_available=False)
        requested_stem_model = payload.stem_model
        if payload.mode == "two_stem" and requested_stem_model in {None, "default"}:
            requested_stem_model = TWO_STEMS_MODEL_ID
        selected_stem_model = resolve_stem_model(requested_stem_model, require_available=False)
        job_payload = payload.model_dump()
        job_payload["chord_backend"] = selected_chord_backend.id
        job_payload["stem_model"] = selected_stem_model.id
        job_payload["stem_model_label"] = selected_stem_model.label
        job_payload["source_artifact_id"] = source_artifact.id
        return job_payload
    raise AppError("INVALID_REQUEST", "Job payload does not match job type.", status_code=422)


def _as_utc_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


class JobExecutionContext:
    def __init__(self, runner: InProcessJobRunner, job_id: str, session: Session) -> None:
        self.runner = runner
        self.job_id = job_id
        self.session = session

    def set_progress(self, progress: int) -> None:
        job = self.session.get(Job, self.job_id)
        if job is None:
            return
        job.progress = progress
        self.session.commit()

    def should_cancel(self) -> bool:
        return self.runner.is_cancel_requested(self.job_id)

    def ensure_not_cancelled(self) -> None:
        if self.should_cancel():
            raise JobCancelledError()

    def register_process(self, process: Popen[str]) -> None:
        self.runner.register_process(self.job_id, process)

    def unregister_process(self) -> None:
        self.runner.unregister_process(self.job_id)


class InProcessJobRunner:
    def __init__(self, session_factory: sessionmaker, *, max_workers: int = 1) -> None:
        self.session_factory = session_factory
        self.max_workers = max_workers
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._worker, name="tuneforge-job-runner", daemon=True)
        self._handlers: dict[str, JobHandler] = {
            "analyze": self._handle_analyze,
            "chords": self._handle_chords,
            "lyrics": self._handle_lyrics,
            "preview": self._handle_preview,
            "retune": self._handle_single_transform,
            "transpose": self._handle_single_transform,
            "stems": self._handle_stems,
            "export": self._handle_export,
        }
        self._active_processes: dict[str, Popen[str]] = {}
        self._lock = threading.Lock()

    def start(self) -> None:
        if not self._thread.is_alive():
            self._thread.start()
        self.recover_pending_jobs()

    def stop(self) -> None:
        self._stop_event.set()
        self._queue.put(None)
        with self._lock:
            for process in self._active_processes.values():
                if process.poll() is None:
                    process.terminate()
        self._thread.join(timeout=2)

    def enqueue(self, job_id: str) -> None:
        self._queue.put(job_id)

    def create_job(self, session: Session, *, project_id: str | None, job_type: str, payload: dict[str, Any]) -> Job:
        if project_id is not None:
            get_mutable_project(session, project_id)
        job_payload = _job_payload_for_create(job_type=job_type, payload=payload)
        job = Job(
            id=new_id("job"),
            project_id=project_id,
            type=job_type,
            status="pending",
            progress=0,
            payload_json=job_payload,
            result_artifact_ids_json=[],
            cancel_requested=False,
        )
        session.add(job)
        session.flush()
        return job

    def recover_running_jobs(self) -> None:
        with self.session_factory() as session:
            running_jobs = list(session.scalars(select(Job).where(Job.status == "running")))
            for job in running_jobs:
                job.status = "failed"
                job.error_message = "Job interrupted during previous shutdown."
                self._mark_job_finished(job)
            session.commit()

    def recover_pending_jobs(self) -> None:
        with self.session_factory() as session:
            for job in session.scalars(select(Job).where(Job.status == "pending").order_by(Job.created_at.asc())):
                self.enqueue(job.id)

    def cancel(self, job_id: str) -> Job:
        with self.session_factory() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise AppError("JOB_NOT_FOUND", "Job not found.", status_code=404)
            job.cancel_requested = True
            if job.status == "pending":
                job.status = "cancelled"
                job.progress = 0
                job.completed_at = utcnow()
            session.commit()
            self._terminate_registered_process(job_id)
            session.refresh(job)
            return job

    def update_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        progress: int | None = None,
        error_message: str | None = None,
        result_artifact_ids: list[str] | None = None,
        runtime_device: str | None = None,
    ) -> None:
        with self.session_factory() as session:
            job = session.get(Job, job_id)
            if job is None:
                return
            if status is not None:
                job.status = status
            if progress is not None:
                job.progress = progress
            if error_message is not None:
                job.error_message = error_message
            if result_artifact_ids is not None:
                job.result_artifact_ids_json = result_artifact_ids
            if runtime_device is not None:
                job.runtime_device = runtime_device
            if status in {"completed", "failed", "cancelled"}:
                self._mark_job_finished(job)
            session.commit()

    def is_cancel_requested(self, job_id: str) -> bool:
        with self.session_factory() as session:
            job = session.get(Job, job_id)
            return bool(job and job.cancel_requested)

    def register_process(self, job_id: str, process: Popen[str]) -> None:
        with self._lock:
            self._active_processes[job_id] = process

    def unregister_process(self, job_id: str) -> None:
        with self._lock:
            self._active_processes.pop(job_id, None)

    def _terminate_registered_process(self, job_id: str) -> None:
        with self._lock:
            process = self._active_processes.get(job_id)
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=_PROCESS_TERMINATION_GRACE_SECONDS)
        except TimeoutExpired:
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=_PROCESS_TERMINATION_GRACE_SECONDS)
            except TimeoutExpired:
                pass

    def _worker(self) -> None:
        while not self._stop_event.is_set():
            job_id = self._queue.get()
            if job_id is None:
                return
            self._execute_job(job_id)

    def _mark_job_finished(self, job: Job) -> None:
        completed_at = utcnow()
        job.completed_at = completed_at
        if job.started_at is None:
            job.duration_seconds = None
            return
        started_at = _as_utc_datetime(job.started_at)
        job.duration_seconds = max(0.0, (_as_utc_datetime(completed_at) - started_at).total_seconds())

    def _execute_job(self, job_id: str) -> None:
        with self.session_factory() as session:
            job = session.get(Job, job_id)
            if job is None or job.status == "cancelled":
                return
            job.status = "running"
            job.progress = 5
            job.error_message = None
            job.runtime_device = None
            job.started_at = utcnow()
            job.completed_at = None
            job.duration_seconds = None
            session.commit()

        try:
            with self.session_factory() as session:
                job = session.get(Job, job_id)
                if job is None:
                    return
                context = JobExecutionContext(self, job_id, session)
                handler = self._handlers.get(job.type)
                if handler is None:
                    raise AppError("PROCESSING_FAILED", f"Unsupported job type: {job.type}")
                if job.project_id is not None:
                    get_mutable_project(session, job.project_id)
                context.ensure_not_cancelled()
                result = handler(context, session, job)
                job.status = "completed"
                job.progress = 100
                job.result_artifact_ids_json = result.artifact_ids
                job.runtime_device = result.runtime_device
                self._mark_job_finished(job)
                session.commit()
        except JobCancelledError:
            self.update_job(job_id, status="cancelled", error_message=None)
        except AppError as exc:
            if self.is_cancel_requested(job_id):
                self.update_job(job_id, status="cancelled", error_message=None)
            else:
                self.update_job(job_id, status="failed", error_message=exc.message)
        except Exception as exc:  # pragma: no cover - defensive fallback
            if self.is_cancel_requested(job_id):
                self.update_job(job_id, status="cancelled", error_message=None)
            else:
                self.update_job(job_id, status="failed", error_message=str(exc))

    def _handle_analyze(self, context: JobExecutionContext, session: Session, job: Job) -> JobExecutionResult:
        project = get_project(session, job.project_id or "")
        payload = AnalysisRequest.model_validate(job.payload_json)
        job.payload_json = {**job.payload_json, "beat_backend": payload.beat_backend, "beat_input": "source"}
        session.flush()
        context.set_progress(20)
        analyze_project(session, project, beat_backend=payload.beat_backend)
        job.payload_json = {
            **job.payload_json,
            "beat_backend": payload.beat_backend,
            "beat_input": "source",
        }
        context.set_progress(90)
        artifact_ids = [artifact.id for artifact in project.artifacts if artifact.type == "analysis_json"]
        return JobExecutionResult(
            artifact_ids=artifact_ids,
            runtime_device=beat_backend_runtime_device(payload.beat_backend),
        )

    def _handle_preview(self, context: JobExecutionContext, session: Session, job: Job) -> JobExecutionResult:
        project = get_project(session, job.project_id or "")
        payload = job.payload_json
        plan, cached = build_preview_plan(
            session,
            project=project,
            retune=payload.get("retune"),
            transpose=payload.get("transpose"),
            output_format=payload.get("output_format", "wav"),
        )
        if cached:
            context.set_progress(100)
            return JobExecutionResult(artifact_ids=[cached.id])
        artifact = execute_transform_plan(
            session,
            project=project,
            plan=plan,
            on_progress=context.set_progress,
            should_cancel=context.should_cancel,
            register_process=context.register_process,
            unregister_process=context.unregister_process,
        )
        return JobExecutionResult(artifact_ids=[artifact.id])

    def _handle_chords(self, context: JobExecutionContext, session: Session, job: Job) -> JobExecutionResult:
        project = get_project(session, job.project_id or "")
        backend = str(job.payload_json.get("backend", "default"))
        selected_backend = resolve_chord_backend(backend, require_available=True)
        job.payload_json = {
            **job.payload_json,
            "chord_backend": selected_backend.id,
            "chord_source": project_chord_detection_source(project, backend=selected_backend.id),
        }
        session.flush()
        context.set_progress(20)
        chords = detect_project_chords(
            session,
            project,
            backend=backend,
            backend_fallback_from=job.payload_json.get("backend_fallback_from")
            if isinstance(job.payload_json.get("backend_fallback_from"), str)
            else None,
            force=bool(job.payload_json.get("force", False)),
            overwrite_user_edits=bool(job.payload_json.get("overwrite_user_edits", False)),
        )
        context.set_progress(90)
        runtime_device = chords.metadata_json.get("runtime_device")
        return JobExecutionResult(
            artifact_ids=[],
            runtime_device=runtime_device if isinstance(runtime_device, str) else None,
        )

    def _handle_lyrics(self, context: JobExecutionContext, session: Session, job: Job) -> JobExecutionResult:
        project = get_project(session, job.project_id or "")
        payload = LyricsGenerateRequest.model_validate(job.payload_json)
        context.set_progress(15)
        lyrics = generate_project_lyrics(
            session,
            project=project,
            force=payload.force,
            language_override=payload.language_override,
            should_cancel=context.should_cancel,
            register_process=context.register_process,
            unregister_process=context.unregister_process,
        )
        context.set_progress(90)
        return JobExecutionResult(artifact_ids=[], runtime_device=lyrics.device)

    def _handle_single_transform(self, context: JobExecutionContext, session: Session, job: Job) -> JobExecutionResult:
        project = get_project(session, job.project_id or "")
        plan = build_single_transform_plan(session, project=project, transform_type=job.type, payload=job.payload_json)
        artifact = execute_transform_plan(
            session,
            project=project,
            plan=plan,
            on_progress=context.set_progress,
            should_cancel=context.should_cancel,
            register_process=context.register_process,
            unregister_process=context.unregister_process,
        )
        return JobExecutionResult(artifact_ids=[artifact.id])

    def _handle_export(self, context: JobExecutionContext, session: Session, job: Job) -> JobExecutionResult:
        project = get_project(session, job.project_id or "")
        payload = job.payload_json
        context.set_progress(25)
        artifact = export_artifacts(
            session,
            project=project,
            artifact_ids=list(payload.get("artifact_ids", [])),
            output_format=payload.get("output_format", "wav"),
            destination_path=payload.get("destination_path"),
        )
        context.set_progress(90)
        return JobExecutionResult(artifact_ids=[artifact.id])

    def _handle_stems(self, context: JobExecutionContext, session: Session, job: Job) -> JobExecutionResult:
        project = get_project(session, job.project_id or "")
        payload = job.payload_json
        stem_result = generate_stems(
            session,
            project=project,
            source_artifact_id=payload.get("source_artifact_id"),
            output_format=payload.get("output_format", "wav"),
            force=bool(payload.get("force", False)),
            stem_model=payload.get("stem_model") if isinstance(payload.get("stem_model"), str) else None,
            on_progress=context.set_progress,
            should_cancel=context.should_cancel,
            register_process=context.register_process,
            unregister_process=context.unregister_process,
        )
        artifacts = stem_result.artifacts
        chord_source = _stem_artifacts_chord_source(artifacts)
        if _should_enqueue_chord_refresh_after_stems(
            job,
            artifacts,
            session.get(ChordTimeline, project.id),
            generated_this_job=stem_result.generated_this_job,
            signal_metadata_hydrated=stem_result.signal_metadata_hydrated,
        ):
            selected_chord_backend = resolve_chord_backend(
                str(payload.get("chord_backend", "default")),
                require_available=False,
            )
            chord_job = self.create_job(
                session,
                project_id=project.id,
                job_type="chords",
                payload={
                    "backend": selected_chord_backend.id,
                    "backend_fallback_from": payload.get("chord_backend_fallback_from")
                    if isinstance(payload.get("chord_backend_fallback_from"), str)
                    else None,
                    "force": True,
                    "overwrite_user_edits": bool(payload.get("overwrite_chord_edits", False)),
                    "chord_backend": selected_chord_backend.id,
                    "chord_source": chord_source,
                },
            )
            self.enqueue(chord_job.id)
        runtime_device = next(
            (
                artifact.metadata_json.get("device")
                for artifact in artifacts
                if isinstance(artifact.metadata_json.get("device"), str)
            ),
            None,
        )
        return JobExecutionResult(
            artifact_ids=[artifact.id for artifact in artifacts],
            runtime_device=runtime_device,
        )


def _job_payload_for_create(*, job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if job_type == "analyze":
        return {**payload, "beat_input": "source"}
    return payload


def _should_enqueue_chord_refresh_after_stems(
    job: Job,
    artifacts: list[Artifact],
    chords: ChordTimeline | None,
    *,
    generated_this_job: bool,
    signal_metadata_hydrated: bool,
) -> bool:
    if not generated_this_job and not signal_metadata_hydrated:
        return False
    if _stem_artifacts_chord_source(artifacts) != "source+stem":
        return False
    overwrite_chord_edits = bool(job.payload_json.get("overwrite_chord_edits", False))
    if chords is not None and chords.has_user_edits and not overwrite_chord_edits:
        return False
    return True


def _stem_artifacts_chord_source(artifacts: list[Artifact]) -> Literal["source", "source+stem"]:
    if any(_is_signal_bearing_chord_stem(artifact) for artifact in artifacts):
        return "source+stem"
    return "source"


def _is_signal_bearing_chord_stem(artifact: Artifact) -> bool:
    metadata = artifact.metadata_json
    source_artifact_id = metadata.get("source_artifact_id")
    if not isinstance(source_artifact_id, str) or not source_artifact_id:
        return False
    source_artifact_type = metadata.get("source_artifact_type")
    if source_artifact_type not in {None, "source_audio"}:
        return False
    if not stem_signal_analysis_usable(metadata):
        return False
    if artifact.type == "instrumental_stem":
        return True

    stem_source = metadata.get("stem_source")
    return (
        isinstance(stem_source, str)
        and stem_source in NON_VOCAL_SIX_STEM_SOURCES
        and STEM_ARTIFACT_TYPE_SOURCES.get(artifact.type) == stem_source
    )
