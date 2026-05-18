from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.errors import AppError
from app.models import Job, Project
from app.services.artifacts import delete_project_artifact, register_artifact
from app.services.jobs import InProcessJobRunner, JobExecutionContext, JobExecutionResult


def _create_project_with_artifacts(tmp_path: Path) -> tuple[str, str, str]:
    source_path = tmp_path / "locked-source.wav"
    source_path.write_bytes(b"source")
    preview_path = tmp_path / "locked-preview.wav"
    preview_path.write_bytes(b"preview")

    with SessionLocal() as session:
        project = Project(
            id="proj_sync_locked",
            display_name="Locked Project",
            source_sha256="a" * 64,
            source_path=str(source_path),
            imported_path=str(source_path),
            duration_seconds=1.0,
            sample_rate=44100,
            channels=2,
        )
        session.add(project)
        source_artifact = register_artifact(
            session,
            project_id=project.id,
            artifact_id="art_locked_source",
            artifact_type="source_audio",
            artifact_format="wav",
            path=source_path,
            generated_by="import",
            can_delete=False,
            can_regenerate=False,
        )
        preview_artifact = register_artifact(
            session,
            project_id=project.id,
            artifact_id="art_locked_preview",
            artifact_type="preview_mix",
            artifact_format="wav",
            path=preview_path,
            generated_by="test",
            can_delete=True,
            can_regenerate=True,
        )
        session.commit()
        return project.id, source_artifact.id, preview_artifact.id


def _lock_project(locked_project_id: str) -> None:
    with SessionLocal() as session:
        project = session.get(Project, locked_project_id)
        assert project is not None
        project.sync_status = "remote_available"
        project.sync_status_reason = "Available from peer."
        project.sync_required_artifact_ids_json = ["art_locked_source"]
        project.sync_provider_device_ids_json = ["peer-a"]
        project.sync_conflict_count = 1
        session.commit()


def _assert_sync_locked(response, project_id: str) -> None:
    assert response.status_code == 409
    assert response.json()["error"] == {
        "code": "PROJECT_SYNC_LOCKED",
        "message": "Project is still syncing and cannot be edited.",
        "details": {
            "project_id": project_id,
            "sync_status": "remote_available",
            "sync_status_reason": "Available from peer.",
            "sync_required_artifact_ids": ["art_locked_source"],
            "sync_provider_device_ids": ["peer-a"],
            "sync_conflict_count": 1,
        },
    }


@pytest.mark.parametrize(
    ("method", "path_template", "payload"),
    [
        ("PATCH", "/api/v1/projects/{project_id}", {"display_name": "Renamed"}),
        ("PATCH", "/api/v1/projects/{project_id}", {"source_key_override": "8:major"}),
        ("DELETE", "/api/v1/projects/{project_id}", None),
        ("POST", "/api/v1/projects/{project_id}/analyze", {"include_tempo": False, "force": False}),
        ("POST", "/api/v1/projects/{project_id}/chords", {"backend": "default", "force": False}),
        ("POST", "/api/v1/projects/{project_id}/lyrics", {"force": False}),
        ("PUT", "/api/v1/projects/{project_id}/lyrics", {"segments": [{"text": "edited lyric"}]}),
        ("POST", "/api/v1/projects/{project_id}/tabs/proposals", {"raw_text": "[Verse]\nC"}),
        ("POST", "/api/v1/projects/{project_id}/tabs/tab_missing/accept", {"accepted_suggestion_ids": []}),
        ("POST", "/api/v1/projects/{project_id}/retune", {"target_reference_hz": 441.0}),
        ("POST", "/api/v1/projects/{project_id}/transpose", {"semitones": 1}),
        ("POST", "/api/v1/projects/{project_id}/preview", {"transpose": {"semitones": 1}}),
        (
            "POST",
            "/api/v1/projects/{project_id}/stems",
            {"mode": "stems", "output_format": "wav", "force": False},
        ),
        (
            "POST",
            "/api/v1/projects/{project_id}/export",
            {"artifact_ids": ["{source_artifact_id}"], "mixdown_mode": "copy", "output_format": "wav"},
        ),
        ("DELETE", "/api/v1/projects/{project_id}/artifacts/{preview_artifact_id}", None),
    ],
)
def test_locked_project_mutations_return_conflict(
    client,
    tmp_path: Path,
    method: str,
    path_template: str,
    payload: dict[str, Any] | None,
) -> None:
    project_id, source_artifact_id, preview_artifact_id = _create_project_with_artifacts(tmp_path)
    _lock_project(project_id)

    path = path_template.format(
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        preview_artifact_id=preview_artifact_id,
    )
    request_payload = (
        None
        if payload is None
        else {
            key: (
                [source_artifact_id]
                if key == "artifact_ids" and value == ["{source_artifact_id}"]
                else value
            )
            for key, value in payload.items()
        }
    )

    response = (
        client.request(method, path)
        if request_payload is None
        else client.request(method, path, json=request_payload)
    )

    _assert_sync_locked(response, project_id)
    with SessionLocal() as session:
        assert session.get(Project, project_id) is not None
        job_count = session.scalar(select(func.count()).select_from(Job))
        assert job_count == 0


