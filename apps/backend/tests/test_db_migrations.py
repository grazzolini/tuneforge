from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

import pytest

from alembic import command
from app.config import ensure_data_dirs, get_settings
from app.db import (
    UnknownDatabaseRevisionError,
    _migration_config,
    reconfigure_engine,
    run_migrations,
)

# Derived from a database upgraded through the complete pre-baseline migration
# chain. Each digest covers the full table-keyed signature assembled below.
EXPECTED_SCHEMA_SIGNATURE_SHA256_BY_TABLE = {
    "analysis_results": "4e0f43fa85b02f2e042cd159bc55a76d91f7473f19e077023cbb197806e7dfc2",
    "artifacts": "82bd9b3a44809a681387d12761947e9b0a145434002f522e94e9c46f1b27368c",
    "chord_timelines": "954cbc2f4a48703610257fe3f2e50719c41ad6840ac47b52cd39946e3f2b2a02",
    "jobs": "985336056a11b651fd8481814540e4331ad9fa357af24cf04ad6f877fa83a184",
    "lyrics_transcripts": "71d1b26a1ab12bcab6acd586445c74f4ae85006d3db3cbe1c17a826c359c4f64",
    "projects": "805b17f8733c3f8fa9a12cde45ebb97901045f52464196b26cc5daa3f7f6f26f",
    "settings": "da7bd8dd2a15802d64c86c2986360eb010b7ce4cd956785a2fec356d5f21c9e8",
    "song_sections": "0d8f23683ab05f1c91438852610f0deafde29044355fdb102de94b19d8702b0a",
    "sync_delete_tombstones": "4328886fa2e63598943d40360f664053892da11783413888b8f7d557e8723ec7",
    "sync_entity_revisions": "c438f8286352c8f20387a13d4209216d76cd0f9932743a92901cbf8a2851e471",
    "sync_local_identities": "beb94f479e9c189e7b2c582b4acc4f8587471d50873dc7f28db5b3a00fcd6233",
    "sync_pairing_offers": "58ea114df56d6aa83d00b519af3a62b831c21363d57cc26d53bf2e6f332cf7b4",
    "sync_staged_artifacts": "8abd9c34212a5f2870b23df26eb066425450d5e80b8805b70c35b7e6fd095181",
    "sync_trusted_peers": "ce39cbce93c759ef39f8cce7ac6ec990fd80b4cabb9bf5e41ec29a21ad00d99a",
    "tab_imports": "d44c27b31cb3fb4541ea42cea4875cc2ab66caac878d49abe90eeac48faa5115",
}


def _normalize_schema_sql(sql: str | None) -> str | None:
    if sql is None:
        return None
    return " ".join(sql.replace('"', "").split())


def _canonical_table_signature(
    connection: sqlite3.Connection,
    table: str,
) -> dict[str, Any]:
    index_rows = connection.execute(f"PRAGMA index_list({table!r})").fetchall()
    table_sql = connection.execute(
        """
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        """,
        (table,),
    ).fetchone()
    index_sql = connection.execute(
        """
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = ?
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
        """,
        (table,),
    ).fetchall()
    return {
        "table_info": [
            list(row)
            for row in connection.execute(f"PRAGMA table_info({table!r})")
        ],
        "foreign_key_list": [
            list(row)
            for row in connection.execute(f"PRAGMA foreign_key_list({table!r})")
        ],
        # SQLite's sequence number reflects creation order, not index structure.
        "index_list": {
            row[1]: [row[2], row[3], row[4]]
            for row in index_rows
        },
        "index_xinfo": {
            row[1]: [
                list(index_column)
                for index_column in connection.execute(
                    f"PRAGMA index_xinfo({row[1]!r})"
                )
            ]
            for row in index_rows
        },
        # Full normalized DDL freezes CHECK clauses, unique constraints, index
        # expressions, and partial-index predicates without depending on SQL
        # formatting introduced by SQLite table rebuilds.
        "sqlite_master": {
            "table": _normalize_schema_sql(table_sql[0]),
            "indexes": {
                name: _normalize_schema_sql(sql)
                for name, sql in index_sql
            },
        },
    }


