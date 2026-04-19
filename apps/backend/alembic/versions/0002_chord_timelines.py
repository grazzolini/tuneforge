from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0002_chord_timelines"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "chord_timelines",
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("backend", sa.String(length=64), nullable=False),
        sa.Column("source_artifact_id", sa.String(length=32), nullable=True),
        sa.Column("timeline_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )


def downgrade() -> None:
    op.drop_table("chord_timelines")
