from __future__ import annotations

import queue
import threading
from collections.abc import Callable
from subprocess import Popen
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.errors import AppError, JobCancelledError
from app.models import Job
from app.services.analysis import analyze_project
from app.services.chords import detect_project_chords
from app.services.lyrics import generate_project_lyrics
from app.services.projects import get_project
from app.services.stems import generate_stems
from app.services.transformations import (
    build_preview_plan,
    build_single_transform_plan,
    execute_transform_plan,
    export_artifacts,
)
from app.utils.ids import new_id

JobHandler = Callable[["JobExecutionContext", Session, Job], list[str]]


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
        job = Job(
            id=new_id("job"),
            project_id=project_id,
            type=job_type,
            status="pending",
            progress=0,
            payload_json=payload,
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
            session.commit()
            with self._lock:
                process = self._active_processes.get(job_id)
                if process and process.poll() is None:
                    process.terminate()
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

    def _worker(self) -> None:
        while not self._stop_event.is_set():
            job_id = self._queue.get()
            if job_id is None:
                return
            self._execute_job(job_id)

    def _execute_job(self, job_id: str) -> None:
        with self.session_factory() as session:
            job = session.get(Job, job_id)
            if job is None or job.status == "cancelled":
                return
            job.status = "running"
            job.progress = 5
            job.error_message = None
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
                artifact_ids = handler(context, session, job)
                job.status = "completed"
                job.progress = 100
                job.result_artifact_ids_json = artifact_ids
                session.commit()
        except JobCancelledError:
            self.update_job(job_id, status="cancelled", error_message=None)
        except AppError as exc:
            self.update_job(job_id, status="failed", error_message=exc.message)
        except Exception as exc:  # pragma: no cover - defensive fallback
            self.update_job(job_id, status="failed", error_message=str(exc))

    def _handle_analyze(self, context: JobExecutionContext, session: Session, job: Job) -> list[str]:
        project = get_project(session, job.project_id or "")
        context.set_progress(20)
        analyze_project(session, project)
        context.set_progress(90)
        artifact_ids = [artifact.id for artifact in project.artifacts if artifact.type == "analysis_json"]
        if not artifact_ids:
            artifact_ids = []
        return artifact_ids

    def _handle_preview(self, context: JobExecutionContext, session: Session, job: Job) -> list[str]:
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
            return [cached.id]
        artifact = execute_transform_plan(
            session,
            project=project,
            plan=plan,
            on_progress=context.set_progress,
            should_cancel=context.should_cancel,
            register_process=context.register_process,
            unregister_process=context.unregister_process,
        )
        return [artifact.id]

    def _handle_chords(self, context: JobExecutionContext, session: Session, job: Job) -> list[str]:
        project = get_project(session, job.project_id or "")
        context.set_progress(20)
        detect_project_chords(session, project, force=bool(job.payload_json.get("force", False)))
        context.set_progress(90)
        return []

    def _handle_lyrics(self, context: JobExecutionContext, session: Session, job: Job) -> list[str]:
        project = get_project(session, job.project_id or "")
        context.set_progress(15)
        generate_project_lyrics(session, project=project, force=bool(job.payload_json.get("force", False)))
        context.set_progress(90)
        return []

    def _handle_single_transform(self, context: JobExecutionContext, session: Session, job: Job) -> list[str]:
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
        return [artifact.id]

    def _handle_export(self, context: JobExecutionContext, session: Session, job: Job) -> list[str]:
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
        return [artifact.id]

    def _handle_stems(self, context: JobExecutionContext, session: Session, job: Job) -> list[str]:
        project = get_project(session, job.project_id or "")
        payload = job.payload_json
        artifacts = generate_stems(
            session,
            project=project,
            source_artifact_id=payload.get("source_artifact_id"),
            output_format=payload.get("output_format", "wav"),
            force=bool(payload.get("force", False)),
            on_progress=context.set_progress,
            should_cancel=context.should_cancel,
            register_process=context.register_process,
            unregister_process=context.unregister_process,
        )
        return [artifact.id for artifact in artifacts]
