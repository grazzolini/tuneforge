from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0013_analysis_timing"
down_revision = "0012_backend_hash_storage"
branch_labels = None
depends_on = None


def _has_analysis_results_table() -> bool:
    return sa.inspect(op.get_bind()).has_table("analysis_results")


def upgrade() -> None:
    if not _has_analysis_results_table():
        return
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.add_column(sa.Column("timing_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    if not _has_analysis_results_table():
        return
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.drop_column("timing_json")
