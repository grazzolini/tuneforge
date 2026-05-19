from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0019_sync_project_state"
down_revision = "0018_sync_delete_tombstones"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("projects") as batch_op:
        batch_op.add_column(
            sa.Column("sync_status", sa.String(length=32), nullable=False, server_default="local")
        )
        batch_op.add_column(sa.Column("sync_status_reason", sa.Text(), nullable=True))
        batch_op.add_column(
            sa.Column("sync_required_artifact_ids_json", sa.JSON(), nullable=False, server_default="[]")
        )
        batch_op.add_column(
            sa.Column("sync_provider_device_ids_json", sa.JSON(), nullable=False, server_default="[]")
        )
        batch_op.add_column(
            sa.Column("sync_conflict_count", sa.Integer(), nullable=False, server_default="0")
        )
        batch_op.add_column(
            sa.Column(
                "sync_status_updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            )
        )
        batch_op.create_check_constraint(
            "ck_projects_sync_status",
            "sync_status IN ("
            "'local', "
            "'syncing', "
            "'remote_available', "
            "'downloading', "
            "'missing', "
            "'deleted', "
            "'conflicted'"
            ")",
        )
        batch_op.create_check_constraint(
            "ck_projects_sync_conflict_count_nonnegative",
            "sync_conflict_count >= 0",
        )
        batch_op.create_index("ix_projects_sync_status", ["sync_status"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch_op:
        batch_op.drop_index("ix_projects_sync_status")
        batch_op.drop_constraint("ck_projects_sync_conflict_count_nonnegative", type_="check")
        batch_op.drop_constraint("ck_projects_sync_status", type_="check")
        batch_op.drop_column("sync_status_updated_at")
        batch_op.drop_column("sync_conflict_count")
        batch_op.drop_column("sync_provider_device_ids_json")
        batch_op.drop_column("sync_required_artifact_ids_json")
        batch_op.drop_column("sync_status_reason")
        batch_op.drop_column("sync_status")
