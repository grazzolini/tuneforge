from __future__ import annotations

import io
import json
import shutil
import wave
from dataclasses import asdict, dataclass, is_dataclass
from datetime import UTC, datetime, timedelta
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
from app.services import sync_reconciliation_apply as sync_reconciliation_apply_service
from app.services.paths import project_root
from app.services.projects import delete_project
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_manifest import export_project_manifest, import_staged_project_manifest
from app.services.sync_revisions import (
    CURRENT_REVISION_STATE,
    SUPERSEDED_REVISION_STATE,
    revision_payload_sha256,
    sanitize_revision_payload,
)
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


def test_issue200_repeated_apply_retry_reuses_staged_content_without_duplicate_rows(
    client: TestClient,
    tmp_path: Path,
) -> None:
    peer_id = "peer-issue200-resume"
    _ensure_identity_and_peers(peer_id)

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue200-resume",
            source_frames=88,
        )
        revision_payload = {
            "project_id": fixture.project_id,
            "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
        }
        session.add(
            SyncEntityRevision(
                id="rev_issue200_resume_chords",
                project_id=fixture.project_id,
                entity_type="chords",
                entity_id=fixture.project_id,
                revision_type="manual",
                base_revision_id=None,
                author_device_id=peer_id,
                source_artifact_id=fixture.source_artifact_id,
                content_sha256=revision_payload_sha256(revision_payload),
                state=CURRENT_REVISION_STATE,
                metadata_json={},
                payload_json=revision_payload,
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        session.commit()
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        content_hashes = _manifest_content_hashes([manifest])
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id=peer_id,
        )
        _delete_live_project(session, fixture)
        session.commit()

    request_payload = {
        "remote_library": {
            "projects": [manifest["project"]],
            "artifacts": manifest["artifacts"],
            "entity_revisions": manifest["entity_revisions"],
            "delete_tombstones": manifest["delete_tombstones"],
        },
        "project_manifests": [manifest],
        "peer_inventory": [
            {
                "device_id": peer_id,
                "available_content_sha256": content_hashes,
            }
        ],
        "use_content_addressed_staging": True,
        "include_timing_evidence": True,
    }

    first_response = client.post("/api/v1/sync/reconciliation/apply", json=request_payload)

    assert first_response.status_code == 200
    first_payload = first_response.json()
    assert first_payload["summary"]["failed_actions"] == 0
    assert any(
        result["action"]["action_type"] == "fetch_artifact_content"
        and result["status"] == "satisfied"
        and result["reason"] == "Required artifact content is staged and verified locally."
        for result in first_payload["results"]
    )
    assert any(
        result["action"]["action_type"] == "import_project_manifest"
        and result["action"]["project_id"] == fixture.project_id
        and result["status"] == "applied"
        for result in first_payload["results"]
    )
    _assert_issue200_resume_counts(fixture.project_id, manifest, staged_count=0)

    with SessionLocal() as session:
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id=peer_id,
        )
        session.commit()
        assert session.scalar(select(func.count()).select_from(SyncStagedArtifact)) == len(content_hashes)

    second_response = client.post("/api/v1/sync/reconciliation/apply", json=request_payload)

    assert second_response.status_code == 200
    second_payload = second_response.json()
    assert second_payload["summary"]["failed_actions"] == 0
    assert any(
        result["status"] == "satisfied"
        for result in second_payload["results"]
    ) or second_payload["summary"]["planned_actions"] == 0
    assert second_payload["timing_evidence"][-1]["details"]["failed_actions"] == 0
    _assert_issue200_resume_counts(fixture.project_id, manifest, staged_count=0)


def test_issue202_apply_clears_stale_remote_available_when_manifest_artifacts_are_local(
    client: TestClient,
    tmp_path: Path,
) -> None:
    peer_id = "peer-issue202-stale-local"
    _ensure_identity_and_peers(peer_id)

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue202-stale-local",
            source_frames=104,
        )
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        project = session.get(Project, fixture.project_id)
        assert project is not None
        project.sync_status = "remote_available"
        project.sync_status_reason = "Waiting for manifest artifact content."
        project.sync_required_artifact_ids_json = [
            artifact["artifact_id"]
            for artifact in manifest["artifacts"]
        ]
        project.sync_provider_device_ids_json = [peer_id]
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": peer_id,
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    import_results = [
        result
        for result in payload["results"]
        if result["action"]["action_type"] == "import_project_manifest"
        and result["action"]["project_id"] == fixture.project_id
    ]
    assert len(import_results) == 1
    assert import_results[0]["status"] == "applied"

    with SessionLocal() as session:
        assert session.scalar(select(func.count()).select_from(SyncStagedArtifact)) == 0
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert project.sync_status_reason is None
        assert project.sync_required_artifact_ids == []
        assert project.sync_provider_device_ids == []
        assert project.sync_conflict_count == 0


