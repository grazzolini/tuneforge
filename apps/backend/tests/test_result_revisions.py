from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import event, func, inspect, select
from sqlalchemy.orm.attributes import flag_modified

from app.db import SessionLocal, get_engine
from app.models import AnalysisResult, Artifact, ChordTimeline, LyricsTranscript, Project, SyncEntityRevision
from app.services import analysis as analysis_service
from app.services.sync_manifest import (
    _export_entity_revision_manifest,
    _hydrate_current_entity_revisions,
    _result_source_artifact_id,
    export_project_manifest,
    hydrate_project_analysis_result_from_artifact,
)
from app.services.sync_revisions import (
    materialize_result_revisions,
    record_analysis_revision,
    record_chord_revision,
    record_lyrics_revision,
    revision_payload_sha256,
)

from .test_sync_revisions import _create_project


@pytest.mark.parametrize("mode", ["sole", "historical", "current-with-history"])
@pytest.mark.parametrize("entity_type", ["analysis", "chords", "lyrics"])
def test_applied_result_tombstone_survives_reopen_export_and_legacy_repair(
    client, tmp_path: Path, entity_type: str, mode: str,
) -> None:
    from app.services.paths import project_root
    from app.services.sync_tombstones import apply_delete_tombstone, record_entity_revision_delete_tombstone

    historical = mode == "historical"

    model, recorder = {
        "analysis": (AnalysisResult, record_analysis_revision),
        "chords": (ChordTimeline, record_chord_revision),
        "lyrics": (LyricsTranscript, record_lyrics_revision),
    }[entity_type]
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        source_path = project_root(project_id) / "source" / "source.wav"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_bytes(b"synthetic source")
        session.add(Artifact(
            id="source", project_id=project_id, type="source_audio", format="wav", path=str(source_path),
            size_bytes=16, content_sha256=hashlib.sha256(b"synthetic source").hexdigest(), generated_by="import",
        ))
        row = model(project_id=project_id)
        session.add(row)
        session.flush()
        first = recorder(session, row)
        first_id = first.id
        winner_id = None
        if mode != "sole":
            if entity_type == "analysis":
                row.estimated_key = "current winner"
            elif entity_type == "chords":
                row.timeline_json = [{"label": "current winner"}]
            else:
                row.segments_json = [{"text": "current winner"}]
            winner_id = recorder(session, row).id
        legacy_path = tmp_path / "legacy-analysis.json"
        legacy_bytes = json.dumps({"project_id": project_id, "estimated_key": "stale legacy"}).encode()
        if entity_type == "analysis":
            legacy_path.write_bytes(legacy_bytes)
            session.add(Artifact(
                id="legacy-retained", project_id=project_id, type="analysis_json", format="json",
                path=str(legacy_path), size_bytes=len(legacy_bytes), generated_by="analysis",
            ))
        target = session.get(SyncEntityRevision, winner_id) if mode == "current-with-history" else first
        target_id = target.id
        tombstone = record_entity_revision_delete_tombstone(
            session, target, deleted_at=datetime(2030, 1, 1, tzinfo=UTC),
        )
        apply_delete_tombstone(session, tombstone)
        session.flush()
        assert (session.get(model, project_id) is not None) == historical
        session.commit()

    with SessionLocal() as session:
        materialize_result_revisions(session)
        if entity_type == "analysis":
            hydrate_project_analysis_result_from_artifact(session, project_id)
            assert legacy_path.read_bytes() == legacy_bytes
            assert session.get(Artifact, "legacy-retained") is not None
        manifest = export_project_manifest(session, project_id)
        active = [revision.revision_id for revision in manifest.entity_revisions
                  if revision.entity_type == entity_type and revision.state == "active"]
        assert active == ([winner_id] if historical else [])
        assert (session.get(model, project_id) is not None) == historical
        assert session.get(SyncEntityRevision, target_id) is None
        if mode == "current-with-history":
            assert session.get(SyncEntityRevision, first_id).state == "superseded"
        session.commit()
        if not historical:
            # Recover stale projections left by older deletion implementations without resurrecting them.
            session.add(model(project_id=project_id))
            session.commit()
            materialize_result_revisions(session)
            assert session.get(model, project_id) is None
            assert not any(
                revision.entity_type == entity_type and revision.state == "active"
                for revision in export_project_manifest(session, project_id).entity_revisions
            )
            session.commit()


def test_python_revision_hash_matches_shared_vectors() -> None:
    vectors = json.loads(
        (Path(__file__).parents[3] / "packages/shared-types/fixtures/result-revisions.json").read_text()
    )
    for vector in vectors:
        canonical = json.dumps(
            vector["payload"], allow_nan=False, ensure_ascii=True, sort_keys=True, separators=(",", ":")
        )
        assert canonical == vector["canonical"]
        assert revision_payload_sha256(vector["payload"]) == vector["sha256"]


