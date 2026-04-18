from __future__ import annotations

from app.db import SessionLocal
from app.models import Job
from app.services.jobs import InProcessJobRunner


def test_running_jobs_are_marked_failed_on_restart(client):
    with SessionLocal() as session:
        job = Job(
            id="job_restart",
            project_id=None,
            type="preview",
            status="running",
            progress=55,
            error_message=None,
            payload_json={},
            result_artifact_ids_json=[],
            cancel_requested=False,
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