def test_issue163_project_scoped_apply_ignores_unselected_remote_projects_and_reports_timing(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue163-scoped")

    with SessionLocal() as session:
        selected = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="scoped-selected",
            source_frames=80,
        )
        unselected = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="scoped-unselected",
            source_frames=112,
        )
        selected_manifest = _jsonable_manifest(
            export_project_manifest(session, project_id=selected.project_id)
        )
        unselected_manifest = _jsonable_manifest(
            export_project_manifest(session, project_id=unselected.project_id)
        )
        _stage_manifest_content(
            session,
            selected_manifest,
            tmp_path=tmp_path,
            artifact_bytes=selected.artifact_bytes,
            provider_device_id="peer-issue163-scoped",
        )
        _delete_live_project(session, selected)
        _delete_live_project(session, unselected)
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [
                    selected_manifest["project"],
                    unselected_manifest["project"],
                ],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [selected_manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue163-scoped",
                    "available_content_sha256": _manifest_content_hashes([selected_manifest]),
                }
            ],
            "project_ids": [selected.project_id],
            "use_content_addressed_staging": True,
            "include_timing_evidence": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    summary = payload["summary"]
    assert summary["failed_actions"] == 0
    assert summary["skipped_actions"] == 0
    assert summary["applied_actions"] >= 1

    planned_project_ids = {
        item["project_id"]
        for item in payload["plan"]["items"]
        if item["project_id"] is not None
    }
    result_project_ids = {
        result["action"]["project_id"] or result["action"]["item_id"]
        for result in payload["results"]
    }
    assert selected.project_id in planned_project_ids
    assert selected.project_id in result_project_ids
    assert unselected.project_id not in planned_project_ids
    assert unselected.project_id not in result_project_ids

    timing_evidence = payload["timing_evidence"]
    phases = {entry["phase"] for entry in timing_evidence}
    assert {"plan", "apply", "action", "staging_cleanup"} <= phases
    assert all(entry["duration_ms"] >= 0 for entry in timing_evidence)
    assert sum(1 for entry in timing_evidence if entry["phase"] == "action") == summary["planned_actions"]
    assert any(
        entry["phase"] == "action"
        and entry["action_type"] == "import_project_manifest"
        and entry["project_id"] == selected.project_id
        and entry["status"] == "applied"
        for entry in timing_evidence
    )

    with SessionLocal() as session:
        project = session.get(Project, selected.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert project.sync_status_reason is None
        assert project.sync_required_artifact_ids == []
        assert project.sync_provider_device_ids == []
        assert project.sync_conflict_count == 0
        assert session.get(Project, unselected.project_id) is None


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


def test_issue221_apply_overwrites_approved_remote_newer_generated_analysis(
    client: TestClient,
    tmp_path: Path,
) -> None:
    peer_id = "peer-issue221-analysis-overwrite"
    artifact_id = "art_issue119_analysis_json"
    local_generated_at = datetime(2026, 1, 1, tzinfo=UTC)
    remote_generated_at = datetime(2026, 1, 2, tzinfo=UTC)
    remote_relative_path = "analysis/analysis.json"
    _ensure_identity_and_peers(peer_id)

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="issue221", source_frames=72)
        _add_analysis_artifact(session, fixture)
        local_artifact = session.get(Artifact, artifact_id)
        assert local_artifact is not None
        local_artifact.metadata_json = {
            "analysis_version": "v3",
            "source_artifact_id": fixture.source_artifact_id,
            "analysis_generated_at": local_generated_at.isoformat(),
        }
        local_artifact.created_at = local_generated_at
        local_path = Path(local_artifact.path)
        legacy_path = fixture.root / "analysis" / "legacy-analysis.json"
        shutil.copy2(local_path, legacy_path)
        local_artifact.path = str(legacy_path)
        session.commit()

        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        remote_payload = {
            "project_id": fixture.project_id,
            "source_artifact_id": fixture.source_artifact_id,
            "estimated_key": "G major",
            "key_confidence": 0.91,
            "estimated_reference_hz": 442.0,
            "tuning_offset_cents": -3.5,
            "tempo_bpm": 132.25,
            "timing": {
                "beats_per_bar": 4,
                "source": "remote-detected",
                "beats": [{"time_seconds": 0.0, "beat_in_bar": 1}],
                "bars": [{"index": 1, "start_seconds": 0.0, "end_seconds": 1.75}],
            },
            "analysis_version": "v4",
        }
        remote_bytes = json.dumps(
            remote_payload,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        remote_hash, remote_size = _write_bytes(tmp_path / "issue221" / "remote-analysis.json", remote_bytes)
        remote_artifact = _artifact_by_id(manifest, artifact_id)
        remote_artifact.update(
            {
                "relative_path": remote_relative_path,
                "content_sha256": remote_hash,
                "size_bytes": remote_size,
                "generated_by": "remote-analysis",
                "can_delete": True,
                "can_regenerate": True,
                "cache_key": f"analysis:{fixture.project_id}:remote",
                "metadata": {
                    "analysis_version": "v4",
                    "source_artifact_id": fixture.source_artifact_id,
                    "analysis_generated_at": remote_generated_at.isoformat(),
                },
                "created_at": remote_generated_at.isoformat(),
            }
        )
        fixture.artifact_hashes[artifact_id] = remote_hash
        fixture.artifact_sizes[artifact_id] = remote_size
        fixture.artifact_bytes[artifact_id] = remote_bytes
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id=peer_id,
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": manifest["artifacts"],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": peer_id,
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert payload["plan"]["summary"]["total_conflicts"] == 0
    assert all(
        result["action"]["action_type"] != "record_conflict"
        for result in payload["results"]
    )
    assert any(
        result["action"]["action_type"] == "import_artifact_manifest"
        and result["action"]["item_id"] == artifact_id
        and result["status"] == "applied"
        for result in payload["results"]
    )

    with SessionLocal() as session:
        artifact = session.get(Artifact, artifact_id)
        assert artifact is not None
        expected_path = legacy_path
        assert Path(artifact.path) == expected_path
        assert file_sha256(expected_path) == remote_hash
        assert artifact.content_sha256 == remote_hash
        assert artifact.size_bytes == remote_size
        assert artifact.metadata_json == {
            "analysis_version": "v4",
            "source_artifact_id": fixture.source_artifact_id,
            "analysis_generated_at": remote_generated_at.isoformat(),
        }
        assert artifact.cache_key == f"analysis:{fixture.project_id}:remote"
        assert artifact.generated_by == "remote-analysis"
        assert artifact.can_delete is True
        assert artifact.can_regenerate is True
        assert artifact.created_at.replace(tzinfo=UTC) == remote_generated_at

        analysis = session.get(AnalysisResult, fixture.project_id)
        assert analysis is not None
        assert analysis.source_artifact_id == fixture.source_artifact_id
        assert analysis.estimated_key == "G major"
        assert analysis.key_confidence == 0.91
        assert analysis.estimated_reference_hz == 442.0
        assert analysis.tuning_offset_cents == -3.5
        assert analysis.tempo_bpm == 132.25
        assert analysis.timing_json == remote_payload["timing"]
        assert analysis.analysis_version == "v4"


def test_issue221_generated_analysis_overwrite_rejects_unowned_canonical_destination(
    client: TestClient,
    tmp_path: Path,
) -> None:
    peer_id = "peer-issue221-analysis-unowned"
    artifact_id = "art_issue119_analysis_json"
    local_generated_at = datetime(2026, 1, 1, tzinfo=UTC)
    remote_generated_at = datetime(2026, 1, 2, tzinfo=UTC)
    _ensure_identity_and_peers(peer_id)

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue221-unowned",
            source_frames=73,
        )
        _add_analysis_artifact(session, fixture)
        local_artifact = session.get(Artifact, artifact_id)
        assert local_artifact is not None
        local_artifact.metadata_json = {
            "analysis_version": "v3",
            "source_artifact_id": fixture.source_artifact_id,
            "analysis_generated_at": local_generated_at.isoformat(),
        }
        local_artifact.created_at = local_generated_at
        original_hash = local_artifact.content_sha256
        canonical_path = fixture.root / "analysis" / "analysis.json"
        unsafe_owned_path = fixture.root / "stems" / "local-analysis.json"
        shutil.copy2(canonical_path, unsafe_owned_path)
        local_artifact.path = str(unsafe_owned_path)
        canonical_path.write_bytes(b"unowned local analysis bytes")
        unowned_hash = file_sha256(canonical_path)
        assert unowned_hash is not None
        session.commit()

        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        remote_payload = {
            "project_id": fixture.project_id,
            "source_artifact_id": fixture.source_artifact_id,
            "estimated_key": "G major",
            "key_confidence": 0.91,
            "estimated_reference_hz": 442.0,
            "tuning_offset_cents": -3.5,
            "tempo_bpm": 132.25,
            "timing": {
                "beats_per_bar": 4,
                "source": "remote-detected",
                "beats": [{"time_seconds": 0.0, "beat_in_bar": 1}],
                "bars": [{"index": 1, "start_seconds": 0.0, "end_seconds": 1.75}],
            },
            "analysis_version": "v4",
        }
        remote_bytes = json.dumps(
            remote_payload,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        remote_hash, remote_size = _write_bytes(
            tmp_path / "issue221" / "unowned-remote-analysis.json",
            remote_bytes,
        )
        remote_artifact = _artifact_by_id(manifest, artifact_id)
        remote_artifact.update(
            {
                "relative_path": "analysis/analysis.json",
                "content_sha256": remote_hash,
                "size_bytes": remote_size,
                "generated_by": "remote-analysis",
                "can_delete": True,
                "can_regenerate": True,
                "cache_key": f"analysis:{fixture.project_id}:remote",
                "metadata": {
                    "analysis_version": "v4",
                    "source_artifact_id": fixture.source_artifact_id,
                    "analysis_generated_at": remote_generated_at.isoformat(),
                },
                "created_at": remote_generated_at.isoformat(),
            }
        )
        fixture.artifact_hashes[artifact_id] = remote_hash
        fixture.artifact_sizes[artifact_id] = remote_size
        fixture.artifact_bytes[artifact_id] = remote_bytes
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id=peer_id,
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": manifest["artifacts"],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": peer_id,
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 1
    assert any(
        result["action"]["action_type"] == "import_artifact_manifest"
        and result["action"]["item_id"] == artifact_id
        and result["status"] == "failed"
        and result["reason"] == "Artifact destination already exists locally."
        for result in payload["results"]
    )

    with SessionLocal() as session:
        artifact = session.get(Artifact, artifact_id)
        assert artifact is not None
        assert Path(artifact.path) == unsafe_owned_path
        assert artifact.content_sha256 == original_hash
        assert file_sha256(unsafe_owned_path) == original_hash
        assert file_sha256(canonical_path) == unowned_hash

        analysis = session.get(AnalysisResult, fixture.project_id)
        assert analysis is not None
        assert analysis.estimated_key == "F major"
        assert analysis.analysis_version == "v3"


def test_issue221_generated_analysis_overwrite_copy_mismatch_keeps_local_bytes(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    peer_id = "peer-issue221-analysis-copy-mismatch"
    artifact_id = "art_issue119_analysis_json"
    local_generated_at = datetime(2026, 1, 1, tzinfo=UTC)
    remote_generated_at = datetime(2026, 1, 2, tzinfo=UTC)
    _ensure_identity_and_peers(peer_id)

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue221-copy-mismatch",
            source_frames=77,
        )
        _add_analysis_artifact(session, fixture)
        local_artifact = session.get(Artifact, artifact_id)
        assert local_artifact is not None
        local_metadata = {
            "analysis_version": "v3",
            "source_artifact_id": fixture.source_artifact_id,
            "analysis_generated_at": local_generated_at.isoformat(),
        }
        local_artifact.metadata_json = local_metadata
        local_artifact.created_at = local_generated_at
        local_path = Path(local_artifact.path)
        legacy_path = fixture.root / "analysis" / "legacy-analysis.json"
        shutil.copy2(local_path, legacy_path)
        local_artifact.path = str(legacy_path)
        original_hash = local_artifact.content_sha256
        original_size = local_artifact.size_bytes
        original_bytes = legacy_path.read_bytes()
        session.commit()

        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        remote_payload = {
            "project_id": fixture.project_id,
            "source_artifact_id": fixture.source_artifact_id,
            "estimated_key": "G major",
            "key_confidence": 0.91,
            "estimated_reference_hz": 442.0,
            "tuning_offset_cents": -3.5,
            "tempo_bpm": 132.25,
            "timing": {
                "beats_per_bar": 4,
                "source": "remote-detected",
                "beats": [{"time_seconds": 0.0, "beat_in_bar": 1}],
                "bars": [{"index": 1, "start_seconds": 0.0, "end_seconds": 1.75}],
            },
            "analysis_version": "v4",
        }
        remote_bytes = json.dumps(
            remote_payload,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        remote_hash, remote_size = _write_bytes(
            tmp_path / "issue221" / "copy-mismatch-remote-analysis.json",
            remote_bytes,
        )
        remote_artifact = _artifact_by_id(manifest, artifact_id)
        remote_artifact.update(
            {
                "relative_path": "analysis/analysis.json",
                "content_sha256": remote_hash,
                "size_bytes": remote_size,
                "generated_by": "remote-analysis",
                "can_delete": True,
                "can_regenerate": True,
                "cache_key": f"analysis:{fixture.project_id}:remote",
                "metadata": {
                    "analysis_version": "v4",
                    "source_artifact_id": fixture.source_artifact_id,
                    "analysis_generated_at": remote_generated_at.isoformat(),
                },
                "created_at": remote_generated_at.isoformat(),
            }
        )
        fixture.artifact_hashes[artifact_id] = remote_hash
        fixture.artifact_sizes[artifact_id] = remote_size
        fixture.artifact_bytes[artifact_id] = remote_bytes
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id=peer_id,
        )
        session.commit()

    def copy_corrupt_bytes(src: str | Path, dst: str | Path, *args: Any, **kwargs: Any) -> Path:
        _ = src, args, kwargs
        destination = Path(dst)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"x" * remote_size)
        return destination

    monkeypatch.setattr(sync_reconciliation_apply_service.shutil, "copy2", copy_corrupt_bytes)

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": manifest["artifacts"],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": peer_id,
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 1
    assert any(
        result["action"]["action_type"] == "import_artifact_manifest"
        and result["action"]["item_id"] == artifact_id
        and result["status"] == "failed"
        and result["reason"] == "Copied artifact bytes do not match the manifest."
        for result in payload["results"]
    )

    with SessionLocal() as session:
        artifact = session.get(Artifact, artifact_id)
        assert artifact is not None
        assert Path(artifact.path) == legacy_path
        assert artifact.content_sha256 == original_hash
        assert artifact.size_bytes == original_size
        assert artifact.metadata_json == local_metadata
        assert legacy_path.read_bytes() == original_bytes
        assert file_sha256(legacy_path) == original_hash
        assert not list(legacy_path.parent.glob(f".{legacy_path.name}.*.tmp"))

        analysis = session.get(AnalysisResult, fixture.project_id)
        assert analysis is not None
        assert analysis.estimated_key == "F major"
        assert analysis.analysis_version == "v3"


