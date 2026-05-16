from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

PROJECT_ID_LENGTH = 80


def utcnow() -> datetime:
    return datetime.now(UTC)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(PROJECT_ID_LENGTH), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(255))
    source_key_override: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
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
    tab_import: Mapped[TabImport | None] = relationship(
        back_populates="project", uselist=False, cascade="all, delete-orphan"
    )
    song_sections: Mapped[list[SongSection]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    artifacts: Mapped[list[Artifact]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    sync_entity_revisions: Mapped[list[SyncEntityRevision]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    jobs: Mapped[list[Job]] = relationship(back_populates="project", cascade="all, delete-orphan")


class SyncLocalIdentity(Base):
    __tablename__ = "sync_local_identities"
    __table_args__ = (
        CheckConstraint("id = 'local'", name="ck_sync_local_identities_singleton"),
        Index("ix_sync_local_identities_sync_group_id", "sync_group_id"),
        Index("uq_sync_local_identities_device_id", "device_id", unique=True),
        Index("uq_sync_local_identities_public_key", "public_key", unique=True),
    )

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default="local")
    sync_group_id: Mapped[str] = mapped_column(String(80))
    device_id: Mapped[str] = mapped_column(String(96))
    display_name: Mapped[str] = mapped_column(String(255))
    public_key: Mapped[str] = mapped_column(String(128))
    private_key: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class SyncTrustedPeer(Base):
    __tablename__ = "sync_trusted_peers"
    __table_args__ = (
        Index("ix_sync_trusted_peers_sync_group_id", "sync_group_id"),
        Index("ix_sync_trusted_peers_revoked_at", "revoked_at"),
        Index("uq_sync_trusted_peers_public_key", "public_key", unique=True),
    )

    device_id: Mapped[str] = mapped_column(String(96), primary_key=True)
    sync_group_id: Mapped[str] = mapped_column(String(80))
    display_name: Mapped[str] = mapped_column(String(255))
    public_key: Mapped[str] = mapped_column(String(128))
    endpoint_hints_json: Mapped[list[str]] = mapped_column(JSON(), default=list)
    trusted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class SyncPairingOffer(Base):
    __tablename__ = "sync_pairing_offers"
    __table_args__ = (
        Index("ix_sync_pairing_offers_expires_at", "expires_at"),
        Index("ix_sync_pairing_offers_used_at", "used_at"),
        Index("uq_sync_pairing_offers_secret_hash", "secret_hash", unique=True),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    secret_hash: Mapped[str] = mapped_column(String(96))
    endpoint_hints_json: Mapped[list[str]] = mapped_column(JSON(), default=list)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SyncStagedArtifact(Base):
    __tablename__ = "sync_staged_artifacts"
    __table_args__ = (
        CheckConstraint("length(content_sha256) = 64", name="ck_sync_staged_artifacts_sha256_len"),
        CheckConstraint("size_bytes >= 0", name="ck_sync_staged_artifacts_size_nonnegative"),
        Index("ix_sync_staged_artifacts_provider_device_id", "provider_device_id"),
        Index("ix_sync_staged_artifacts_verified_at", "verified_at"),
    )

    content_sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    size_bytes: Mapped[int] = mapped_column(Integer())
    relative_path: Mapped[str] = mapped_column(String(2048))
    provider_device_id: Mapped[str | None] = mapped_column(String(96), nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class SyncEntityRevision(Base):
    __tablename__ = "sync_entity_revisions"
    __table_args__ = (
        CheckConstraint(
            "length(content_sha256) = 64",
            name="ck_sync_entity_revisions_sha256_len",
        ),
        Index(
            "ix_sync_entity_revisions_project_entity",
            "project_id",
            "entity_type",
            "entity_id",
        ),
        Index("ix_sync_entity_revisions_base_revision_id", "base_revision_id"),
        Index("ix_sync_entity_revisions_author_device_id", "author_device_id"),
        Index("ix_sync_entity_revisions_state", "state"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE")
    )
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str] = mapped_column(String(PROJECT_ID_LENGTH))
    revision_type: Mapped[str] = mapped_column(String(32))
    base_revision_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("sync_entity_revisions.id", ondelete="SET NULL"), nullable=True
    )
    source_artifact_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("artifacts.id", ondelete="SET NULL"), nullable=True
    )
    content_sha256: Mapped[str] = mapped_column(String(64))
    author_device_id: Mapped[str] = mapped_column(String(96))
    state: Mapped[str] = mapped_column(String(32), default="active")
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    project: Mapped[Project] = relationship(back_populates="sync_entity_revisions")


class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    source_artifact_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    estimated_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    key_confidence: Mapped[float | None] = mapped_column(Float(), nullable=True)
    estimated_reference_hz: Mapped[float | None] = mapped_column(Float(), nullable=True)
    tuning_offset_cents: Mapped[float | None] = mapped_column(Float(), nullable=True)
    tempo_bpm: Mapped[float | None] = mapped_column(Float(), nullable=True)
    timing_json: Mapped[dict[str, Any] | None] = mapped_column(JSON(), nullable=True)
    analysis_version: Mapped[str] = mapped_column(String(32), default="v3")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="analysis")


class ChordTimeline(Base):
    __tablename__ = "chord_timelines"

    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    backend: Mapped[str] = mapped_column(String(64), default="default")
    source_artifact_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    timeline_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON(), default=list)
    source_segments_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON(), default=list)
    segments_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON(), default=list)
    source_kind: Mapped[str] = mapped_column(String(32), default="generated")
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    has_user_edits: Mapped[bool] = mapped_column(Boolean(), default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=True
    )

    project: Mapped[Project] = relationship(back_populates="chords")


