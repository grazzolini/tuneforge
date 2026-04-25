from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0008_chord_edit_segments"
down_revision = "0007_artifact_storage_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("chord_timelines") as batch_op:
        batch_op.add_column(sa.Column("source_segments_json", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("segments_json", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("has_user_edits", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch_op.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))

    op.execute("UPDATE chord_timelines SET source_segments_json = timeline_json")
    op.execute("UPDATE chord_timelines SET segments_json = timeline_json")
    op.execute("UPDATE chord_timelines SET has_user_edits = 0")
    op.execute("UPDATE chord_timelines SET updated_at = created_at")


def downgrade() -> None:
    with op.batch_alter_table("chord_timelines") as batch_op:
        batch_op.drop_column("updated_at")
        batch_op.drop_column("has_user_edits")
        batch_op.drop_column("segments_json")
        batch_op.drop_column("source_segments_json")
