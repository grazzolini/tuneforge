from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0022_artifact_updated_at"
down_revision = "0021_job_runtime_status"
branch_labels = None
depends_on = None

_CREATE_STEM_UNIQUE_INDEX = ("CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_stem_per_source "
                             "ON artifacts (project_id, type, json_extract(metadata_json, '$.source_artifact_id'), "
                             "coalesce(json_extract(metadata_json, '$.stem_model'), '')) WHERE type IN "
                             "('vocal_stem', 'instrumental_stem', 'drums_stem', 'bass_stem', "
                             "'guitar_stem', 'piano_stem', 'other_stem')")


def upgrade() -> None:
    with op.batch_alter_table("artifacts") as batch_op:
        batch_op.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE artifacts SET updated_at = created_at WHERE updated_at IS NULL")
    with op.batch_alter_table("artifacts") as batch_op:
        batch_op.alter_column("updated_at", existing_type=sa.DateTime(timezone=True), nullable=False)
    op.execute(_CREATE_STEM_UNIQUE_INDEX)


def downgrade() -> None:
    with op.batch_alter_table("artifacts") as batch_op:
        batch_op.drop_column("updated_at")
    op.execute(_CREATE_STEM_UNIQUE_INDEX)