def test_result_hydration_allows_only_proven_same_project_deleted_sources(client, tmp_path: Path) -> None:
    from app.errors import AppError
    from app.models import SyncDeleteTombstone
    from app.services.sync_trust import get_or_create_local_identity

    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        identity = get_or_create_local_identity(session)
        session.add(SyncDeleteTombstone(
            id="deleted-source", sync_group_id=identity.sync_group_id, project_id=project.id,
            target_type="artifact", target_id="old-source", author_device_id=identity.device_id,
            deleted_at=datetime.now(UTC), prior_metadata_json={},
        ))
        session.flush()
        assert _result_source_artifact_id(session, project.id, "old-source") is None
        with pytest.raises(AppError, match="must belong"):
            _result_source_artifact_id(session, project.id, "unproven-source")
        with pytest.raises(AppError, match="must belong"):
            _result_source_artifact_id(session, "other-project", "old-source")


@pytest.mark.parametrize("timestamp_source", ["metadata", "payload", "artifact", "row"])
def test_upgrade_preserves_recorded_analysis_time_and_provenance(client, tmp_path: Path, timestamp_source: str) -> None:
    created = datetime(2025, 1, 1, tzinfo=UTC)
    recorded = created + timedelta(days=1)
    artifact_time = created + timedelta(days=2)
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        analysis = AnalysisResult(project_id=project.id, estimated_key=None, tempo_bpm=None, created_at=created)
        session.add(analysis)
        if timestamp_source != "row":
            payload = {"analysis_generated_at": recorded.isoformat()} if timestamp_source == "payload" else {}
            path = tmp_path / "legacy-analysis.json"
            path.write_text(json.dumps(payload))
            metadata = {"source_stem_artifact_ids": ["synthetic-drums"], "preprocessing": {"resampler": "soxr"}}
            if timestamp_source == "metadata":
                metadata["analysis_generated_at"] = recorded.isoformat()
            session.add(
                Artifact(
                    id="legacy-analysis",
                    project_id=project.id,
                    type="analysis_json",
                    format="json",
                    path=str(path),
                    size_bytes=path.stat().st_size,
                    generated_by="analysis",
                    metadata_json=metadata,
                    created_at=created,
                    updated_at=artifact_time,
                )
            )
        session.flush()
        materialize_result_revisions(session)
        session.commit()
        revision = session.scalar(select(SyncEntityRevision).where(SyncEntityRevision.entity_type == "analysis"))
        assert revision is not None
        expected_time = (
            recorded
            if timestamp_source in {"metadata", "payload"}
            else artifact_time
            if timestamp_source == "artifact"
            else created
        )
        assert revision.updated_at.replace(tzinfo=UTC) == expected_time
        assert analysis.created_at.replace(tzinfo=UTC) == created
        assert revision.base_revision_id is None
        assert revision.payload_json["tempo_bpm"] is None
        if timestamp_source != "row":
            assert revision.metadata_json["source_stem_artifact_ids"] == ["synthetic-drums"]
            assert revision.metadata_json["preprocessing"] == {"resampler": "soxr"}
        materialize_result_revisions(session)
        session.commit()
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == 1


def test_upgrade_hydrates_existing_winner_and_respects_deleted_results(client, tmp_path: Path) -> None:
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        analysis = AnalysisResult(project_id=project.id, estimated_key="C major")
        session.add(analysis)
        session.flush()
        revision = record_analysis_revision(session, analysis)
        original_id = revision.id
        analysis.estimated_key = "stale JSON result"
        analysis.updated_at = datetime.now(UTC) + timedelta(days=30)
        materialize_result_revisions(session)
        assert analysis.estimated_key == "C major"
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == 1
        revision.state = "deleted"
        session.flush()
        materialize_result_revisions(session)
        session.commit()
        assert session.get(AnalysisResult, project.id) is None
        assert session.get(SyncEntityRevision, original_id).state == "deleted"


