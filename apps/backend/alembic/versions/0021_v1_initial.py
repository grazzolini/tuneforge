from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0021_job_runtime_status"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.String(length=80), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("source_path", sa.String(length=2048), nullable=False),
        sa.Column("imported_path", sa.String(length=2048), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("sample_rate", sa.Integer(), nullable=True),
        sa.Column("channels", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_key_override", sa.String(length=32), nullable=True),
        sa.Column("source_sha256", sa.String(length=64), nullable=True),
        sa.Column("sync_status", sa.String(length=32), nullable=False, server_default="local"),
        sa.Column("sync_status_reason", sa.Text(), nullable=True),
        sa.Column("sync_required_artifact_ids_json", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("sync_provider_device_ids_json", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("sync_conflict_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "sync_status_updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "sync_status IN ("
            "'local', "
            "'syncing', "
            "'remote_available', "
            "'downloading', "
            "'missing', "
            "'deleted', "
            "'conflicted'"
            ")",
            name="ck_projects_sync_status",
        ),
        sa.CheckConstraint(
            "sync_conflict_count >= 0",
            name="ck_projects_sync_conflict_count_nonnegative",
        ),
    )
    op.create_index("ix_projects_source_sha256", "projects", ["source_sha256"], unique=False)
    op.create_index("ix_projects_sync_status", "projects", ["sync_status"], unique=False)

    op.create_table(
        "settings",
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("value_json", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )

    op.create_table(
        "artifacts",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("format", sa.String(length=32), nullable=False),
        sa.Column("path", sa.String(length=2048), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("cache_key", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "size_bytes",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "generated_by",
            sa.String(length=128),
            nullable=False,
            server_default="unknown",
        ),
        sa.Column(
            "can_delete",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column(
            "can_regenerate",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("content_sha256", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("cache_key"),
    )
    op.create_index("ix_artifacts_content_sha256", "artifacts", ["content_sha256"], unique=False)
    op.create_index("ix_artifacts_project_id", "artifacts", ["project_id"], unique=False)
    op.execute(
        """
        CREATE UNIQUE INDEX uq_artifacts_analysis_json_project
        ON artifacts (project_id)
        WHERE type = 'analysis_json'
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_artifacts_stem_per_source
        ON artifacts (
            project_id,
            type,
            json_extract(metadata_json, '$.source_artifact_id'),
            coalesce(json_extract(metadata_json, '$.stem_model'), '')
        )
        WHERE type IN (
            'vocal_stem',
            'instrumental_stem',
            'drums_stem',
            'bass_stem',
            'guitar_stem',
            'piano_stem',
            'other_stem'
        )
        """
    )

    op.create_table(
        "analysis_results",
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("estimated_key", sa.String(length=64), nullable=True),
        sa.Column("key_confidence", sa.Float(), nullable=True),
        sa.Column("estimated_reference_hz", sa.Float(), nullable=True),
        sa.Column("tuning_offset_cents", sa.Float(), nullable=True),
        sa.Column("tempo_bpm", sa.Float(), nullable=True),
        sa.Column("analysis_version", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_artifact_id", sa.String(length=32), nullable=True),
        sa.Column("timing_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("project_id"),
    )

    op.create_table(
        "chord_timelines",
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("source_artifact_id", sa.String(length=32), nullable=True),
        sa.Column("timeline_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_segments_json", sa.JSON(), nullable=True),
        sa.Column("segments_json", sa.JSON(), nullable=True),
        sa.Column(
            "has_user_edits",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "source_kind",
            sa.String(length=32),
            nullable=False,
            server_default="generated",
        ),
        sa.Column(
            "metadata_json",
            sa.JSON(),
            nullable=False,
            server_default="{}",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("project_id"),
    )

    op.create_table(
        "lyrics_transcripts",
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("source_artifact_id", sa.String(length=32), nullable=True),
        sa.Column("source_kind", sa.String(length=32), nullable=False),
        sa.Column("source_segments_json", sa.JSON(), nullable=False),
        sa.Column("segments_json", sa.JSON(), nullable=False),
        sa.Column("has_user_edits", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("requested_device", sa.String(length=16), nullable=True),
        sa.Column("device", sa.String(length=16), nullable=True),
        sa.Column("model_name", sa.String(length=64), nullable=True),
        sa.Column("language", sa.String(length=32), nullable=True),
        sa.Column("language_override", sa.String(length=16), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("project_id"),
    )

    op.create_table(
        "tab_imports",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("raw_text", sa.Text(), nullable=False),
        sa.Column("parser_version", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("parsed_json", sa.JSON(), nullable=False),
        sa.Column("proposal_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tab_imports_project_id", "tab_imports", ["project_id"], unique=True)

    op.create_table(
        "song_sections",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("tab_import_id", sa.String(length=32), nullable=True),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("start_seconds", sa.Float(), nullable=True),
        sa.Column("end_seconds", sa.Float(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tab_import_id"],
            ["tab_imports.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_song_sections_project_id", "song_sections", ["project_id"], unique=False)
    op.create_index("ix_song_sections_tab_import_id", "song_sections", ["tab_import_id"], unique=False)

    op.create_table(
        "jobs",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=80), nullable=True),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("result_artifact_ids_json", sa.JSON(), nullable=False),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("runtime_device", sa.String(length=16), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("stage", sa.String(length=32), nullable=True),
        sa.Column("stage_label", sa.String(length=160), nullable=True),
        sa.Column("runtime_detail", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_jobs_project_id", "jobs", ["project_id"], unique=False)

    op.create_table(
        "sync_local_identities",
        sa.Column("id", sa.String(length=16), nullable=False),
        sa.Column("sync_group_id", sa.String(length=80), nullable=False),
        sa.Column("device_id", sa.String(length=96), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("public_key", sa.String(length=128), nullable=False),
        sa.Column("private_key", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "id = 'local'",
            name="ck_sync_local_identities_singleton",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sync_local_identities_sync_group_id", "sync_local_identities", ["sync_group_id"], unique=False
    )
    op.create_index("uq_sync_local_identities_device_id", "sync_local_identities", ["device_id"], unique=True)
    op.create_index("uq_sync_local_identities_public_key", "sync_local_identities", ["public_key"], unique=True)

    op.create_table(
        "sync_trusted_peers",
        sa.Column("device_id", sa.String(length=96), nullable=False),
        sa.Column("sync_group_id", sa.String(length=80), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("public_key", sa.String(length=128), nullable=False),
        sa.Column("endpoint_hints_json", sa.JSON(), nullable=False),
        sa.Column("trusted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("device_id"),
    )
    op.create_index("ix_sync_trusted_peers_sync_group_id", "sync_trusted_peers", ["sync_group_id"], unique=False)
    op.create_index("ix_sync_trusted_peers_revoked_at", "sync_trusted_peers", ["revoked_at"], unique=False)
    op.create_index("uq_sync_trusted_peers_public_key", "sync_trusted_peers", ["public_key"], unique=True)

    op.create_table(
        "sync_pairing_offers",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("secret_hash", sa.String(length=96), nullable=False),
        sa.Column("endpoint_hints_json", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sync_pairing_offers_expires_at", "sync_pairing_offers", ["expires_at"], unique=False)
    op.create_index("ix_sync_pairing_offers_used_at", "sync_pairing_offers", ["used_at"], unique=False)
    op.create_index("uq_sync_pairing_offers_secret_hash", "sync_pairing_offers", ["secret_hash"], unique=True)

    op.create_table(
        "sync_staged_artifacts",
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("relative_path", sa.String(length=2048), nullable=False),
        sa.Column("provider_device_id", sa.String(length=96), nullable=True),
        sa.Column(
            "metadata_json",
            sa.JSON(),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(content_sha256) = 64",
            name="ck_sync_staged_artifacts_sha256_len",
        ),
        sa.CheckConstraint(
            "size_bytes >= 0",
            name="ck_sync_staged_artifacts_size_nonnegative",
        ),
        sa.PrimaryKeyConstraint("content_sha256"),
    )
    op.create_index(
        "ix_sync_staged_artifacts_provider_device_id", "sync_staged_artifacts", ["provider_device_id"], unique=False
    )
    op.create_index(
        "ix_sync_staged_artifacts_verified_at", "sync_staged_artifacts", ["verified_at"], unique=False
    )

    op.create_table(
        "sync_entity_revisions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=80), nullable=False),
        sa.Column("revision_type", sa.String(length=32), nullable=False),
        sa.Column("base_revision_id", sa.String(length=64), nullable=True),
        sa.Column("source_artifact_id", sa.String(length=32), nullable=True),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("author_device_id", sa.String(length=96), nullable=False),
        sa.Column(
            "state",
            sa.String(length=32),
            nullable=False,
            server_default="active",
        ),
        sa.Column(
            "metadata_json",
            sa.JSON(),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "payload_json",
            sa.JSON(),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(content_sha256) = 64",
            name="ck_sync_entity_revisions_sha256_len",
        ),
        sa.ForeignKeyConstraint(
            ["base_revision_id"],
            ["sync_entity_revisions.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_artifact_id"],
            ["artifacts.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sync_entity_revisions_project_entity",
        "sync_entity_revisions",
        ["project_id", "entity_type", "entity_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_entity_revisions_base_revision_id", "sync_entity_revisions", ["base_revision_id"], unique=False
    )
    op.create_index(
        "ix_sync_entity_revisions_author_device_id", "sync_entity_revisions", ["author_device_id"], unique=False
    )
    op.create_index("ix_sync_entity_revisions_state", "sync_entity_revisions", ["state"], unique=False)

    op.create_table(
        "sync_delete_tombstones",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("sync_group_id", sa.String(length=80), nullable=False),
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=False),
        sa.Column("target_id", sa.String(length=80), nullable=False),
        sa.Column("author_device_id", sa.String(length=96), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "prior_metadata_json",
            sa.JSON(),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_sync_delete_tombstones_group_target",
        "sync_delete_tombstones",
        ["sync_group_id", "target_type", "target_id"],
        unique=True,
    )
    op.create_index(
        "ix_sync_delete_tombstones_project_id", "sync_delete_tombstones", ["project_id"], unique=False
    )
    op.create_index(
        "ix_sync_delete_tombstones_target", "sync_delete_tombstones", ["target_type", "target_id"], unique=False
    )
    op.create_index(
        "ix_sync_delete_tombstones_author_device_id",
        "sync_delete_tombstones",
        ["author_device_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_delete_tombstones_deleted_at", "sync_delete_tombstones", ["deleted_at"], unique=False
    )


def downgrade() -> None:
    op.drop_table("sync_delete_tombstones")
    op.drop_table("sync_entity_revisions")
    op.drop_table("sync_staged_artifacts")
    op.drop_table("sync_pairing_offers")
    op.drop_table("sync_trusted_peers")
    op.drop_table("sync_local_identities")
    op.drop_table("jobs")
    op.drop_table("song_sections")
    op.drop_table("tab_imports")
    op.drop_table("lyrics_transcripts")
    op.drop_table("chord_timelines")
    op.drop_table("analysis_results")
    op.drop_table("artifacts")
    op.drop_table("settings")
    op.drop_table("projects")
