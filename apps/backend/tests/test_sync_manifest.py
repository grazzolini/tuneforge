from __future__ import annotations

import importlib
import shutil
from collections.abc import Callable, Iterable, Iterator
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.errors import AppError
from app.models import Artifact, Job, Project
from app.services.paths import project_root
from app.services.sync_identity import source_hash_to_project_id
from app.utils.hashing import file_sha256

ManifestService = Callable[..., Any]

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


@dataclass(frozen=True)
class ManifestProjectFixture:
    project_id: str
    root: Path
    source_sha256: str
    source_relative_path: str
    stem_relative_path: str
    artifact_hashes: dict[str, str]
    artifact_sizes: dict[str, int]
    external_source_path: Path


def _sync_manifest_services() -> tuple[ManifestService, ManifestService]:
    try:
        module = importlib.import_module("app.services.sync_manifest")
    except ModuleNotFoundError as exc:
        if exc.name == "app.services.sync_manifest":
            pytest.fail(
                "Expected app.services.sync_manifest with export_project_manifest() and "
                "import_staged_project_manifest() for sync manifest issue #112."
            )
        raise

    export_manifest = getattr(module, "export_project_manifest", None)
    import_manifest = getattr(module, "import_staged_project_manifest", None)
    if not callable(export_manifest) or not callable(import_manifest):
        pytest.fail(
            "Expected sync manifest services named export_project_manifest() and "
            "import_staged_project_manifest()."
        )

    return export_manifest, import_manifest


