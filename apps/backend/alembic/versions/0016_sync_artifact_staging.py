from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0016_sync_artifact_staging"
down_revision = "0015_sync_trust_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_staged_artifacts",
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("relative_path", sa.String(length=2048), nullable=False),
        sa.Column("provider_device_id", sa.String(length=96), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(content_sha256) = 64",
            name="ck_sync_staged_artifacts_sha256_len",
        ),
        sa.CheckConstraint(
            "size_bytes >= 0",
            name="ck_sync_staged_artifacts_size_nonnegative",
        ),
        sa.PrimaryKeyConstraint("content_sha256"),
    )
    op.create_index(
        "ix_sync_staged_artifacts_provider_device_id",
        "sync_staged_artifacts",
        ["provider_device_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_staged_artifacts_verified_at",
        "sync_staged_artifacts",
        ["verified_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_sync_staged_artifacts_verified_at",
        table_name="sync_staged_artifacts",
    )
    op.drop_index(
        "ix_sync_staged_artifacts_provider_device_id",
        table_name="sync_staged_artifacts",
    )
    op.drop_table("sync_staged_artifacts")
