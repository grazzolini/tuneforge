from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.script.revision import ResolutionError
from alembic.util.exc import CommandError
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from alembic import command
from app.config import Settings, ensure_data_dirs, get_settings


class Base(DeclarativeBase):
    pass


def _engine_for(settings: Settings):
    return create_engine(settings.database_url, future=True)


_engine = _engine_for(get_settings())
SessionLocal = sessionmaker(autoflush=False, expire_on_commit=False, class_=Session)
SessionLocal.configure(bind=_engine)


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
