from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0023_analysis_revisions"
down_revision = "0022_artifact_updated_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("metadata_json", sa.JSON(), nullable=False, server_default="{}"))
    op.execute("UPDATE analysis_results SET updated_at = created_at WHERE updated_at IS NULL")
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.alter_column("updated_at", existing_type=sa.DateTime(timezone=True), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.drop_column("metadata_json")
        batch_op.drop_column("updated_at")
