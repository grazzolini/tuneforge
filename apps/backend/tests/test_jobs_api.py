from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta
from subprocess import TimeoutExpired
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.errors import AppError
from app.models import AnalysisResult, Artifact, Job, Project
from app.runtime_status import runtime_event_payload
from app.services.jobs import InProcessJobRunner, JobExecutionContext, JobExecutionResult

_BASE_TIME = datetime(2026, 1, 1, tzinfo=UTC)


def _timestamp(minutes: int) -> datetime:
    return _BASE_TIME + timedelta(minutes=minutes)


def _add_project(
    session: Session,
    project_id: str,
    *,
    display_name: str | None = None,
    sync_status: str = "local",
    sync_status_reason: str | None = None,
) -> None:
    session.add(
        Project(
            id=project_id,
            display_name=display_name or project_id,
            source_path=f"/tmp/{project_id}.wav",
            imported_path=f"/tmp/tuneforge/{project_id}.wav",
            sync_status=sync_status,
            sync_status_reason=sync_status_reason,
        )
    )


def _add_job(
    session: Session,
    job_id: str,
    status: str,
    *,
    project_id: str | None = None,
    job_type: str = "test",
    created_at: datetime | None = None,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
    updated_at: datetime | None = None,
    payload_json: dict[str, Any] | None = None,
) -> None:
    effective_created_at = created_at or _timestamp(0)
    session.add(
        Job(
            id=job_id,
            project_id=project_id,
            type=job_type,
            status=status,
            progress=0,
            error_message=None,
            runtime_device=None,
            payload_json=payload_json or {},
            result_artifact_ids_json=[],
            cancel_requested=False,
            created_at=effective_created_at,
            started_at=started_at,
            completed_at=completed_at,
            duration_seconds=None,
            updated_at=updated_at or completed_at or started_at or effective_created_at,
        )
    )


def _add_artifact(
    session: Session,
    artifact_id: str,
    project_id: str,
    artifact_type: str,
    *,
    metadata: dict[str, str] | None = None,
) -> None:
    session.add(
        Artifact(
            id=artifact_id,
            project_id=project_id,
            type=artifact_type,
            format="wav",
            path=f"/tmp/{artifact_id}.wav",
            metadata_json=metadata or {},
            generated_by="test",
            can_delete=True,
            can_regenerate=True,
        )
    )


