from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0006_artifact_uniqueness"
down_revision = "0005_job_runtime_metadata"
branch_labels = None
depends_on = None


def _delete_duplicate_artifacts() -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            """
            SELECT
                id,
                project_id,
                type,
                json_extract(metadata_json, '$.source_artifact_id') AS source_artifact_id
            FROM artifacts
            WHERE type IN ('analysis_json', 'vocal_stem', 'instrumental_stem')
            ORDER BY created_at DESC, id DESC
            """
        )
    ).mappings()

    seen_analysis: set[str] = set()
    seen_stems: set[tuple[str, str, str | None]] = set()
    duplicate_ids: list[str] = []
    for row in rows:
        artifact_type = row["type"]
        if artifact_type == "analysis_json":
            key = row["project_id"]
            if key in seen_analysis:
                duplicate_ids.append(row["id"])
                continue
            seen_analysis.add(key)
            continue

        stem_key = (row["project_id"], artifact_type, row["source_artifact_id"])
        if stem_key in seen_stems:
            duplicate_ids.append(row["id"])
            continue
        seen_stems.add(stem_key)

    if duplicate_ids:
        delete_statement = sa.text("DELETE FROM artifacts WHERE id IN :ids").bindparams(
            sa.bindparam("ids", expanding=True)
        )
        connection.execute(delete_statement, {"ids": duplicate_ids})


def upgrade() -> None:
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.add_column(sa.Column("source_artifact_id", sa.String(length=32), nullable=True))

    op.execute(
        """
        UPDATE analysis_results
        SET source_artifact_id = (
            SELECT artifacts.id
            FROM artifacts
            WHERE artifacts.project_id = analysis_results.project_id
              AND artifacts.type = 'source_audio'
            ORDER BY artifacts.created_at DESC, artifacts.id DESC
            LIMIT 1
        )
        """
    )

    _delete_duplicate_artifacts()

    op.execute(
        """
        CREATE UNIQUE INDEX uq_artifacts_analysis_json_project
        ON artifacts (project_id)
        WHERE type = 'analysis_json'
        """
    )
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


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_artifacts_stem_per_source")
    op.execute("DROP INDEX IF EXISTS uq_artifacts_analysis_json_project")

    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.drop_column("source_artifact_id")
