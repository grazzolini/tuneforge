from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from alembic.config import Config
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
    config = Config(str(current.backend_root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", current.database_url)
    config.set_main_option("script_location", str(current.backend_root / "alembic"))
    command.upgrade(config, "head")
