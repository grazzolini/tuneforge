from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.config import ensure_data_dirs, get_settings
from app.db import UnknownDatabaseRevisionError, reconfigure_engine, run_migrations
from app.services.sync_identity import source_hash_to_project_id, source_hash_to_project_storage_key
from app.utils.hashing import file_sha256


def test_run_migrations_reports_unknown_database_revision() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute("INSERT INTO alembic_version (version_num) VALUES (?)", ("9999_future_branch",))

    reconfigure_engine(settings)

    with pytest.raises(UnknownDatabaseRevisionError) as exc:
        run_migrations(settings)

    message = str(exc.value)
    assert "9999_future_branch" in message
    assert str(settings.database_path) in message
    assert "branch with newer migrations" in message
    assert "TUNEFORGE_DATA_DIR" in message


def test_sync_trust_identity_migration_creates_identity_and_trust_tables() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }

    assert {
        "sync_local_identities",
        "sync_pairing_offers",
        "sync_trusted_peers",
    } <= tables


def test_sync_artifact_staging_migration_creates_table_and_indexes() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info('sync_staged_artifacts')")
        }
        indexes = {
            row[1]
            for row in connection.execute("PRAGMA index_list('sync_staged_artifacts')")
        }

    assert "sync_staged_artifacts" in tables
    assert {
        "content_sha256",
        "size_bytes",
        "relative_path",
        "provider_device_id",
        "metadata_json",
        "verified_at",
        "created_at",
        "updated_at",
    } <= columns
    assert {
        "ix_sync_staged_artifacts_provider_device_id",
        "ix_sync_staged_artifacts_verified_at",
    } <= indexes


def test_hash_storage_migration_backfills_existing_files(tmp_path: Path) -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    duplicate_source_path = tmp_path / "duplicate.wav"
    artifact_path = tmp_path / "artifact.wav"
    old_project_root = settings.projects_root / "proj_legacy"
    old_project_source_dir = old_project_root / "source"
    old_project_source_dir.mkdir(parents=True)
    source_path = old_project_source_dir / "source.wav"
    imported_path = old_project_source_dir / "imported.wav"
    source_path.write_bytes(b"source")
    imported_path.write_bytes(b"imported")
    duplicate_source_path.write_bytes(b"duplicate")
    artifact_path.write_bytes(b"artifact")
    expected_project_hash = file_sha256(source_path)
    expected_project_id = source_hash_to_project_id(expected_project_hash)
    expected_storage_key = source_hash_to_project_storage_key(expected_project_hash)
    duplicate_hash = file_sha256(duplicate_source_path)

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0011_expand_stem_artifact_uniqueness",),
        )
        connection.execute(
            """
            CREATE TABLE projects (
                id VARCHAR(32) PRIMARY KEY,
                display_name VARCHAR(255) NOT NULL,
                source_key_override VARCHAR(32),
                source_path VARCHAR(2048) NOT NULL,
                imported_path VARCHAR(2048) NOT NULL,
                duration_seconds FLOAT,
                sample_rate INTEGER,
                channels INTEGER,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE artifacts (
                id VARCHAR(32) PRIMARY KEY,
                project_id VARCHAR(32) NOT NULL,
                type VARCHAR(64) NOT NULL,
                format VARCHAR(32) NOT NULL,
                path VARCHAR(2048) NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                generated_by VARCHAR(128) NOT NULL DEFAULT 'unknown',
                can_delete BOOLEAN NOT NULL DEFAULT 1,
                can_regenerate BOOLEAN NOT NULL DEFAULT 0,
                metadata_json JSON NOT NULL DEFAULT '{}',
                cache_key VARCHAR(128),
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE analysis_results (
                project_id VARCHAR(32) PRIMARY KEY,
                source_artifact_id VARCHAR(32),
                estimated_key VARCHAR(64),
                key_confidence FLOAT,
                estimated_reference_hz FLOAT,
                tuning_offset_cents FLOAT,
                tempo_bpm FLOAT,
                analysis_version VARCHAR(32) NOT NULL DEFAULT 'v3',
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_path, imported_path
            ) VALUES (?, ?, ?, ?)
            """,
            ("proj_legacy", "Song", str(source_path), str(imported_path)),
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_path, imported_path
            ) VALUES (?, ?, ?, ?)
            """,
            ("proj_duplicate_1", "Duplicate Song 1", str(duplicate_source_path), str(duplicate_source_path)),
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_path, imported_path
            ) VALUES (?, ?, ?, ?)
            """,
            ("proj_duplicate_2", "Duplicate Song 2", str(duplicate_source_path), str(duplicate_source_path)),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "source_1",
                "proj_legacy",
                "source_audio",
                "wav",
                str(imported_path),
                "{}",
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "art_1",
                "proj_legacy",
                "vocal_stem",
                "wav",
                str(artifact_path),
                '{"source_artifact_id":"source_1"}',
            ),
        )
        connection.execute(
            """
            INSERT INTO analysis_results (project_id, source_artifact_id)
            VALUES (?, ?)
            """,
            ("proj_legacy", "source_1"),
        )

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        project_rows = connection.execute(
            """
            SELECT id, display_name, source_sha256, source_path, imported_path
            FROM projects
            ORDER BY display_name
            """
        ).fetchall()
        analysis_project_id = connection.execute(
            "SELECT project_id FROM analysis_results WHERE source_artifact_id = 'source_1'"
        ).fetchone()[0]
        source_artifact = connection.execute(
            "SELECT project_id, path, content_sha256 FROM artifacts WHERE id = 'source_1'"
        ).fetchone()
        artifact_hash = connection.execute(
            "SELECT content_sha256 FROM artifacts WHERE id = 'art_1'"
        ).fetchone()[0]
        indexes = {
            row[1]
            for row in connection.execute("PRAGMA index_list('artifacts')")
        }
        project_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info('projects')")
        }

    assert project_rows == [
        (
            "proj_duplicate_1",
            "Duplicate Song 1",
            duplicate_hash,
            str(duplicate_source_path),
            str(duplicate_source_path),
        ),
        (
            "proj_duplicate_2",
            "Duplicate Song 2",
            duplicate_hash,
            str(duplicate_source_path),
            str(duplicate_source_path),
        ),
        (
            expected_project_id,
            "Song",
            expected_project_hash,
            str(settings.projects_root / expected_storage_key / "source" / "source.wav"),
            str(settings.projects_root / expected_storage_key / "source" / "imported.wav"),
        ),
    ]
    assert analysis_project_id == expected_project_id
    assert source_artifact == (
        expected_project_id,
        str(settings.projects_root / expected_storage_key / "source" / "imported.wav"),
        file_sha256(settings.projects_root / expected_storage_key / "source" / "imported.wav"),
    )
    assert artifact_hash == file_sha256(artifact_path)
    assert "ix_artifacts_content_sha256" in indexes
    assert "uq_artifacts_stem_per_source" in indexes
    assert "sync_project_id" not in project_columns
    assert not old_project_root.exists()
    assert (settings.projects_root / expected_storage_key).exists()