def _capture_enqueued_jobs(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    enqueued: list[str] = []
    monkeypatch.setattr(client.app.state.job_runner, "enqueue", enqueued.append)
    return enqueued


def test_bulk_jobs_creates_jobs_for_editable_projects(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enqueued = _capture_enqueued_jobs(client, monkeypatch)
    with SessionLocal() as session:
        _add_project(session, "project_a")
        _add_project(session, "project_b")
        session.commit()

    response = client.post(
        "/api/v1/jobs/bulk",
        json={"job_type": "chords", "chord_backend": "tuneforge-fast"},
    )

    assert response.status_code == 200
    payload = response.json()
    created_jobs = payload["created_jobs"]
    assert payload["total_projects"] == 2
    assert payload["skipped"] == []
    assert {job["project_id"] for job in created_jobs} == {"project_a", "project_b"}
    assert {job["type"] for job in created_jobs} == {"chords"}
    assert {job["status"] for job in created_jobs} == {"pending"}
    assert {job["stage"] for job in created_jobs} == {"queued"}
    assert {job["stage_label"] for job in created_jobs} == {"Waiting to start."}
    assert {job["runtime_detail"] for job in created_jobs} == {None}
    assert set(enqueued) == {job["id"] for job in created_jobs}

    with SessionLocal() as session:
        jobs = list(session.scalars(select(Job).where(Job.type == "chords")))
        assert {job.project_id for job in jobs} == {"project_a", "project_b"}
        assert all(job.payload_json["force"] is True for job in jobs)
        assert all(job.payload_json["overwrite_user_edits"] is True for job in jobs)
        assert all(job.payload_json["chord_backend"] == "tuneforge-fast" for job in jobs)
        assert all(job.stage == "queued" for job in jobs)
        assert all(job.stage_label == "Waiting to start." for job in jobs)
        assert all(job.runtime_detail is None for job in jobs)


def test_jobs_schema_exposes_runtime_status_fields(client: TestClient) -> None:
    runner = InProcessJobRunner(SessionLocal)
    with SessionLocal() as session:
        job = runner.create_job(session, project_id=None, job_type="test", payload={})
        job_id = job.id
        session.commit()

    get_response = client.get(f"/api/v1/jobs/{job_id}")
    assert get_response.status_code == 200
    payload = get_response.json()["job"]
    assert payload["stage"] == "queued"
    assert payload["stage_label"] == "Waiting to start."
    assert payload["runtime_detail"] is None

    list_response = client.get("/api/v1/jobs")
    assert list_response.status_code == 200
    listed_job = next(job for job in list_response.json()["jobs"] if job["id"] == job_id)
    assert listed_job["stage"] == "queued"
    assert listed_job["stage_label"] == "Waiting to start."
    assert listed_job["runtime_detail"] is None


def test_runtime_status_helper_updates_fields_and_drops_unsafe_detail(client: TestClient) -> None:
    runner = InProcessJobRunner(SessionLocal)
    safe_detail = "Whisper switched to CPU after the accelerator attempt failed."
    with SessionLocal() as session:
        job = runner.create_job(session, project_id=None, job_type="test", payload={})
        job_id = job.id
        session.commit()

    with SessionLocal() as session:
        context = JobExecutionContext(runner, job_id, session)
        context.handle_runtime_event(
            runtime_event_payload(
                stage="fallback",
                stage_label="Falling back from MPS to CPU.",
                runtime_device="MPS",
                runtime_detail="/tmp/private/song.wav failed",
                progress=42,
            )
        )

    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.stage == "fallback"
        assert job.stage_label == "Falling back from MPS to CPU."
        assert job.runtime_device == "mps"
        assert job.runtime_detail is None
        assert job.progress == 42

    runner.update_runtime_status(
        job_id,
        runtime_detail=safe_detail,
        stage_label="Falling back from MPS to CPU.",
    )

    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.runtime_detail == safe_detail


def test_jobs_api_drops_unsafe_runtime_text_before_exposure(client: TestClient) -> None:
    runner = InProcessJobRunner(SessionLocal)
    with SessionLocal() as session:
        job = runner.create_job(session, project_id=None, job_type="test", payload={})
        job_id = job.id
        job.stage = "processing"
        job.stage_label = "/Users/example/My Song.wav failed"
        job.runtime_device = "MPS"
        job.runtime_detail = "song.wav failed"
        session.commit()

    get_response = client.get(f"/api/v1/jobs/{job_id}")
    assert get_response.status_code == 200
    payload = get_response.json()["job"]
    assert payload["stage"] == "processing"
    assert payload["stage_label"] is None
    assert payload["runtime_device"] == "mps"
    assert payload["runtime_detail"] is None

    list_response = client.get("/api/v1/jobs")
    assert list_response.status_code == 200
    listed_job = next(job for job in list_response.json()["jobs"] if job["id"] == job_id)
    assert listed_job["stage_label"] is None
    assert listed_job["runtime_detail"] is None

    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        job.stage_label = "MPS failed, retrying CPU."
        job.runtime_detail = "MPS failed, retrying CPU."
        session.commit()

    safe_response = client.get(f"/api/v1/jobs/{job_id}")
    assert safe_response.status_code == 200
    safe_payload = safe_response.json()["job"]
    assert safe_payload["stage_label"] == "MPS failed, retrying CPU."
    assert safe_payload["runtime_detail"] == "MPS failed, retrying CPU."


def test_bulk_lyrics_refreshes_existing_transcripts(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enqueued = _capture_enqueued_jobs(client, monkeypatch)
    with SessionLocal() as session:
        _add_project(session, "project_a")
        session.commit()

    response = client.post("/api/v1/jobs/bulk", json={"job_type": "lyrics"})

    assert response.status_code == 200
    payload = response.json()
    assert [job["project_id"] for job in payload["created_jobs"]] == ["project_a"]
    assert set(enqueued) == {payload["created_jobs"][0]["id"]}
    with SessionLocal() as session:
        job = session.scalar(select(Job).where(Job.type == "lyrics"))
        assert job is not None
        assert job.payload_json["force"] is True


def test_bulk_stems_refreshes_only_sources_with_existing_stems(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enqueued = _capture_enqueued_jobs(client, monkeypatch)
    with SessionLocal() as session:
        _add_project(session, "project_with_stems")
        _add_project(session, "project_without_stems", display_name="No Stems Song")
        _add_artifact(session, "source_existing", "project_with_stems", "source_audio")
        _add_artifact(session, "mix_existing", "project_with_stems", "preview_mix")
        _add_artifact(session, "mix_without_stems", "project_with_stems", "preview_mix")
        _add_artifact(session, "source_without", "project_without_stems", "source_audio")
        _add_artifact(
            session,
            "stem_source_existing",
            "project_with_stems",
            "vocal_stem",
            metadata={"source_artifact_id": "source_existing", "stem_model": "htdemucs_6s"},
        )
        _add_artifact(
            session,
            "stem_mix_existing",
            "project_with_stems",
            "vocal_stem",
            metadata={"source_artifact_id": "mix_existing", "stem_model": "htdemucs_6s"},
        )
        session.commit()

    response = client.post(
        "/api/v1/jobs/bulk",
        json={
            "job_type": "stems",
            "chord_backend": "tuneforge-fast",
            "chord_backend_fallback_from": "crema-advanced",
            "stem_model": "htdemucs_ft",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_projects"] == 2
    assert payload["skipped"] == [
        {
            "project_id": "project_without_stems",
            "project_name": "No Stems Song",
            "reason": "no_existing_stems",
        }
    ]
    assert [job["project_id"] for job in payload["created_jobs"]] == [
        "project_with_stems",
        "project_with_stems",
    ]
    assert set(enqueued) == {job["id"] for job in payload["created_jobs"]}
    with SessionLocal() as session:
        jobs = list(session.scalars(select(Job).where(Job.type == "stems").order_by(Job.created_at.asc())))
        assert {job.payload_json["source_artifact_id"] for job in jobs} == {"source_existing", "mix_existing"}
        assert all(job.payload_json["force"] is True for job in jobs)
        assert all(job.payload_json["chord_backend"] == "tuneforge-fast" for job in jobs)
        assert all(job.payload_json["chord_backend_fallback_from"] == "crema-advanced" for job in jobs)
        assert all(job.payload_json["stem_model"] == "htdemucs_ft" for job in jobs)


def test_bulk_jobs_skips_active_duplicate_project_type(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enqueued = _capture_enqueued_jobs(client, monkeypatch)
    with SessionLocal() as session:
        _add_project(session, "project_a", display_name="Active Song")
        _add_project(session, "project_b")
        _add_job(session, "job_existing", "pending", project_id="project_a", job_type="lyrics")
        session.commit()

    response = client.post("/api/v1/jobs/bulk", json={"job_type": "lyrics"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_projects"] == 2
    assert payload["skipped"] == [
        {"project_id": "project_a", "project_name": "Active Song", "reason": "active_job"}
    ]
    assert [job["project_id"] for job in payload["created_jobs"]] == ["project_b"]
    assert set(enqueued) == {payload["created_jobs"][0]["id"]}


def test_bulk_jobs_skips_locked_project(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enqueued = _capture_enqueued_jobs(client, monkeypatch)
    with SessionLocal() as session:
        _add_project(session, "project_editable")
        _add_project(
            session,
            "project_locked",
            display_name="Locked Song",
            sync_status="remote_available",
            sync_status_reason="Available from peer.",
        )
        session.commit()

    response = client.post("/api/v1/jobs/bulk", json={"job_type": "analyze"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_projects"] == 2
    assert payload["skipped"] == [
        {"project_id": "project_locked", "project_name": "Locked Song", "reason": "locked"}
    ]
    assert [job["project_id"] for job in payload["created_jobs"]] == ["project_editable"]
    assert set(enqueued) == {payload["created_jobs"][0]["id"]}


def test_bulk_analyze_jobs_store_requested_beat_backend(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _capture_enqueued_jobs(client, monkeypatch)
    with SessionLocal() as session:
        _add_project(session, "project_a")
        _add_project(session, "project_b")
        session.commit()

    response = client.post(
        "/api/v1/jobs/bulk",
        json={"job_type": "analyze", "beat_backend": "beat-this"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["created_jobs"]) == 2
    job_ids = [job["id"] for job in payload["created_jobs"]]
    with SessionLocal() as session:
        jobs = list(session.scalars(select(Job).where(Job.id.in_(job_ids))))

    assert {job.payload_json["beat_backend"] for job in jobs} == {"beat-this"}
    assert {job.payload_json["beat_input"] for job in jobs} == {"source"}


@pytest.mark.parametrize(
    "timing_json",
    [
        None,
        {},
        {"source": "detected"},
        {"source": "beat-this"},
    ],
)
def test_analyze_job_exposes_source_beat_input(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    timing_json: dict[str, str] | None,
) -> None:
    runner = InProcessJobRunner(SessionLocal)
    project_id = "project_source_beat_input"

    def fake_analyze_project(
        _session: Session,
        project: Project,
        *,
        beat_backend: str = "built-in",
    ) -> AnalysisResult:
        assert beat_backend == "beat-this"
        return AnalysisResult(project_id=project.id, timing_json=None if timing_json is None else dict(timing_json))

    monkeypatch.setattr("app.services.jobs.analyze_project", fake_analyze_project)
    with SessionLocal() as session:
        _add_project(session, project_id)
        session.flush()
        job = runner.create_job(
            session,
            project_id=project_id,
            job_type="analyze",
            payload={"beat_backend": "beat-this"},
        )
        assert job.payload_json["beat_input"] == "source"
        job_id = job.id
        session.commit()

    runner._execute_job(job_id)

    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.status == "completed"
        assert job.runtime_device == "cpu"
        assert job.payload_json["beat_input"] == "source"
        assert job.beat_input == "source"

    response = client.get(f"/api/v1/jobs/{job_id}")
    assert response.status_code == 200
    payload = response.json()["job"]
    assert payload["beat_backend"] == "beat-this"
    assert payload["beat_input"] == "source"
    assert payload["runtime_device"] == "cpu"


def test_cancelled_analyze_job_keeps_source_beat_input(client: TestClient) -> None:
    runner = InProcessJobRunner(SessionLocal)
    with SessionLocal() as session:
        _add_project(session, "project_cancelled_analyze")
        session.flush()
        job = runner.create_job(
            session,
            project_id="project_cancelled_analyze",
            job_type="analyze",
            payload={"beat_backend": "beat-this"},
        )
        job.cancel_requested = True
        job_id = job.id
        session.commit()

    runner._execute_job(job_id)

    response = client.get(f"/api/v1/jobs/{job_id}")
    assert response.status_code == 200
    payload = response.json()["job"]
    assert payload["status"] == "cancelled"
    assert payload["beat_backend"] == "beat-this"
    assert payload["beat_input"] == "source"

    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.payload_json["beat_input"] == "source"


@pytest.mark.parametrize(
    "payload_json",
    [
        {},
        {"beat_input": "percussion"},
        {"beat_input": []},
        {"beat_input": {}},
    ],
)
def test_analyze_job_api_defaults_missing_or_unknown_beat_input_to_source(
    client: TestClient,
    payload_json: dict[str, Any],
) -> None:
    with SessionLocal() as session:
        _add_job(
            session,
            "job_analyze_input",
            "completed",
            job_type="analyze",
            payload_json=payload_json,
            created_at=_timestamp(1),
            completed_at=_timestamp(2),
        )
        session.commit()

    get_response = client.get("/api/v1/jobs/job_analyze_input")
    assert get_response.status_code == 200
    assert get_response.json()["job"]["beat_input"] == "source"

    list_response = client.get("/api/v1/jobs")
    assert list_response.status_code == 200
    listed_job = next(job for job in list_response.json()["jobs"] if job["id"] == "job_analyze_input")
    assert listed_job["beat_input"] == "source"


def test_bulk_jobs_rejects_unsupported_job_type(client: TestClient) -> None:
    response = client.post("/api/v1/jobs/bulk", json={"job_type": "preview"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_list_jobs_returns_pagination_metadata(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_job(session, "job_a", "pending", created_at=_timestamp(1))
        _add_job(session, "job_b", "pending", created_at=_timestamp(2))
        _add_job(session, "job_c", "pending", created_at=_timestamp(3))
        session.commit()

    response = client.get("/api/v1/jobs", params={"limit": "2"})

    assert response.status_code == 200
    payload = response.json()
    assert [job["id"] for job in payload["jobs"]] == ["job_a", "job_b"]
    assert payload["total"] == 3
    assert payload["limit"] == 2
    assert payload["offset"] == 0
    assert payload["has_more"] is True


def test_list_jobs_orders_active_before_terminal_then_unknown(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_job(session, "job_pending", "pending", created_at=_timestamp(1))
        _add_job(
            session,
            "job_running_started",
            "running",
            created_at=_timestamp(0),
            started_at=_timestamp(10),
            updated_at=_timestamp(10),
        )
        _add_job(session, "job_running_fallback", "running", created_at=_timestamp(5))
        _add_job(
            session,
            "job_terminal",
            "failed",
            created_at=_timestamp(2),
            completed_at=_timestamp(30),
            updated_at=_timestamp(30),
        )
        _add_job(session, "job_unknown", "paused", created_at=_timestamp(4), updated_at=_timestamp(100))
        session.commit()

    response = client.get("/api/v1/jobs")

    assert response.status_code == 200
    assert [job["id"] for job in response.json()["jobs"]] == [
        "job_running_fallback",
        "job_running_started",
        "job_pending",
        "job_terminal",
        "job_unknown",
    ]


@pytest.mark.parametrize(
    ("sort_by", "field_name"),
    [
        ("created_at", "created_at"),
        ("updated_at", "updated_at"),
    ],
)
def test_list_jobs_sorts_timestamp_fields_descending_by_default(
    client: TestClient,
    sort_by: str,
    field_name: str,
) -> None:
    with SessionLocal() as session:
        _add_job(session, "job_old", "running", **{field_name: _timestamp(1)})
        _add_job(session, "job_same_a", "pending", **{field_name: _timestamp(10)})
        _add_job(session, "job_same_b", "completed", **{field_name: _timestamp(10)})
        _add_job(session, "job_new", "failed", **{field_name: _timestamp(30)})
        session.commit()

    response = client.get("/api/v1/jobs", params={"sort_by": sort_by})

    assert response.status_code == 200
    assert [job["id"] for job in response.json()["jobs"]] == [
        "job_new",
        "job_same_a",
        "job_same_b",
        "job_old",
    ]


def test_list_jobs_sorts_started_at_with_nulls_last_and_stable_tiebreaker(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_job(session, "job_unstarted", "pending", created_at=_timestamp(30))
        _add_job(session, "job_started_a", "running", started_at=_timestamp(10))
        _add_job(session, "job_started_b", "completed", started_at=_timestamp(10))
        _add_job(session, "job_started_late", "failed", started_at=_timestamp(20))
        session.commit()

    descending_response = client.get("/api/v1/jobs", params={"sort_by": "started_at"})
    ascending_response = client.get(
        "/api/v1/jobs",
        params={"sort_by": "started_at", "sort_order": "asc"},
    )

    assert descending_response.status_code == 200
    assert [job["id"] for job in descending_response.json()["jobs"]] == [
        "job_started_late",
        "job_started_a",
        "job_started_b",
        "job_unstarted",
    ]
    assert ascending_response.status_code == 200
    assert [job["id"] for job in ascending_response.json()["jobs"]] == [
        "job_started_a",
        "job_started_b",
        "job_started_late",
        "job_unstarted",
    ]


def test_list_jobs_sorts_status_groups_ascending_and_descending(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_job(session, "job_running", "running", started_at=_timestamp(10))
        _add_job(session, "job_pending", "pending", created_at=_timestamp(20))
        _add_job(session, "job_completed", "completed", completed_at=_timestamp(30))
        _add_job(session, "job_cancelled", "cancelled", completed_at=_timestamp(40))
        _add_job(session, "job_failed", "failed", completed_at=_timestamp(50))
        _add_job(session, "job_unknown", "paused", updated_at=_timestamp(60))
        session.commit()

    ascending_response = client.get("/api/v1/jobs", params={"sort_by": "status"})
    descending_response = client.get(
        "/api/v1/jobs",
        params={"sort_by": "status", "sort_order": "desc"},
    )

    assert ascending_response.status_code == 200
    assert [job["id"] for job in ascending_response.json()["jobs"]] == [
        "job_running",
        "job_pending",
        "job_completed",
        "job_cancelled",
        "job_failed",
        "job_unknown",
    ]
    assert descending_response.status_code == 200
    assert [job["id"] for job in descending_response.json()["jobs"]] == [
        "job_unknown",
        "job_failed",
        "job_cancelled",
        "job_completed",
        "job_pending",
        "job_running",
    ]


def test_list_jobs_status_sort_uses_activity_tiebreakers_within_groups(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_job(session, "job_pending_b", "pending", created_at=_timestamp(10))
        _add_job(session, "job_pending_a", "pending", created_at=_timestamp(10))
        _add_job(session, "job_running_late", "running", started_at=_timestamp(20))
        _add_job(session, "job_running_early", "running", started_at=_timestamp(5))
        session.commit()

    response = client.get("/api/v1/jobs", params={"sort_by": "status"})

    assert response.status_code == 200
    assert [job["id"] for job in response.json()["jobs"]] == [
        "job_running_early",
        "job_running_late",
        "job_pending_a",
        "job_pending_b",
    ]


def test_list_jobs_sorting_composes_with_filters_search_and_pagination(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_project(session, "project_a", display_name="Needle Song")
        _add_project(session, "project_b", display_name="Needle Song")
        _add_project(session, "project_c", display_name="Other Song")
        _add_job(
            session,
            "job_match_old",
            "completed",
            project_id="project_a",
            updated_at=_timestamp(10),
        )
        _add_job(
            session,
            "job_match_middle",
            "completed",
            project_id="project_a",
            updated_at=_timestamp(20),
        )
        _add_job(
            session,
            "job_match_new",
            "completed",
            project_id="project_a",
            updated_at=_timestamp(30),
        )
        _add_job(
            session,
            "job_status_excluded",
            "pending",
            project_id="project_a",
            updated_at=_timestamp(40),
        )
        _add_job(
            session,
            "job_project_excluded",
            "completed",
            project_id="project_b",
            updated_at=_timestamp(50),
        )
        _add_job(
            session,
            "job_search_excluded",
            "completed",
            project_id="project_c",
            updated_at=_timestamp(60),
        )
        session.commit()

    response = client.get(
        "/api/v1/jobs",
        params=[
            ("search", "needle"),
            ("status", "completed"),
            ("project_id", "project_a"),
            ("sort_by", "updated_at"),
            ("limit", "2"),
            ("offset", "1"),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert [job["id"] for job in payload["jobs"]] == ["job_match_middle", "job_match_old"]
    assert payload["total"] == 3
    assert payload["has_more"] is False


@pytest.mark.parametrize(
    "params",
    [
        {"sort_by": "activity", "sort_order": "asc"},
        {"sort_order": "desc"},
    ],
)
def test_list_jobs_rejects_sort_order_with_activity_sort(
    client: TestClient,
    params: dict[str, str],
) -> None:
    response = client.get("/api/v1/jobs", params=params)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_list_jobs_accepts_repeatable_status_filter(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_job(session, "job_pending", "pending", created_at=_timestamp(1))
        _add_job(session, "job_running", "running", started_at=_timestamp(2))
        _add_job(session, "job_completed", "completed", completed_at=_timestamp(3))
        session.commit()

    response = client.get(
        "/api/v1/jobs",
        params=[("status", "pending"), ("status", "running")],
    )

    assert response.status_code == 200
    payload = response.json()
    assert [job["id"] for job in payload["jobs"]] == ["job_running", "job_pending"]
    assert payload["total"] == 2


def test_list_jobs_filters_by_project_id(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_project(session, "project_a")
        _add_project(session, "project_b")
        _add_job(session, "job_project_a_1", "pending", project_id="project_a", created_at=_timestamp(1))
        _add_job(session, "job_project_a_2", "pending", project_id="project_a", created_at=_timestamp(2))
        _add_job(session, "job_project_b", "pending", project_id="project_b", created_at=_timestamp(3))
        _add_job(session, "job_global", "pending", project_id=None, created_at=_timestamp(4))
        session.commit()

    response = client.get("/api/v1/jobs", params={"project_id": "project_a"})

    assert response.status_code == 200
    payload = response.json()
    assert [job["id"] for job in payload["jobs"]] == ["job_project_a_1", "job_project_a_2"]
    assert payload["total"] == 2


def test_list_jobs_search_applies_before_pagination(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_project(session, "project_early", display_name="Earlier Song")
        _add_project(session, "project_target", display_name="Deep Needle Match")
        _add_job(session, "job_early_1", "pending", project_id="project_early", created_at=_timestamp(1))
        _add_job(session, "job_early_2", "pending", project_id="project_early", created_at=_timestamp(2))
        _add_job(session, "job_target", "pending", project_id="project_target", created_at=_timestamp(3))
        session.commit()

    response = client.get("/api/v1/jobs", params={"search": "  NEEDLE  ", "limit": "1"})

    assert response.status_code == 200
    payload = response.json()
    assert [job["id"] for job in payload["jobs"]] == ["job_target"]
    assert payload["total"] == 1
    assert payload["has_more"] is False


def test_list_jobs_search_combines_with_status_and_project_filters(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_project(session, "project_a", display_name="Practice Alpha")
        _add_project(session, "project_b", display_name="Practice Alpha")
        _add_job(session, "job_a_pending", "pending", project_id="project_a", created_at=_timestamp(1))
        _add_job(
            session,
            "job_a_completed",
            "completed",
            project_id="project_a",
            completed_at=_timestamp(2),
        )
        _add_job(
            session,
            "job_b_completed",
            "completed",
            project_id="project_b",
            completed_at=_timestamp(3),
        )
        session.commit()

    response = client.get(
        "/api/v1/jobs",
        params=[("search", "alpha"), ("status", "completed"), ("project_id", "project_a")],
    )

    assert response.status_code == 200
    payload = response.json()
    assert [job["id"] for job in payload["jobs"]] == ["job_a_completed"]
    assert payload["total"] == 1


def test_list_jobs_search_excludes_no_project_jobs(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_project(session, "project_match", display_name="Global Match")
        _add_job(session, "job_project", "pending", project_id="project_match", created_at=_timestamp(1))
        _add_job(session, "job_no_project", "pending", project_id=None, created_at=_timestamp(2))
        session.commit()

    search_response = client.get("/api/v1/jobs", params={"search": "match"})
    no_search_response = client.get("/api/v1/jobs")

    assert search_response.status_code == 200
    assert [job["id"] for job in search_response.json()["jobs"]] == ["job_project"]
    assert search_response.json()["total"] == 1
    assert no_search_response.status_code == 200
    assert [job["id"] for job in no_search_response.json()["jobs"]] == ["job_project", "job_no_project"]
    assert no_search_response.json()["total"] == 2


@pytest.mark.parametrize(
    ("query", "expected_job_id"),
    [
        ("%", "job_percent"),
        ("_", "job_underscore"),
    ],
)
def test_list_jobs_search_treats_like_metacharacters_as_literals(
    client: TestClient,
    query: str,
    expected_job_id: str,
) -> None:
    with SessionLocal() as session:
        _add_project(session, "project_percent", display_name="Mix 100%")
        _add_project(session, "project_underscore", display_name="rough_mix")
        _add_project(session, "project_plain", display_name="Plain Song")
        _add_job(session, "job_percent", "pending", project_id="project_percent", created_at=_timestamp(1))
        _add_job(
            session,
            "job_underscore",
            "pending",
            project_id="project_underscore",
            created_at=_timestamp(2),
        )
        _add_job(session, "job_plain", "pending", project_id="project_plain", created_at=_timestamp(3))
        _add_job(session, "job_no_project", "pending", project_id=None, created_at=_timestamp(4))
        session.commit()

    response = client.get("/api/v1/jobs", params={"search": query})

    assert response.status_code == 200
    payload = response.json()
    assert [job["id"] for job in payload["jobs"]] == [expected_job_id]
    assert payload["total"] == 1


def test_list_jobs_empty_search_preserves_existing_behavior(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_project(session, "project_a", display_name="Project A")
        _add_job(session, "job_project", "pending", project_id="project_a", created_at=_timestamp(1))
        _add_job(session, "job_no_project", "pending", project_id=None, created_at=_timestamp(2))
        session.commit()

    no_search_payload = client.get("/api/v1/jobs").json()
    empty_search_payload = client.get("/api/v1/jobs", params={"search": "   "}).json()

    assert [job["id"] for job in empty_search_payload["jobs"]] == [
        job["id"] for job in no_search_payload["jobs"]
    ]
    assert empty_search_payload["total"] == no_search_payload["total"]


def test_list_jobs_keeps_terminal_pages_stable(client: TestClient) -> None:
    with SessionLocal() as session:
        _add_job(
            session,
            "job_a",
            "completed",
            completed_at=_timestamp(10),
            updated_at=_timestamp(99),
        )
        _add_job(
            session,
            "job_b",
            "completed",
            completed_at=None,
            updated_at=_timestamp(30),
        )
        _add_job(
            session,
            "job_c",
            "cancelled",
            completed_at=_timestamp(30),
            updated_at=_timestamp(30),
        )
        _add_job(
            session,
            "job_d",
            "failed",
            completed_at=_timestamp(30),
            updated_at=_timestamp(30),
        )
        session.commit()

    first_page = client.get("/api/v1/jobs", params={"limit": "2"}).json()
    second_page = client.get("/api/v1/jobs", params={"limit": "2", "offset": "2"}).json()

    assert [job["id"] for job in first_page["jobs"]] == ["job_d", "job_c"]
    assert first_page["has_more"] is True
    assert [job["id"] for job in second_page["jobs"]] == ["job_b", "job_a"]
    assert second_page["has_more"] is False


@pytest.mark.parametrize("params", [{"limit": "0"}, {"offset": "-1"}])
def test_list_jobs_rejects_invalid_pagination_query(client: TestClient, params: dict[str, str]) -> None:
    response = client.get("/api/v1/jobs", params=params)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_cancelled_pending_job_does_not_execute(client: TestClient) -> None:
    runner = InProcessJobRunner(SessionLocal)
    handler_called = False

    def handler(_context: JobExecutionContext, _session: Session, _job: Job) -> JobExecutionResult:
        nonlocal handler_called
        handler_called = True
        return JobExecutionResult(artifact_ids=[])

    runner._handlers["test"] = handler
    with SessionLocal() as session:
        job = runner.create_job(session, project_id=None, job_type="test", payload={})
        job_id = job.id
        session.commit()

    runner.cancel(job_id)
    runner._execute_job(job_id)

    assert handler_called is False
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.cancel_requested is True
        assert job.status == "cancelled"
        assert job.stage == "queued"
        assert job.stage_label == "Waiting to start."
        assert job.runtime_detail is None
        assert job.started_at is None
        assert job.completed_at is not None


def test_cancel_requested_before_handler_start_finishes_cancelled(client: TestClient) -> None:
    runner = InProcessJobRunner(SessionLocal)
    handler_called = False

    def handler(_context: JobExecutionContext, _session: Session, _job: Job) -> JobExecutionResult:
        nonlocal handler_called
        handler_called = True
        return JobExecutionResult(artifact_ids=[])

    runner._handlers["test"] = handler
    with SessionLocal() as session:
        job = runner.create_job(session, project_id=None, job_type="test", payload={})
        job.cancel_requested = True
        job_id = job.id
        session.commit()

    runner._execute_job(job_id)

    assert handler_called is False
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.cancel_requested is True
        assert job.status == "cancelled"
        assert job.stage == "preparing"
        assert job.stage_label == "Preparing job."
        assert job.runtime_detail is None
        assert job.started_at is not None
        assert job.completed_at is not None
        assert job.duration_seconds is not None
        assert job.duration_seconds >= 0


def test_running_cancelled_job_finishes_cancelled_when_handler_reports_failure(client: TestClient) -> None:
    runner = InProcessJobRunner(SessionLocal)
    handler_started = threading.Event()
    fallback_detail = "Whisper switched to CPU after the accelerator attempt failed."

    def handler(context: JobExecutionContext, _session: Session, _job: Job) -> JobExecutionResult:
        handler_started.set()
        while not context.should_cancel():
            time.sleep(0.01)
        context.update_runtime_status(
            stage="fallback",
            stage_label="Falling back from MPS to CPU.",
            runtime_device="cpu",
            runtime_detail=fallback_detail,
        )
        raise AppError("PROCESSING_FAILED", "Subprocess exited after cancellation.")

    runner._handlers["test"] = handler
    with SessionLocal() as session:
        job = runner.create_job(session, project_id=None, job_type="test", payload={})
        job_id = job.id
        session.commit()

    thread = threading.Thread(target=runner._execute_job, args=(job_id,))
    thread.start()
    assert handler_started.wait(timeout=2)

    runner.cancel(job_id)
    thread.join(timeout=2)

    assert not thread.is_alive()
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.cancel_requested is True
        assert job.status == "cancelled"
        assert job.error_message is None
        assert job.stage == "fallback"
        assert job.stage_label == "Falling back from MPS to CPU."
        assert job.runtime_device == "cpu"
        assert job.runtime_detail == fallback_detail
        assert job.started_at is not None
        assert job.completed_at is not None
        assert job.duration_seconds is not None
        assert job.duration_seconds >= 0


class _IgnoringTerminationProcess:
    def __init__(self) -> None:
        self.terminate_calls = 0
        self.kill_calls = 0
        self.wait_timeouts: list[float | None] = []

    def poll(self) -> int | None:
        if self.kill_calls:
            return -9
        return None

    def terminate(self) -> None:
        self.terminate_calls += 1

    def kill(self) -> None:
        self.kill_calls += 1

    def wait(self, timeout: float | None = None) -> int:
        self.wait_timeouts.append(timeout)
        if self.kill_calls:
            return -9
        raise TimeoutExpired(cmd="fake-process", timeout=timeout)


def test_cancel_kills_registered_process_after_termination_grace(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.jobs._PROCESS_TERMINATION_GRACE_SECONDS", 0.0)
    runner = InProcessJobRunner(SessionLocal)
    with SessionLocal() as session:
        _add_job(session, "job_running", "running", started_at=_timestamp(1))
        session.commit()

    process = _IgnoringTerminationProcess()
    runner.register_process("job_running", process)

    runner.cancel("job_running")

    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert process.wait_timeouts == [0.0, 0.0]
    with SessionLocal() as session:
        job = session.get(Job, "job_running")
        assert job is not None
        assert job.cancel_requested is True
