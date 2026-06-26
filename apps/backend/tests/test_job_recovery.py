from __future__ import annotations

from app.db import SessionLocal
from app.models import Job, utcnow
from app.services.jobs import InProcessJobRunner


def test_running_jobs_are_marked_failed_on_restart(client):
    runtime_detail = "Whisper switched to CPU after the accelerator attempt failed."
    with SessionLocal() as session:
        job = Job(
            id="job_restart",
            project_id=None,
            type="preview",
            status="running",
            progress=55,
            stage="processing",
            stage_label="Transcribing lyrics on CPU.",
            error_message=None,
            runtime_device=None,
            runtime_detail=runtime_detail,
            payload_json={},
            result_artifact_ids_json=[],
            cancel_requested=False,
            started_at=utcnow(),
            completed_at=None,
            duration_seconds=None,
        )
        session.add(job)
        session.commit()

    runner = InProcessJobRunner(SessionLocal)
    runner.recover_running_jobs()

    with SessionLocal() as session:
        recovered = session.get(Job, "job_restart")
        assert recovered is not None
        assert recovered.status == "failed"
        assert recovered.error_message == "Job interrupted during previous shutdown."
        assert recovered.stage == "processing"
        assert recovered.stage_label == "Transcribing lyrics on CPU."
        assert recovered.runtime_detail == runtime_detail
        assert recovered.completed_at is not None
        assert recovered.duration_seconds is not None