def _to_plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _to_plain(value.model_dump(mode="json"))
    if is_dataclass(value):
        return _to_plain(asdict(value))
    if isinstance(value, dict):
        return {key: _to_plain(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(child) for child in value]
    return value


def _plain_manifest(value: Any) -> dict[str, Any]:
    manifest = _to_plain(value)
    assert isinstance(manifest, dict)
    if "project_manifest" in manifest:
        manifest = manifest["project_manifest"]
        assert isinstance(manifest, dict)

    if "project" in manifest:
        project = manifest["project"]
        artifacts = manifest.get("artifacts")
    else:
        project = {key: child for key, child in manifest.items() if key != "artifacts"}
        artifacts = manifest.get("artifacts")

    assert isinstance(project, dict)
    assert isinstance(artifacts, list)
    return {"project": project, "artifacts": artifacts}


def _iter_strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _iter_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_strings(child)


def _iter_keys(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(key, str):
                yield key
            yield from _iter_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_keys(child)


def _assert_no_absolute_local_paths(payload: dict[str, Any], local_roots: Iterable[Path]) -> None:
    local_root_strings = [str(root) for root in local_roots]
    for value in _iter_strings(payload):
        assert not Path(value).is_absolute(), value
        assert all(root not in value for root in local_root_strings), value


def _assert_no_local_path_keys(payload: dict[str, Any]) -> None:
    leaked_keys = [
        key
        for key in _iter_keys(payload)
        if key != "relative_path" and (key in LOCAL_PATH_KEYS or key.endswith("_path"))
    ]
    assert leaked_keys == []


def _artifacts_by_id(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    artifacts = manifest["artifacts"]
    return {artifact["artifact_id"]: artifact for artifact in artifacts}


def _write_bytes(path: Path, contents: bytes) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    content_hash = file_sha256(path)
    assert content_hash is not None
    return content_hash, path.stat().st_size


def _create_project_with_artifacts(
    session: Any,
    tmp_path: Path,
    *,
    source_bytes: bytes = b"sync source audio",
    stem_bytes: bytes = b"sync vocal stem",
) -> ManifestProjectFixture:
    external_source = tmp_path / "user-library" / "fixture.wav"
    source_sha256, _ = _write_bytes(external_source, source_bytes)
    project_id = source_hash_to_project_id(source_sha256)
    root = project_root(project_id)

    source_relative_path = "source/fixture.wav"
    stem_relative_path = "stems/vocals.wav"
    source_path = root / source_relative_path
    stem_path = root / stem_relative_path
    source_hash, source_size = _write_bytes(source_path, source_bytes)
    stem_hash, stem_size = _write_bytes(stem_path, stem_bytes)

    project = Project(
        id=project_id,
        display_name="Sync Fixture",
        source_key_override="7:minor",
        source_sha256=source_sha256,
        source_path=str(external_source),
        imported_path=str(source_path),
        duration_seconds=2.5,
        sample_rate=44100,
        channels=2,
    )
    session.add(project)
    session.flush()
    session.add_all(
        [
            Artifact(
                id="art_source_audio",
                project_id=project_id,
                type="source_audio",
                format="wav",
                path=str(source_path),
                content_sha256=source_hash,
                size_bytes=source_size,
                generated_by="import",
                can_delete=False,
                can_regenerate=False,
                metadata_json={
                    "source_path": str(external_source),
                    "source_label": "fixture",
                },
            ),
            Artifact(
                id="art_vocals",
                project_id=project_id,
                type="vocals",
                format="wav",
                path=str(stem_path),
                content_sha256=stem_hash,
                size_bytes=stem_size,
                generated_by="stems",
                can_delete=True,
                can_regenerate=True,
                cache_key=f"stem:{project_id}",
                metadata_json={
                    "stem_model": "htdemucs_6s",
                    "render_path": str(tmp_path / "rendered.wav"),
                    "source_artifact_id": "art_source_audio",
                },
            ),
        ]
    )
    session.commit()

    return ManifestProjectFixture(
        project_id=project_id,
        root=root,
        source_sha256=source_sha256,
        source_relative_path=source_relative_path,
        stem_relative_path=stem_relative_path,
        artifact_hashes={
            "art_source_audio": source_hash,
            "art_vocals": stem_hash,
        },
        artifact_sizes={
            "art_source_audio": source_size,
            "art_vocals": stem_size,
        },
        external_source_path=external_source,
    )


def _stage_manifest_files(
    manifest: dict[str, Any],
    *,
    staging_root: Path,
    source_root: Path,
) -> None:
    for artifact in manifest["artifacts"]:
        relative_path = artifact["relative_path"]
        source_path = source_root / relative_path
        staged_path = staging_root / relative_path
        staged_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, staged_path)


def _delete_live_project(session: Any, fixture: ManifestProjectFixture) -> None:
    project = session.get(Project, fixture.project_id)
    assert project is not None
    session.delete(project)
    session.commit()
    shutil.rmtree(fixture.root, ignore_errors=True)


def test_export_project_manifest_omits_local_paths_and_includes_sync_safe_fields(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, _ = _sync_manifest_services()
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))

    _assert_no_absolute_local_paths(manifest, (tmp_path, fixture.root))
    _assert_no_local_path_keys(manifest)

    project = manifest["project"]
    assert project["project_id"] == fixture.project_id
    assert project["display_name"] == "Sync Fixture"
    assert project["source_key_override"] == "7:minor"
    assert project["source_sha256"] == fixture.source_sha256
    assert project["duration_seconds"] == 2.5
    assert project["sample_rate"] == 44100
    assert project["channels"] == 2
    assert "created_at" in project
    assert "updated_at" in project
    assert "source_path" not in project
    assert "imported_path" not in project

    artifacts = _artifacts_by_id(manifest)
    assert set(artifacts) == {"art_source_audio", "art_vocals"}

    source_artifact = artifacts["art_source_audio"]
    assert source_artifact["project_id"] == fixture.project_id
    assert source_artifact["type"] == "source_audio"
    assert source_artifact["format"] == "wav"
    assert source_artifact["relative_path"] == fixture.source_relative_path
    assert source_artifact["content_sha256"] == fixture.artifact_hashes["art_source_audio"]
    assert source_artifact["size_bytes"] == fixture.artifact_sizes["art_source_audio"]
    assert source_artifact["generated_by"] == "import"
    assert source_artifact["can_delete"] is False
    assert source_artifact["can_regenerate"] is False
    assert source_artifact["metadata"] == {"source_label": "fixture"}

    stem_artifact = artifacts["art_vocals"]
    assert stem_artifact["project_id"] == fixture.project_id
    assert stem_artifact["type"] == "vocals"
    assert stem_artifact["format"] == "wav"
    assert stem_artifact["relative_path"] == fixture.stem_relative_path
    assert stem_artifact["content_sha256"] == fixture.artifact_hashes["art_vocals"]
    assert stem_artifact["size_bytes"] == fixture.artifact_sizes["art_vocals"]
    assert stem_artifact["generated_by"] == "stems"
    assert stem_artifact["can_delete"] is True
    assert stem_artifact["can_regenerate"] is True
    assert stem_artifact["cache_key"] == f"stem:{fixture.project_id}"
    assert stem_artifact["metadata"] == {
        "stem_model": "htdemucs_6s",
        "source_artifact_id": "art_source_audio",
    }


@pytest.mark.parametrize("unportable_path", ["outside_project_root", "project_root_directory"])
def test_export_project_manifest_rejects_unportable_artifact_paths(
    client: object,
    tmp_path: Path,
    unportable_path: str,
) -> None:
    export_manifest, _ = _sync_manifest_services()
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        if unportable_path == "outside_project_root":
            artifact_path = tmp_path / "external" / "escape.wav"
            content_hash, size_bytes = _write_bytes(artifact_path, b"outside root")
        else:
            artifact_path = fixture.root
            content_hash = "0" * 64
            size_bytes = 0
        session.add(
            Artifact(
                id=f"art_bad_{unportable_path}",
                project_id=fixture.project_id,
                type="preview_mix",
                format="wav",
                path=str(artifact_path),
                content_sha256=content_hash,
                size_bytes=size_bytes,
                generated_by="test",
                can_delete=True,
                can_regenerate=True,
            )
        )
        session.commit()

        with pytest.raises(AppError) as exc:
            export_manifest(session, project_id=fixture.project_id)

    assert exc.value.code in {
        "SYNC_MANIFEST_ARTIFACT_FILE_UNREADABLE",
        "SYNC_MANIFEST_ARTIFACT_PATH_MISSING",
        "SYNC_MANIFEST_RELATIVE_PATH_INVALID",
    }
    assert exc.value.status_code == 400
    assert exc.value.details["artifact_id"] == f"art_bad_{unportable_path}"


def test_export_project_manifest_requires_source_artifact_to_match_project_source_hash(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, _ = _sync_manifest_services()
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        source_path = fixture.root / fixture.source_relative_path
        proxy_hash, proxy_size = _write_bytes(source_path, b"normalized proxy bytes")
        source_artifact = session.get(Artifact, "art_source_audio")
        assert source_artifact is not None
        source_artifact.content_sha256 = proxy_hash
        source_artifact.size_bytes = proxy_size

        with pytest.raises(AppError) as exc:
            export_manifest(session, project_id=fixture.project_id)

    assert exc.value.code == "SYNC_MANIFEST_SOURCE_ARTIFACT_HASH_MISMATCH"
    assert exc.value.status_code == 400
    assert exc.value.details["project_id"] == fixture.project_id
    assert exc.value.details["artifact_id"] == "art_source_audio"
    assert exc.value.details["source_sha256"] == fixture.source_sha256
    assert exc.value.details["artifact_content_sha256"] == proxy_hash


def test_export_project_manifest_rejects_multiple_source_artifacts(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, _ = _sync_manifest_services()
    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        duplicate_source_path = fixture.root / "source" / "duplicate.wav"
        duplicate_hash, duplicate_size = _write_bytes(duplicate_source_path, b"duplicate source")
        session.add(
            Artifact(
                id="art_source_audio_duplicate",
                project_id=fixture.project_id,
                type="source_audio",
                format="wav",
                path=str(duplicate_source_path),
                content_sha256=duplicate_hash,
                size_bytes=duplicate_size,
                generated_by="import",
                can_delete=False,
                can_regenerate=False,
            )
        )
        session.flush()

        with pytest.raises(AppError) as exc:
            export_manifest(session, project_id=fixture.project_id)

    assert exc.value.code == "SYNC_MANIFEST_SOURCE_ARTIFACT_AMBIGUOUS"
    assert exc.value.status_code == 400
    assert exc.value.details == {
        "project_id": fixture.project_id,
        "source_artifact_count": 2,
    }


def test_import_staged_project_manifest_rewrites_paths_preserves_hashes_and_skips_jobs(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, import_manifest = _sync_manifest_services()
    staging_root = tmp_path / "staging"

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))
        _stage_manifest_files(manifest, staging_root=staging_root, source_root=fixture.root)
        _delete_live_project(session, fixture)

        imported_project = import_manifest(session, manifest=manifest, staging_root=staging_root)
        imported_project = _to_plain(imported_project)
        session.commit()

        if isinstance(imported_project, dict):
            assert imported_project.get("project_id", fixture.project_id) == fixture.project_id

        project = session.get(Project, fixture.project_id)
        assert project is not None
        receiving_root = project_root(fixture.project_id)
        expected_source_path = receiving_root / fixture.source_relative_path
        assert Path(project.source_path) == expected_source_path
        assert Path(project.imported_path) == expected_source_path
        assert project.source_sha256 == fixture.source_sha256
        assert project.display_name == "Sync Fixture"
        assert project.source_key_override == "7:minor"
        assert project.duration_seconds == 2.5
        assert project.sample_rate == 44100
        assert project.channels == 2

        artifacts = {
            artifact.id: artifact
            for artifact in session.scalars(
                select(Artifact).where(Artifact.project_id == fixture.project_id)
            )
        }
        assert set(artifacts) == {"art_source_audio", "art_vocals"}
        expected_relative_paths = {
            "art_source_audio": fixture.source_relative_path,
            "art_vocals": fixture.stem_relative_path,
        }
        for artifact_id, relative_path in expected_relative_paths.items():
            artifact = artifacts[artifact_id]
            expected_path = receiving_root / relative_path
            assert Path(artifact.path) == expected_path
            assert expected_path.exists()
            assert artifact.content_sha256 == fixture.artifact_hashes[artifact_id]
            assert file_sha256(expected_path) == fixture.artifact_hashes[artifact_id]

        job_types = set(
            session.scalars(select(Job.type).where(Job.project_id == fixture.project_id))
        )
        assert not job_types.intersection({"analyze", "chords"})


def test_import_staged_project_manifest_rejects_hash_mismatch(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, import_manifest = _sync_manifest_services()
    staging_root = tmp_path / "staging"

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))
        _stage_manifest_files(manifest, staging_root=staging_root, source_root=fixture.root)
        (staging_root / fixture.stem_relative_path).write_bytes(b"corrupt stem!!!")
        _delete_live_project(session, fixture)

        with pytest.raises(AppError) as exc:
            import_manifest(session, manifest=manifest, staging_root=staging_root)
        session.rollback()

        assert session.get(Project, fixture.project_id) is None

    assert exc.value.code == "SYNC_MANIFEST_STAGED_FILE_HASH_MISMATCH"
    assert exc.value.status_code == 400
    assert "sha-256" in exc.value.message.lower()
    assert exc.value.details["artifact_id"] == "art_vocals"
    assert exc.value.details["relative_path"] == fixture.stem_relative_path
    assert exc.value.details["expected_sha256"] == fixture.artifact_hashes["art_vocals"]


def test_import_staged_project_manifest_rejects_unsupported_schema_version(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, import_manifest = _sync_manifest_services()

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))
        manifest["schema_version"] = "2"
        _delete_live_project(session, fixture)

        with pytest.raises(AppError) as exc:
            import_manifest(session, manifest=manifest, staging_root=tmp_path / "unused-staging")

    assert exc.value.code == "SYNC_MANIFEST_SCHEMA_UNSUPPORTED"
    assert exc.value.status_code == 400
    assert exc.value.details == {
        "schema_version": "2",
        "supported_schema_version": "1",
    }