def test_issue221_apply_adopts_matching_orphan_destination_artifact(
    client: TestClient,
    tmp_path: Path,
) -> None:
    peer_id = "peer-issue221-orphan-destination"
    _ensure_identity_and_peers(peer_id)

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue221-orphan",
            source_frames=72,
        )
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        stem_artifact = session.get(Artifact, fixture.stem_artifact_id)
        assert stem_artifact is not None
        orphan_path = Path(stem_artifact.path)
        assert orphan_path.exists()
        session.delete(stem_artifact)
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id=peer_id,
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": manifest["artifacts"],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": peer_id,
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert any(
        result["action"]["action_type"] == "import_artifact_manifest"
        and result["action"]["item_id"] == fixture.stem_artifact_id
        and result["status"] == "applied"
        for result in payload["results"]
    )

    with SessionLocal() as session:
        artifact = session.get(Artifact, fixture.stem_artifact_id)
        assert artifact is not None
        assert Path(artifact.path) == orphan_path
        assert artifact.content_sha256 == fixture.artifact_hashes[fixture.stem_artifact_id]
        assert artifact.size_bytes == fixture.artifact_sizes[fixture.stem_artifact_id]
        assert file_sha256(orphan_path) == fixture.artifact_hashes[fixture.stem_artifact_id]


