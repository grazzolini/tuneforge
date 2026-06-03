from __future__ import annotations

from pathlib import Path

import pytest

from app.config import get_settings
from app.db import SessionLocal
from app.errors import AppError
from app.models import SyncStagedArtifact
from app.services.sync_staging import (
    get_staged_artifact_path,
    require_staged_artifact,
    stage_sync_artifact,
)
from app.utils.hashing import file_sha256


def test_stage_sync_artifact_stores_verified_bytes_under_content_addressed_path(
    client: object,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.bin"
    source_path.write_bytes(b"sync artifact bytes")
    content_sha256 = file_sha256(source_path)
    assert content_sha256 is not None

    with SessionLocal() as session:
        staged = stage_sync_artifact(
            session,
            source_path=source_path,
            content_sha256=content_sha256.upper(),
            size_bytes=source_path.stat().st_size,
            provider_device_id="device-a",
            metadata={"kind": "source_audio"},
        )
        staged_path = get_staged_artifact_path(session, content_sha256=content_sha256)
        record = session.get(SyncStagedArtifact, content_sha256)

    assert staged.content_sha256 == content_sha256
    assert staged.size_bytes == source_path.stat().st_size
    assert staged.relative_path == f"sha256/{content_sha256[:2]}/{content_sha256}"
    assert staged.provider_device_id == "device-a"
    assert staged.metadata == {"kind": "source_audio"}
    assert staged.resolved_path == staged_path
    assert staged.resolved_path.read_bytes() == b"sync artifact bytes"
    assert source_path.exists()
    assert not Path(staged.relative_path).is_absolute()
    assert record is not None
    assert record.relative_path == staged.relative_path


def test_stage_sync_artifact_promotes_transport_temp_source(
    client: object,
) -> None:
    transport_root = get_settings().data_root / "sync" / "transport-tmp"
    source_path = transport_root / "batch-one" / "artifact.bin"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(b"transport temp bytes")
    content_sha256 = file_sha256(source_path)
    assert content_sha256 is not None

    with SessionLocal() as session:
        staged = stage_sync_artifact(
            session,
            source_path=source_path,
            content_sha256=content_sha256,
            size_bytes=source_path.stat().st_size,
            provider_device_id="device-transport",
            metadata={"project_id": "proj-one", "artifact_id": "art-one"},
        )
        record = session.get(SyncStagedArtifact, content_sha256)

    assert not source_path.exists()
    assert staged.resolved_path.exists()
    assert staged.resolved_path.read_bytes() == b"transport temp bytes"
    assert staged.provider_device_id == "device-transport"
    assert staged.metadata == {"project_id": "proj-one", "artifact_id": "art-one"}
    assert record is not None
    assert record.relative_path == staged.relative_path


def test_stage_sync_artifact_verifies_promoted_transport_destination(
    client: object,
    tmp_path: Path,
) -> None:
    transport_root = get_settings().data_root / "sync" / "transport-tmp"
    source_path = transport_root / "batch-one" / "mutated.bin"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(b"wrong-bytes")
    expected_path = tmp_path / "expected.bin"
    expected_path.write_bytes(b"right-bytes")
    content_sha256 = file_sha256(expected_path)
    assert content_sha256 is not None
    destination_path = get_settings().data_root / "sync" / "staging" / "sha256" / content_sha256[:2] / content_sha256

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            stage_sync_artifact(
                session,
                source_path=source_path,
                content_sha256=content_sha256,
                size_bytes=expected_path.stat().st_size,
                provider_device_id="device-transport",
            )
        record = session.get(SyncStagedArtifact, content_sha256)

    assert exc.value.code == "SYNC_STAGING_PROMOTED_FILE_MISMATCH"
    assert exc.value.status_code == 409
    assert not source_path.exists()
    assert not destination_path.exists()
    assert record is None


@pytest.mark.parametrize(
    "bad_bytes",
    [
        b"incomplete",
        b"fedcba9876543210",
    ],
)
def test_stage_sync_artifact_removes_bad_transport_temp_before_valid_retry(
    client: object,
    tmp_path: Path,
    bad_bytes: bytes,
) -> None:
    transport_root = get_settings().data_root / "sync" / "transport-tmp"
    valid_bytes = b"0123456789abcdef"
    valid_fixture = tmp_path / "valid.bin"
    valid_fixture.write_bytes(valid_bytes)
    content_sha256 = file_sha256(valid_fixture)
    assert content_sha256 is not None
    size_bytes = len(valid_bytes)
    bad_source_path = transport_root / "batch-bad" / "artifact.bin"
    valid_source_path = transport_root / "batch-valid" / "artifact.bin"
    bad_source_path.parent.mkdir(parents=True, exist_ok=True)
    bad_source_path.write_bytes(bad_bytes)
    destination_path = (
        get_settings().data_root / "sync" / "staging" / "sha256" / content_sha256[:2] / content_sha256
    )

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            stage_sync_artifact(
                session,
                source_path=bad_source_path,
                content_sha256=content_sha256,
                size_bytes=size_bytes,
                provider_device_id="device-transport",
            )
        bad_record = session.get(SyncStagedArtifact, content_sha256)

        valid_source_path.parent.mkdir(parents=True, exist_ok=True)
        valid_source_path.write_bytes(valid_bytes)
        staged = stage_sync_artifact(
            session,
            source_path=valid_source_path,
            content_sha256=content_sha256,
            size_bytes=size_bytes,
            provider_device_id="device-transport",
        )
        records = session.query(SyncStagedArtifact).all()

    assert exc.value.code == "SYNC_STAGING_PROMOTED_FILE_MISMATCH"
    assert not bad_source_path.exists()
    assert bad_record is None
    assert not valid_source_path.exists()
    assert destination_path.exists()
    assert staged.resolved_path == destination_path
    assert staged.resolved_path.read_bytes() == valid_bytes
    assert len(records) == 1
    assert records[0].content_sha256 == content_sha256


def test_stage_sync_artifact_is_idempotent_and_repairs_missing_staged_file(
    client: object,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.bin"
    source_path.write_bytes(b"idempotent bytes")
    content_sha256 = file_sha256(source_path)
    assert content_sha256 is not None

    with SessionLocal() as session:
        first = stage_sync_artifact(
            session,
            source_path=source_path,
            content_sha256=content_sha256,
            size_bytes=source_path.stat().st_size,
        )
        first.resolved_path.unlink()

        second = stage_sync_artifact(
            session,
            source_path=source_path,
            content_sha256=content_sha256,
            size_bytes=source_path.stat().st_size,
            provider_device_id="device-b",
            metadata={"restaged": True},
        )
        records = session.query(SyncStagedArtifact).all()

    assert second.content_sha256 == first.content_sha256
    assert second.resolved_path == first.resolved_path
    assert second.resolved_path.read_bytes() == b"idempotent bytes"
    assert second.provider_device_id == "device-b"
    assert second.metadata == {"restaged": True}
    assert len(records) == 1


def test_stage_sync_artifact_rejects_hash_mismatch(client: object, tmp_path: Path) -> None:
    source_path = tmp_path / "source.bin"
    source_path.write_bytes(b"actual bytes")
    expected_sha256 = file_sha256(tmp_path / "missing.bin") or "0" * 64

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            stage_sync_artifact(
                session,
                source_path=source_path,
                content_sha256=expected_sha256,
                size_bytes=source_path.stat().st_size,
            )

    assert exc.value.code == "SYNC_STAGING_SOURCE_HASH_MISMATCH"
    assert exc.value.status_code == 409


def test_stage_sync_artifact_rejects_size_mismatch(client: object, tmp_path: Path) -> None:
    source_path = tmp_path / "source.bin"
    source_path.write_bytes(b"actual bytes")
    content_sha256 = file_sha256(source_path)
    assert content_sha256 is not None

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            stage_sync_artifact(
                session,
                source_path=source_path,
                content_sha256=content_sha256,
                size_bytes=source_path.stat().st_size + 1,
            )

    assert exc.value.code == "SYNC_STAGING_SOURCE_SIZE_MISMATCH"
    assert exc.value.status_code == 409


def test_require_staged_artifact_rejects_missing_staged_content(
    client: object,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.bin"
    source_path.write_bytes(b"missing staged bytes")
    content_sha256 = file_sha256(source_path)
    assert content_sha256 is not None

    with SessionLocal() as session:
        staged = stage_sync_artifact(
            session,
            source_path=source_path,
            content_sha256=content_sha256,
            size_bytes=source_path.stat().st_size,
        )
        staged.resolved_path.unlink()

        with pytest.raises(AppError) as exc:
            require_staged_artifact(session, content_sha256=content_sha256)

    assert exc.value.code == "SYNC_STAGING_FILE_MISSING"
    assert exc.value.status_code == 404
