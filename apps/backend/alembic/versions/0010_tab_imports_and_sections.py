from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0010_tab_imports_and_sections"
down_revision = "0009_chord_backend_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tab_imports",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("raw_text", sa.Text(), nullable=False),
        sa.Column("parser_version", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("parsed_json", sa.JSON(), nullable=False),
        sa.Column("proposal_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tab_imports_project_id", "tab_imports", ["project_id"], unique=True)

    op.create_table(
        "song_sections",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("tab_import_id", sa.String(length=32), nullable=True),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("start_seconds", sa.Float(), nullable=True),
        sa.Column("end_seconds", sa.Float(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tab_import_id"], ["tab_imports.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_song_sections_project_id", "song_sections", ["project_id"])
    op.create_index("ix_song_sections_tab_import_id", "song_sections", ["tab_import_id"])


def downgrade() -> None:
    op.drop_index("ix_song_sections_tab_import_id", table_name="song_sections")
    op.drop_index("ix_song_sections_project_id", table_name="song_sections")
    op.drop_table("song_sections")
    op.drop_index("ix_tab_imports_project_id", table_name="tab_imports")
    op.drop_table("tab_imports")
