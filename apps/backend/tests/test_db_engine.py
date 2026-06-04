from __future__ import annotations

from app.config import ensure_data_dirs, get_settings
from app.db import (
    SQLITE_BUSY_TIMEOUT_MS,
    SQLITE_BUSY_TIMEOUT_SECONDS,
    _engine_for,
    _engine_options_for,
)


def test_sqlite_engine_sets_driver_busy_timeout() -> None:
    assert _engine_options_for("sqlite:///app.sqlite") == {
        "connect_args": {"timeout": SQLITE_BUSY_TIMEOUT_SECONDS}
    }


def test_non_sqlite_engine_options_are_unchanged() -> None:
    assert _engine_options_for("postgresql://localhost/tuneforge") == {}


def test_sqlite_engine_applies_lock_pragmas() -> None:
    settings = get_settings()
    ensure_data_dirs(settings)
    engine = _engine_for(settings)

    try:
        with engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA busy_timeout").scalar_one() == SQLITE_BUSY_TIMEOUT_MS
            assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one().lower() == "wal"
    finally:
        engine.dispose()
