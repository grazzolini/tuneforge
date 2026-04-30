from __future__ import annotations

import sqlite3

import pytest

from app.config import ensure_data_dirs, get_settings
from app.db import UnknownDatabaseRevisionError, reconfigure_engine, run_migrations


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