def test_issue221_apply_rejects_orphan_destination_symlink_escape(
    client: TestClient,
    tmp_path: Path,
) -> None:
    peer_id = "peer-issue221-orphan-symlink"
    _ensure_identity_and_peers(peer_id)

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue221-symlink",
            source_frames=75,
        )
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        stem_artifact = session.get(Artifact, fixture.stem_artifact_id)
        assert stem_artifact is not None
        session.delete(stem_artifact)
        shutil.rmtree(fixture.root / "stems")
        outside_stem_path = tmp_path / "outside-stems" / Path(fixture.stem_relative_path).name
        _write_bytes(outside_stem_path, fixture.artifact_bytes[fixture.stem_artifact_id])
        (fixture.root / "stems").symlink_to(outside_stem_path.parent, target_is_directory=True)
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id=peer_id,
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": manifest["artifacts"],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": peer_id,
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 1
    assert any(
        result["action"]["action_type"] == "import_artifact_manifest"
        and result["action"]["item_id"] == fixture.stem_artifact_id
        and result["status"] == "failed"
        and result["reason"] == "Artifact destination escapes the project root."
        for result in payload["results"]
    )

    with SessionLocal() as session:
        assert session.get(Artifact, fixture.stem_artifact_id) is None
        assert outside_stem_path.exists()
        assert file_sha256(outside_stem_path) == fixture.artifact_hashes[fixture.stem_artifact_id]


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


