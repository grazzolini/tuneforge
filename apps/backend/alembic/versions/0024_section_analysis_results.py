from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0024_section_analysis_results"
down_revision = "0023_analysis_revisions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "section_analysis_results",
        sa.Column("project_id", sa.String(80), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("model_revision", sa.String(128), nullable=False),
        sa.Column("raw_sections_json", sa.JSON(), nullable=False),
        sa.Column("refined_sections_json", sa.JSON(), nullable=False),
        sa.Column("source_artifact_id", sa.String(32), nullable=True),
        sa.Column("sections_json", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("source_kind", sa.String(32), nullable=False, server_default="generated"),
        sa.Column("has_user_edits", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("section_analysis_results")
