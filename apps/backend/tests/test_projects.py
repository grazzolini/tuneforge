from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import soundfile as sf
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, reconfigure_engine, run_migrations
from app.errors import AppError
from app.models import Artifact, Project, SyncDeleteTombstone, SyncEntityRevision
from app.services.analysis import analyze_project
from app.services.artifacts import delete_project_artifact, register_artifact
from app.services.paths import project_root
from app.services.projects import delete_project, import_project
from app.services.stems import _prune_extra_stem_artifacts
from app.services.sync_identity import source_hash_to_project_id, source_hash_to_project_storage_key
from app.services.sync_tombstones import (
    ARTIFACT_TARGET_TYPE,
    ENTITY_REVISION_TARGET_TYPE,
    PROJECT_TARGET_TYPE,
)
from app.services.sync_trust import get_or_create_local_identity
from app.utils.hashing import file_sha256
from app.utils.ids import new_id
from tests.conftest import wait_for_job


def _prepare_database() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)


def _wait_for_project_job(client, project_id: str, predicate, *, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        jobs = client.get("/api/v1/jobs").json()["jobs"]
        for job in jobs:
            if job["project_id"] == project_id and predicate(job):
                return job
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for matching job in project {project_id}")


def _insert_project_rows(
    tmp_path: Path,
    rows: list[tuple[str, str, datetime, str]],
) -> None:
    with SessionLocal() as session:
        for index, row in enumerate(rows, start=1):
            project_id, display_name, updated_at, sync_status = row
            session.add(
                Project(
                    id=project_id,
                    display_name=display_name,
                    source_sha256=f"{index:064x}",
                    source_path=str(tmp_path / f"{project_id}-source.wav"),
                    imported_path=str(tmp_path / f"{project_id}-imported.wav"),
                    sync_status=sync_status,
                    created_at=updated_at,
                    updated_at=updated_at,
                )
            )
        session.commit()


def test_import_project_persists_metadata_and_source_artifact(client, sample_audio_file: Path):
    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    )

    assert response.status_code == 200
    project = response.json()["project"]
    assert project["display_name"] == "fixture"
    assert project["source_key_override"] is None
    assert project["sample_rate"] == 44100
    assert project["channels"] == 1

    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    assert project["id"] == source_hash_to_project_id(expected_hash)

    data_root = get_settings().data_root
    imported_path = Path(project["imported_path"])
    assert imported_path.exists()
    assert imported_path.suffix == ".wav"
    assert str(imported_path).startswith(
        str(data_root / "projects" / source_hash_to_project_storage_key(expected_hash))
    )

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    assert source_artifact["format"] == "wav"
    assert source_artifact["size_bytes"] > 0
    assert source_artifact["generated_by"] == "import"
    assert source_artifact["can_delete"] is False
    assert source_artifact["can_regenerate"] is False
    assert source_artifact["metadata"]["source_path"] == str(sample_audio_file.resolve())
    assert source_artifact["metadata"]["original_format"] == "wav"
    assert "original_copy_path" not in source_artifact["metadata"]
    assert "content_sha256" not in source_artifact
    assert "source_sha256" not in project

    with SessionLocal() as session:
        project_row = session.get(Project, project["id"])
        artifact_row = session.get(Artifact, source_artifact["id"])
        assert project_row is not None
        assert artifact_row is not None
        assert project_row.source_sha256 == expected_hash
        assert artifact_row.content_sha256 == file_sha256(imported_path)


def test_import_project_rejects_duplicate_source_hash(client, sample_audio_file: Path):
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Existing Song",
                source_sha256=source_hash,
                source_path=str(sample_audio_file),
                imported_path=str(sample_audio_file),
            )
        )
        session.commit()

    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    )

    assert response.status_code == 409
    assert response.json()["error"] == {
        "code": "DUPLICATE_PROJECT_SOURCE",
        "message": 'This project is already imported with name "Existing Song".',
        "details": {"project_id": project_id, "project_name": "Existing Song"},
    }


