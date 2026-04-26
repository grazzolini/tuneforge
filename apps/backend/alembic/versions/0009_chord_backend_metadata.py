from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0009_chord_backend_metadata"
down_revision = "0008_chord_edit_segments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("chord_timelines") as batch_op:
        batch_op.add_column(
            sa.Column("source_kind", sa.String(length=32), nullable=False, server_default="generated")
        )
        batch_op.add_column(sa.Column("metadata_json", sa.JSON(), nullable=False, server_default="{}"))

    op.execute("UPDATE chord_timelines SET source_kind = 'user-edited' WHERE has_user_edits = 1")
    op.execute("UPDATE chord_timelines SET source_kind = 'generated' WHERE has_user_edits = 0")
    op.execute("UPDATE chord_timelines SET metadata_json = '{}'")


def downgrade() -> None:
    with op.batch_alter_table("chord_timelines") as batch_op:
        batch_op.drop_column("metadata_json")
        batch_op.drop_column("source_kind")