def test_import_staged_project_manifest_rejects_source_artifact_hash_mismatch(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, import_manifest = _sync_manifest_services()

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))
        artifacts = _artifacts_by_id(manifest)
        artifacts["art_source_audio"]["content_sha256"] = fixture.artifact_hashes["art_vocals"]
        _delete_live_project(session, fixture)

        with pytest.raises(AppError) as exc:
            import_manifest(session, manifest=manifest, staging_root=tmp_path / "unused-staging")

    assert exc.value.code == "SYNC_MANIFEST_SOURCE_ARTIFACT_HASH_MISMATCH"
    assert exc.value.status_code == 400
    assert exc.value.details["project_id"] == fixture.project_id
    assert exc.value.details["artifact_id"] == "art_source_audio"
    assert exc.value.details["source_sha256"] == fixture.source_sha256
    assert exc.value.details["artifact_content_sha256"] == fixture.artifact_hashes["art_vocals"]


def test_import_staged_project_manifest_rejects_multiple_source_artifacts(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, import_manifest = _sync_manifest_services()

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))
        source_artifact = _artifacts_by_id(manifest)["art_source_audio"].copy()
        source_artifact["artifact_id"] = "art_source_audio_duplicate"
        source_artifact["relative_path"] = "source/duplicate.wav"
        manifest["artifacts"].append(source_artifact)
        _delete_live_project(session, fixture)

        with pytest.raises(AppError) as exc:
            import_manifest(session, manifest=manifest, staging_root=tmp_path / "unused-staging")

    assert exc.value.code == "SYNC_MANIFEST_SOURCE_ARTIFACT_AMBIGUOUS"
    assert exc.value.status_code == 400
    assert exc.value.details == {
        "project_id": fixture.project_id,
        "source_artifact_count": 2,
    }