def test_import_project_without_copy_still_materializes_internal_wav(
    sample_mp3_file: Path,
) -> None:
    source_path = sample_mp3_file
    expected_hash = file_sha256(source_path)
    assert expected_hash is not None
    original_path = source_path.resolve()

    with SessionLocal() as session:
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=False,
            display_name=None,
        )
        session.commit()
        session.refresh(project)

        imported_path = Path(project.imported_path)
        assert project.source_sha256 == expected_hash
        assert project.source_path == str(original_path)
        assert imported_path.exists()
        assert imported_path.suffix == ".wav"
        assert imported_path.is_relative_to(project_root(project.id))
        assert imported_path != original_path
        assert not (imported_path.parent / source_path.name).exists()

        source_artifact = next(artifact for artifact in project.artifacts if artifact.type == "source_audio")
        assert Path(source_artifact.path) == imported_path
        assert source_artifact.format == "wav"
        assert source_artifact.metadata_json["source_path"] == str(original_path)
        assert source_artifact.metadata_json["original_format"] == "mp3"
        assert "original_copy_path" not in source_artifact.metadata_json
        assert source_artifact.content_sha256 == file_sha256(imported_path)
        assert source_artifact.content_sha256 != expected_hash

        source_path.unlink()
        analysis = analyze_project(session, project)

        assert analysis.project_id == project.id
        assert imported_path.exists()


def test_import_project_with_deprecated_external_reference_still_rejects_duplicate_source_hash(
    sample_audio_file: Path,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "deprecated-original.wav"
    source_path.write_bytes(sample_audio_file.read_bytes() + b"deprecated-duplicate")
    duplicate_source = tmp_path / "same-audio-different-path.wav"
    duplicate_source.write_bytes(source_path.read_bytes())

    with SessionLocal() as session:
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=False,
            display_name="Original",
        )
        session.commit()

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            import_project(
                session,
                source_path=str(duplicate_source),
                copy_into_project=False,
                display_name="Duplicate",
            )

    assert exc.value.code == "DUPLICATE_PROJECT_SOURCE"
    assert exc.value.details == {"project_id": project.id, "project_name": "Original"}


def test_import_project_translates_duplicate_project_id_race(
    monkeypatch: pytest.MonkeyPatch,
    sample_audio_file: Path,
) -> None:
    race_audio_file = sample_audio_file.with_name("race-fixture.wav")
    race_audio_file.write_bytes(sample_audio_file.read_bytes() + b"race")
    source_hash = file_sha256(race_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)

    with SessionLocal() as session:
        def raise_duplicate_project_id(*args, **kwargs):
            raise IntegrityError("INSERT INTO projects", {}, Exception("duplicate project id"))

        monkeypatch.setattr(session, "flush", raise_duplicate_project_id)

        with pytest.raises(AppError) as exc:
            import_project(
                session,
                source_path=str(race_audio_file),
                copy_into_project=True,
                display_name=None,
            )

    assert exc.value.code == "DUPLICATE_PROJECT_SOURCE"
    assert exc.value.status_code == 409
    assert exc.value.message == 'This project is already imported with name "race-fixture".'
    assert exc.value.details == {"project_id": project_id, "project_name": "race-fixture"}
    assert not project_root(project_id).exists()


