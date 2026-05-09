from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.config import ensure_data_dirs, get_settings
from app.db import UnknownDatabaseRevisionError, reconfigure_engine, run_migrations
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


def test_hash_storage_migration_backfills_existing_files(tmp_path: Path) -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    source_path = tmp_path / "source.wav"
    artifact_path = tmp_path / "artifact.wav"
    source_path.write_bytes(b"source")
    artifact_path.write_bytes(b"artifact")

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
            INSERT INTO projects (
                id, display_name, source_path, imported_path
            ) VALUES (?, ?, ?, ?)
            """,
            ("proj_1", "Song", str(source_path), str(source_path)),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "art_1",
                "proj_1",
                "vocal_stem",
                "wav",
                str(artifact_path),
                '{"source_artifact_id":"source_1"}',
            ),
        )

    reconfigure_engine(settings)
    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        project_hash = connection.execute(
            "SELECT source_sha256 FROM projects WHERE id = 'proj_1'"
        ).fetchone()[0]
        artifact_hash = connection.execute(
            "SELECT content_sha256 FROM artifacts WHERE id = 'art_1'"
        ).fetchone()[0]
        indexes = {
            row[1]
            for row in connection.execute("PRAGMA index_list('artifacts')")
        }

    assert project_hash == file_sha256(source_path)
    assert artifact_hash == file_sha256(artifact_path)
    assert "ix_artifacts_content_sha256" in indexes
    assert "uq_artifacts_stem_per_source" in indexes
