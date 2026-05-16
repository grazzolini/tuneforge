from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, reconfigure_engine, run_migrations
from app.models import ChordTimeline, LyricsTranscript, Project, SongSection, SyncEntityRevision
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_revisions import (
    CHORDS_ENTITY_TYPE,
    CURRENT_REVISION_STATE,
    LYRICS_ENTITY_TYPE,
    PROJECT_METADATA_ENTITY_TYPE,
    SECTION_ENTITY_TYPE,
    SUPERSEDED_REVISION_STATE,
    current_entity_revision,
    list_project_entity_revisions,
    record_chord_revision,
    record_lyrics_revision,
    record_project_metadata_revision,
    record_section_revision,
)
from app.services.sync_trust import get_or_create_local_identity

LOCAL_PATH_KEYS = {
    "absolute_path",
    "imported_path",
    "local_path",
    "original_copy_path",
    "path",
    "playback_path",
    "render_path",
    "source_path",
}


@pytest.fixture()
def db_session() -> Iterator[Session]:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_project_metadata_revision_uses_local_identity_and_stable_content_hash(
    db_session: Session,
    tmp_path: Path,
) -> None:
    project = _create_project(db_session, tmp_path)
    first_revision = record_project_metadata_revision(db_session, project)
    db_session.commit()
    db_session.refresh(first_revision)
    identity = get_or_create_local_identity(db_session)

    second_revision = record_project_metadata_revision(db_session, project)
    db_session.commit()
    db_session.refresh(first_revision)
    db_session.refresh(second_revision)

    assert first_revision.author_device_id == identity.device_id
    assert second_revision.author_device_id == identity.device_id
    assert first_revision.content_sha256 == second_revision.content_sha256
    assert first_revision.content_sha256 == _canonical_payload_hash(first_revision.payload_json)
    assert first_revision.state == SUPERSEDED_REVISION_STATE
    assert second_revision.state == CURRENT_REVISION_STATE
    assert second_revision.base_revision_id == first_revision.id
    assert current_entity_revision(
        db_session,
        project.id,
        PROJECT_METADATA_ENTITY_TYPE,
        project.id,
    ).id == second_revision.id


def test_chord_revision_sanitizes_payload_and_metadata(
    db_session: Session,
    tmp_path: Path,
) -> None:
    project = _create_project(db_session, tmp_path)
    chords = ChordTimeline(
        project_id=project.id,
        backend="tuneforge-fast",
        source_artifact_id="art_source",
        timeline_json=[
            {
                "start": 0.0,
                "end": 1.0,
                "label": "C",
                "source_path": str(tmp_path / "timeline-leak.wav"),
            }
        ],
        source_segments_json=[
            {
                "start": 0.0,
                "end": 1.0,
                "label": "C",
                "path": str(tmp_path / "source-leak.wav"),
            }
        ],
        segments_json=[
            {
                "start": 0.0,
                "end": 1.0,
                "label": "C",
                "note": str(tmp_path / "absolute-string-leak.wav"),
            }
        ],
        source_kind="generated",
        metadata_json={
            "model": "tuneforge-fast",
            "render_path": str(tmp_path / "render.wav"),
            "nested": {"playback_path": str(tmp_path / "playback.wav"), "confidence": 0.9},
        },
    )
    db_session.add(chords)
    db_session.flush()

    revision = record_chord_revision(db_session, chords)
    db_session.commit()
    db_session.refresh(revision)

    payload = revision.payload_json
    metadata = revision.metadata_json
    assert revision.entity_type == CHORDS_ENTITY_TYPE
    assert revision.entity_id == project.id
    assert revision.source_artifact_id == "art_source"
    assert payload["timeline"] == [{"start": 0.0, "end": 1.0, "label": "C"}]
    assert payload["source_segments"] == [{"start": 0.0, "end": 1.0, "label": "C"}]
    assert payload["segments"] == [{"start": 0.0, "end": 1.0, "label": "C"}]
    assert metadata == {"model": "tuneforge-fast", "nested": {"confidence": 0.9}}
    _assert_sync_safe(payload, tmp_path)
    _assert_sync_safe(metadata, tmp_path)


def test_lyrics_and_section_revisions_are_listed_as_current_project_entities(
    db_session: Session,
    tmp_path: Path,
) -> None:
    project = _create_project(db_session, tmp_path)
    lyrics = LyricsTranscript(
        project_id=project.id,
        backend="whisper",
        source_artifact_id="art_source",
        source_kind="ai",
        requested_device="cpu",
        device="cpu",
        model_name="base",
        language="en",
        source_segments_json=[{"start": 0.0, "end": 1.0, "text": "hello"}],
        segments_json=[{"start": 0.0, "end": 1.0, "text": "hello edit"}],
        has_user_edits=True,
    )
    section = SongSection(
        id="section_intro",
        project_id=project.id,
        label="Intro",
        start_seconds=0.0,
        end_seconds=12.0,
        source="user",
        metadata_json={"source_path": str(tmp_path / "section-leak.txt"), "color": "blue"},
    )
    db_session.add_all([lyrics, section])
    db_session.flush()

    lyrics_revision = record_lyrics_revision(db_session, lyrics, revision_type="user_edit")
    section_revision = record_section_revision(db_session, section)
    db_session.commit()
    db_session.refresh(lyrics_revision)
    db_session.refresh(section_revision)

    revisions = list_project_entity_revisions(db_session, project.id)
    revision_ids = {revision.id for revision in revisions}

    assert revision_ids == {lyrics_revision.id, section_revision.id}
    assert lyrics_revision.entity_type == LYRICS_ENTITY_TYPE
    assert lyrics_revision.revision_type == "user_edit"
    assert lyrics_revision.payload_json["has_user_edits"] is True
    assert section_revision.entity_type == SECTION_ENTITY_TYPE
    assert section_revision.payload_json["metadata"] == {"color": "blue"}
    _assert_sync_safe(section_revision.payload_json, tmp_path)


