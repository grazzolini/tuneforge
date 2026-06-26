from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0021_job_runtime_status"
down_revision = "0020_lyrics_language_override"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("jobs"):
        return
    columns = {column["name"] for column in inspector.get_columns("jobs")}
    columns_to_add = [
        column
        for column in (
            sa.Column("stage", sa.String(length=32), nullable=True),
            sa.Column("stage_label", sa.String(length=160), nullable=True),
            sa.Column("runtime_detail", sa.Text(), nullable=True),
        )
        if column.name not in columns
    ]
    if not columns_to_add:
        return
    with op.batch_alter_table("jobs") as batch_op:
        for column in columns_to_add:
            batch_op.add_column(column)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("jobs"):
        return
    columns = {column["name"] for column in inspector.get_columns("jobs")}
    columns_to_drop = [
        column_name
        for column_name in ("runtime_detail", "stage_label", "stage")
        if column_name in columns
    ]
    if not columns_to_drop:
        return
    with op.batch_alter_table("jobs") as batch_op:
        for column_name in columns_to_drop:
            batch_op.drop_column(column_name)