def test_issue163_retry_merges_missing_artifacts_with_existing_canonical_revision(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue163-retry")
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="retry", source_frames=72)
        dirty_payload = {
            "project_id": fixture.project_id,
            "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
            "source_path": str(tmp_path / "local-only.wav"),
        }
        session.add(
            SyncEntityRevision(
                id="rev_issue163_retry_chords",
                project_id=fixture.project_id,
                entity_type="chords",
                entity_id=fixture.project_id,
                revision_type="generated",
                base_revision_id=None,
                author_device_id="peer-issue163-retry",
                source_artifact_id=fixture.source_artifact_id,
                content_sha256=revision_payload_sha256(dirty_payload),
                state=CURRENT_REVISION_STATE,
                metadata_json={},
                payload_json=dirty_payload,
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        session.commit()
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        exported_revision = _revision_by_id(manifest, "rev_issue163_retry_chords")
        assert exported_revision["payload"] == sanitize_revision_payload(dirty_payload)
        assert exported_revision["content_sha256"] != revision_payload_sha256(dirty_payload)

        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue163-retry",
        )
        stem = session.get(Artifact, fixture.stem_artifact_id)
        assert stem is not None
        Path(stem.path).unlink()
        session.delete(stem)
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue163-retry",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert payload["summary"]["applied_actions"] >= 1
    assert all(
        result["action"]["action_type"] != "record_conflict"
        for result in payload["results"]
    )
    with SessionLocal() as session:
        assert session.get(Artifact, fixture.stem_artifact_id) is not None
        revision = session.get(SyncEntityRevision, "rev_issue163_retry_chords")
        assert revision is not None
        assert revision.content_sha256 == revision_payload_sha256(dirty_payload)


def test_issue163_retry_rejects_existing_revision_without_canonical_payload(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue163-bad-payload")
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="bad-payload", source_frames=74)
        payload = {
            "project_id": fixture.project_id,
            "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
        }
        content_sha256 = revision_payload_sha256(payload)
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        remote_revision = {
            "revision_id": "rev_issue163_bad_payload_chords",
            "project_id": fixture.project_id,
            "entity_type": "chords",
            "entity_id": fixture.project_id,
            "revision_type": "generated",
            "base_revision_id": None,
            "author_device_id": "peer-issue163-bad-payload",
            "source_artifact_id": fixture.source_artifact_id,
            "content_sha256": content_sha256,
            "state": CURRENT_REVISION_STATE,
            "metadata": {},
            "payload": payload,
            "created_at": datetime(2026, 1, 1, tzinfo=UTC).isoformat(),
            "updated_at": datetime(2026, 1, 1, tzinfo=UTC).isoformat(),
        }
        session.add(
            SyncEntityRevision(
                id="rev_issue163_bad_payload_chords",
                project_id=fixture.project_id,
                entity_type="chords",
                entity_id=fixture.project_id,
                revision_type="generated",
                base_revision_id=None,
                author_device_id="peer-issue163-bad-payload",
                source_artifact_id=fixture.source_artifact_id,
                content_sha256=content_sha256,
                state=CURRENT_REVISION_STATE,
                metadata_json={},
                payload_json=None,
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                **_empty_remote_library(),
                "projects": [manifest["project"]],
                "entity_revisions": [remote_revision],
            },
            "project_manifests": [],
            "peer_inventory": [],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    revision_item = _plan_item(
        payload["plan"]["items"],
        "entity_revision",
        "rev_issue163_bad_payload_chords",
    )
    assert revision_item["status"] == "conflicted"
    assert revision_item["reason"] == "Local and remote entity revisions share an ID but have different content hashes."
    assert revision_item["details"]["remote_content_sha256"] == content_sha256
    assert revision_item["details"]["local_content_sha256"] is None


def test_issue163_existing_project_embedded_revision_drift_is_not_reported_as_conflict(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue163-existing")
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="existing", source_frames=76)
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        local_payload = {"project_id": fixture.project_id, "timeline": [{"label": "C"}]}
        remote_payload = {"project_id": fixture.project_id, "timeline": [{"label": "G"}]}
        session.add(
            SyncEntityRevision(
                id="rev_issue163_existing_drift",
                project_id=fixture.project_id,
                entity_type="chords",
                entity_id=fixture.project_id,
                revision_type="generated",
                base_revision_id=None,
                author_device_id="peer-issue163-existing",
                source_artifact_id=fixture.source_artifact_id,
                content_sha256=revision_payload_sha256(local_payload),
                state=CURRENT_REVISION_STATE,
                metadata_json={},
                payload_json=local_payload,
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        session.commit()
        manifest["entity_revisions"].append(
            {
                "revision_id": "rev_issue163_existing_drift",
                "project_id": fixture.project_id,
                "entity_type": "chords",
                "entity_id": fixture.project_id,
                "revision_type": "generated",
                "base_revision_id": None,
                "author_device_id": "peer-issue163-existing",
                "source_artifact_id": fixture.source_artifact_id,
                "content_sha256": revision_payload_sha256(remote_payload),
                "state": CURRENT_REVISION_STATE,
                "metadata": {},
                "payload": remote_payload,
                "created_at": datetime(2026, 1, 1, tzinfo=UTC).isoformat(),
                "updated_at": datetime(2026, 1, 1, tzinfo=UTC).isoformat(),
            }
        )

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue163-existing",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert payload["plan"]["summary"]["total_conflicts"] == 0
    assert all(
        item["item_type"] != "entity_revision"
        or item["item_id"] != "rev_issue163_existing_drift"
        for item in payload["plan"]["items"]
    )
    assert all(
        result["action"]["action_type"] != "record_conflict"
        for result in payload["results"]
    )


def test_issue163_newer_manifest_reimports_project_after_local_project_tombstone(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue163-reimport")
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path, slug="reimport", source_frames=78)
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        delete_project(session, fixture.project_id)
        tombstone = session.scalar(
            select(SyncDeleteTombstone).where(
                SyncDeleteTombstone.project_id == fixture.project_id,
                SyncDeleteTombstone.target_type == "project",
            )
        )
        assert tombstone is not None
        resurrected_at = tombstone.deleted_at.replace(microsecond=0) + timedelta(seconds=1)
        manifest["project"]["created_at"] = resurrected_at.isoformat()
        manifest["project"]["updated_at"] = resurrected_at.isoformat()
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue163-reimport",
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue163-reimport",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "project_ids": [fixture.project_id],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert payload["summary"]["applied_actions"] >= 1
    project_item = _plan_item(payload["plan"]["items"], "project", fixture.project_id)
    assert project_item["status"] == "remote_available"
    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert session.get(Artifact, fixture.source_artifact_id) is not None
        assert session.get(Artifact, fixture.stem_artifact_id) is not None
        assert (
            session.scalar(
                select(func.count())
                .select_from(SyncDeleteTombstone)
                .where(SyncDeleteTombstone.project_id == fixture.project_id)
            )
            == 0
        )
        exported_manifest = export_project_manifest(session, project_id=fixture.project_id)
        assert exported_manifest.delete_tombstones == []


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
        now = datetime.now(UTC) + timedelta(seconds=1)
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


def test_issue120_three_peer_import_uses_staged_bytes_from_non_advertising_peer(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers(
        "peer-issue120-manifest",
        "peer-issue120-bytes",
        "peer-issue120-offline",
    )

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue120-three-peer",
            source_frames=120,
        )
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        _delete_live_project(session, fixture)
        session.commit()

    peer_inventory = [
        {
            "device_id": "peer-issue120-manifest",
            "available_content_sha256": _manifest_content_hashes([manifest]),
        }
    ]
    first_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": peer_inventory,
            "use_content_addressed_staging": True,
        },
    )

    assert first_response.status_code == 200
    first_payload = first_response.json()
    assert first_payload["summary"]["failed_actions"] == 0
    assert first_payload["summary"]["skipped_actions"] > 0
    project_item = _plan_item(first_payload["plan"]["items"], "project", fixture.project_id)
    assert project_item["status"] == "remote_available"
    assert project_item["chosen_provider_device_id"] == "peer-issue120-manifest"
    assert any(
        result["action"]["action_type"] == "import_project_manifest"
        and result["status"] == "skipped"
        and result["details"]["missing_artifacts"]
        for result in first_payload["results"]
    )

    with SessionLocal() as session:
        placeholder = session.get(Project, fixture.project_id)
        assert placeholder is not None
        assert placeholder.sync_status == "remote_available"
        assert placeholder.sync_provider_device_ids == ["peer-issue120-manifest"]
        assert session.scalar(
            select(func.count())
            .select_from(Artifact)
            .where(Artifact.project_id == fixture.project_id)
        ) == 0

    locked_response = client.patch(
        f"/api/v1/projects/{fixture.project_id}",
        json={"display_name": "Still Waiting For Bytes"},
    )
    assert locked_response.status_code == 409
    assert locked_response.json()["error"]["code"] == "PROJECT_SYNC_LOCKED"

    with SessionLocal() as session:
        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue120-bytes",
        )
        session.commit()

    second_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": peer_inventory,
            "use_content_addressed_staging": True,
        },
    )

    assert second_response.status_code == 200
    second_payload = second_response.json()
    assert second_payload["summary"]["failed_actions"] == 0
    fetch_results = [
        result
        for result in second_payload["results"]
        if result["action"]["action_type"] == "fetch_artifact_content"
    ]
    assert fetch_results
    assert {result["status"] for result in fetch_results} == {"satisfied"}
    assert {
        result["action"]["provider_device_id"] for result in fetch_results
    } == {"peer-issue120-manifest"}
    assert {result["details"]["provider_device_id"] for result in fetch_results} == {
        "peer-issue120-bytes"
    }
    assert any(
        result["action"]["action_type"] == "import_project_manifest"
        and result["status"] == "applied"
        for result in second_payload["results"]
    )

    unlocked_response = client.patch(
        f"/api/v1/projects/{fixture.project_id}",
        json={"display_name": "Editable After Three Peer Import"},
    )
    assert unlocked_response.status_code == 200
    assert unlocked_response.json()["project"]["display_name"] == (
        "Editable After Three Peer Import"
    )

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert project.sync_status_reason is None
        assert project.sync_provider_device_ids == []
        assert project.sync_required_artifact_ids == []
        assert "peer-issue120-offline" not in project.sync_provider_device_ids

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
        for artifact_id, expected_hash in fixture.artifact_hashes.items():
            artifact = imported_artifacts[artifact_id]
            assert artifact.content_sha256 == expected_hash
            assert Path(artifact.path).exists()
            assert file_sha256(Path(artifact.path)) == expected_hash


