from __future__ import annotations

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import SongSection, TabImport


def clear_project_tab_state(session: Session, *, project_id: str) -> None:
    session.execute(delete(SongSection).where(SongSection.project_id == project_id, SongSection.source == "tab"))
    session.execute(delete(TabImport).where(TabImport.project_id == project_id))
    session.flush()
