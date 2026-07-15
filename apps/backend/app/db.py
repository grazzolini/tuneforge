from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.script.revision import ResolutionError
from alembic.util.exc import CommandError
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from alembic import command
from app.config import Settings, ensure_data_dirs, get_settings

SQLITE_BUSY_TIMEOUT_SECONDS = 30.0
SQLITE_BUSY_TIMEOUT_MS = int(SQLITE_BUSY_TIMEOUT_SECONDS * 1000)


class Base(DeclarativeBase):
    pass


def _engine_for(settings: Settings) -> Engine:
    engine = create_engine(
        settings.database_url,
        future=True,
        **_engine_options_for(settings.database_url),
    )
    if _is_sqlite_database_url(settings.database_url):
        _configure_sqlite_engine(
            engine,
            enable_wal=_sqlite_database_supports_wal(settings.database_url),
        )
    return engine


def _engine_options_for(database_url: str) -> dict[str, Any]:
    if not _is_sqlite_database_url(database_url):
        return {}
    return {"connect_args": {"timeout": SQLITE_BUSY_TIMEOUT_SECONDS}}


def _is_sqlite_database_url(database_url: str) -> bool:
    return make_url(database_url).drivername.startswith("sqlite")


def _sqlite_database_supports_wal(database_url: str) -> bool:
    database_path = make_url(database_url).database
    return database_path not in {None, "", ":memory:"}


def _configure_sqlite_engine(engine: Engine, *, enable_wal: bool) -> None:
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection: sqlite3.Connection, _connection_record: object) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
            if enable_wal:
                cursor.execute("PRAGMA journal_mode = WAL")
        finally:
            cursor.close()


_engine = _engine_for(get_settings())
SessionLocal = sessionmaker(autoflush=False, expire_on_commit=False, class_=Session)
SessionLocal.configure(bind=_engine)


@event.listens_for(Session, "before_commit")
def _prepare_project_storage_reconciliations(session: Session) -> None:
    if session.get_nested_transaction() is not None:
        return
    from app.services.project_storage import prepare_project_storage_reconciliations

    prepare_project_storage_reconciliations(session)


@event.listens_for(Session, "after_commit")
def _drain_project_storage_reconciliations(session: Session) -> None:
    if session.get_nested_transaction() is not None:
        return
    from app.services.project_storage import drain_project_storage_reconciliations

    drain_project_storage_reconciliations(session)


@event.listens_for(Session, "after_rollback")
def _discard_project_storage_reconciliations(session: Session) -> None:
    from app.services.project_storage import discard_project_storage_reconciliations

    discard_project_storage_reconciliations(session)


class UnknownDatabaseRevisionError(RuntimeError):
    pass


def reconfigure_engine(settings: Settings) -> None:
    global _engine, SessionLocal
    _engine.dispose()
    _engine = _engine_for(settings)
    SessionLocal.configure(bind=_engine)


def get_engine():
    return _engine


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def run_migrations(settings: Settings | None = None) -> None:
    current = settings or get_settings()
    ensure_data_dirs(current)
    config = _migration_config(current)
    _ensure_database_revision_is_known(current, config)
    command.upgrade(config, "head")


def _migration_config(settings: Settings) -> Config:
    config = Config(str(settings.backend_root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", settings.database_url)
    config.set_main_option("script_location", str(settings.backend_root / "alembic"))
    return config


def _ensure_database_revision_is_known(settings: Settings, config: Config) -> None:
    script = ScriptDirectory.from_config(config)
    with _engine.connect() as connection:
        migration_context = MigrationContext.configure(connection)
        current_revisions = migration_context.get_current_heads()

    unknown_revisions: list[str] = []
    for revision in current_revisions:
        try:
            script.get_revision(revision)
        except (CommandError, ResolutionError):
            unknown_revisions.append(revision)

    if unknown_revisions:
        known_heads = ", ".join(script.get_heads()) or "base"
        unknown = ", ".join(unknown_revisions)
        raise UnknownDatabaseRevisionError(
            "Database migration history references revision(s) that this checkout does not know: "
            f"{unknown}.\n"
            f"Database: {settings.database_path}\n"
            f"Known migration head(s) in this checkout: {known_heads}\n"
            "This usually happens after running a branch with newer migrations, then switching to a branch "
            "without those migration files. Switch to a branch containing the missing migration, merge or rebase "
            "the migration into this checkout, or run this branch with a separate TUNEFORGE_DATA_DIR."
        )