def test_delete_project_records_tombstones_for_cascaded_sync_rows(tmp_path: Path) -> None:
    _prepare_database()
    artifact_path = tmp_path / "source.wav"
    artifact_path.write_bytes(b"source")
    project_id = "proj_delete_tombstones"
    revision_id = new_id("rev")

    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Delete Me",
            source_sha256="a" * 64,
            source_path=str(tmp_path / "leaky-source.wav"),
            imported_path=str(artifact_path),
        )
        session.add(project)
        artifact = register_artifact(
            session,
            project_id=project_id,
            artifact_id="art_delete_source",
            artifact_type="source_audio",
            artifact_format="wav",
            path=artifact_path,
            metadata={"render_path": str(tmp_path / "render.wav"), "safe": "kept"},
            generated_by="import",
            can_delete=False,
            can_regenerate=False,
        )
        identity = get_or_create_local_identity(session)
        session.add(
            SyncEntityRevision(
                id=revision_id,
                project_id=project_id,
                entity_type="project_metadata",
                entity_id=project_id,
                revision_type="metadata_change",
                base_revision_id=None,
                source_artifact_id=None,
                content_sha256="b" * 64,
                author_device_id=identity.device_id,
                state="active",
                metadata_json={"local_path": str(tmp_path / "metadata.wav"), "safe": "metadata"},
                payload_json={"display_name": "Delete Me"},
            )
        )
        session.flush()

        delete_project(session, project_id)
        session.commit()

        tombstones = list(session.query(SyncDeleteTombstone).order_by(SyncDeleteTombstone.target_type))
        tombstone_keys = {(tombstone.target_type, tombstone.target_id) for tombstone in tombstones}

        assert session.get(Project, project_id) is None
        assert session.get(Artifact, artifact.id) is None
        assert session.get(SyncEntityRevision, revision_id) is None
        assert tombstone_keys == {
            (PROJECT_TARGET_TYPE, project_id),
            (ARTIFACT_TARGET_TYPE, artifact.id),
            (ENTITY_REVISION_TARGET_TYPE, revision_id),
        }
        artifact_tombstone = next(
            tombstone for tombstone in tombstones if tombstone.target_type == ARTIFACT_TARGET_TYPE
        )
        assert artifact_tombstone.sync_group_id == identity.sync_group_id
        assert artifact_tombstone.author_device_id == identity.device_id
        assert artifact_tombstone.prior_metadata_json["metadata"] == {"safe": "kept"}
        assert "path" not in artifact_tombstone.prior_metadata_json


def test_delete_preview_mix_records_tombstones_for_related_stems(tmp_path: Path) -> None:
    _prepare_database()
    mix_path = tmp_path / "mix.wav"
    related_stem_path = tmp_path / "mix-vocals.wav"
    source_stem_path = tmp_path / "source-vocals.wav"
    for path in (mix_path, related_stem_path, source_stem_path):
        path.write_bytes(path.name.encode("utf-8"))

    with SessionLocal() as session:
        project = Project(
            id="proj_mix_tombstones",
            display_name="Mix Delete",
            source_sha256="c" * 64,
            source_path=str(tmp_path / "source.wav"),
            imported_path=str(tmp_path / "source.wav"),
        )
        session.add(project)
        mix = register_artifact(
            session,
            project_id=project.id,
            artifact_id="art_mix_delete",
            artifact_type="preview_mix",
            artifact_format="wav",
            path=mix_path,
            metadata={"transpose": {"semitones": 1}},
        )
        related_stem = register_artifact(
            session,
            project_id=project.id,
            artifact_id="art_mix_vocal_stem",
            artifact_type="vocal_stem",
            artifact_format="wav",
            path=related_stem_path,
            metadata={"source_artifact_id": mix.id, "source_artifact_type": "preview_mix"},
        )
        source_stem = register_artifact(
            session,
            project_id=project.id,
            artifact_id="art_source_vocal_stem",
            artifact_type="vocal_stem",
            artifact_format="wav",
            path=source_stem_path,
            metadata={"source_artifact_id": "art_source", "source_artifact_type": "source_audio"},
        )

        delete_project_artifact(session, project_id=project.id, artifact_id=mix.id)
        session.commit()

        tombstone_ids = {
            tombstone.target_id
            for tombstone in session.query(SyncDeleteTombstone).filter_by(
                project_id=project.id,
                target_type=ARTIFACT_TARGET_TYPE,
            )
        }

        assert session.get(Artifact, mix.id) is None
        assert session.get(Artifact, related_stem.id) is None
        assert session.get(Artifact, source_stem.id) is not None
        assert tombstone_ids == {mix.id, related_stem.id}


