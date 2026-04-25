from __future__ import annotations

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0007_artifact_storage_metadata"
down_revision = "0006_artifact_uniqueness"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("artifacts") as batch_op:
        batch_op.add_column(sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"))
        batch_op.add_column(
            sa.Column("generated_by", sa.String(length=128), nullable=False, server_default="unknown")
        )
        batch_op.add_column(sa.Column("can_delete", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch_op.add_column(
            sa.Column("can_regenerate", sa.Boolean(), nullable=False, server_default=sa.false())
        )

    op.execute("UPDATE artifacts SET generated_by = 'import' WHERE type = 'source_audio'")
    op.execute("UPDATE artifacts SET generated_by = 'analysis' WHERE type = 'analysis_json'")
    op.execute("UPDATE artifacts SET generated_by = 'demucs' WHERE type IN ('vocal_stem', 'instrumental_stem')")
    op.execute("UPDATE artifacts SET generated_by = 'ffmpeg' WHERE type IN ('preview_mix', 'export_mix')")
    op.execute("UPDATE artifacts SET can_delete = 0 WHERE type = 'source_audio'")
    connection = op.get_bind()
    for artifact_id, artifact_path in connection.execute(sa.text("SELECT id, path FROM artifacts")):
        try:
            size_bytes = Path(artifact_path).stat().st_size
        except OSError:
            size_bytes = 0
        connection.execute(
            sa.text("UPDATE artifacts SET size_bytes = :size_bytes WHERE id = :artifact_id"),
            {"artifact_id": artifact_id, "size_bytes": size_bytes},
        )
    op.execute(
        """
        UPDATE artifacts
        SET can_regenerate = 1
        WHERE type IN (
            'analysis_json',
            'instrumental_stem',
            'lyrics',
            'preview_mix',
            'vocal_stem',
            'waveform_cache'
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_analysis_json_project
        ON artifacts (project_id)
        WHERE type = 'analysis_json'
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_stem_per_source
        ON artifacts (
            project_id,
            type,
            json_extract(metadata_json, '$.source_artifact_id')
        )
        WHERE type IN ('vocal_stem', 'instrumental_stem')
        """
    )


def downgrade() -> None:
    with op.batch_alter_table("artifacts") as batch_op:
        batch_op.drop_column("can_regenerate")
        batch_op.drop_column("can_delete")
        batch_op.drop_column("generated_by")
        batch_op.drop_column("size_bytes")
