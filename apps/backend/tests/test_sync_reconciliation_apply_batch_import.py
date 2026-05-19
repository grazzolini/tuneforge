from __future__ import annotations

import io
import json
import shutil
import wave
from dataclasses import asdict, dataclass, is_dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    AnalysisResult,
    Artifact,
    ChordTimeline,
    Project,
    SyncDeleteTombstone,
    SyncEntityRevision,
    SyncStagedArtifact,
    SyncTrustedPeer,
)
from app.services.paths import project_root
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_manifest import export_project_manifest, import_staged_project_manifest
from app.services.sync_revisions import CURRENT_REVISION_STATE, revision_payload_sha256, sanitize_revision_payload
from app.services.sync_staging import stage_sync_artifact
from app.services.sync_trust import get_or_create_local_identity
from app.utils.hashing import file_sha256


@dataclass(frozen=True)
class Issue119ProjectFixture:
    project_id: str
    root: Path
    source_relative_path: str
    stem_relative_path: str
    source_artifact_id: str
    stem_artifact_id: str
    artifact_hashes: dict[str, str]
    artifact_sizes: dict[str, int]
    artifact_bytes: dict[str, bytes]


def test_issue119_apply_imports_fresh_multi_project_receiver(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue119-a")

    with SessionLocal() as session:
        fixtures = [
            _create_project_with_artifacts(session, tmp_path, slug="alpha", source_frames=64),
            _create_project_with_artifacts(session, tmp_path, slug="beta", source_frames=96),
        ]
        manifests = [
            _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
            for fixture in fixtures
        ]
        all_hashes = _manifest_content_hashes(manifests)
        for manifest, fixture in zip(manifests, fixtures, strict=True):
            _stage_manifest_content(
                session,
                manifest,
                tmp_path=tmp_path,
                artifact_bytes=fixture.artifact_bytes,
                provider_device_id="peer-issue119-a",
            )
            _delete_live_project(session, fixture)
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": manifests,
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-a",
                    "available_content_sha256": all_hashes,
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    summary = payload["summary"]
    assert summary["failed_actions"] == 0
    assert summary["skipped_actions"] == 0
    assert summary["applied_actions"] >= len(fixtures)
    assert summary["satisfied_actions"] >= len(all_hashes)

    with SessionLocal() as session:
        assert session.scalar(select(func.count()).select_from(SyncStagedArtifact)) == 0
        staging_root = get_settings().data_root / "sync" / "staging"
        for content_hash in all_hashes:
            assert not (staging_root / "sha256" / content_hash[:2] / content_hash).exists()

        for fixture in fixtures:
            project = session.get(Project, fixture.project_id)
            assert project is not None
            assert project.sync_status == "local"
            assert project.sync_status_reason is None
            assert project.sync_required_artifact_ids == []
            assert project.sync_provider_device_ids == []
            assert project.sync_conflict_count == 0

            imported_artifacts = {
                artifact.id: artifact
                for artifact in session.scalars(
                    select(Artifact).where(Artifact.project_id == fixture.project_id)
                )
            }
            assert set(imported_artifacts) == {
                fixture.source_artifact_id,
                fixture.stem_artifact_id,
            }
            expected_paths = {
                fixture.source_artifact_id: fixture.source_relative_path,
                fixture.stem_artifact_id: fixture.stem_relative_path,
            }
            for artifact_id, relative_path in expected_paths.items():
                artifact = imported_artifacts[artifact_id]
                copied_path = project_root(fixture.project_id) / relative_path
                assert Path(artifact.path) == copied_path
                assert copied_path.exists()
                assert file_sha256(copied_path) == fixture.artifact_hashes[artifact_id]
                assert artifact.content_sha256 == fixture.artifact_hashes[artifact_id]
                assert artifact.size_bytes == fixture.artifact_sizes[artifact_id]


def test_issue119_apply_hydrates_analysis_from_synced_analysis_artifact(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue119-analysis")

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="analysis", source_frames=72)
        _add_analysis_artifact(session, fixture)
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue119-analysis",
        )
        _delete_live_project(session, fixture)
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-analysis",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["summary"]["failed_actions"] == 0

    with SessionLocal() as session:
        analysis = session.get(AnalysisResult, fixture.project_id)
        assert analysis is not None
        assert analysis.source_artifact_id == fixture.source_artifact_id
        assert analysis.estimated_key == "F major"
        assert analysis.key_confidence == 0.82
        assert analysis.estimated_reference_hz == 441.25
        assert analysis.tuning_offset_cents == 4.91
        assert analysis.tempo_bpm == 118.5
        assert analysis.timing_json == {
            "beats_per_bar": 4,
            "source": "detected",
            "beats": [{"time_seconds": 0.0, "beat_in_bar": 1}],
            "bars": [{"index": 1, "start_seconds": 0.0, "end_seconds": 2.0}],
        }
        assert analysis.analysis_version == "v3"
        session.delete(analysis)
        session.commit()

    repair_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-analysis",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert repair_response.status_code == 200
    assert repair_response.json()["summary"]["failed_actions"] == 0

    with SessionLocal() as session:
        repaired_analysis = session.get(AnalysisResult, fixture.project_id)
        assert repaired_analysis is not None
        assert repaired_analysis.tempo_bpm == 118.5
        assert repaired_analysis.estimated_key == "F major"