def test_pruning_stem_artifacts_records_tombstones(tmp_path: Path) -> None:
    _prepare_database()
    kept_path = tmp_path / "kept-vocals.wav"
    pruned_path = tmp_path / "pruned-drums.wav"
    source_path = tmp_path / "source.wav"
    for path in (kept_path, pruned_path, source_path):
        path.write_bytes(path.name.encode("utf-8"))

    with SessionLocal() as session:
        project = Project(
            id="proj_prune_stem_tombstones",
            display_name="Stem Prune",
            source_sha256="d" * 64,
            source_path=str(source_path),
            imported_path=str(source_path),
        )
        session.add(project)
        kept = register_artifact(
            session,
            project_id=project.id,
            artifact_id="art_kept_vocals",
            artifact_type="vocal_stem",
            artifact_format="wav",
            path=kept_path,
            metadata={"source_artifact_id": "art_source", "stem_model": "htdemucs_6s"},
        )
        pruned = register_artifact(
            session,
            project_id=project.id,
            artifact_id="art_pruned_drums",
            artifact_type="drums_stem",
            artifact_format="wav",
            path=pruned_path,
            metadata={"source_artifact_id": "art_source", "stem_model": "htdemucs_6s"},
        )

        _prune_extra_stem_artifacts(
            session,
            project_id=project.id,
            source_artifact_id="art_source",
            stem_model_id="htdemucs_6s",
            keep_ids={kept.id},
        )
        session.commit()

        tombstone = session.scalar(
            select(SyncDeleteTombstone).where(
                SyncDeleteTombstone.target_type == ARTIFACT_TARGET_TYPE,
                SyncDeleteTombstone.target_id == pruned.id,
            )
        )
        assert session.get(Artifact, kept.id) is not None
        assert session.get(Artifact, pruned.id) is None
        assert tombstone is not None
        assert tombstone.project_id == project.id
        assert tombstone.prior_metadata_json["metadata"] == {
            "source_artifact_id": "art_source",
            "stem_model": "htdemucs_6s",
        }


def test_import_project_enqueues_full_source_processing(
    client,
    sample_chord_audio_file: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        signal, sample_rate = sf.read(source_path, always_2d=True)
        vocal_path.parent.mkdir(parents=True, exist_ok=True)
        instrumental_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(vocal_path, signal * 0.7, sample_rate)
        sf.write(instrumental_path, signal * 0.3, sample_rate)
        if on_progress:
            on_progress(98)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    response = client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_chord_audio_file),
            "copy_into_project": True,
            "stem_model": "htdemucs_ft",
        },
    )

    assert response.status_code == 200
    project = response.json()["project"]
    source_artifact = next(
        artifact
        for artifact in client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
        if artifact["type"] == "source_audio"
    )

    jobs = client.get("/api/v1/jobs").json()["jobs"]
    analyze_job = next(job for job in jobs if job["project_id"] == project["id"] and job["type"] == "analyze")
    chord_job = next(
        job
        for job in jobs
        if job["project_id"] == project["id"] and job["type"] == "chords" and job["chord_source"] == "source"
    )
    lyrics_job = next(job for job in jobs if job["project_id"] == project["id"] and job["type"] == "lyrics")
    stem_job = next(job for job in jobs if job["project_id"] == project["id"] and job["type"] == "stems")

    assert wait_for_job(client, analyze_job["id"], timeout=90.0)["status"] == "completed"
    completed_chord_job = wait_for_job(client, chord_job["id"], timeout=90.0)
    assert completed_chord_job["status"] == "completed"
    assert completed_chord_job["chord_backend"] == "tuneforge-fast"
    assert completed_chord_job["chord_source"] == "source"
    assert wait_for_job(client, lyrics_job["id"])["status"] == "completed"
    completed_stem_job = wait_for_job(client, stem_job["id"])
    assert completed_stem_job["status"] == "completed"
    assert completed_stem_job["source_artifact_id"] == source_artifact["id"]
    assert completed_stem_job["stem_model"] == "htdemucs_ft"
    assert completed_stem_job["stem_model_label"] == "2 stems model"

    chord_refresh_job = _wait_for_project_job(
        client,
        project["id"],
        lambda job: job["type"] == "chords" and job["id"] != chord_job["id"],
    )
    completed_chord_refresh_job = wait_for_job(client, chord_refresh_job["id"])
    assert completed_chord_refresh_job["status"] == "completed"
    assert completed_chord_refresh_job["chord_backend"] == "tuneforge-fast"
    assert completed_chord_refresh_job["chord_source"] == "source+stem"

    analysis = client.get(f"/api/v1/projects/{project['id']}/analysis").json()["analysis"]
    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    lyrics = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()

    assert analysis is not None
    assert len(chords["timeline"]) >= 3
    assert lyrics["segments"][0]["text"] == "Test lyric"