def test_issue120_stale_inventory_cannot_import_without_verified_staged_size(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers(
        "peer-issue120-stale-inventory",
        "peer-issue120-size-provider",
    )

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue120-stale-inventory",
            source_frames=124,
        )
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        stale_size_manifest = json.loads(json.dumps(manifest))
        stale_source_artifact = _artifact_by_id(stale_size_manifest, fixture.source_artifact_id)
        stale_source_artifact["size_bytes"] += 1
        _delete_live_project(session, fixture)
        session.commit()

    stale_inventory = [
        {
            "device_id": "peer-issue120-stale-inventory",
            "available_content_sha256": _manifest_content_hashes([stale_size_manifest]),
        }
    ]
    missing_bytes_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [stale_size_manifest],
            "peer_inventory": stale_inventory,
            "use_content_addressed_staging": True,
        },
    )

    assert missing_bytes_response.status_code == 200
    missing_bytes_payload = missing_bytes_response.json()
    assert missing_bytes_payload["summary"]["failed_actions"] == 0
    assert any(
        result["action"]["action_type"] == "import_project_manifest"
        and result["status"] == "skipped"
        and {
            artifact["artifact_id"]
            for artifact in result["details"]["missing_artifacts"]
        }
        == {fixture.source_artifact_id, fixture.stem_artifact_id}
        for result in missing_bytes_payload["results"]
    )

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "remote_available"
        assert session.scalar(
            select(func.count())
            .select_from(Artifact)
            .where(Artifact.project_id == fixture.project_id)
        ) == 0

        _stage_manifest_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue120-size-provider",
        )
        session.commit()

    mismatched_size_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [stale_size_manifest],
            "peer_inventory": stale_inventory,
            "use_content_addressed_staging": True,
        },
    )

    assert mismatched_size_response.status_code == 200
    mismatched_size_payload = mismatched_size_response.json()
    assert mismatched_size_payload["summary"]["failed_actions"] == 0
    import_skips = [
        result
        for result in mismatched_size_payload["results"]
        if result["action"]["action_type"] == "import_project_manifest"
        and result["status"] == "skipped"
    ]
    assert len(import_skips) == 1
    assert import_skips[0]["details"]["missing_artifacts"] == [
        {
            "artifact_id": fixture.source_artifact_id,
            "content_sha256": fixture.artifact_hashes[fixture.source_artifact_id],
            "error_code": "SYNC_STAGING_RECORD_SIZE_MISMATCH",
        }
    ]

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "remote_available"
        assert session.scalar(
            select(func.count())
            .select_from(Artifact)
            .where(Artifact.project_id == fixture.project_id)
        ) == 0

    correct_manifest_response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": stale_inventory,
            "use_content_addressed_staging": True,
        },
    )

    assert correct_manifest_response.status_code == 200
    assert correct_manifest_response.json()["summary"]["failed_actions"] == 0

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert project.sync_required_artifact_ids == []
        assert project.sync_provider_device_ids == []
        assert {
            artifact.id
            for artifact in session.scalars(
                select(Artifact).where(Artifact.project_id == fixture.project_id)
            )
        } == {fixture.source_artifact_id, fixture.stem_artifact_id}


