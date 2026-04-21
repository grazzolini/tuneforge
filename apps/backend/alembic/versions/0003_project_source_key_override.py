from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0003_project_source_key_override"
down_revision = "0002_chord_timelines"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("source_key_override", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "source_key_override")