def test_project_can_be_renamed(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"display_name": "Practice Version"},
    )

    assert response.status_code == 200
    assert response.json()["project"]["display_name"] == "Practice Version"


def test_project_source_key_override_can_be_updated_and_cleared(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    update_response = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"source_key_override": "8:major"},
    )

    assert update_response.status_code == 200
    assert update_response.json()["project"]["source_key_override"] == "8:major"

    cleared_response = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"source_key_override": None},
    )

    assert cleared_response.status_code == 200
    assert cleared_response.json()["project"]["source_key_override"] is None


def test_project_list_can_filter_by_search_term(
    client,
    sample_audio_file: Path,
    sample_stereo_audio_file: Path,
):
    client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_audio_file),
            "copy_into_project": True,
            "display_name": "Choir Warmup",
        },
    )
    client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_stereo_audio_file),
            "copy_into_project": True,
            "display_name": "Bass Drill",
        },
    )

    response = client.get("/api/v1/projects", params={"search": "choir"})

    assert response.status_code == 200
    payload = response.json()
    projects = payload["projects"]
    assert len(projects) == 1
    assert projects[0]["display_name"] == "Choir Warmup"
    assert payload["total"] == 1
    assert payload["limit"] == 50
    assert payload["offset"] == 0
    assert payload["has_more"] is False


def test_project_list_returns_empty_pagination_metadata(client):
    response = client.get("/api/v1/projects")

    assert response.status_code == 200
    payload = response.json()
    assert payload["projects"] == []
    assert payload["total"] == 0
    assert payload["limit"] == 50
    assert payload["offset"] == 0
    assert payload["has_more"] is False