def test_issue120_existing_project_imports_late_manifest_artifacts(
    client: TestClient,
    tmp_path: Path,
) -> None:
    _ensure_identity_and_peers("peer-issue120-late-artifact")

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue120-late-artifact",
            source_frames=128,
        )
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        late_artifact_path = project_root(fixture.project_id) / fixture.stem_relative_path
        late_artifact = session.get(Artifact, fixture.stem_artifact_id)
        assert late_artifact is not None
        session.delete(late_artifact)
        late_artifact_path.unlink()
        _stage_manifest_artifact_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue120-late-artifact",
            artifact_id=fixture.stem_artifact_id,
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue120-late-artifact",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert any(
        result["action"]["action_type"] == "import_artifact_manifest"
        and result["action"]["project_id"] == fixture.project_id
        and result["action"]["item_id"] == fixture.stem_artifact_id
        and result["status"] == "applied"
        for result in payload["results"]
    )

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        restored_artifact = session.get(Artifact, fixture.stem_artifact_id)
        assert restored_artifact is not None
        assert Path(restored_artifact.path).exists()
        assert restored_artifact.project_id == fixture.project_id
        assert restored_artifact.type == "vocals"
        assert restored_artifact.metadata_json == {"source_artifact_id": fixture.source_artifact_id}
        assert restored_artifact.content_sha256 == fixture.artifact_hashes[fixture.stem_artifact_id]


def test_issue120_late_manifest_copy_mismatch_does_not_persist_artifact(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    _ensure_identity_and_peers("peer-issue120-copy-mismatch")

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue120-copy-mismatch",
            source_frames=130,
        )
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        late_artifact_path = project_root(fixture.project_id) / fixture.stem_relative_path
        late_artifact = session.get(Artifact, fixture.stem_artifact_id)
        assert late_artifact is not None
        session.delete(late_artifact)
        late_artifact_path.unlink()
        _stage_manifest_artifact_content(
            session,
            manifest,
            tmp_path=tmp_path,
            artifact_bytes=fixture.artifact_bytes,
            provider_device_id="peer-issue120-copy-mismatch",
            artifact_id=fixture.stem_artifact_id,
        )
        session.commit()

    def copy_corrupt_bytes(src: str | Path, dst: str | Path, *args: Any, **kwargs: Any) -> Path:
        _ = src, args, kwargs
        destination = Path(dst)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"corrupt copied artifact bytes")
        return destination

    monkeypatch.setattr(sync_reconciliation_apply_service.shutil, "copy2", copy_corrupt_bytes)

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue120-copy-mismatch",
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 1
    assert any(
        result["action"]["action_type"] == "import_artifact_manifest"
        and result["action"]["item_id"] == fixture.stem_artifact_id
        and result["status"] == "failed"
        and result["reason"] == "Copied artifact bytes do not match the manifest."
        for result in payload["results"]
    )

    with SessionLocal() as session:
        assert session.get(Artifact, fixture.stem_artifact_id) is None
        staged_artifact = session.get(
            SyncStagedArtifact,
            fixture.artifact_hashes[fixture.stem_artifact_id],
        )
        assert staged_artifact is not None
        assert (get_settings().data_root / "sync" / "staging" / staged_artifact.relative_path).exists()


