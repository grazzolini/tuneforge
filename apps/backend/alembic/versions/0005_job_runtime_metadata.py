from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0005_job_runtime_metadata"
down_revision = "0004_lyrics_transcripts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("jobs") as batch_op:
        batch_op.add_column(sa.Column("runtime_device", sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column("started_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("duration_seconds", sa.Float(), nullable=True))

    with op.batch_alter_table("lyrics_transcripts") as batch_op:
        batch_op.add_column(sa.Column("requested_device", sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column("device", sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column("model_name", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("language", sa.String(length=32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("lyrics_transcripts") as batch_op:
        batch_op.drop_column("language")
        batch_op.drop_column("model_name")
        batch_op.drop_column("device")
        batch_op.drop_column("requested_device")

    with op.batch_alter_table("jobs") as batch_op:
        batch_op.drop_column("duration_seconds")
        batch_op.drop_column("completed_at")
        batch_op.drop_column("started_at")
        batch_op.drop_column("runtime_device")
