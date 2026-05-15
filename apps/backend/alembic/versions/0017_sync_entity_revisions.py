from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0017_sync_entity_revisions"
down_revision = "0016_sync_artifact_staging"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
        sa.Column("state", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("payload_json", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(content_sha256) = 64",
            name="ck_sync_entity_revisions_sha256_len",
        ),
        sa.ForeignKeyConstraint(["base_revision_id"], ["sync_entity_revisions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_artifact_id"], ["artifacts.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sync_entity_revisions_project_entity",
        "sync_entity_revisions",
        ["project_id", "entity_type", "entity_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_entity_revisions_base_revision_id",
        "sync_entity_revisions",
        ["base_revision_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_entity_revisions_author_device_id",
        "sync_entity_revisions",
        ["author_device_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_entity_revisions_state",
        "sync_entity_revisions",
        ["state"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_sync_entity_revisions_state", table_name="sync_entity_revisions")
    op.drop_index("ix_sync_entity_revisions_author_device_id", table_name="sync_entity_revisions")
    op.drop_index("ix_sync_entity_revisions_base_revision_id", table_name="sync_entity_revisions")
    op.drop_index("ix_sync_entity_revisions_project_entity", table_name="sync_entity_revisions")
    op.drop_table("sync_entity_revisions")