def test_locked_project_artifact_delete_service_returns_conflict(
    client,
    tmp_path: Path,
) -> None:
    _ = client
    project_id, _, preview_artifact_id = _create_project_with_artifacts(tmp_path)
    _lock_project(project_id)

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            delete_project_artifact(
                session,
                project_id=project_id,
                artifact_id=preview_artifact_id,
            )

    assert exc.value.code == "PROJECT_SYNC_LOCKED"
    assert exc.value.status_code == 409
    assert exc.value.details == {
        "project_id": project_id,
        "sync_status": "remote_available",
        "sync_status_reason": "Available from peer.",
        "sync_required_artifact_ids": ["art_locked_source"],
        "sync_provider_device_ids": ["peer-a"],
        "sync_conflict_count": 1,
    }


def test_locked_project_job_creation_service_returns_conflict(
    client,
    tmp_path: Path,
) -> None:
    _ = client
    project_id, _, _ = _create_project_with_artifacts(tmp_path)
    _lock_project(project_id)
    runner = InProcessJobRunner(SessionLocal)

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            runner.create_job(
                session,
                project_id=project_id,
                job_type="analyze",
                payload={"include_tempo": False, "force": False},
            )

    assert exc.value.code == "PROJECT_SYNC_LOCKED"


def test_pending_project_job_fails_if_project_locks_before_execution(
    client,
    tmp_path: Path,
) -> None:
    _ = client
    project_id, _, _ = _create_project_with_artifacts(tmp_path)
    runner = InProcessJobRunner(SessionLocal)
    with SessionLocal() as session:
        job = runner.create_job(
            session,
            project_id=project_id,
            job_type="test_mutation",
            payload={},
        )
        session.commit()
        job_id = job.id

    _lock_project(project_id)
    handler_called = False

    def handler(
        _context: JobExecutionContext,
        _session: Session,
        _job: Job,
    ) -> JobExecutionResult:
        nonlocal handler_called
        handler_called = True
        return JobExecutionResult(artifact_ids=[])

    runner._handlers["test_mutation"] = handler
    runner._execute_job(job_id)

    assert handler_called is False
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.status == "failed"
        assert job.error_message == "Project is still syncing and cannot be edited."
        assert job.result_artifact_ids_json == []


def test_locked_project_read_routes_remain_open(
    client,
    tmp_path: Path,
) -> None:
    project_id, _, _ = _create_project_with_artifacts(tmp_path)
    _lock_project(project_id)

    projects_response = client.get("/api/v1/projects")
    assert projects_response.status_code == 200
    assert [project["id"] for project in projects_response.json()["projects"]] == [project_id]

    detail_response = client.get(f"/api/v1/projects/{project_id}")
    assert detail_response.status_code == 200
    assert detail_response.json()["project"]["id"] == project_id

    artifacts_response = client.get(f"/api/v1/projects/{project_id}/artifacts")
    assert artifacts_response.status_code == 200
    assert {artifact["id"] for artifact in artifacts_response.json()["artifacts"]} == {
        "art_locked_preview",
        "art_locked_source",
    }

    assert client.get(f"/api/v1/projects/{project_id}/analysis").status_code == 200
    assert client.get(f"/api/v1/projects/{project_id}/chords").status_code == 200
    assert client.get(f"/api/v1/projects/{project_id}/lyrics").status_code == 200
    assert client.get(f"/api/v1/projects/{project_id}/sections").status_code == 200

    tab_response = client.get(f"/api/v1/projects/{project_id}/tabs/tab_missing")
    assert tab_response.status_code == 404
    assert tab_response.json()["error"]["code"] == "TAB_IMPORT_NOT_FOUND"