def test_project_list_returns_empty_search_pagination_metadata(client, tmp_path: Path):
    _insert_project_rows(
        tmp_path,
        [
            ("proj_search_empty", "Visible Song", datetime(2026, 1, 1, tzinfo=UTC), "local"),
        ],
    )

    response = client.get("/api/v1/projects", params={"search": "missing"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["projects"] == []
    assert payload["total"] == 0
    assert payload["limit"] == 50
    assert payload["offset"] == 0
    assert payload["has_more"] is False


def test_project_list_exact_page_size_has_no_more_results(client, tmp_path: Path):
    base_time = datetime(2026, 1, 1, tzinfo=UTC)
    _insert_project_rows(
        tmp_path,
        [
            (f"proj_exact_{index}", f"Exact Song {index}", base_time + timedelta(minutes=index), "local")
            for index in range(3)
        ],
    )

    response = client.get("/api/v1/projects", params={"limit": 3})

    assert response.status_code == 200
    payload = response.json()
    assert [project["id"] for project in payload["projects"]] == [
        "proj_exact_2",
        "proj_exact_1",
        "proj_exact_0",
    ]
    assert payload["total"] == 3
    assert payload["limit"] == 3
    assert payload["offset"] == 0
    assert payload["has_more"] is False


def test_project_list_returns_pagination_metadata_and_page_boundaries(client, tmp_path: Path):
    base_time = datetime(2026, 1, 1, tzinfo=UTC)
    _insert_project_rows(
        tmp_path,
        [
            (f"proj_page_{index}", f"Page Song {index}", base_time + timedelta(minutes=index), "local")
            for index in range(5)
        ],
    )

    middle_page = client.get("/api/v1/projects", params={"limit": 2, "offset": 2})

    assert middle_page.status_code == 200
    middle_payload = middle_page.json()
    assert [project["id"] for project in middle_payload["projects"]] == ["proj_page_2", "proj_page_1"]
    assert middle_payload["total"] == 5
    assert middle_payload["limit"] == 2
    assert middle_payload["offset"] == 2
    assert middle_payload["has_more"] is True

    last_page = client.get("/api/v1/projects", params={"limit": 2, "offset": 4})

    assert last_page.status_code == 200
    last_payload = last_page.json()
    assert [project["id"] for project in last_payload["projects"]] == ["proj_page_0"]
    assert last_payload["total"] == 5
    assert last_payload["limit"] == 2
    assert last_payload["offset"] == 4
    assert last_payload["has_more"] is False


def test_project_list_search_applies_before_pagination(client, tmp_path: Path):
    base_time = datetime(2026, 1, 1, tzinfo=UTC)
    _insert_project_rows(
        tmp_path,
        [
            ("proj_recent_2", "Recent Song 2", base_time + timedelta(minutes=4), "local"),
            ("proj_recent_1", "Recent Song 1", base_time + timedelta(minutes=3), "local"),
            ("proj_recent_0", "Recent Song 0", base_time + timedelta(minutes=2), "local"),
            ("proj_needle", "Deep Needle Match", base_time + timedelta(minutes=1), "local"),
        ],
    )

    response = client.get("/api/v1/projects", params={"search": "needle", "limit": 1, "offset": 0})

    assert response.status_code == 200
    payload = response.json()
    assert [project["id"] for project in payload["projects"]] == ["proj_needle"]
    assert payload["total"] == 1
    assert payload["has_more"] is False


def test_project_list_uses_project_id_as_updated_at_tie_breaker(client, tmp_path: Path):
    tied_time = datetime(2026, 1, 1, tzinfo=UTC)
    _insert_project_rows(
        tmp_path,
        [
            ("proj_tie_a", "Tie A", tied_time, "local"),
            ("proj_tie_c", "Tie C", tied_time, "local"),
            ("proj_tie_b", "Tie B", tied_time, "local"),
        ],
    )

    response = client.get("/api/v1/projects", params={"limit": 3})

    assert response.status_code == 200
    assert [project["id"] for project in response.json()["projects"]] == [
        "proj_tie_c",
        "proj_tie_b",
        "proj_tie_a",
    ]


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 201},
        {"offset": -1},
    ],
)
def test_project_list_rejects_invalid_pagination_params(client, params: dict[str, int]):
    response = client.get("/api/v1/projects", params=params)

    assert response.status_code == 422


def test_project_list_hides_deleted_sync_placeholders(client, tmp_path: Path):
    with SessionLocal() as session:
        session.add_all(
            [
                Project(
                    id="proj_visible_local",
                    display_name="Visible Project",
                    source_sha256="a" * 64,
                    source_path=str(tmp_path / "visible-source.wav"),
                    imported_path=str(tmp_path / "visible-imported.wav"),
                    sync_status="local",
                ),
                Project(
                    id="proj_hidden_deleted",
                    display_name="Hidden Deleted Project",
                    source_sha256="b" * 64,
                    source_path="sync-placeholder:proj_hidden_deleted",
                    imported_path="sync-placeholder:proj_hidden_deleted",
                    sync_status="deleted",
                    sync_status_reason="Project is covered by a sync delete tombstone.",
                ),
            ]
        )
        session.commit()

    response = client.get("/api/v1/projects")

    assert response.status_code == 200
    payload = response.json()
    projects = payload["projects"]
    assert [project["id"] for project in projects] == ["proj_visible_local"]
    assert payload["total"] == 1
    assert payload["has_more"] is False


