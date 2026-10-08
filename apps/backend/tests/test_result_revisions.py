from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.db import SessionLocal
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


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("entity_type", ["analysis", "chords", "lyrics"])
def test_result_hydration_uses_utc_author_id_lww_independent_of_order(
    client, tmp_path: Path, reverse: bool, entity_type: str,
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
