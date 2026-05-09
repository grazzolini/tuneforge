from __future__ import annotations

import hashlib
from pathlib import Path

from sqlalchemy import Column, String, text

from alembic import op

revision = "0012_backend_hash_storage"
down_revision = "0011_expand_stem_artifact_uniqueness"
branch_labels = None
depends_on = None


def _file_sha256(raw_path: str | None) -> str | None:
    if not raw_path:
        return None
    path = Path(raw_path)
    hasher = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
    except OSError:
        return None
    return hasher.hexdigest()


def upgrade() -> None:
    op.add_column("projects", Column("source_sha256", String(64), nullable=True))
    op.add_column("artifacts", Column("content_sha256", String(64), nullable=True))
    op.create_index("ix_projects_source_sha256", "projects", ["source_sha256"], unique=False)
    op.create_index("ix_artifacts_content_sha256", "artifacts", ["content_sha256"], unique=False)

    connection = op.get_bind()
    for row in connection.execute(text("SELECT id, source_path FROM projects")):
        connection.execute(
            text("UPDATE projects SET source_sha256 = :sha WHERE id = :id"),
            {"id": row.id, "sha": _file_sha256(row.source_path)},
        )

    for row in connection.execute(text("SELECT id, path FROM artifacts")):
        connection.execute(
            text("UPDATE artifacts SET content_sha256 = :sha WHERE id = :id"),
            {"id": row.id, "sha": _file_sha256(row.path)},
        )

    op.execute("DROP INDEX IF EXISTS uq_artifacts_stem_per_source")
    op.execute(
        """
        CREATE UNIQUE INDEX uq_artifacts_stem_per_source
        ON artifacts (
            project_id,
            type,
            json_extract(metadata_json, '$.source_artifact_id'),
            coalesce(json_extract(metadata_json, '$.stem_model'), '')
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
    op.drop_index("ix_artifacts_content_sha256", table_name="artifacts")
    op.drop_index("ix_projects_source_sha256", table_name="projects")
    op.drop_column("artifacts", "content_sha256")
    op.drop_column("projects", "source_sha256")