def test_import_project_replaces_deleted_sync_placeholder(
    client,
    sample_audio_file: Path,
) -> None:
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)

    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Deleted Placeholder",
                source_sha256=source_hash,
                source_path=f"sync-placeholder:{project_id}",
                imported_path=f"sync-placeholder:{project_id}",
                sync_status="deleted",
                sync_status_reason="Project is covered by a sync delete tombstone.",
            )
        )
        session.add(
            SyncDeleteTombstone(
                id="tomb_reimport_project",
                sync_group_id="group-a",
                project_id=project_id,
                target_type=PROJECT_TARGET_TYPE,
                target_id=project_id,
                author_device_id="peer-a",
                deleted_at=datetime(2026, 1, 1, tzinfo=UTC),
                prior_metadata_json={"display_name": "Deleted Placeholder"},
            )
        )
        session.add(
            SyncDeleteTombstone(
                id="tomb_reimport_artifact",
                sync_group_id="group-a",
                project_id=project_id,
                target_type=ARTIFACT_TARGET_TYPE,
                target_id="art_reimport_artifact",
                author_device_id="peer-a",
                deleted_at=datetime(2026, 1, 1, tzinfo=UTC),
                prior_metadata_json={"type": "source_audio"},
            )
        )
        session.commit()

    response = client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_audio_file),
            "copy_into_project": True,
            "display_name": "Reimported Project",
        },
    )

    assert response.status_code == 200
    project = response.json()["project"]
    assert project["id"] == project_id
    assert project["display_name"] == "Reimported Project"
    assert project["sync_status"] == "local"

    with SessionLocal() as session:
        assert session.get(SyncDeleteTombstone, "tomb_reimport_project") is None
        assert session.get(SyncDeleteTombstone, "tomb_reimport_artifact") is None
        persisted_project = session.get(Project, project_id)
        assert persisted_project is not None
        assert persisted_project.sync_status == "local"


def test_retune_request_rejects_invalid_payload(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.post(
        f"/api/v1/projects/{project['id']}/retune",
        json={"target_reference_hz": 440.0, "target_cents_offset": 12.0},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize(
    ("fixture_name", "original_format"),
    [
        ("sample_audio_file", "wav"),
        ("sample_mp3_file", "mp3"),
        ("sample_flac_file", "flac"),
        ("sample_m4a_file", "m4a"),
        ("sample_aac_file", "aac"),
        ("sample_ogg_file", "ogg"),
        ("sample_mp4_file", "mp4"),
        ("sample_webm_file", "webm"),
    ],
)
def test_supported_imports_are_normalized_to_internal_wav(
    client,
    request,
    fixture_name: str,
    original_format: str,
):
    source_path = request.getfixturevalue(fixture_name)
    source_hash = file_sha256(source_path)
    assert source_hash is not None

    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(source_path), "copy_into_project": True},
    )

    assert response.status_code == 200
    project = response.json()["project"]
    imported_path = Path(project["imported_path"])
    assert imported_path.exists()
    assert imported_path.name == f"{source_path.stem}.wav"
    assert project["id"] == source_hash_to_project_id(source_hash)

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    assert source_artifact["format"] == "wav"
    assert source_artifact["metadata"]["source_path"] == str(source_path.resolve())
    assert source_artifact["metadata"]["original_format"] == original_format
    assert "original_copy_path" not in source_artifact["metadata"]
    if original_format != "wav":
        assert not (imported_path.parent / source_path.name).exists()

    with SessionLocal() as session:
        project_row = session.get(Project, project["id"])
        artifact_row = session.get(Artifact, source_artifact["id"])
        assert project_row is not None
        assert artifact_row is not None
        assert project_row.source_sha256 == source_hash
        assert artifact_row.content_sha256 == file_sha256(imported_path)
        if original_format != "wav":
            assert artifact_row.content_sha256 != source_hash