def test_import_staged_project_manifest_cleans_copied_files_after_post_copy_failure(
    client: object,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module = importlib.import_module("app.services.sync_manifest")
    export_manifest, import_manifest = _sync_manifest_services()
    staging_root = tmp_path / "staging"

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))
        _stage_manifest_files(manifest, staging_root=staging_root, source_root=fixture.root)
        _delete_live_project(session, fixture)

        def fail_register_artifact(*args: object, **kwargs: object) -> None:
            raise AppError("SYNC_MANIFEST_FORCED_FAILURE", "Forced failure.")

        monkeypatch.setattr(module, "register_artifact", fail_register_artifact)
        with pytest.raises(AppError) as exc:
            import_manifest(session, manifest=manifest, staging_root=staging_root)
        session.rollback()

        assert exc.value.code == "SYNC_MANIFEST_FORCED_FAILURE"
        receiving_root = project_root(fixture.project_id)
        assert not (receiving_root / fixture.source_relative_path).exists()
        assert not (receiving_root / fixture.stem_relative_path).exists()

        monkeypatch.undo()
        import_manifest(session, manifest=manifest, staging_root=staging_root)
        session.commit()

        assert (receiving_root / fixture.source_relative_path).exists()
        assert (receiving_root / fixture.stem_relative_path).exists()