def test_issue119_apply_reports_analysis_repair_failure_without_rolling_back_import(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue119-analysis-failure")

    with SessionLocal() as session:
        fresh_fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="fresh-analysis",
            source_frames=74,
        )
        imported_fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="bad-analysis",
            source_frames=76,
        )
        _add_analysis_artifact(session, imported_fixture)
        fresh_manifest = _jsonable_manifest(
            export_project_manifest(session, project_id=fresh_fixture.project_id)
        )
        imported_manifest = _jsonable_manifest(
            export_project_manifest(session, project_id=imported_fixture.project_id)
        )
        _stage_manifest_content(
            session,
            fresh_manifest,
            tmp_path=tmp_path,
            artifact_bytes=fresh_fixture.artifact_bytes,
            provider_device_id="peer-issue119-analysis-failure",
        )
        _delete_live_project(session, fresh_fixture)
        analysis = session.get(AnalysisResult, imported_fixture.project_id)
        assert analysis is not None
        session.delete(analysis)
        bad_analysis_artifact = session.get(Artifact, "art_issue119_analysis_json")
        assert bad_analysis_artifact is not None
        Path(bad_analysis_artifact.path).write_text("{not json", encoding="utf-8")
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [fresh_manifest, imported_manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-analysis-failure",
                    "available_content_sha256": _manifest_content_hashes([fresh_manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 1
    failed_results = [
        result for result in payload["results"] if result["status"] == "failed"
    ]
    assert len(failed_results) == 1
    assert failed_results[0]["action"]["project_id"] == imported_fixture.project_id
    assert failed_results[0]["reason"] == "Analysis artifact payload must be readable JSON."

    with SessionLocal() as session:
        fresh_project = session.get(Project, fresh_fixture.project_id)
        assert fresh_project is not None
        assert fresh_project.sync_status == "local"
        assert session.get(AnalysisResult, imported_fixture.project_id) is None


def test_issue119_staging_cleanup_keeps_shared_hash_until_all_references_import(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue119-shared-hash")
    shared_stem_bytes = b"shared issue119 stem bytes"

    with SessionLocal() as session:
        first = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="shared-one",
            source_frames=78,
            stem_bytes=shared_stem_bytes,
        )
        second = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="shared-two",
            source_frames=82,
            stem_bytes=shared_stem_bytes,
        )
        first_manifest = _jsonable_manifest(export_project_manifest(session, project_id=first.project_id))
        second_manifest = _jsonable_manifest(export_project_manifest(session, project_id=second.project_id))
        _stage_manifest_content(
            session,
            first_manifest,
            tmp_path=tmp_path,
            artifact_bytes=first.artifact_bytes,
            provider_device_id="peer-issue119-shared-hash",
        )
        _stage_manifest_content(
            session,
            second_manifest,
            tmp_path=tmp_path,
            artifact_bytes=second.artifact_bytes,
            provider_device_id="peer-issue119-shared-hash",
        )
        _delete_live_project(session, first)
        _delete_live_project(session, second)
        session.commit()

    shared_hash = first.artifact_hashes[first.stem_artifact_id]
    assert shared_hash == second.artifact_hashes[second.stem_artifact_id]

    first_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [first_manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-shared-hash",
                    "available_content_sha256": _manifest_content_hashes([first_manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert first_response.status_code == 200
    assert first_response.json()["summary"]["failed_actions"] == 0
    staging_root = get_settings().data_root / "sync" / "staging"
    with SessionLocal() as session:
        assert session.get(SyncStagedArtifact, first.artifact_hashes[first.source_artifact_id]) is None
        assert session.get(SyncStagedArtifact, shared_hash) is not None
        assert (staging_root / "sha256" / shared_hash[:2] / shared_hash).exists()

    second_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [second_manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-shared-hash",
                    "available_content_sha256": _manifest_content_hashes([second_manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert second_response.status_code == 200
    assert second_response.json()["summary"]["failed_actions"] == 0
    with SessionLocal() as session:
        assert session.scalar(select(func.count()).select_from(SyncStagedArtifact)) == 0
        assert not (staging_root / "sha256" / shared_hash[:2] / shared_hash).exists()


def test_issue119_revision_manifest_hash_matches_sanitized_payload_and_round_trips(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ = client
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="hash", source_frames=80)
        local_path = str(tmp_path / "local-only" / "take.wav")
        dirty_payload = {
            "project_id": fixture.project_id,
            "backend": "tuneforge-fast",
            "source_kind": "user-edited",
            "has_user_edits": True,
            "source_artifact_id": fixture.source_artifact_id,
            "timeline": [
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "label": "C",
                    "source_path": local_path,
                }
            ],
            "segments": [
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "label": "Am",
                    "path": local_path,
                }
            ],
            "metadata": {"reviewed": True, "render_path": local_path},
        }
        dirty_metadata = {"reason": "manual-edit", "local_path": local_path}
        dirty_hash = revision_payload_sha256(dirty_payload)
        session.add(
            SyncEntityRevision(
                id="rev_issue119_hash_chords",
                project_id=fixture.project_id,
                entity_type="chords",
                entity_id=fixture.project_id,
                revision_type="manual",
                base_revision_id=None,
                author_device_id="peer-issue119-source",
                source_artifact_id=fixture.source_artifact_id,
                content_sha256=dirty_hash,
                state=CURRENT_REVISION_STATE,
                metadata_json=dirty_metadata,
                payload_json=dirty_payload,
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        session.commit()

        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        exported_revision = _revision_by_id(manifest, "rev_issue119_hash_chords")
        sanitized_payload = sanitize_revision_payload(dirty_payload)
        sanitized_metadata = sanitize_revision_payload(dirty_metadata)
        assert exported_revision["payload"] == sanitized_payload
        assert exported_revision["metadata"] == sanitized_metadata
        assert exported_revision["content_sha256"] == revision_payload_sha256(sanitized_payload)
        assert exported_revision["content_sha256"] != dirty_hash

        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue119-source",
        )
        _delete_live_project(session, fixture)

        import_staged_project_manifest(
            session,
            manifest=manifest,
            use_content_addressed_staging=True,
        )
        session.commit()

        imported_revision = session.get(SyncEntityRevision, "rev_issue119_hash_chords")
        assert imported_revision is not None
        assert imported_revision.content_sha256 == exported_revision["content_sha256"]
        assert imported_revision.payload_json == sanitized_payload
        assert imported_revision.metadata_json == sanitized_metadata

        chords = session.get(ChordTimeline, fixture.project_id)
        assert chords is not None
        assert chords.has_user_edits is True
        assert chords.source_kind == "user-edited"
        assert chords.segments_json == [
            {"start_seconds": 0.0, "end_seconds": 1.0, "label": "Am"}
        ]


def test_issue119_project_manifest_import_canonicalizes_revision_payload_hash(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue119-hash-mismatch")

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="hash-mismatch",
            source_frames=84,
        )
        session.add(
            SyncEntityRevision(
                id="rev_issue119_hash_mismatch",
                project_id=fixture.project_id,
                entity_type="chords",
                entity_id=fixture.project_id,
                revision_type="analysis",
                base_revision_id=None,
                author_device_id="peer-issue119-hash-mismatch",
                source_artifact_id=fixture.source_artifact_id,
                content_sha256=revision_payload_sha256({"timeline": [{"label": "C"}]}),
                state=CURRENT_REVISION_STATE,
                metadata_json={},
                payload_json={"timeline": [{"label": "C"}]},
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        session.commit()

        manifest = _jsonable_manifest(
            export_project_manifest(session, project_id=fixture.project_id)
        )
        exported_revision = _revision_by_id(manifest, "rev_issue119_hash_mismatch")
        canonical_hash = revision_payload_sha256(
            sanitize_revision_payload(exported_revision["payload"])
        )
        assert exported_revision["content_sha256"] == canonical_hash
        exported_revision["content_sha256"] = "0" * 64

        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue119-hash-mismatch",
        )
        _delete_live_project(session, fixture)
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-hash-mismatch",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert payload["plan"]["summary"]["total_conflicts"] == 0

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert project.sync_status_reason is None
        imported_revision = session.get(SyncEntityRevision, "rev_issue119_hash_mismatch")
        assert imported_revision is not None
        assert imported_revision.content_sha256 == canonical_hash
        assert imported_revision.content_sha256 != "0" * 64


def test_issue119_reconnect_stale_manifest_does_not_resurrect_tombstoned_targets(
    client: TestClient,
    tmp_path: Path,
) -> None:
    identity = _ensure_identity_and_peers("peer-issue119-reconnect")

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="reconnect", source_frames=88)
        deleted_path = fixture.root / "previews" / "deleted-mix.wav"
        deleted_hash, deleted_size = _write_bytes(deleted_path, b"deleted mix")
        session.add(
            Artifact(
                id="art_issue119_deleted_mix",
                project_id=fixture.project_id,
                type="preview_mix",
                format="wav",
                path=str(deleted_path),
                content_sha256=deleted_hash,
                size_bytes=deleted_size,
                generated_by="preview",
                can_delete=True,
                can_regenerate=True,
                metadata_json={"source_artifact_id": fixture.source_artifact_id},
            )
        )
        session.add(
            SyncEntityRevision(
                id="rev_issue119_deleted_chords",
                project_id=fixture.project_id,
                entity_type="chords",
                entity_id=fixture.project_id,
                revision_type="manual",
                base_revision_id=None,
                author_device_id="peer-issue119-reconnect",
                source_artifact_id=None,
                content_sha256=revision_payload_sha256({"timeline": []}),
                state=CURRENT_REVISION_STATE,
                metadata_json={},
                payload_json={"timeline": []},
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        session.commit()
        stale_manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))

        session.delete(session.get(Artifact, "art_issue119_deleted_mix"))
        session.delete(session.get(SyncEntityRevision, "rev_issue119_deleted_chords"))
        deleted_path.unlink()
        now = datetime(2026, 1, 2, tzinfo=UTC)
        session.add_all(
            [
                SyncDeleteTombstone(
                    id="tomb_issue119_deleted_mix",
                    sync_group_id=identity["sync_group_id"],
                    project_id=fixture.project_id,
                    target_type="artifact",
                    target_id="art_issue119_deleted_mix",
                    author_device_id=identity["device_id"],
                    deleted_at=now,
                    prior_metadata_json={"type": "preview_mix"},
                    created_at=now,
                    updated_at=now,
                ),
                SyncDeleteTombstone(
                    id="tomb_issue119_deleted_chords",
                    sync_group_id=identity["sync_group_id"],
                    project_id=fixture.project_id,
                    target_type="entity_revision",
                    target_id="rev_issue119_deleted_chords",
                    author_device_id=identity["device_id"],
                    deleted_at=now,
                    prior_metadata_json={"entity_type": "chords"},
                    created_at=now,
                    updated_at=now,
                ),
            ]
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [stale_manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-reconnect",
                    "available_content_sha256": _manifest_content_hashes([stale_manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    plan_items = response.json()["plan"]["items"]
    assert _plan_item(plan_items, "artifact", "art_issue119_deleted_mix")["status"] == "deleted"
    assert (
        _plan_item(plan_items, "entity_revision", "rev_issue119_deleted_chords")["status"]
        == "deleted"
    )

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert session.get(Artifact, "art_issue119_deleted_mix") is None
        assert session.get(SyncEntityRevision, "rev_issue119_deleted_chords") is None
        assert not deleted_path.exists()
        assert session.get(SyncDeleteTombstone, "tomb_issue119_deleted_mix") is not None
        assert session.get(SyncDeleteTombstone, "tomb_issue119_deleted_chords") is not None


def test_issue119_duplicate_source_from_second_peer_is_noop_and_remains_editable(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue119-first", "peer-issue119-second")

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="duplicate", source_frames=104)
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue119-first",
        )
        _delete_live_project(session, fixture)
        session.commit()

    first_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-first",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )
    assert first_response.status_code == 200
    assert first_response.json()["summary"]["failed_actions"] == 0

    second_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-second",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )
    assert second_response.status_code == 200
    assert second_response.json()["summary"]["failed_actions"] == 0
    assert second_response.json()["summary"]["applied_actions"] == 0
    assert second_response.json()["plan"]["summary"]["total_conflicts"] == 0

    with SessionLocal() as session:
        project_count = session.scalar(
            select(func.count())
            .select_from(Project)
            .where(Project.source_sha256 == manifest["project"]["source_sha256"])
        )
        assert project_count == 1
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"

    patch_response = client.patch(
        f"/api/v1/projects/{fixture.project_id}",
        json={"display_name": "Duplicate Source Editable"},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["project"]["display_name"] == "Duplicate Source Editable"


def test_issue119_remote_placeholder_stays_locked_until_cross_peer_bytes_import(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue119-lock-a", "peer-issue119-lock-b")

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="lock", source_frames=112)
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        _delete_live_project(session, fixture)
        session.commit()

    first_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-lock-a",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )
    assert first_response.status_code == 200
    assert first_response.json()["summary"]["failed_actions"] == 0
    assert first_response.json()["summary"]["applied_actions"] > 0

    locked_response = client.patch(
        f"/api/v1/projects/{fixture.project_id}",
        json={"display_name": "Should Stay Locked"},
    )
    assert locked_response.status_code == 409
    assert locked_response.json()["error"]["code"] == "PROJECT_SYNC_LOCKED"
    assert locked_response.json()["error"]["details"]["sync_status"] == "remote_available"
    assert locked_response.json()["error"]["details"]["sync_provider_device_ids"] == [
        "peer-issue119-lock-a"
    ]

    with SessionLocal() as session:
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue119-lock-b",
        )
        session.commit()

    second_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue119-lock-b",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )
    assert second_response.status_code == 200
    assert second_response.json()["summary"]["failed_actions"] == 0
    assert second_response.json()["summary"]["applied_actions"] > 0

    unlocked_response = client.patch(
        f"/api/v1/projects/{fixture.project_id}",
        json={"display_name": "Unlocked After Import"},
    )
    assert unlocked_response.status_code == 200
    assert unlocked_response.json()["project"]["display_name"] == "Unlocked After Import"

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert project.sync_provider_device_ids == []
        assert project.sync_required_artifact_ids == []


def _ensure_identity_and_peers(*peer_device_ids: str) -> dict[str, str]:
    now = datetime.now(UTC)
    with SessionLocal() as session:
        identity = get_or_create_local_identity(session)
        for peer_device_id in peer_device_ids:
            if session.get(SyncTrustedPeer, peer_device_id) is not None:
                continue
            session.add(
                SyncTrustedPeer(
                    device_id=peer_device_id,
                    sync_group_id=identity.sync_group_id,
                    display_name=peer_device_id,
                    public_key=f"pub-{peer_device_id}",
                    endpoint_hints_json=[],
                    trusted_at=now,
                    revoked_at=None,
                    created_at=now,
                    updated_at=now,
                )
            )
        session.commit()
        return {"device_id": identity.device_id, "sync_group_id": identity.sync_group_id}


def _create_project_with_artifacts(
    session: Session,
    tmp_path: Path,
    *,
    slug: str,
    source_frames: int,
    stem_bytes: bytes | None = None,
) -> Issue119ProjectFixture:
    source_bytes = _wav_bytes(frame_count=source_frames)
    stem_bytes = stem_bytes if stem_bytes is not None else f"issue119 stem {slug}".encode()
    external_source_path = tmp_path / "library" / f"{slug}.wav"
    source_sha256, _ = _write_bytes(external_source_path, source_bytes)
    project_id = source_hash_to_project_id(source_sha256)
    root = project_root(project_id)
    source_relative_path = f"source/{slug}.wav"
    stem_relative_path = f"stems/{slug}-vocals.wav"
    source_path = root / source_relative_path
    stem_path = root / stem_relative_path
    source_hash, source_size = _write_bytes(source_path, source_bytes)
    stem_hash, stem_size = _write_bytes(stem_path, stem_bytes)
    source_artifact_id = f"art_issue119_{slug}_source"
    stem_artifact_id = f"art_issue119_{slug}_vocals"
    timestamp = datetime(2026, 1, 1, tzinfo=UTC)

    session.add(
        Project(
            id=project_id,
            display_name=f"Issue 119 {slug.title()}",
            source_key_override="1:major",
            source_sha256=source_sha256,
            source_path=str(external_source_path),
            imported_path=str(source_path),
            duration_seconds=1.0,
            sample_rate=44100,
            channels=1,
            created_at=timestamp,
            updated_at=timestamp,
        )
    )
    session.flush()
    session.add_all(
        [
            Artifact(
                id=source_artifact_id,
                project_id=project_id,
                type="source_audio",
                format="wav",
                path=str(source_path),
                content_sha256=source_hash,
                size_bytes=source_size,
                generated_by="import",
                can_delete=False,
                can_regenerate=False,
                metadata_json={"source_label": slug},
                created_at=timestamp,
            ),
            Artifact(
                id=stem_artifact_id,
                project_id=project_id,
                type="vocals",
                format="wav",
                path=str(stem_path),
                content_sha256=stem_hash,
                size_bytes=stem_size,
                generated_by="stems",
                can_delete=True,
                can_regenerate=True,
                cache_key=f"stem:{project_id}:vocals",
                metadata_json={"source_artifact_id": source_artifact_id},
                created_at=timestamp,
            ),
        ]
    )
    session.commit()
    return Issue119ProjectFixture(
        project_id=project_id,
        root=root,
        source_relative_path=source_relative_path,
        stem_relative_path=stem_relative_path,
        source_artifact_id=source_artifact_id,
        stem_artifact_id=stem_artifact_id,
        artifact_hashes={
            source_artifact_id: source_hash,
            stem_artifact_id: stem_hash,
        },
        artifact_sizes={
            source_artifact_id: source_size,
            stem_artifact_id: stem_size,
        },
        artifact_bytes={
            source_artifact_id: source_bytes,
            stem_artifact_id: stem_bytes,
        },
    )


def _add_analysis_artifact(session: Session, fixture: Issue119ProjectFixture) -> None:
    analysis_payload = {
        "project_id": fixture.project_id,
        "source_artifact_id": fixture.source_artifact_id,
        "estimated_key": "F major",
        "key_confidence": 0.82,
        "estimated_reference_hz": 441.25,
        "tuning_offset_cents": 4.91,
        "tempo_bpm": 118.5,
        "timing": {
            "beats_per_bar": 4,
            "source": "detected",
            "beats": [{"time_seconds": 0.0, "beat_in_bar": 1}],
            "bars": [{"index": 1, "start_seconds": 0.0, "end_seconds": 2.0}],
        },
        "analysis_version": "v3",
    }
    contents = json.dumps(
        analysis_payload,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    artifact_id = "art_issue119_analysis_json"
    analysis_path = fixture.root / "analysis" / "analysis.json"
    analysis_hash, analysis_size = _write_bytes(analysis_path, contents)
    session.add(
        AnalysisResult(
            project_id=fixture.project_id,
            source_artifact_id=fixture.source_artifact_id,
            estimated_key="F major",
            key_confidence=0.82,
            estimated_reference_hz=441.25,
            tuning_offset_cents=4.91,
            tempo_bpm=118.5,
            timing_json=analysis_payload["timing"],
            analysis_version="v3",
            created_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    session.add(
        Artifact(
            id=artifact_id,
            project_id=fixture.project_id,
            type="analysis_json",
            format="json",
            path=str(analysis_path),
            content_sha256=analysis_hash,
            size_bytes=analysis_size,
            generated_by="analysis",
            can_delete=True,
            can_regenerate=True,
            metadata_json={
                "analysis_version": "v3",
                "source_artifact_id": fixture.source_artifact_id,
            },
            created_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    session.commit()
    fixture.artifact_hashes[artifact_id] = analysis_hash
    fixture.artifact_sizes[artifact_id] = analysis_size
    fixture.artifact_bytes[artifact_id] = contents


def _jsonable_manifest(value: Any) -> dict[str, Any]:
    manifest = _to_plain(value)
    assert isinstance(manifest, dict)
    if "project_manifest" in manifest:
        manifest = manifest["project_manifest"]
        assert isinstance(manifest, dict)
    return manifest


def _to_plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _to_plain(value.model_dump(mode="json"))
    if is_dataclass(value):
        return _to_plain(asdict(value))
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _to_plain(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(child) for child in value]
    return value


def _stage_manifest_content(
    session: Session,
    manifest: dict[str, Any],
    *,
    tmp_path: Path,
    artifact_bytes: dict[str, bytes],
    provider_device_id: str,
) -> None:
    for artifact in manifest["artifacts"]:
        artifact_id = artifact["artifact_id"]
        source_path = tmp_path / "issue119-stage" / provider_device_id / artifact_id
        content = artifact_bytes[artifact_id]
        _write_bytes(source_path, content)
        stage_sync_artifact(
            session,
            source_path=source_path,
            content_sha256=artifact["content_sha256"],
            size_bytes=artifact["size_bytes"],
            provider_device_id=provider_device_id,
            metadata={"artifact_id": artifact_id, "project_id": artifact["project_id"]},
        )


def _delete_live_project(session: Session, fixture: Issue119ProjectFixture) -> None:
    for revision in session.scalars(
        select(SyncEntityRevision).where(SyncEntityRevision.project_id == fixture.project_id)
    ):
        session.delete(revision)
    for artifact in session.scalars(select(Artifact).where(Artifact.project_id == fixture.project_id)):
        session.delete(artifact)
    project = session.get(Project, fixture.project_id)
    if project is not None:
        session.delete(project)
    session.flush()
    shutil.rmtree(fixture.root, ignore_errors=True)


def _manifest_content_hashes(manifests: list[dict[str, Any]]) -> list[str]:
    return sorted(
        {
            artifact["content_sha256"]
            for manifest in manifests
            for artifact in manifest["artifacts"]
        }
    )


def _empty_remote_library() -> dict[str, list[Any]]:
    return {
        "projects": [],
        "artifacts": [],
        "entity_revisions": [],
        "delete_tombstones": [],
    }


def _revision_by_id(manifest: dict[str, Any], revision_id: str) -> dict[str, Any]:
    for revision in manifest["entity_revisions"]:
        if revision["revision_id"] == revision_id:
            return revision
    raise AssertionError(f"Missing revision in manifest: {revision_id}")


def _plan_item(items: list[dict[str, Any]], item_type: str, item_id: str) -> dict[str, Any]:
    for item in items:
        if item["item_type"] == item_type and item["item_id"] == item_id:
            return item
    raise AssertionError(f"Missing plan item: {item_type}:{item_id}")


def _write_bytes(path: Path, contents: bytes) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    content_hash = file_sha256(path)
    assert content_hash is not None
    return content_hash, path.stat().st_size


def _wav_bytes(*, frame_count: int, sample_rate: int = 44100) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\0\0" * frame_count)
    return buffer.getvalue()