def test_current_revision_lookup_prefers_current_state_then_latest_created_at(
    db_session: Session,
    tmp_path: Path,
) -> None:
    project = _create_project(db_session, tmp_path)
    old_time = datetime.now(UTC) - timedelta(minutes=5)
    new_time = datetime.now(UTC)
    older_current = _manual_revision(
        project_id=project.id,
        revision_id="rev_manual_current",
        entity_type=CHORDS_ENTITY_TYPE,
        entity_id=project.id,
        state=CURRENT_REVISION_STATE,
        created_at=old_time,
    )
    newer_superseded = _manual_revision(
        project_id=project.id,
        revision_id="rev_manual_superseded",
        entity_type=CHORDS_ENTITY_TYPE,
        entity_id=project.id,
        state=SUPERSEDED_REVISION_STATE,
        created_at=new_time,
    )
    db_session.add_all([older_current, newer_superseded])
    db_session.commit()

    assert current_entity_revision(
        db_session,
        project.id,
        CHORDS_ENTITY_TYPE,
        project.id,
    ).id == older_current.id

    older_current.state = SUPERSEDED_REVISION_STATE
    db_session.commit()

    assert current_entity_revision(
        db_session,
        project.id,
        CHORDS_ENTITY_TYPE,
        project.id,
    ).id == newer_superseded.id


def test_record_revision_supersedes_imported_current_alias(
    db_session: Session,
    tmp_path: Path,
) -> None:
    project = _create_project(db_session, tmp_path)
    imported_current = _manual_revision(
        project_id=project.id,
        revision_id="rev_imported_current",
        entity_type=PROJECT_METADATA_ENTITY_TYPE,
        entity_id=project.id,
        state="current",
        created_at=datetime.now(UTC),
    )
    db_session.add(imported_current)
    db_session.commit()

    next_revision = record_project_metadata_revision(db_session, project)
    db_session.commit()
    db_session.refresh(imported_current)
    db_session.refresh(next_revision)

    assert imported_current.state == SUPERSEDED_REVISION_STATE
    assert next_revision.base_revision_id == imported_current.id
    assert next_revision.state == CURRENT_REVISION_STATE


def _create_project(session: Session, tmp_path: Path) -> Project:
    source_hash = "a" * 64
    project_id = source_hash_to_project_id(source_hash)
    source_path = tmp_path / "library" / "source.wav"
    imported_path = tmp_path / "app-data" / "source.wav"
    project = Project(
        id=project_id,
        display_name="Sync Revision Fixture",
        source_key_override="3:major",
        source_sha256=source_hash,
        source_path=str(source_path),
        imported_path=str(imported_path),
        duration_seconds=10.5,
        sample_rate=44100,
        channels=2,
    )
    session.add(project)
    session.flush()
    return project


def _manual_revision(
    *,
    project_id: str,
    revision_id: str,
    entity_type: str,
    entity_id: str,
    state: str,
    created_at: datetime,
) -> SyncEntityRevision:
    payload = {"value": revision_id}
    return SyncEntityRevision(
        id=revision_id,
        project_id=project_id,
        entity_type=entity_type,
        entity_id=entity_id,
        revision_type="manual",
        base_revision_id=None,
        author_device_id="dev_manual",
        source_artifact_id=None,
        content_sha256=_canonical_payload_hash(payload),
        state=state,
        metadata_json={},
        payload_json=payload,
        created_at=created_at,
        updated_at=created_at,
    )


def _canonical_payload_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(
            payload,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()


def _assert_sync_safe(payload: dict[str, Any], local_root: Path) -> None:
    encoded = json.dumps(payload, sort_keys=True)
    assert str(local_root) not in encoded
    leaked_keys = [
        key
        for key in _iter_keys(payload)
        if key in LOCAL_PATH_KEYS or key.endswith("_path")
    ]
    assert leaked_keys == []
    absolute_values = [
        value
        for value in _iter_strings(payload)
        if _looks_like_local_absolute_path(value)
    ]
    assert absolute_values == []


def _iter_keys(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(key, str):
                yield key
            yield from _iter_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_keys(child)


def _iter_strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _iter_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_strings(child)


def _looks_like_local_absolute_path(value: str) -> bool:
    return value.startswith("~/") or PurePosixPath(value).is_absolute()
