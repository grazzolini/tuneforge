from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(255))
    source_key_override: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_path: Mapped[str] = mapped_column(String(2048))
    imported_path: Mapped[str] = mapped_column(String(2048))
    duration_seconds: Mapped[float | None] = mapped_column(Float(), nullable=True)
    sample_rate: Mapped[int | None] = mapped_column(Integer(), nullable=True)
    channels: Mapped[int | None] = mapped_column(Integer(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    analysis: Mapped[AnalysisResult | None] = relationship(
        back_populates="project", uselist=False, cascade="all, delete-orphan"
    )
    chords: Mapped[ChordTimeline | None] = relationship(
        back_populates="project", uselist=False, cascade="all, delete-orphan"
    )
    lyrics: Mapped[LyricsTranscript | None] = relationship(
        back_populates="project", uselist=False, cascade="all, delete-orphan"
    )
    artifacts: Mapped[list[Artifact]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    jobs: Mapped[list[Job]] = relationship(back_populates="project", cascade="all, delete-orphan")


class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    source_artifact_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    estimated_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    key_confidence: Mapped[float | None] = mapped_column(Float(), nullable=True)
    estimated_reference_hz: Mapped[float | None] = mapped_column(Float(), nullable=True)
    tuning_offset_cents: Mapped[float | None] = mapped_column(Float(), nullable=True)
    tempo_bpm: Mapped[float | None] = mapped_column(Float(), nullable=True)
    analysis_version: Mapped[str] = mapped_column(String(32), default="v1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="analysis")


class ChordTimeline(Base):
    __tablename__ = "chord_timelines"

    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    backend: Mapped[str] = mapped_column(String(64), default="default")
    source_artifact_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    timeline_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON(), default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="chords")


class LyricsTranscript(Base):
    __tablename__ = "lyrics_transcripts"

    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    backend: Mapped[str] = mapped_column(String(64), default="openai-whisper")
    source_artifact_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_kind: Mapped[str] = mapped_column(String(32), default="ai")
    requested_device: Mapped[str | None] = mapped_column(String(16), nullable=True)
    device: Mapped[str | None] = mapped_column(String(16), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    language: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_segments_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON(), default=list)
    segments_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON(), default=list)
    has_user_edits: Mapped[bool] = mapped_column(Boolean(), default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    project: Mapped[Project] = relationship(back_populates="lyrics")


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(32), ForeignKey("projects.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(64))
    format: Mapped[str] = mapped_column(String(32))
    path: Mapped[str] = mapped_column(String(2048))
    size_bytes: Mapped[int] = mapped_column(Integer(), default=0)
    generated_by: Mapped[str] = mapped_column(String(128), default="unknown")
    can_delete: Mapped[bool] = mapped_column(Boolean(), default=True)
    can_regenerate: Mapped[bool] = mapped_column(Boolean(), default=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    cache_key: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="artifacts")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True
    )
    type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default="pending")
    progress: Mapped[int] = mapped_column(Integer(), default=0)
    error_message: Mapped[str | None] = mapped_column(Text(), nullable=True)
    runtime_device: Mapped[str | None] = mapped_column(String(16), nullable=True)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    result_artifact_ids_json: Mapped[list[str]] = mapped_column(JSON(), default=list)
    cancel_requested: Mapped[bool] = mapped_column(Boolean(), default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float(), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    project: Mapped[Project | None] = relationship(back_populates="jobs")

    @property
    def source_artifact_id(self) -> str | None:
        value = self.payload_json.get("source_artifact_id")
        return value if isinstance(value, str) else None


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
