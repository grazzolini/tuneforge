from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0018_sync_delete_tombstones"
down_revision = "0017_sync_entity_revisions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_delete_tombstones",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("sync_group_id", sa.String(length=80), nullable=False),
        sa.Column("project_id", sa.String(length=80), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=False),
        sa.Column("target_id", sa.String(length=80), nullable=False),
        sa.Column("author_device_id", sa.String(length=96), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("prior_metadata_json", sa.JSON(), nullable=False, server_default="{}"),
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
        "ix_sync_delete_tombstones_project_id",
        "sync_delete_tombstones",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_delete_tombstones_target",
        "sync_delete_tombstones",
        ["target_type", "target_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_delete_tombstones_author_device_id",
        "sync_delete_tombstones",
        ["author_device_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_delete_tombstones_deleted_at",
        "sync_delete_tombstones",
        ["deleted_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_sync_delete_tombstones_deleted_at", table_name="sync_delete_tombstones")
    op.drop_index("ix_sync_delete_tombstones_author_device_id", table_name="sync_delete_tombstones")
    op.drop_index("ix_sync_delete_tombstones_target", table_name="sync_delete_tombstones")
    op.drop_index("ix_sync_delete_tombstones_project_id", table_name="sync_delete_tombstones")
    op.drop_index("uq_sync_delete_tombstones_group_target", table_name="sync_delete_tombstones")
    op.drop_table("sync_delete_tombstones")