def test_issue120_existing_project_imports_project_metadata_rename(
    client: TestClient,
    tmp_path: Path,
) -> None:
    peer_device_id = "peer-issue120-rename"
    _ensure_identity_and_peers(peer_device_id)

    old_revision_id = "rev_issue120_project_metadata_original"
    rename_revision_id = "rev_issue120_project_metadata_rename"
    remote_display_name = "Synced Delta Rename"
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue120-rename",
            source_frames=132,
        )
        project = session.get(Project, fixture.project_id)
        assert project is not None
        project.display_name = "Local Delta Name"
        local_updated_at = datetime(2026, 1, 1, tzinfo=UTC)
        project.updated_at = local_updated_at
        old_revision_payload = sanitize_revision_payload(
            {
                "project_id": fixture.project_id,
                "display_name": project.display_name,
                "source_key_override": project.source_key_override,
                "source_sha256": project.source_sha256,
                "duration_seconds": project.duration_seconds,
                "sample_rate": project.sample_rate,
                "channels": project.channels,
            }
        )
        session.add(
            SyncEntityRevision(
                id=old_revision_id,
                project_id=fixture.project_id,
                entity_type="project_metadata",
                entity_id=fixture.project_id,
                revision_type="metadata_change",
                base_revision_id=None,
                author_device_id=peer_device_id,
                source_artifact_id=None,
                content_sha256=revision_payload_sha256(old_revision_payload),
                state=CURRENT_REVISION_STATE,
                metadata_json={},
                payload_json=old_revision_payload,
                created_at=local_updated_at,
                updated_at=local_updated_at,
            )
        )
        session.flush()
        manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        remote_updated_at = datetime(2026, 1, 2, tzinfo=UTC).isoformat()
        manifest["project"]["display_name"] = remote_display_name
        manifest["project"]["updated_at"] = remote_updated_at
        old_revision_manifest = _revision_by_id(manifest, old_revision_id)
        old_revision_manifest["state"] = SUPERSEDED_REVISION_STATE
        old_revision_manifest["updated_at"] = remote_updated_at
        revision_payload = sanitize_revision_payload(
            {
                "project_id": fixture.project_id,
                "display_name": remote_display_name,
                "source_key_override": project.source_key_override,
                "source_sha256": project.source_sha256,
                "duration_seconds": project.duration_seconds,
                "sample_rate": project.sample_rate,
                "channels": project.channels,
            }
        )
        manifest["entity_revisions"].append(
            {
                "revision_id": rename_revision_id,
                "project_id": fixture.project_id,
                "entity_type": "project_metadata",
                "entity_id": fixture.project_id,
                "revision_type": "metadata_change",
                "base_revision_id": old_revision_id,
                "author_device_id": peer_device_id,
                "source_artifact_id": None,
                "content_sha256": revision_payload_sha256(revision_payload),
                "state": CURRENT_REVISION_STATE,
                "metadata": {},
                "payload": revision_payload,
                "created_at": remote_updated_at,
                "updated_at": remote_updated_at,
            }
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": _empty_remote_library(),
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": peer_device_id,
                    "available_content_sha256": _manifest_content_hashes([manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert any(
        result["action"]["action_type"] == "import_entity_revision"
        and result["action"]["item_id"] == old_revision_id
        and result["status"] == "applied"
        for result in payload["results"]
    )
    assert any(
        result["action"]["action_type"] == "import_entity_revision"
        and result["action"]["item_id"] == rename_revision_id
        and result["status"] == "applied"
        for result in payload["results"]
    )

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        old_revision = session.get(SyncEntityRevision, old_revision_id)
        revision = session.get(SyncEntityRevision, rename_revision_id)
        assert project is not None
        assert old_revision is not None
        assert revision is not None
        assert project.display_name == remote_display_name
        assert old_revision.state == SUPERSEDED_REVISION_STATE
        assert revision.state == CURRENT_REVISION_STATE
        assert revision.payload_json["display_name"] == remote_display_name
        current_metadata_revisions = list(
            session.scalars(
                select(SyncEntityRevision).where(
                    SyncEntityRevision.project_id == fixture.project_id,
                    SyncEntityRevision.entity_type == "project_metadata",
                    SyncEntityRevision.state.in_((CURRENT_REVISION_STATE, "current")),
                )
            )
        )
        assert [current.id for current in current_metadata_revisions] == [rename_revision_id]

        exported_manifest = _jsonable_manifest(export_project_manifest(session, project_id=fixture.project_id))
        exported_current_metadata_revisions = [
            exported_revision
            for exported_revision in exported_manifest["entity_revisions"]
            if exported_revision["entity_type"] == "project_metadata"
            and exported_revision["state"] in {CURRENT_REVISION_STATE, "current"}
        ]
        assert [revision["revision_id"] for revision in exported_current_metadata_revisions] == [
            rename_revision_id
        ]


def test_issue120_remote_tombstone_from_trusted_peer_wins_over_stale_manifest(
    client: TestClient,
    tmp_path: Path,
) -> None:
    identity = _ensure_identity_and_peers(
        "peer-issue120-stale-manifest",
        "peer-issue120-tombstone",
    )

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(
            session,
            tmp_path,
            slug="issue120-tombstone",
            source_frames=128,
        )
        stale_manifest = _jsonable_manifest(
            export_project_manifest(session, project_id=fixture.project_id)
        )
        deleted_artifact_path = project_root(fixture.project_id) / fixture.stem_relative_path
        deleted_artifact = session.get(Artifact, fixture.stem_artifact_id)
        assert deleted_artifact is not None
        session.delete(deleted_artifact)
        deleted_artifact_path.unlink()
        session.commit()

    tombstone_time = datetime(2026, 1, 2, tzinfo=UTC).isoformat()
    tombstone = {
        "tombstone_id": "tomb_issue120_remote_deleted_stem",
        "sync_group_id": identity["sync_group_id"],
        "project_id": fixture.project_id,
        "target_type": "artifact",
        "target_id": fixture.stem_artifact_id,
        "author_device_id": "peer-issue120-tombstone",
        "deleted_at": tombstone_time,
        "prior_metadata": {"artifact_id": fixture.stem_artifact_id, "type": "vocals"},
        "created_at": tombstone_time,
        "updated_at": tombstone_time,
    }
    remote_library = _empty_remote_library()
    remote_library["delete_tombstones"] = [tombstone]

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": remote_library,
            "project_manifests": [stale_manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-issue120-stale-manifest",
                    "available_content_sha256": _manifest_content_hashes([stale_manifest]),
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert (
        _plan_item(payload["plan"]["items"], "artifact", fixture.stem_artifact_id)["status"]
        == "deleted"
    )
    assert all(
        result["action"]["action_type"] != "import_project_manifest"
        for result in payload["results"]
    )
    assert any(
        result["action"]["action_type"] == "apply_delete_tombstone"
        and result["action"]["item_id"] == fixture.stem_artifact_id
        and result["status"] == "applied"
        for result in payload["results"]
    )

    editable_response = client.patch(
        f"/api/v1/projects/{fixture.project_id}",
        json={"display_name": "Tombstone Still Editable"},
    )
    assert editable_response.status_code == 200
    assert editable_response.json()["project"]["display_name"] == "Tombstone Still Editable"

    with SessionLocal() as session:
        project = session.get(Project, fixture.project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert session.get(Artifact, fixture.source_artifact_id) is not None
        assert session.get(Artifact, fixture.stem_artifact_id) is None
        assert not deleted_artifact_path.exists()
        persisted_tombstone = session.get(SyncDeleteTombstone, tombstone["tombstone_id"])
        assert persisted_tombstone is not None
        assert persisted_tombstone.author_device_id == "peer-issue120-tombstone"


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


def _stage_manifest_artifact_content(
    session: Session,
    manifest: dict[str, Any],
    *,
    tmp_path: Path,
    artifact_bytes: dict[str, bytes],
    provider_device_id: str,
    artifact_id: str,
) -> None:
    artifact = _artifact_by_id(manifest, artifact_id)
    source_path = tmp_path / "issue119-stage" / provider_device_id / artifact_id
    _write_bytes(source_path, artifact_bytes[artifact_id])
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


def _assert_issue200_resume_counts(
    project_id: str,
    manifest: dict[str, Any],
    *,
    staged_count: int,
) -> None:
    with SessionLocal() as session:
        assert (
            session.scalar(
                select(func.count()).select_from(Project).where(Project.id == project_id)
            )
            == 1
        )
        assert (
            session.scalar(
                select(func.count()).select_from(Artifact).where(Artifact.project_id == project_id)
            )
            == len(manifest["artifacts"])
        )
        assert (
            session.scalar(
                select(func.count()).select_from(SyncEntityRevision).where(
                    SyncEntityRevision.project_id == project_id
                )
            )
            == len(manifest["entity_revisions"])
        )
        assert (
            session.scalar(
                select(func.count()).select_from(SyncDeleteTombstone).where(
                    SyncDeleteTombstone.project_id == project_id
                )
            )
            == len(manifest["delete_tombstones"])
        )
        assert session.scalar(select(func.count()).select_from(SyncStagedArtifact)) == staged_count


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


def _artifact_by_id(manifest: dict[str, Any], artifact_id: str) -> dict[str, Any]:
    for artifact in manifest["artifacts"]:
        if artifact["artifact_id"] == artifact_id:
            return artifact
    raise AssertionError(f"Missing artifact in manifest: {artifact_id}")


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
