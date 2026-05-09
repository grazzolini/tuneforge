from __future__ import annotations

from alembic import op

revision = "0011_expand_stem_artifact_uniqueness"
down_revision = "0010_tab_imports_and_sections"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_artifacts_stem_per_source")
    op.execute(
        """
        CREATE UNIQUE INDEX uq_artifacts_stem_per_source
        ON artifacts (
            project_id,
            type,
            json_extract(metadata_json, '$.source_artifact_id')
        )
        WHERE type IN (
            'vocal_stem',
            'instrumental_stem',
            'drums_stem',
            'bass_stem',
            'guitar_stem',
            'piano_stem',
            'other_stem'
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_artifacts_stem_per_source")
    op.execute(
        """
        CREATE UNIQUE INDEX uq_artifacts_stem_per_source
        ON artifacts (
            project_id,
            type,
            json_extract(metadata_json, '$.source_artifact_id')
        )
        WHERE type IN ('vocal_stem', 'instrumental_stem')
        """
    )
