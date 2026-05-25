from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0020_lyrics_language_override"
down_revision = "0019_sync_project_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("lyrics_transcripts") as batch_op:
        batch_op.add_column(sa.Column("language_override", sa.String(length=16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("lyrics_transcripts") as batch_op:
        batch_op.drop_column("language_override")
