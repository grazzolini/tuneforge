from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0015_sync_trust_identity"
down_revision = "0014_sync_project_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_local_identities",
        sa.Column("id", sa.String(length=16), nullable=False),
        sa.Column("sync_group_id", sa.String(length=80), nullable=False),
        sa.Column("device_id", sa.String(length=96), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("public_key", sa.String(length=128), nullable=False),
        sa.Column("private_key", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("id = 'local'", name="ck_sync_local_identities_singleton"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sync_local_identities_sync_group_id",
        "sync_local_identities",
        ["sync_group_id"],
        unique=False,
    )
    op.create_index(
        "uq_sync_local_identities_device_id",
        "sync_local_identities",
        ["device_id"],
        unique=True,
    )
    op.create_index(
        "uq_sync_local_identities_public_key",
        "sync_local_identities",
        ["public_key"],
        unique=True,
    )

    op.create_table(
        "sync_trusted_peers",
        sa.Column("device_id", sa.String(length=96), nullable=False),
        sa.Column("sync_group_id", sa.String(length=80), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("public_key", sa.String(length=128), nullable=False),
        sa.Column("endpoint_hints_json", sa.JSON(), nullable=False),
        sa.Column("trusted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("device_id"),
    )
    op.create_index(
        "ix_sync_trusted_peers_sync_group_id",
        "sync_trusted_peers",
        ["sync_group_id"],
        unique=False,
    )
    op.create_index(
        "ix_sync_trusted_peers_revoked_at",
        "sync_trusted_peers",
        ["revoked_at"],
        unique=False,
    )
    op.create_index(
        "uq_sync_trusted_peers_public_key",
        "sync_trusted_peers",
        ["public_key"],
        unique=True,
    )

    op.create_table(
        "sync_pairing_offers",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("secret_hash", sa.String(length=96), nullable=False),
        sa.Column("endpoint_hints_json", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sync_pairing_offers_expires_at",
        "sync_pairing_offers",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_sync_pairing_offers_used_at",
        "sync_pairing_offers",
        ["used_at"],
        unique=False,
    )
    op.create_index(
        "uq_sync_pairing_offers_secret_hash",
        "sync_pairing_offers",
        ["secret_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_sync_pairing_offers_secret_hash", table_name="sync_pairing_offers")
    op.drop_index("ix_sync_pairing_offers_used_at", table_name="sync_pairing_offers")
    op.drop_index("ix_sync_pairing_offers_expires_at", table_name="sync_pairing_offers")
    op.drop_table("sync_pairing_offers")

    op.drop_index("uq_sync_trusted_peers_public_key", table_name="sync_trusted_peers")
    op.drop_index("ix_sync_trusted_peers_revoked_at", table_name="sync_trusted_peers")
    op.drop_index("ix_sync_trusted_peers_sync_group_id", table_name="sync_trusted_peers")
    op.drop_table("sync_trusted_peers")

    op.drop_index("uq_sync_local_identities_public_key", table_name="sync_local_identities")
    op.drop_index("uq_sync_local_identities_device_id", table_name="sync_local_identities")
    op.drop_index("ix_sync_local_identities_sync_group_id", table_name="sync_local_identities")
    op.drop_table("sync_local_identities")