def test_sync_identity_migration_prefers_imported_copy_when_hash_missing(tmp_path: Path) -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    external_source_path = tmp_path / "external.wav"
    external_source_path.write_bytes(b"changed external bytes")
    old_project_root = settings.projects_root / "proj_legacy"
    old_imported_path = old_project_root / "source" / "imported.wav"
    old_imported_path.parent.mkdir(parents=True)
    old_imported_path.write_bytes(b"original imported bytes")
    expected_project_hash = file_sha256(old_imported_path)
    expected_project_id = source_hash_to_project_id(expected_project_hash)
    expected_storage_key = source_hash_to_project_storage_key(expected_project_hash)
    expected_imported_path = settings.projects_root / expected_storage_key / "source" / "imported.wav"

    assert file_sha256(external_source_path) != expected_project_hash

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0013_analysis_timing",),
        )
        connection.execute(
            """
            CREATE TABLE projects (
                id VARCHAR(32) PRIMARY KEY,
                display_name VARCHAR(255) NOT NULL,
                source_key_override VARCHAR(32),
                source_sha256 VARCHAR(64),
                source_path VARCHAR(2048) NOT NULL,
                imported_path VARCHAR(2048) NOT NULL,
                duration_seconds FLOAT,
                sample_rate INTEGER,
                channels INTEGER,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE artifacts (
                id VARCHAR(32) PRIMARY KEY,
                project_id VARCHAR(32) NOT NULL,
                type VARCHAR(64) NOT NULL,
                format VARCHAR(32) NOT NULL,
                path VARCHAR(2048) NOT NULL,
                content_sha256 VARCHAR(64),
                size_bytes INTEGER NOT NULL DEFAULT 0,
                generated_by VARCHAR(128) NOT NULL DEFAULT 'unknown',
                can_delete BOOLEAN NOT NULL DEFAULT 1,
                can_regenerate BOOLEAN NOT NULL DEFAULT 0,
                metadata_json JSON NOT NULL DEFAULT '{}',
                cache_key VARCHAR(128),
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_sha256, source_path, imported_path
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                "proj_legacy",
                "Song",
                None,
                str(external_source_path),
                str(old_imported_path),
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("source_1", "proj_legacy", "source_audio", "wav", str(old_imported_path), "{}"),
        )

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        project = connection.execute(
            """
            SELECT id, source_sha256, source_path, imported_path
            FROM projects
            WHERE display_name = 'Song'
            """
        ).fetchone()
        source_artifact = connection.execute(
            "SELECT project_id, path FROM artifacts WHERE id = 'source_1'"
        ).fetchone()

    assert project == (
        expected_project_id,
        expected_project_hash,
        str(external_source_path),
        str(expected_imported_path),
    )
    assert source_artifact == (expected_project_id, str(expected_imported_path))


def test_sync_identity_migration_recovers_already_moved_project_root(tmp_path: Path) -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    source_path = tmp_path / "source.wav"
    source_path.write_bytes(b"source")
    expected_project_hash = file_sha256(source_path)
    expected_project_id = source_hash_to_project_id(expected_project_hash)
    expected_storage_key = source_hash_to_project_storage_key(expected_project_hash)

    old_project_root = settings.projects_root / "proj_interrupted"
    old_imported_path = old_project_root / "source" / "imported.wav"
    recovered_project_root = settings.projects_root / expected_storage_key
    recovered_imported_path = recovered_project_root / "source" / "imported.wav"
    recovered_imported_path.parent.mkdir(parents=True)
    recovered_imported_path.write_bytes(b"imported")

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0013_analysis_timing",),
        )
        connection.execute(
            """
            CREATE TABLE projects (
                id VARCHAR(32) PRIMARY KEY,
                display_name VARCHAR(255) NOT NULL,
                source_key_override VARCHAR(32),
                source_sha256 VARCHAR(64),
                source_path VARCHAR(2048) NOT NULL,
                imported_path VARCHAR(2048) NOT NULL,
                duration_seconds FLOAT,
                sample_rate INTEGER,
                channels INTEGER,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE artifacts (
                id VARCHAR(32) PRIMARY KEY,
                project_id VARCHAR(32) NOT NULL,
                type VARCHAR(64) NOT NULL,
                format VARCHAR(32) NOT NULL,
                path VARCHAR(2048) NOT NULL,
                content_sha256 VARCHAR(64),
                size_bytes INTEGER NOT NULL DEFAULT 0,
                generated_by VARCHAR(128) NOT NULL DEFAULT 'unknown',
                can_delete BOOLEAN NOT NULL DEFAULT 1,
                can_regenerate BOOLEAN NOT NULL DEFAULT 0,
                metadata_json JSON NOT NULL DEFAULT '{}',
                cache_key VARCHAR(128),
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_sha256, source_path, imported_path
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                "proj_interrupted",
                "Interrupted",
                expected_project_hash,
                str(source_path),
                str(old_imported_path),
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "source_interrupted",
                "proj_interrupted",
                "source_audio",
                "wav",
                str(old_imported_path),
                "{}",
            ),
        )

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        project = connection.execute(
            "SELECT id, imported_path FROM projects WHERE display_name = 'Interrupted'"
        ).fetchone()
        artifact = connection.execute(
            "SELECT project_id, path FROM artifacts WHERE id = 'source_interrupted'"
        ).fetchone()

    assert project == (expected_project_id, str(recovered_imported_path))
    assert artifact == (expected_project_id, str(recovered_imported_path))
    assert recovered_imported_path.exists()


def test_sync_identity_migration_recovers_artifacts_already_referenced_by_new_project_id(tmp_path: Path) -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    old_project_id = "proj_interrupted"
    source_path = tmp_path / "source.wav"
    source_path.write_bytes(b"source")
    expected_project_hash = file_sha256(source_path)
    expected_project_id = source_hash_to_project_id(expected_project_hash)
    expected_storage_key = source_hash_to_project_storage_key(expected_project_hash)

    old_project_root = settings.projects_root / old_project_id
    old_source_path = old_project_root / "source" / "source.wav"
    old_imported_path = old_project_root / "source" / "imported.wav"
    old_stem_path = old_project_root / "stems" / "vocals.wav"
    recovered_project_root = settings.projects_root / expected_storage_key
    recovered_source_path = recovered_project_root / "source" / "source.wav"
    recovered_imported_path = recovered_project_root / "source" / "imported.wav"
    recovered_stem_path = recovered_project_root / "stems" / "vocals.wav"
    recovered_source_path.parent.mkdir(parents=True)
    recovered_source_path.write_bytes(source_path.read_bytes())
    recovered_imported_path.write_bytes(b"imported")

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0013_analysis_timing",),
        )
        connection.execute(
            """
            CREATE TABLE projects (
                id VARCHAR(32) PRIMARY KEY,
                display_name VARCHAR(255) NOT NULL,
                source_key_override VARCHAR(32),
                source_sha256 VARCHAR(64),
                source_path VARCHAR(2048) NOT NULL,
                imported_path VARCHAR(2048) NOT NULL,
                duration_seconds FLOAT,
                sample_rate INTEGER,
                channels INTEGER,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE artifacts (
                id VARCHAR(32) PRIMARY KEY,
                project_id VARCHAR(32) NOT NULL,
                type VARCHAR(64) NOT NULL,
                format VARCHAR(32) NOT NULL,
                path VARCHAR(2048) NOT NULL,
                content_sha256 VARCHAR(64),
                size_bytes INTEGER NOT NULL DEFAULT 0,
                generated_by VARCHAR(128) NOT NULL DEFAULT 'unknown',
                can_delete BOOLEAN NOT NULL DEFAULT 1,
                can_regenerate BOOLEAN NOT NULL DEFAULT 0,
                metadata_json JSON NOT NULL DEFAULT '{}',
                cache_key VARCHAR(128),
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE analysis_results (
                project_id VARCHAR(32) PRIMARY KEY,
                source_artifact_id VARCHAR(32),
                estimated_key VARCHAR(64),
                key_confidence FLOAT,
                estimated_reference_hz FLOAT,
                tuning_offset_cents FLOAT,
                tempo_bpm FLOAT,
                analysis_version VARCHAR(32) NOT NULL DEFAULT 'v3',
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_sha256, source_path, imported_path
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                old_project_id,
                "Interrupted",
                expected_project_hash,
                str(recovered_source_path),
                str(recovered_imported_path),
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "source_interrupted",
                expected_project_id,
                "source_audio",
                "wav",
                str(old_imported_path),
                json.dumps({"original_copy_path": str(old_source_path)}),
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "stem_interrupted",
                expected_project_id,
                "vocal_stem",
                "wav",
                str(old_stem_path),
                json.dumps(
                    {
                        "source_artifact_id": "source_interrupted",
                        "source_path": str(old_imported_path),
                        "copies": [str(old_stem_path)],
                    }
                ),
            ),
        )
        connection.execute(
            """
            INSERT INTO analysis_results (project_id, source_artifact_id)
            VALUES (?, ?)
            """,
            (old_project_id, "source_interrupted"),
        )

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        project = connection.execute(
            """
            SELECT id, source_path, imported_path
            FROM projects
            WHERE display_name = 'Interrupted'
            """
        ).fetchone()
        artifacts = {
            row[0]: row[1:]
            for row in connection.execute(
                """
                SELECT id, project_id, path, metadata_json
                FROM artifacts
                ORDER BY id
                """
            )
        }
        analysis_project_id = connection.execute(
            "SELECT project_id FROM analysis_results WHERE source_artifact_id = 'source_interrupted'"
        ).fetchone()[0]

    assert project == (expected_project_id, str(recovered_source_path), str(recovered_imported_path))
    assert artifacts["source_interrupted"] == (
        expected_project_id,
        str(recovered_imported_path),
        json.dumps({"original_copy_path": str(recovered_source_path)}, separators=(",", ":")),
    )
    assert artifacts["stem_interrupted"] == (
        expected_project_id,
        str(recovered_stem_path),
        json.dumps(
            {
                "source_artifact_id": "source_interrupted",
                "source_path": str(recovered_imported_path),
                "copies": [str(recovered_stem_path)],
            },
            separators=(",", ":"),
        ),
    )
    assert analysis_project_id == expected_project_id


def test_sync_identity_migration_recovers_canonical_project_with_legacy_paths() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    legacy_project_id = "proj_legacy_paths"
    old_project_root = settings.projects_root / legacy_project_id
    old_source_path = old_project_root / "source" / "source.wav"
    old_imported_path = old_project_root / "source" / "imported.wav"
    old_stem_path = old_project_root / "stems" / "vocals.wav"
    old_analysis_path = old_project_root / "analysis" / "analysis.json"
    old_source_path.parent.mkdir(parents=True)
    old_stem_path.parent.mkdir(parents=True)
    old_analysis_path.parent.mkdir(parents=True)
    old_source_path.write_bytes(b"source")
    old_imported_path.write_bytes(b"imported")
    old_stem_path.write_bytes(b"stem")
    old_analysis_path.write_text(json.dumps({"project_id": legacy_project_id, "tempo_bpm": 120}), encoding="utf-8")
    expected_project_hash = file_sha256(old_source_path)
    expected_project_id = source_hash_to_project_id(expected_project_hash)
    expected_storage_key = source_hash_to_project_storage_key(expected_project_hash)
    expected_project_root = settings.projects_root / expected_storage_key
    expected_source_path = expected_project_root / "source" / "source.wav"
    expected_imported_path = expected_project_root / "source" / "imported.wav"
    expected_stem_path = expected_project_root / "stems" / "vocals.wav"
    expected_analysis_path = expected_project_root / "analysis" / "analysis.json"

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0013_analysis_timing",),
        )
        connection.execute(
            """
            CREATE TABLE projects (
                id VARCHAR(80) PRIMARY KEY,
                display_name VARCHAR(255) NOT NULL,
                source_key_override VARCHAR(32),
                source_sha256 VARCHAR(64),
                source_path VARCHAR(2048) NOT NULL,
                imported_path VARCHAR(2048) NOT NULL,
                duration_seconds FLOAT,
                sample_rate INTEGER,
                channels INTEGER,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE artifacts (
                id VARCHAR(32) PRIMARY KEY,
                project_id VARCHAR(80) NOT NULL,
                type VARCHAR(64) NOT NULL,
                format VARCHAR(32) NOT NULL,
                path VARCHAR(2048) NOT NULL,
                content_sha256 VARCHAR(64),
                size_bytes INTEGER NOT NULL DEFAULT 0,
                generated_by VARCHAR(128) NOT NULL DEFAULT 'unknown',
                can_delete BOOLEAN NOT NULL DEFAULT 1,
                can_regenerate BOOLEAN NOT NULL DEFAULT 0,
                metadata_json JSON NOT NULL DEFAULT '{}',
                cache_key VARCHAR(128),
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_sha256, source_path, imported_path
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                expected_project_id,
                "Canonical Interrupted",
                expected_project_hash,
                str(old_source_path),
                str(old_imported_path),
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "source_canonical_interrupted",
                expected_project_id,
                "source_audio",
                "wav",
                str(old_imported_path),
                json.dumps({"original_copy_path": str(old_source_path)}),
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "stem_canonical_interrupted",
                expected_project_id,
                "vocal_stem",
                "wav",
                str(old_stem_path),
                json.dumps({"source_path": str(old_imported_path)}),
            ),
        )

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        project = connection.execute(
            """
            SELECT id, source_path, imported_path
            FROM projects
            WHERE display_name = 'Canonical Interrupted'
            """
        ).fetchone()
        artifacts = {
            row[0]: row[1:]
            for row in connection.execute(
                """
                SELECT id, project_id, path, metadata_json
                FROM artifacts
                ORDER BY id
                """
            )
        }

    assert project == (expected_project_id, str(expected_source_path), str(expected_imported_path))
    assert artifacts["source_canonical_interrupted"] == (
        expected_project_id,
        str(expected_imported_path),
        json.dumps({"original_copy_path": str(expected_source_path)}, separators=(",", ":")),
    )
    assert artifacts["stem_canonical_interrupted"] == (
        expected_project_id,
        str(expected_stem_path),
        json.dumps({"source_path": str(expected_imported_path)}, separators=(",", ":")),
    )
    assert not old_project_root.exists()
    assert expected_stem_path.exists()
    snapshot = json.loads(expected_analysis_path.read_text(encoding="utf-8"))
    assert snapshot == {"project_id": expected_project_id, "tempo_bpm": 120}


def test_sync_identity_migration_recovers_already_rewritten_project_root_and_snapshots() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    old_project_id = "proj_interrupted"
    recovered_project_root = settings.projects_root / "proj_placeholder"
    recovered_source_path = recovered_project_root / "source" / "source.wav"
    recovered_imported_path = recovered_project_root / "source" / "imported.wav"
    recovered_source_path.parent.mkdir(parents=True)
    recovered_source_path.write_bytes(b"source")
    recovered_imported_path.write_bytes(b"imported")
    expected_project_hash = file_sha256(recovered_source_path)
    expected_project_id = source_hash_to_project_id(expected_project_hash)
    expected_storage_key = source_hash_to_project_storage_key(expected_project_hash)
    expected_project_root = settings.projects_root / expected_storage_key
    recovered_project_root.rename(expected_project_root)
    recovered_source_path = expected_project_root / "source" / "source.wav"
    recovered_imported_path = expected_project_root / "source" / "imported.wav"
    analysis_dir = expected_project_root / "analysis"
    analysis_dir.mkdir()
    snapshot_payloads = {
        "analysis.json": {"project_id": old_project_id, "kind": "analysis", "nested": {"project_id": old_project_id}},
        "chords.json": {"project_id": old_project_id, "timeline": [{"project_id": old_project_id, "chord": "C"}]},
        "lyrics.json": {"project_id": old_project_id, "segments": [{"text": "hello"}]},
    }
    for filename, payload in snapshot_payloads.items():
        (analysis_dir / filename).write_text(json.dumps(payload), encoding="utf-8")

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0013_analysis_timing",),
        )
        connection.execute(
            """
            CREATE TABLE projects (
                id VARCHAR(32) PRIMARY KEY,
                display_name VARCHAR(255) NOT NULL,
                source_key_override VARCHAR(32),
                source_sha256 VARCHAR(64),
                source_path VARCHAR(2048) NOT NULL,
                imported_path VARCHAR(2048) NOT NULL,
                duration_seconds FLOAT,
                sample_rate INTEGER,
                channels INTEGER,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE artifacts (
                id VARCHAR(32) PRIMARY KEY,
                project_id VARCHAR(32) NOT NULL,
                type VARCHAR(64) NOT NULL,
                format VARCHAR(32) NOT NULL,
                path VARCHAR(2048) NOT NULL,
                content_sha256 VARCHAR(64),
                size_bytes INTEGER NOT NULL DEFAULT 0,
                generated_by VARCHAR(128) NOT NULL DEFAULT 'unknown',
                can_delete BOOLEAN NOT NULL DEFAULT 1,
                can_regenerate BOOLEAN NOT NULL DEFAULT 0,
                metadata_json JSON NOT NULL DEFAULT '{}',
                cache_key VARCHAR(128),
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE analysis_results (
                project_id VARCHAR(32) PRIMARY KEY,
                source_artifact_id VARCHAR(32),
                estimated_key VARCHAR(64),
                key_confidence FLOAT,
                estimated_reference_hz FLOAT,
                tuning_offset_cents FLOAT,
                tempo_bpm FLOAT,
                analysis_version VARCHAR(32) NOT NULL DEFAULT 'v3',
                created_at DATETIME
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_sha256, source_path, imported_path
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                old_project_id,
                "Interrupted",
                expected_project_hash,
                str(recovered_source_path),
                str(recovered_imported_path),
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "source_interrupted",
                old_project_id,
                "source_audio",
                "wav",
                str(recovered_imported_path),
                json.dumps({"original_copy_path": str(recovered_source_path)}),
            ),
        )
        connection.execute(
            """
            INSERT INTO analysis_results (project_id, source_artifact_id)
            VALUES (?, ?)
            """,
            (old_project_id, "source_interrupted"),
        )

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        project = connection.execute(
            """
            SELECT id, source_path, imported_path
            FROM projects
            WHERE display_name = 'Interrupted'
            """
        ).fetchone()
        artifact = connection.execute(
            "SELECT project_id, path, metadata_json FROM artifacts WHERE id = 'source_interrupted'"
        ).fetchone()
        analysis_project_id = connection.execute(
            "SELECT project_id FROM analysis_results WHERE source_artifact_id = 'source_interrupted'"
        ).fetchone()[0]

    assert project == (expected_project_id, str(recovered_source_path), str(recovered_imported_path))
    assert artifact == (
        expected_project_id,
        str(recovered_imported_path),
        json.dumps({"original_copy_path": str(recovered_source_path)}),
    )
    assert analysis_project_id == expected_project_id
    for filename, payload in snapshot_payloads.items():
        snapshot = json.loads((analysis_dir / filename).read_text(encoding="utf-8"))
        assert snapshot["project_id"] == expected_project_id
        assert {key: value for key, value in snapshot.items() if key != "project_id"} == {
            key: value for key, value in payload.items() if key != "project_id"
        }
