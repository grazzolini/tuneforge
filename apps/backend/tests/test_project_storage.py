from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, reconfigure_engine, run_migrations
from app.models import Artifact, ChordTimeline, LyricsTranscript, Project, SyncDeleteTombstone
from app.services.paths import project_root
from app.services.project_storage import queue_project_storage_reconciliation
from app.services.projects import delete_project
from app.services.sync_tombstones import ARTIFACT_TARGET_TYPE, apply_delete_tombstone


def _prepare_database() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)


def _project(project_id: str, imported_path: Path) -> Project:
    return Project(
        id=project_id,
        display_name="Storage Test",
        source_sha256="a" * 64,
        source_path=str(imported_path),
        imported_path=str(imported_path),
    )


def _artifact(
    artifact_id: str,
    project_id: str,
    path: Path,
    *,
    artifact_type: str = "preview_mix",
) -> Artifact:
    return Artifact(
        id=artifact_id,
        project_id=project_id,
        type=artifact_type,
        format=path.suffix.removeprefix(".") or "wav",
        path=str(path),
        content_sha256=None,
        size_bytes=0,
        generated_by="test",
        can_delete=True,
        can_regenerate=True,
        metadata_json={},
    )


def test_reconciliation_preserves_live_ownership_and_never_follows_symlinks(
    tmp_path: Path,
) -> None:
    _prepare_database()
    project_id = "proj_storage_ownership"
    root = project_root(project_id)
    owned_audio = root / "previews" / "owned.wav"
    missing_audio = root / "previews" / "missing.wav"
    analysis_json = root / "analysis" / "analysis.json"
    chords_json = root / "analysis" / "chords.json"
    lyrics_json = root / "analysis" / "lyrics.json"
    stale_json = root / "analysis" / "old.json"
    stale_nested = root / "stems" / "old-stemset" / "vocals.wav"
    empty_descendant = root / "previews" / "empty"
    external_file = tmp_path / "external.wav"
    external_target = tmp_path / "external-target.wav"
    stale_link = root / "stems" / "external-link.wav"
    linked_parent = root / "linked-parent"
    linked_target = tmp_path / "linked-target"
    linked_file = linked_target / "file.wav"
    cross_project_file = root / "previews" / "cross-project.wav"

    for path in (
        owned_audio,
        analysis_json,
        chords_json,
        lyrics_json,
        stale_json,
        stale_nested,
        cross_project_file,
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(path.name.encode())
    empty_descendant.mkdir(parents=True)
    external_file.write_bytes(b"external artifact")
    external_target.write_bytes(b"external target")
    linked_target.mkdir()
    linked_file.write_bytes(b"linked target")
    stale_link.symlink_to(external_target)
    linked_parent.symlink_to(linked_target, target_is_directory=True)

    with SessionLocal() as session:
        session.add(_project(project_id, owned_audio))
        session.add(_project("proj_cross_owner", external_file))
        session.add_all(
            [
                _artifact("art_owned_audio", project_id, owned_audio),
                _artifact("art_missing_audio", project_id, missing_audio),
                _artifact(
                    "art_analysis_json",
                    project_id,
                    analysis_json,
                    artifact_type="analysis_json",
                ),
                _artifact("art_external", project_id, external_file),
                _artifact("art_linked", project_id, linked_parent / "file.wav"),
                _artifact("art_cross_owner", "proj_cross_owner", cross_project_file),
            ]
        )
        session.add(ChordTimeline(project_id=project_id))
        session.add(LyricsTranscript(project_id=project_id))
        queue_project_storage_reconciliation(session, project_id)
        session.commit()

    assert owned_audio.exists()
    assert analysis_json.exists()
    assert chords_json.exists()
    assert lyrics_json.exists()
    assert not stale_json.exists()
    assert not stale_nested.exists()
    assert not stale_nested.parent.exists()
    assert not empty_descendant.exists()
    assert not stale_link.exists()
    assert linked_parent.is_symlink()
    assert linked_file.read_bytes() == b"linked target"
    assert cross_project_file.exists()
    assert external_file.read_bytes() == b"external artifact"
    assert external_target.read_bytes() == b"external target"
    with SessionLocal() as session:
        assert session.get(Artifact, "art_missing_audio") is not None
        assert session.get(Artifact, "art_external") is not None


def test_reconciliation_runs_after_commit_and_not_after_rollback() -> None:
    _prepare_database()
    project_id = "proj_storage_transaction"
    root = project_root(project_id)
    owned = root / "source" / "source.wav"
    stale = root / "stems" / "stale.wav"
    owned.parent.mkdir(parents=True, exist_ok=True)
    stale.parent.mkdir(parents=True, exist_ok=True)
    owned.write_bytes(b"owned")
    stale.write_bytes(b"stale")

    with SessionLocal() as session:
        session.add(_project(project_id, owned))
        session.add(_artifact("art_transaction", project_id, owned, artifact_type="source_audio"))
        session.commit()

    with SessionLocal() as session:
        queue_project_storage_reconciliation(session, project_id)
        session.rollback()
    assert stale.exists()

    with SessionLocal() as session:
        queue_project_storage_reconciliation(session, project_id)
        session.commit()
    assert not stale.exists()
    assert owned.exists()


def test_parent_identity_change_aborts_cleanup_and_next_commit_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prepare_database()
    project_id = "proj_storage_race"
    root = project_root(project_id)
    owned = root / "source" / "source.wav"
    late_owned = root / "previews" / "late.wav"
    stale = root / "stems" / "stale.wav"
    replacement = root.parent.parent / "replacement"
    external_victim = replacement / "victim.wav"
    owned.parent.mkdir(parents=True, exist_ok=True)
    stale.parent.mkdir(parents=True, exist_ok=True)
    replacement.mkdir()
    external_victim.write_bytes(b"external victim")
    owned.write_bytes(b"owned")
    stale.write_bytes(b"stale")

    with SessionLocal() as session:
        session.add(_project(project_id, owned))
        session.add(_artifact("art_race", project_id, owned, artifact_type="source_audio"))
        session.commit()

    from app.services import project_storage

    original_path_identity = project_storage._path_identity
    projects_root_checks = 0

    def raced_path_identity(path: Path):
        nonlocal projects_root_checks
        if path == root.parent:
            projects_root_checks += 1
            if projects_root_checks >= 2:
                return os.lstat(replacement)
        return original_path_identity(path)

    monkeypatch.setattr(project_storage, "_path_identity", raced_path_identity)
    with SessionLocal() as session:
        queue_project_storage_reconciliation(session, project_id)
        session.commit()
    assert stale.exists()
    assert owned.exists()
    assert external_victim.read_bytes() == b"external victim"

    monkeypatch.setattr(project_storage, "_path_identity", original_path_identity)
    late_owned.parent.mkdir(parents=True)
    late_owned.write_bytes(b"late owned")
    with SessionLocal() as session:
        session.add(_artifact("art_race_late", project_id, late_owned))
        session.commit()
    assert not stale.exists()
    assert owned.exists()
    assert late_owned.exists()
    assert external_victim.read_bytes() == b"external victim"


def test_tombstones_and_project_delete_retire_storage_only_after_commit() -> None:
    _prepare_database()
    project_id = "proj_storage_delete"
    root = project_root(project_id)
    source = root / "source" / "source.wav"
    deleted = root / "previews" / "deleted.wav"
    for path in (source, deleted):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(path.name.encode())

    with SessionLocal() as session:
        session.add(_project(project_id, source))
        session.add_all(
            [
                _artifact("art_delete_source", project_id, source, artifact_type="source_audio"),
                _artifact("art_delete_preview", project_id, deleted),
            ]
        )
        session.commit()

    now = datetime.now(UTC)
    tombstone = SyncDeleteTombstone(
        id="del_storage_artifact",
        sync_group_id="group_storage",
        project_id=project_id,
        target_type=ARTIFACT_TARGET_TYPE,
        target_id="art_delete_preview",
        author_device_id="device_storage",
        deleted_at=now,
        prior_metadata_json={},
        created_at=now,
        updated_at=now,
    )
    with SessionLocal() as session:
        apply_delete_tombstone(session, tombstone)
        assert deleted.exists()
        session.commit()
    assert not deleted.exists()
    assert source.exists()

    with SessionLocal() as session:
        delete_project(session, project_id)
        assert root.exists()
        session.commit()
    assert not root.exists()