@pytest.mark.parametrize("full_library", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("entity_type", ["analysis", "chords", "lyrics"])
def test_result_hydration_uses_utc_author_id_lww_independent_of_order(
    client, tmp_path: Path, reverse: bool, entity_type: str, full_library: bool,
) -> None:
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        timestamp = datetime(2026, 1, 1, tzinfo=UTC)
        rows = []
        for revision_id, author, offset, key in [
            ("rev_a", "author_a", 0, "A"),
            ("rev_z", "author_b", 0, "B"),
            ("rev_y", "author_b", 0, "C"),
            ("rev_old", "author_z", -1, "old"),
        ]:
            payload = {"project_id": project.id, "estimated_key": key, "timing": None,
                       "segments": [{"label": key, "text": key}], "timeline": [{"label": key}]}
            rows.append(
                SyncEntityRevision(
                    id=revision_id,
                    project_id=project.id,
                    entity_type=entity_type,
                    entity_id=project.id,
                    revision_type="generated",
                    author_device_id=author,
                    state="active",
                    content_sha256=revision_payload_sha256(payload),
                    payload_json=payload,
                    metadata_json={},
                    created_at=timestamp + timedelta(days=5),
                    updated_at=timestamp + timedelta(seconds=offset),
                )
            )
        session.add_all(rows[::-1] if reverse else rows)
        session.flush()
        if full_library:
            materialize_result_revisions(session)
        else:
            _hydrate_current_entity_revisions(session, project, [_export_entity_revision_manifest(row) for row in rows])
        def value() -> str:
            if entity_type == "analysis":
                return session.get(AnalysisResult, project.id).estimated_key
            if entity_type == "chords":
                return session.get(ChordTimeline, project.id).timeline_json[0]["label"]
            return session.get(LyricsTranscript, project.id).segments_json[0]["text"]
        assert value() == "B"
        assert [row.id for row in rows if row.state == "active"] == ["rev_z"]
        stale = rows[-1]
        stale.state = "active"
        _hydrate_current_entity_revisions(session, project, [_export_entity_revision_manifest(stale)])
        assert value() == "B"


def test_generation_rolls_back_result_and_revision_together(client, sample_audio_file: Path, monkeypatch) -> None:
    from .conftest import import_project_without_jobs

    project_id = import_project_without_jobs(sample_audio_file)["id"]
    monkeypatch.setattr(
        analysis_service,
        "_analyze_track_with_backend",
        lambda *_args, **_kwargs: {
            "estimated_key": "C major",
            "key_confidence": 0.8,
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
            "tempo_bpm": 120.0,
            "timing": None,
        },
    )

    def fail_revision(*_args, **_kwargs):
        raise RuntimeError("synthetic interrupted publication")

    monkeypatch.setattr(analysis_service, "record_analysis_revision", fail_revision)
    with SessionLocal() as session:
        with pytest.raises(RuntimeError, match="interrupted publication"):
            analysis_service.analyze_project(session, session.get(Project, project_id), beat_backend="built-in")
        session.rollback()
        assert session.get(AnalysisResult, project_id) is None
        assert (
            session.scalar(
                select(func.count()).select_from(SyncEntityRevision).where(SyncEntityRevision.entity_type == "analysis")
            )
            == 0
        )


@pytest.mark.parametrize("count", [25, 194])
def test_populated_upgrade_materialization_is_bounded_and_idempotent(
    client, tmp_path: Path, count: int
) -> None:
    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        for index in range(count):
            source_hash = hashlib.sha256(f"synthetic-{index}".encode()).hexdigest()
            project_id = f"proj_sha256_{source_hash}"
            session.add(
                Project(
                    id=project_id,
                    display_name=f"Synthetic {index}",
                    source_sha256=source_hash,
                    source_path=str(tmp_path / f"{index}.wav"),
                    imported_path=str(tmp_path / f"{index}.wav"),
                )
            )
            session.flush()
            session.add_all(
                [
                    AnalysisResult(project_id=project_id, created_at=recorded, tempo_bpm=120.0),
                    ChordTimeline(project_id=project_id, created_at=recorded, updated_at=recorded),
                    LyricsTranscript(project_id=project_id, created_at=recorded, updated_at=recorded),
                ]
            )
        session.commit()
        start = time.perf_counter()
        materialize_result_revisions(session)
        session.commit()
        elapsed = time.perf_counter() - start
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == count * 3
        materialize_result_revisions(session)
        session.commit()
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == count * 3
        revisions = list(session.scalars(select(SyncEntityRevision)))
        assert all(revision.updated_at.replace(tzinfo=UTC) == recorded for revision in revisions)
        print(
            json.dumps(
                {
                    "projects": count,
                    "materialization_ms": round(elapsed * 1000, 2),
                    "payload_bytes": sum(len(json.dumps(revision.payload_json)) for revision in revisions),
                }
            )
        )


def _result_projection(session, project_id: str) -> dict:
    from app.services.sync_timestamps import sync_datetime_as_utc

    result = {}
    for model in (AnalysisResult, ChordTimeline, LyricsTranscript):
        row = session.get(model, project_id)
        result[model.__tablename__] = None if row is None else {
            column.name: sync_datetime_as_utc(value) if isinstance(value, datetime) else value
            for column in model.__table__.columns
            for value in [getattr(row, column.name)]
        }
    return result


@pytest.mark.parametrize(
    "mode", ["stale", "field-only", "missing", "metadata", "timestamp", "winner", "inactive", "aliases"],
)
@pytest.mark.parametrize("entity_type", ["analysis", "chords", "lyrics"])
def test_full_library_hydration_matches_scoped_projection(client, tmp_path: Path, mode: str, entity_type: str) -> None:
    model, recorder = {
        "analysis": (AnalysisResult, record_analysis_revision),
        "chords": (ChordTimeline, record_chord_revision),
        "lyrics": (LyricsTranscript, record_lyrics_revision),
    }[entity_type]
    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        row = model(project_id=project_id, created_at=recorded, updated_at=recorded)
        session.add(row)
        session.flush()
        if isinstance(row, AnalysisResult):
            row.estimated_key = "C major"
            row.key_confidence = 0.8
            row.estimated_reference_hz = 442.0
            row.tuning_offset_cents = 7.0
            row.tempo_bpm = 120.0
            row.timing_json = {"beats": [0.0, 0.5], "enabled": True}
            row.analysis_version = "synthetic"
            row.metadata_json = {"provenance": {"engine": "synthetic", "enabled": True}}
        elif isinstance(row, ChordTimeline):
            row.backend = "synthetic"
            row.source_kind = "edited"
            row.has_user_edits = True
            row.source_segments_json = [{"label": "C", "start_seconds": 0.0}]
            row.segments_json = [{"label": "Am", "start_seconds": 0.0}]
            row.timeline_json = [{"label": "F", "start_seconds": 0.0}]
            row.metadata_json = {"provenance": {"engine": "synthetic", "enabled": True}}
        else:
            row.backend = "synthetic"
            row.source_kind = "edited"
            row.requested_device = "auto"
            row.device = "cpu"
            row.model_name = "synthetic"
            row.language = "en"
            row.language_override = "en"
            row.source_segments_json = [{"text": "source", "start_seconds": 0.0}]
            row.segments_json = [{"text": "edited", "start_seconds": 0.0}]
            row.has_user_edits = True
        revision = recorder(session, row)
        revision_id = revision.id
        materialize_result_revisions(session, project_id)
        expected = _result_projection(session, project_id)
        if mode == "missing":
            session.delete(row)
        elif mode == "inactive":
            revision.state = "superseded"
        elif mode == "aliases":
            revision.state = "current"
            revision.author_device_id = "winner"
            for revision_id_suffix, alias, author in [("loser", project_id, "a"), ("unrelated", "alias", "a")]:
                session.add(SyncEntityRevision(
                    id=revision_id_suffix, project_id=project_id, entity_type=entity_type, entity_id=alias,
                    revision_type="generated", author_device_id=author, state="current",
                    content_sha256=revision.content_sha256, payload_json=revision.payload_json,
                    metadata_json=revision.metadata_json,
                    created_at=revision.created_at, updated_at=revision.updated_at,
                ))
        elif mode == "winner":
            revision.state = "superseded"
            session.add(SyncEntityRevision(
                id="new-winner", project_id=project_id, entity_type=entity_type, entity_id=project_id,
                revision_type="generated", author_device_id="winner", state="active",
                content_sha256=revision.content_sha256, payload_json=revision.payload_json,
                metadata_json=revision.metadata_json, created_at=revision.created_at, updated_at=revision.updated_at,
            ))
        elif mode == "timestamp":
            row.created_at = recorded + timedelta(days=400)
            row.updated_at = recorded + timedelta(days=500)
        elif mode == "field-only":
            if isinstance(row, AnalysisResult):
                row.tempo_bpm = 99.0
            elif isinstance(row, ChordTimeline):
                row.timeline_json = [{"label": "stale"}]
            else:
                row.segments_json = [{"text": "stale"}]
        elif mode == "metadata" and not isinstance(row, LyricsTranscript):
            row.metadata_json = {"provenance": {"engine": "synthetic", "enabled": 1}}
            flag_modified(row, "metadata_json")
        else:
            for column in model.__table__.columns:
                if column.name == "project_id":
                    continue
                value = getattr(row, column.name)
                if column.name == "source_artifact_id":
                    setattr(row, column.name, "stale-source")
                elif isinstance(value, datetime):
                    setattr(row, column.name, recorded + timedelta(days=500))
                elif isinstance(value, bool):
                    setattr(row, column.name, not value)
                elif isinstance(value, (float, int)):
                    setattr(row, column.name, 99.0)
                elif isinstance(value, str):
                    setattr(row, column.name, "stale")
                elif isinstance(value, dict):
                    setattr(row, column.name, {"stale": True})
                elif isinstance(value, list):
                    setattr(row, column.name, [{"stale": True}])
        if mode in {"field-only", "metadata"}:
            row.updated_at = expected[model.__tablename__]["updated_at"]
            flag_modified(row, "updated_at")
        session.commit()
    with SessionLocal() as session:
        if mode in {"field-only", "metadata"}:
            assert _result_projection(session, project_id)[model.__tablename__]["updated_at"] == (
                expected[model.__tablename__]["updated_at"]
            )
        materialize_result_revisions(session)
        bulk = _result_projection(session, project_id)
        bulk_states = dict(session.execute(select(SyncEntityRevision.id, SyncEntityRevision.state)).tuples().all())
        session.rollback()
        if mode != "field-only":
            materialize_result_revisions(session, project_id)
            assert _result_projection(session, project_id) == bulk
            scoped_states = dict(session.execute(
                select(SyncEntityRevision.id, SyncEntityRevision.state)
            ).tuples().all())
            assert scoped_states == bulk_states
        if mode != "inactive":
            assert bulk == expected
        else:
            assert bulk[model.__tablename__] is None
        if mode == "aliases":
            assert bulk_states["unrelated"] == "current"
            assert bulk_states["loser"] == "superseded"
            assert bulk_states[revision_id] == "current"
        session.rollback()
    # Persist the bulk repair, then prove the cold projection includes the repaired JSON types.
    with SessionLocal() as session:
        materialize_result_revisions(session)
        session.commit()
    with SessionLocal() as session:
        assert _result_projection(session, project_id) == bulk


@pytest.mark.parametrize("count", [25, 194])
def test_cold_canonical_library_has_bounded_reads_and_no_writes(client, tmp_path: Path, count: int) -> None:
    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        for index in range(count):
            project_id = f"canonical-{index}"
            session.add(Project(
                id=project_id, display_name=project_id, source_sha256=hashlib.sha256(project_id.encode()).hexdigest(),
                source_path=str(tmp_path / "synthetic.wav"), imported_path=str(tmp_path / "synthetic.wav"),
            ))
            session.flush()
            source_id = f"source-{index}"
            session.add(Artifact(
                id=source_id, project_id=project_id, type="source_audio", format="wav",
                path=str(tmp_path / "synthetic.wav"), size_bytes=0, generated_by="import",
            ))
            session.add_all([
                AnalysisResult(project_id=project_id, source_artifact_id=source_id, created_at=recorded,
                               updated_at=recorded, metadata_json={"synthetic": True}),
                ChordTimeline(project_id=project_id, source_artifact_id=source_id,
                              created_at=recorded, updated_at=recorded),
                LyricsTranscript(project_id=project_id, source_artifact_id=source_id,
                                 created_at=recorded, updated_at=recorded),
            ])
        materialize_result_revisions(session)
        session.commit()
    statements = []

    def observe(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.lstrip().split()[0].upper())

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", observe)
    try:
        with SessionLocal() as session:
            materialize_result_revisions(session)
            session.commit()
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert statements.count("SELECT") <= 12
    assert not set(statements) & {"INSERT", "UPDATE", "DELETE"}


@pytest.mark.parametrize("source_mode", ["valid", "deleted", "unproven", "foreign-deleted"])
@pytest.mark.parametrize("entity_type", ["analysis", "chords", "lyrics"])
def test_bulk_hydration_validates_selected_source_ownership(
    client, tmp_path: Path, source_mode: str, entity_type: str,
) -> None:
    from app.errors import AppError
    from app.models import SyncDeleteTombstone
    from app.services.sync_trust import get_or_create_local_identity

    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        identity = get_or_create_local_identity(session)
        project_id = project.id
        if source_mode in {"valid", "foreign-deleted"}:
            owner = project_id
            if source_mode == "foreign-deleted":
                owner = "foreign"
                session.add(Project(id=owner, display_name=owner, source_sha256="f" * 64,
                                    source_path="synthetic", imported_path="synthetic"))
                session.flush()
            session.add(Artifact(id="source", project_id=owner, type="source_audio", format="wav",
                                 path="synthetic", size_bytes=0, generated_by="import"))
        if source_mode in {"deleted", "foreign-deleted"}:
            session.add(SyncDeleteTombstone(
                id="deleted-source", sync_group_id=identity.sync_group_id, project_id=project_id,
                target_type="artifact", target_id="source", author_device_id=identity.device_id,
                deleted_at=datetime.now(UTC), prior_metadata_json={},
            ))
        payload = {"project_id": project_id, "source_artifact_id": "source"}
        session.add(SyncEntityRevision(
            id="revision", project_id=project_id, entity_type=entity_type, entity_id=project_id,
            revision_type="generated", author_device_id=identity.device_id, state="active",
            source_artifact_id="source", content_sha256=revision_payload_sha256(payload),
            payload_json=payload, metadata_json={},
        ))
        model = {"analysis": AnalysisResult, "chords": ChordTimeline, "lyrics": LyricsTranscript}[entity_type]
        session.add(model(project_id=project_id, source_artifact_id="source"))
        session.commit()
    with SessionLocal() as session:
        if source_mode in {"unproven", "foreign-deleted"}:
            with pytest.raises(AppError, match="must belong"):
                materialize_result_revisions(session)
            session.rollback()
        else:
            materialize_result_revisions(session)
            model = {"analysis": AnalysisResult, "chords": ChordTimeline, "lyrics": LyricsTranscript}[entity_type]
            row = session.get(model, project_id)
            assert row.source_artifact_id == ("source" if source_mode == "valid" else None)


def test_bulk_hydration_invalid_winner_rolls_back_earlier_backfill(client, tmp_path: Path) -> None:
    from app.errors import AppError

    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        session.add(AnalysisResult(project_id=project_id, estimated_key="legacy"))
        session.flush()
        payload = {"project_id": project_id, "segments": "invalid"}
        session.add(SyncEntityRevision(
            id="invalid", project_id=project_id, entity_type="lyrics", entity_id=project_id,
            revision_type="generated", author_device_id="synthetic", state="active",
            content_sha256=revision_payload_sha256(payload), payload_json=payload, metadata_json={},
        ))
        session.commit()
    with SessionLocal() as session:
        with pytest.raises(AppError):
            materialize_result_revisions(session)
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == 2
        session.rollback()
    with SessionLocal() as session:
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == 1
        assert session.get(AnalysisResult, project_id).estimated_key == "legacy"
        assert session.get(LyricsTranscript, project_id) is None


def test_scoped_export_never_builds_full_library_lookup(client, sample_audio_file: Path, monkeypatch) -> None:
    def unexpected_lookup(*_args, **_kwargs):
        raise AssertionError("project export attempted a full-library lookup")

    from .conftest import import_project_without_jobs

    monkeypatch.setattr("app.services.sync_revisions._load_result_revision_lookup", unexpected_lookup)
    monkeypatch.setattr("app.services.sync_revisions._load_startup_result_revisions", unexpected_lookup)
    project_id = import_project_without_jobs(sample_audio_file)["id"]
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        session.add(AnalysisResult(project_id=project.id))
        session.flush()
        record_analysis_revision(session, session.get(AnalysisResult, project.id))
        assert export_project_manifest(session, project.id).project.project_id == project.id


def test_bulk_lookup_chunks_every_query_below_sqlite_binding_limit(client, tmp_path: Path) -> None:
    from app.services.sync_revisions import _load_result_revision_lookup

    projects = [f"chunk-{index}" for index in range(901)]
    with SessionLocal() as session:
        session.add_all(Project(id=project_id, display_name=project_id,
                               source_sha256=hashlib.sha256(project_id.encode()).hexdigest(),
                               source_path="synthetic", imported_path="synthetic") for project_id in projects)
        session.flush()
        session.add_all(Artifact(id=f"source-{index}", project_id=project_id, type="source_audio", format="wav",
                                 path="synthetic", size_bytes=0, generated_by="import")
                        for index, project_id in enumerate(projects))
        session.flush()
        revisions = [SyncEntityRevision(project_id=project_id, entity_type="analysis", state="active",
                                        payload_json={"source_artifact_id": f"source-{index}"})
                     for index, project_id in enumerate(projects)]
        bindings = []

        def observe(_connection, _cursor, statement, parameters, _context, _executemany):
            if statement.lstrip().startswith("SELECT"):
                bindings.append(len(parameters))

        engine = get_engine()
        event.listen(engine, "before_cursor_execute", observe)
        try:
            lookup = _load_result_revision_lookup(session, projects, revisions)
        finally:
            event.remove(engine, "before_cursor_execute", observe)
        assert len(lookup.artifact_owners) == len(projects)
        assert max(bindings) <= 900
        assert len(bindings) == 10


@pytest.mark.parametrize("skip", ["status", "effective-tombstone", "older-tombstone", "inactive", "losing"])
def test_bulk_hydration_only_validates_effective_winners(client, tmp_path: Path, skip: str) -> None:
    from app.models import SyncDeleteTombstone
    from app.services.sync_trust import get_or_create_local_identity

    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        identity = get_or_create_local_identity(session)
        project.updated_at = recorded
        if skip == "status":
            project.sync_status = "deleted"
        if "tombstone" in skip:
            session.add(SyncDeleteTombstone(
                id="project-delete", sync_group_id=identity.sync_group_id, project_id=project_id,
                target_type="project", target_id=project_id, author_device_id=identity.device_id,
                deleted_at=recorded + timedelta(days=-1 if skip == "older-tombstone" else 1),
                prior_metadata_json={},
            ))
        session.add(AnalysisResult(project_id=project_id, estimated_key="projection"))
        payload = {"estimated_key": "winner"} if skip == "older-tombstone" else {"tempo_bpm": "invalid"}
        session.add(SyncEntityRevision(
            id="old", project_id=project_id, entity_type="analysis", entity_id=project_id,
            revision_type="generated", author_device_id="synthetic",
            state="superseded" if skip == "inactive" else "active",
            content_sha256=revision_payload_sha256(payload), payload_json=payload, metadata_json={},
            created_at=recorded, updated_at=recorded,
        ))
        if skip == "losing":
            payload = {"estimated_key": "winner"}
            session.add(SyncEntityRevision(
                id="winner", project_id=project_id, entity_type="analysis", entity_id=project_id,
                revision_type="generated", author_device_id="synthetic", state="active",
                content_sha256=revision_payload_sha256(payload), payload_json=payload, metadata_json={},
                created_at=recorded, updated_at=recorded + timedelta(days=1),
            ))
        session.commit()
    with SessionLocal() as session:
        materialize_result_revisions(session)
        row = session.get(AnalysisResult, project_id)
        if skip == "inactive":
            assert row is None
        else:
            assert row.estimated_key == ("winner" if skip in {"losing", "older-tombstone"} else "projection")


def test_bulk_hydration_flushes_pending_rows_with_autoflush_disabled(client, tmp_path: Path) -> None:
    with SessionLocal(autoflush=False) as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        session.add(AnalysisResult(project_id=project_id, estimated_key="pending"))
        materialize_result_revisions(session)
        assert session.get(AnalysisResult, project_id).estimated_key == "pending"
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == 1


@pytest.mark.parametrize("total", [600, 1200, 2400, 4800])
def test_startup_history_loads_only_winner_payloads_with_bounded_queries(client, tmp_path: Path, total: int) -> None:
    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    project_ids = [f"history-project-{index}" for index in range(194)]
    with SessionLocal() as session:
        session.add_all(Project(
            id=project_id, display_name=project_id, source_sha256=hashlib.sha256(project_id.encode()).hexdigest(),
            source_path="synthetic", imported_path="synthetic",
        ) for project_id in project_ids)
        session.flush()
        for project_id in project_ids:
            session.add_all([
                AnalysisResult(project_id=project_id, created_at=recorded, updated_at=recorded),
                ChordTimeline(project_id=project_id, created_at=recorded, updated_at=recorded),
                LyricsTranscript(project_id=project_id, created_at=recorded, updated_at=recorded),
            ])
        materialize_result_revisions(session)
        winners = set(session.scalars(select(SyncEntityRevision.id)))
        for index in range(total - 582):
            project_id = project_ids[(index // 3) % 194]
            entity_type = ("analysis", "chords", "lyrics")[index % 3]
            payload = {"historical_only": index, "tempo_bpm": "not a selected result"}
            session.add(SyncEntityRevision(
                id=f"history-{index}", project_id=project_id, entity_type=entity_type, entity_id=project_id,
                revision_type="generated", state="superseded", author_device_id="synthetic",
                payload_json=payload, metadata_json={"historical_only": True},
                content_sha256=revision_payload_sha256(payload), created_at=recorded, updated_at=recorded,
            ))
        session.commit()
    statements = []
    full_payload_queries = []
    loaded = []

    def observe_sql(_connection, _cursor, statement, parameters, _context, _executemany):
        statements.append(statement.lstrip().split()[0].upper())
        if "sync_entity_revisions.payload_json" in statement:
            full_payload_queries.append(set(parameters))

    def observe_load(_session, row):
        if isinstance(row, SyncEntityRevision):
            loaded.append((row.id, inspect(row).unloaded.copy()))

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", observe_sql)
    try:
        with SessionLocal() as session:
            event.listen(session, "loaded_as_persistent", observe_load)
            materialize_result_revisions(session)
            session.commit()
    finally:
        event.remove(engine, "before_cursor_execute", observe_sql)
    assert len(loaded) == 582
    assert {identifier for identifier, _unloaded in loaded} == winners
    assert all("payload_json" not in unloaded and "metadata_json" not in unloaded for _id, unloaded in loaded)
    assert full_payload_queries == [winners]
    assert statements.count("SELECT") <= 12
    assert not set(statements) & {"INSERT", "UPDATE", "DELETE"}


@pytest.mark.parametrize("preloaded", ["absent", "loaded", "expired", "rollback"])
def test_startup_loser_state_loading_preserves_unrelated_aliases(client, tmp_path: Path, preloaded: str) -> None:
    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        for identifier, entity_id, state, author, payload in [
            ("winner", project_id, "current", "z", {"estimated_key": "C major"}),
            ("loser", project_id, "active", "a", {"tempo_bpm": "invalid losing payload"}),
            ("alias", "other-entity", "active", "b", {"tempo_bpm": "invalid unrelated payload"}),
            ("inactive", project_id, "superseded", "zz", {"tempo_bpm": "invalid inactive payload"}),
        ]:
            session.add(SyncEntityRevision(
                id=identifier, project_id=project_id, entity_type="analysis", entity_id=entity_id,
                revision_type="generated", state=state, author_device_id=author, payload_json=payload,
                metadata_json={}, content_sha256=revision_payload_sha256(payload),
                created_at=recorded, updated_at=recorded,
            ))
        session.commit()
    with SessionLocal(autoflush=False) as session:
        previous = session.get(SyncEntityRevision, "loser") if preloaded != "absent" else None
        if preloaded == "expired":
            session.expire(previous)
        elif preloaded == "rollback":
            session.rollback()
        loaded = {}
        payload_queries = []

        def observe_sql(_connection, _cursor, statement, parameters, _context, _executemany):
            if "sync_entity_revisions.payload_json" in statement:
                payload_queries.append(set(parameters))

        def observe(_session, row):
            if isinstance(row, SyncEntityRevision):
                loaded[row.id] = inspect(row).unloaded.copy()

        event.listen(session, "loaded_as_persistent", observe)
        engine = get_engine()
        event.listen(engine, "before_cursor_execute", observe_sql)
        try:
            materialize_result_revisions(session)
        finally:
            event.remove(engine, "before_cursor_execute", observe_sql)
            event.remove(session, "loaded_as_persistent", observe)
        assert payload_queries == [{"winner"}]
        assert set(loaded) == ({"winner", "loser"} if preloaded == "absent" else {"winner"})
        if preloaded == "absent":
            assert {"payload_json", "metadata_json"} <= loaded["loser"]
        else:
            assert previous.state == "superseded"
            assert previous.payload_json == {"tempo_bpm": "invalid losing payload"}
        assert session.get(AnalysisResult, project_id).estimated_key == "C major"
        assert session.get(SyncEntityRevision, "loser").state == "superseded"
        assert session.get(SyncEntityRevision, "alias").state == "active"
        assert session.get(SyncEntityRevision, "inactive").state == "superseded"


def test_startup_headers_include_pending_new_and_changed_revisions(client, tmp_path: Path) -> None:
    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        analysis = AnalysisResult(project_id=project_id, estimated_key="old", created_at=recorded, updated_at=recorded)
        session.add(analysis)
        session.flush()
        original_id = record_analysis_revision(session, analysis).id
        session.commit()
    with SessionLocal(autoflush=False) as session:
        previous = session.get(SyncEntityRevision, original_id)
        previous.state = "superseded"
        payload = {"estimated_key": "pending winner"}
        session.add(SyncEntityRevision(
            id="pending-winner", project_id=project_id, entity_type="analysis", entity_id=project_id,
            revision_type="generated", state="current", author_device_id="synthetic", payload_json=payload,
            metadata_json={}, content_sha256=revision_payload_sha256(payload),
            created_at=recorded, updated_at=recorded + timedelta(days=1),
        ))
        materialize_result_revisions(session)
        assert session.get(AnalysisResult, project_id).estimated_key == "pending winner"
        assert previous.state == "superseded"


def test_startup_rollback_restores_losers_and_repairs_after_legacy_flush(client, tmp_path: Path) -> None:
    from app.errors import AppError

    with SessionLocal() as session:
        project = _create_project(session, tmp_path)
        project_id = project.id
        session.add_all([
            AnalysisResult(project_id=project_id, estimated_key="stale"),
            ChordTimeline(project_id=project_id),
        ])
        for identifier, entity_type, author, payload in [
            ("winner", "analysis", "z", {"estimated_key": "canonical"}),
            ("loser", "analysis", "a", {"estimated_key": "old"}),
            ("invalid", "lyrics", "z", {"segments": "invalid"}),
        ]:
            session.add(SyncEntityRevision(
                id=identifier, project_id=project_id, entity_type=entity_type, entity_id=project_id,
                revision_type="generated", state="active", author_device_id=author, payload_json=payload,
                metadata_json={}, content_sha256=revision_payload_sha256(payload),
                created_at=datetime(2025, 1, 1, tzinfo=UTC), updated_at=datetime(2025, 1, 1, tzinfo=UTC),
            ))
        session.commit()
    with SessionLocal() as session:
        with pytest.raises(AppError):
            materialize_result_revisions(session)
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == 4
        session.rollback()
    with SessionLocal() as session:
        assert session.get(AnalysisResult, project_id).estimated_key == "stale"
        assert session.get(SyncEntityRevision, "loser").state == "active"
        assert session.scalar(select(func.count()).select_from(SyncEntityRevision)) == 3
        assert session.get(LyricsTranscript, project_id) is None


def test_startup_header_winner_and_loser_queries_obey_binding_limit(client) -> None:
    from app.services.sync_revisions import _load_startup_result_revisions

    project_ids = [f"selection-chunk-{index}" for index in range(901)]
    recorded = datetime(2025, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        session.add_all(Project(id=pid, display_name=pid, source_sha256=hashlib.sha256(pid.encode()).hexdigest(),
                               source_path="synthetic", imported_path="synthetic") for pid in project_ids)
        session.flush()
        for index, pid in enumerate(project_ids):
            for suffix, author in [("winner", "z"), ("loser", "a")]:
                payload = {"estimated_key": "synthetic"}
                session.add(SyncEntityRevision(
                    id=f"{suffix}-{index}", project_id=pid, entity_type="analysis", entity_id=pid,
                    revision_type="generated", state="active", author_device_id=author,
                    payload_json=payload, metadata_json={}, content_sha256=revision_payload_sha256(payload),
                    created_at=recorded, updated_at=recorded,
                ))
        session.commit()
    bindings = []

    def observe(_connection, _cursor, statement, parameters, _context, _executemany):
        if statement.lstrip().startswith("SELECT"):
            bindings.append(len(parameters))

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", observe)
    try:
        with SessionLocal() as session:
            selected, losers = _load_startup_result_revisions(session, project_ids)
            assert len(selected) == len(losers) == 901
            assert all(rows[0].id.startswith("winner-") for rows in selected.values())
            assert all(rows[0].state == "active" for rows in losers.values())
            assert all({"payload_json", "metadata_json"} <= inspect(rows[0]).unloaded for rows in losers.values())
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert len(bindings) == 6
    assert max(bindings) <= 900