class LyricsTranscript(Base):
    __tablename__ = "lyrics_transcripts"

    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
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


class TabImport(Base):
    __tablename__ = "tab_imports"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE")
    )
    raw_text: Mapped[str] = mapped_column(Text())
    parser_version: Mapped[str] = mapped_column(String(32), default="v1")
    status: Mapped[str] = mapped_column(String(32), default="proposed")
    parsed_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    proposal_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    project: Mapped[Project] = relationship(back_populates="tab_import")
    song_sections: Mapped[list[SongSection]] = relationship(back_populates="tab_import")

    @property
    def groups(self) -> list[dict[str, Any]]:
        groups = self.proposal_json.get("groups")
        return groups if isinstance(groups, list) else []


class SongSection(Base):
    __tablename__ = "song_sections"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE")
    )
    tab_import_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("tab_imports.id", ondelete="SET NULL"), nullable=True
    )
    label: Mapped[str] = mapped_column(String(128))
    start_seconds: Mapped[float | None] = mapped_column(Float(), nullable=True)
    end_seconds: Mapped[float | None] = mapped_column(Float(), nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="tab")
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    project: Mapped[Project] = relationship(back_populates="song_sections")
    tab_import: Mapped[TabImport | None] = relationship(back_populates="song_sections")


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE")
    )
    type: Mapped[str] = mapped_column(String(64))
    format: Mapped[str] = mapped_column(String(32))
    path: Mapped[str] = mapped_column(String(2048))
    content_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
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
        String(PROJECT_ID_LENGTH), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True
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

    @property
    def chord_source(self) -> str | None:
        if self.type != "chords":
            return None
        value = self.payload_json.get("chord_source")
        return value if isinstance(value, str) else None

    @property
    def chord_backend(self) -> str | None:
        if self.type != "chords":
            return None
        value = self.payload_json.get("chord_backend")
        if isinstance(value, str):
            return value
        fallback = self.payload_json.get("backend")
        if fallback == "default":
            return "tuneforge-fast"
        return fallback if isinstance(fallback, str) else None

    @property
    def chord_backend_fallback_from(self) -> str | None:
        if self.type != "chords":
            return None
        value = self.payload_json.get("backend_fallback_from")
        if isinstance(value, str):
            return value
        value = self.payload_json.get("chord_backend_fallback_from")
        return value if isinstance(value, str) else None

    @property
    def stem_model(self) -> str | None:
        if self.type != "stems":
            return None
        value = self.payload_json.get("stem_model")
        return value if isinstance(value, str) else None

    @property
    def stem_model_label(self) -> str | None:
        value = self.payload_json.get("stem_model_label")
        if isinstance(value, str):
            return value
        if self.stem_model == "htdemucs_6s":
            return "Default (6 stems model)"
        if self.stem_model == "htdemucs_ft":
            return "2 stems model"
        return self.stem_model


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value_json: Mapped[dict[str, Any]] = mapped_column(JSON(), default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
