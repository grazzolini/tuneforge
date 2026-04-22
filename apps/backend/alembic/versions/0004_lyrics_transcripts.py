from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0004_lyrics_transcripts"
down_revision = "0003_project_source_key_override"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "lyrics_transcripts",
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("source_artifact_id", sa.String(length=32), nullable=True),
        sa.Column("source_kind", sa.String(length=32), nullable=False),
        sa.Column("source_segments_json", sa.JSON(), nullable=False),
        sa.Column("segments_json", sa.JSON(), nullable=False),
        sa.Column("has_user_edits", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )


def downgrade() -> None:
    op.drop_table("lyrics_transcripts")