def _schema_signature_sha256(signature: dict[str, Any]) -> str:
    encoded = json.dumps(
        signature,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _database_snapshot(connection: sqlite3.Connection) -> tuple[object, ...]:
    return (
        connection.execute(
            """
            SELECT type, name, tbl_name, sql
            FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name
            """
        ).fetchall(),
        connection.execute(
            """
            SELECT id, display_name, source_path, imported_path, sync_status
            FROM projects
            """
        ).fetchall(),
        connection.execute(
            """
            SELECT id, project_id, type, path, content_sha256
            FROM artifacts
            """
        ).fetchall(),
        connection.execute(
            """
            SELECT id, project_id, status, runtime_device, stage, runtime_detail
            FROM jobs
            """
        ).fetchall(),
    )


def test_fresh_v1_baseline_matches_frozen_pre_v1_schema_signature() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)

    command.upgrade(_migration_config(settings), "0021_job_runtime_status")

    with sqlite3.connect(settings.database_path) as connection:
        revision = connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone()[0]
        tables = tuple(
            row[0]
            for row in connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name NOT LIKE 'sqlite_%'
                  AND name != 'alembic_version'
                ORDER BY name
                """
            )
        )
        signatures = {
            table: _schema_signature_sha256(
                _canonical_table_signature(connection, table)
            )
            for table in tables
        }

    assert revision == "0021_job_runtime_status"
    assert tables == tuple(EXPECTED_SCHEMA_SIGNATURE_SHA256_BY_TABLE)
    assert signatures == EXPECTED_SCHEMA_SIGNATURE_SHA256_BY_TABLE


def test_stamped_v1_database_is_noop_and_preserves_data() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)
    timestamp = "2026-07-23 12:00:00+00:00"
    source_path = str(settings.projects_root / "synthetic" / "source.wav")
    artifact_path = str(settings.projects_root / "synthetic" / "analysis.json")

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            """
            INSERT INTO projects (
                id, display_name, source_path, imported_path, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "project_reference",
                "Synthetic Reference",
                source_path,
                source_path,
                timestamp,
                timestamp,
            ),
        )
        connection.execute(
            """
            INSERT INTO artifacts (
                id, project_id, type, format, path, metadata_json, created_at,
                content_sha256, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "artifact_reference",
                "project_reference",
                "analysis_json",
                "json",
                artifact_path,
                '{"source_artifact_id":"source_reference"}',
                timestamp,
                "a" * 64,
                timestamp,
            ),
        )
        connection.execute(
            """
            INSERT INTO jobs (
                id, project_id, type, status, progress, payload_json,
                result_artifact_ids_json, cancel_requested, created_at, updated_at,
                runtime_device, stage, runtime_detail
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "job_reference",
                "project_reference",
                "analyze",
                "completed",
                100,
                '{"source_artifact_id":"source_reference"}',
                '["artifact_reference"]',
                0,
                timestamp,
                timestamp,
                "cpu",
                "finalize",
                "Synthetic runtime detail",
            ),
        )
        before = _database_snapshot(connection)

    run_migrations(settings)

    with sqlite3.connect(settings.database_path) as connection:
        after = _database_snapshot(connection)
        revision = connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone()[0]

    assert revision == "0022_artifact_updated_at"
    assert after == before


def test_artifact_updated_at_migration_backfills_created_at() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    command.upgrade(_migration_config(settings), "0021_job_runtime_status")
    timestamp = "2026-07-23 12:00:00+00:00"
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "INSERT INTO projects "
            "(id, display_name, source_path, imported_path, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("project_reference", "Reference", "/tmp/source.wav", "/tmp/source.wav", timestamp, timestamp),
        )
        connection.execute(
            "INSERT INTO artifacts "
            "(id, project_id, type, format, path, metadata_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("artifact_reference", "project_reference", "source_audio", "wav", "/tmp/source.wav", "{}", timestamp),
        )

    command.upgrade(_migration_config(settings), "head")

    with sqlite3.connect(settings.database_path) as connection:
        created_at, updated_at = connection.execute(
            "SELECT created_at, updated_at FROM artifacts WHERE id = 'artifact_reference'"
        ).fetchone()
    assert updated_at == created_at


def test_pre_v1_revision_reports_safe_v1_recovery_path() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"
        )
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0019_sync_project_state",),
        )

    reconfigure_engine(settings)

    with pytest.raises(UnknownDatabaseRevisionError) as exc:
        run_migrations(settings)

    message = str(exc.value)
    assert "0019_sync_project_state" in message
    assert str(settings.database_path) in message
    assert "revisions 0001 through 0020 are pre-v1 history" in message
    assert "close every TuneForge instance" in message
    assert "entire TuneForge data directory" in message
    assert "SQLite sidecar files" in message
    assert "project and artifact files" in message
    assert "app.sqlite alone is not sufficient" in message
    assert "TuneForge v1.0.0" in message
    assert "0021_job_runtime_status" in message
    assert "branch with newer migrations" in message
    assert "separate TUNEFORGE_DATA_DIR" in message


def test_v1_baseline_downgrade_removes_application_schema() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)

    command.downgrade(_migration_config(settings), "base")

    with sqlite3.connect(settings.database_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                """
            )
        }
        indexes = {
            row[0]
            for row in connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
                """
            )
        }
        revisions = connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchall()

    assert tables == {"alembic_version"}
    assert indexes == set()
    assert revisions == []