def test_import_staged_project_manifest_rejects_duplicate_source_conflict(
    client: object,
    tmp_path: Path,
) -> None:
    export_manifest, import_manifest = _sync_manifest_services()
    staging_root = tmp_path / "staging"

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)
        manifest = _plain_manifest(export_manifest(session, project_id=fixture.project_id))
        _stage_manifest_files(manifest, staging_root=staging_root, source_root=fixture.root)

        original_project = session.get(Project, fixture.project_id)
        assert original_project is not None
        session.delete(original_project)
        session.flush()
        session.add(
            Project(
                id="proj_legacy_duplicate",
                display_name="Existing Copy",
                source_sha256=fixture.source_sha256,
                source_path=str(fixture.external_source_path),
                imported_path=str(fixture.external_source_path),
            )
        )
        session.commit()

        with pytest.raises(AppError) as exc:
            import_manifest(session, manifest=manifest, staging_root=staging_root)

    assert exc.value.code == "DUPLICATE_PROJECT_SOURCE"
    assert exc.value.status_code == 409
    assert exc.value.details == {
        "project_id": "proj_legacy_duplicate",
        "project_name": "Existing Copy",
    }


def test_sync_project_manifest_api_round_trips_staged_import(
    client: Any,
    tmp_path: Path,
) -> None:
    staging_root = tmp_path / "staging"

    with SessionLocal() as session:
        fixture = _create_project_with_artifacts(session, tmp_path)

    export_response = client.get(f"/api/v1/sync/projects/{fixture.project_id}/manifest")

    assert export_response.status_code == 200
    payload = export_response.json()
    assert set(payload) == {"project_manifest"}
    manifest = payload["project_manifest"]
    assert manifest["schema_version"] == "1"
    assert manifest["project"]["project_id"] == fixture.project_id
    _assert_no_absolute_local_paths(manifest, (tmp_path, fixture.root))
    _assert_no_local_path_keys(manifest)

    _stage_manifest_files(manifest, staging_root=staging_root, source_root=fixture.root)
    with SessionLocal() as session:
        _delete_live_project(session, fixture)

    import_response = client.post(
        "/api/v1/sync/projects/import",
        json={"manifest": manifest, "staging_root": str(staging_root)},
    )

    assert import_response.status_code == 200
    project = import_response.json()["project"]
    assert project["id"] == fixture.project_id
    assert project["display_name"] == "Sync Fixture"

    with SessionLocal() as session:
        job_types = set(session.scalars(select(Job.type).where(Job.project_id == fixture.project_id)))
        assert not job_types.intersection({"analyze", "chords"})
