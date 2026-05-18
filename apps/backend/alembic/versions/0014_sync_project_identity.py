from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import sqlalchemy as sa

from alembic import op

revision = "0014_sync_project_identity"
down_revision = "0013_analysis_timing"
branch_labels = None
depends_on = None

PROJECT_ID_LENGTH = 80
PROJECT_ID_PREFIX = "proj_sha256_"
PROJECT_STORAGE_KEY_PREFIX = "proj_"
PROJECT_STORAGE_HASH_LENGTH = 24
NORMALIZED_IMPORT_SOURCE_FORMATS = {"mp4", "webm"}
HEX_DIGITS = frozenset("0123456789abcdef")
PROJECT_REFERENCE_TABLES = (
    "analysis_results",
    "chord_timelines",
    "lyrics_transcripts",
    "tab_imports",
    "song_sections",
    "artifacts",
    "jobs",
)
PROJECT_SNAPSHOT_FILENAMES = ("analysis.json", "chords.json", "lyrics.json")


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    _widen_project_id_columns(inspector)
    _restore_artifact_expression_indexes(connection, inspector)
    _migrate_existing_project_ids(connection, inspector)


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    _narrow_project_id_columns(inspector)


def _widen_project_id_columns(inspector: sa.Inspector) -> None:
    _alter_column_length(inspector, "projects", "id", length=PROJECT_ID_LENGTH)
    for table_name in PROJECT_REFERENCE_TABLES:
        _alter_column_length(inspector, table_name, "project_id", length=PROJECT_ID_LENGTH)


def _narrow_project_id_columns(inspector: sa.Inspector) -> None:
    _alter_column_length(inspector, "projects", "id", length=32)
    for table_name in PROJECT_REFERENCE_TABLES:
        _alter_column_length(inspector, table_name, "project_id", length=32)


def _alter_column_length(
    inspector: sa.Inspector,
    table_name: str,
    column_name: str,
    *,
    length: int,
) -> None:
    if not inspector.has_table(table_name):
        return
    columns = {column["name"]: column for column in inspector.get_columns(table_name)}
    if column_name not in columns:
        return
    column = columns[column_name]
    with op.batch_alter_table(table_name) as batch_op:
        batch_op.alter_column(
            column_name,
            existing_type=sa.String(length=32),
            type_=sa.String(length=length),
            existing_nullable=bool(column["nullable"]),
        )


def _restore_artifact_expression_indexes(connection: sa.Connection, inspector: sa.Inspector) -> None:
    if not inspector.has_table("artifacts"):
        return
    connection.execute(sa.text("DROP INDEX IF EXISTS uq_artifacts_analysis_json_project"))
    connection.execute(sa.text("DROP INDEX IF EXISTS uq_artifacts_stem_per_source"))
    connection.execute(
        sa.text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_analysis_json_project
            ON artifacts (project_id)
            WHERE type = 'analysis_json'
            """
        )
    )
    connection.execute(
        sa.text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_stem_per_source
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
    )


def _migrate_existing_project_ids(connection: sa.Connection, inspector: sa.Inspector) -> None:
    if not inspector.has_table("projects"):
        return

    source_artifacts = _source_artifacts_by_project(connection, inspector)
    project_rows = [
        dict(row._mapping)
        for row in connection.execute(
            sa.text(
                """
                SELECT id, source_path, imported_path, source_sha256
                FROM projects
                ORDER BY id
                """
            )
        )
    ]
    resolved_hashes = {
        project["id"]: source_hash
        for project in project_rows
        if (source_hash := _resolve_source_hash(project, source_artifacts.get(project["id"]))) is not None
    }
    duplicate_hashes = {
        source_hash
        for source_hash, count in Counter(resolved_hashes.values()).items()
        if count > 1
    }

    existing_project_ids = {project["id"] for project in project_rows}
    project_artifacts = _artifacts_by_project(connection, inspector)
    projects_root = _projects_root()

    for project in project_rows:
        old_id = project["id"]
        source_hash = resolved_hashes.get(old_id)
        if source_hash is None:
            continue

        connection.execute(
            sa.text("UPDATE projects SET source_sha256 = :source_sha256 WHERE id = :project_id"),
            {"project_id": old_id, "source_sha256": source_hash},
        )

        if source_hash in duplicate_hashes:
            continue

        new_root = projects_root / _source_hash_to_project_storage_key(source_hash)
        new_id = _source_hash_to_project_id(source_hash)
        artifacts = _project_artifacts(project_artifacts, old_id, new_id)
        if old_id == new_id:
            _recover_canonical_project_paths(
                connection,
                project=project,
                artifacts=artifacts,
                projects_root=projects_root,
                new_root=new_root,
                new_id=new_id,
            )
            continue
        if new_id in existing_project_ids:
            continue

        old_root = projects_root / old_id
        if not _storage_paths_can_move(project, artifacts, old_root, new_root):
            continue

        path_updates = _path_updates(project, artifacts, old_root, new_root)
        if not _move_project_root(old_root, new_root):
            continue

        _rewrite_project_snapshots(new_root, old_id=old_id, new_id=new_id)
        _update_project_references(connection, inspector, old_id=old_id, new_id=new_id)
        _update_path_columns(connection, project=project, artifact_updates=path_updates)
        connection.execute(
            sa.text(
                """
                UPDATE projects
                SET id = :new_id, source_sha256 = :source_sha256
                WHERE id = :old_id
                """
            ),
            {"old_id": old_id, "new_id": new_id, "source_sha256": source_hash},
        )

        existing_project_ids.remove(old_id)
        existing_project_ids.add(new_id)


def _source_artifacts_by_project(
    connection: sa.Connection,
    inspector: sa.Inspector,
) -> dict[str, dict[str, Any]]:
    if not inspector.has_table("artifacts"):
        return {}
    artifacts: dict[str, dict[str, Any]] = {}
    for row in connection.execute(
        sa.text(
            """
            SELECT id, project_id, path, metadata_json
            FROM artifacts
            WHERE type = 'source_audio'
            ORDER BY project_id, created_at, id
            """
        )
    ):
        artifact = dict(row._mapping)
        artifacts.setdefault(artifact["project_id"], artifact)
    return artifacts


def _artifacts_by_project(
    connection: sa.Connection,
    inspector: sa.Inspector,
) -> dict[str, list[dict[str, Any]]]:
    if not inspector.has_table("artifacts"):
        return {}
    artifacts: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in connection.execute(
        sa.text(
            """
            SELECT id, project_id, path, metadata_json
            FROM artifacts
            ORDER BY project_id, id
            """
        )
    ):
        artifact = dict(row._mapping)
        artifacts[artifact["project_id"]].append(artifact)
    return artifacts


def _project_artifacts(
    project_artifacts: dict[str, list[dict[str, Any]]],
    old_id: str,
    new_id: str,
) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    seen_artifact_ids: set[str] = set()
    for project_id in (old_id, new_id):
        for artifact in project_artifacts.get(project_id, []):
            artifact_id = artifact["id"]
            if artifact_id in seen_artifact_ids:
                continue
            seen_artifact_ids.add(artifact_id)
            artifacts.append(artifact)
    return artifacts


def _recover_canonical_project_paths(
    connection: sa.Connection,
    *,
    project: dict[str, Any],
    artifacts: list[dict[str, Any]],
    projects_root: Path,
    new_root: Path,
    new_id: str,
) -> None:
    for old_root in _candidate_project_roots(project, artifacts, projects_root, new_root):
        if old_root.exists() and new_root.exists():
            continue
        path_updates = _path_updates(project, artifacts, old_root, new_root)
        if not _move_project_root(old_root, new_root):
            continue
        _rewrite_project_snapshots(new_root, old_id=old_root.name, new_id=new_id)
        _update_path_columns(connection, project=project, artifact_updates=path_updates)


def _candidate_project_roots(
    project: dict[str, Any],
    artifacts: list[dict[str, Any]],
    projects_root: Path,
    new_root: Path,
) -> list[Path]:
    roots: list[Path] = []
    for value in _owned_path_values(project, artifacts):
        if not isinstance(value, str):
            continue
        root = _project_root_for_path(value, projects_root)
        if root is None or root == new_root or root in roots:
            continue
        roots.append(root)
    return roots


def _project_root_for_path(value: str, projects_root: Path) -> Path | None:
    root_text = str(projects_root)
    prefix = f"{root_text}/"
    if not value.startswith(prefix):
        return None
    remainder = value[len(prefix):]
    project_root_name = remainder.split("/", 1)[0]
    if not project_root_name:
        return None
    return projects_root / project_root_name


def _resolve_source_hash(
    project: dict[str, Any],
    source_artifact: dict[str, Any] | None,
) -> str | None:
    stored_hash = _normalize_source_hash(project.get("source_sha256"))
    if stored_hash is not None and _stored_source_hash_is_trusted(project, source_artifact, stored_hash):
        return stored_hash

    original_copy_path = _original_copy_path(source_artifact)
    original_copy_hash = _file_sha256(original_copy_path) if _is_app_managed_path(original_copy_path) else None
    if original_copy_hash is not None:
        return original_copy_hash

    candidate_paths = [project.get("source_path")]
    if not _uses_normalized_source_proxy(project, source_artifact):
        candidate_paths.extend(
            [
                source_artifact.get("path") if source_artifact is not None else None,
                project.get("imported_path"),
            ]
        )
    return _first_app_managed_file_hash(candidate_paths)


def _stored_source_hash_is_trusted(
    project: dict[str, Any],
    source_artifact: dict[str, Any] | None,
    stored_hash: str,
) -> bool:
    candidate_paths = [
        _original_copy_path(source_artifact),
        project.get("source_path"),
    ]
    if not _uses_normalized_source_proxy(project, source_artifact):
        candidate_paths.extend(
            [
                source_artifact.get("path") if source_artifact is not None else None,
                project.get("imported_path"),
            ]
        )
    return any(
        _is_app_managed_path(candidate_path) and _file_sha256(candidate_path) == stored_hash
        for candidate_path in candidate_paths
    )


def _normalize_source_hash(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if len(normalized) != 64 or any(character not in HEX_DIGITS for character in normalized):
        return None
    return normalized


def _file_sha256(raw_path: Any) -> str | None:
    if not isinstance(raw_path, str) or not raw_path:
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


def _original_copy_path(source_artifact: dict[str, Any] | None) -> str | None:
    if source_artifact is None:
        return None
    value = _metadata_dict(source_artifact.get("metadata_json")).get("original_copy_path")
    return value if isinstance(value, str) else None


def _is_app_managed_path(raw_path: Any) -> bool:
    if not isinstance(raw_path, str) or not raw_path:
        return False
    return _project_root_for_path(raw_path, _projects_root()) is not None


def _first_app_managed_file_hash(raw_paths: list[Any]) -> str | None:
    for raw_path in raw_paths:
        if not _is_app_managed_path(raw_path):
            continue
        file_hash = _file_sha256(raw_path)
        if file_hash is not None:
            return file_hash
    return None


def _uses_normalized_source_proxy(
    project: dict[str, Any],
    source_artifact: dict[str, Any] | None,
) -> bool:
    metadata = _metadata_dict(source_artifact.get("metadata_json")) if source_artifact else {}
    original_format = metadata.get("original_format")
    if isinstance(original_format, str) and original_format.lower() in NORMALIZED_IMPORT_SOURCE_FORMATS:
        return True
    source_format = Path(str(project.get("source_path", ""))).suffix.lower().lstrip(".")
    imported_format = Path(str(project.get("imported_path", ""))).suffix.lower().lstrip(".")
    return source_format in NORMALIZED_IMPORT_SOURCE_FORMATS and imported_format == "wav"


def _source_hash_to_project_id(source_sha256: str) -> str:
    return f"{PROJECT_ID_PREFIX}{source_sha256}"


def _source_hash_to_project_storage_key(source_sha256: str) -> str:
    return f"{PROJECT_STORAGE_KEY_PREFIX}{source_sha256[:PROJECT_STORAGE_HASH_LENGTH]}"


def _projects_root() -> Path:
    from app.config import get_settings

    return get_settings().projects_root


def _storage_paths_can_move(
    project: dict[str, Any],
    artifacts: list[dict[str, Any]],
    old_root: Path,
    new_root: Path,
) -> bool:
    if old_root.exists():
        return not new_root.exists()
    if new_root.exists():
        # Recover interrupted prior runs where the folder move happened before DB updates fully completed.
        return _has_owned_path(project, artifacts, old_root) or _has_owned_path(project, artifacts, new_root)
    return not _has_owned_path(project, artifacts, old_root)


def _has_owned_path(
    project: dict[str, Any],
    artifacts: list[dict[str, Any]],
    old_root: Path,
) -> bool:
    return any(
        isinstance(value, str) and _is_under_root(value, old_root)
        for value in _owned_path_values(project, artifacts)
    )


def _owned_path_values(
    project: dict[str, Any],
    artifacts: list[dict[str, Any]],
) -> list[Any]:
    path_values = [project.get("source_path"), project.get("imported_path")]
    for artifact in artifacts:
        path_values.append(artifact.get("path"))
        path_values.extend(_metadata_path_values(_metadata_dict(artifact.get("metadata_json"))))
    return path_values


def _is_under_root(value: str, root: Path) -> bool:
    root_text = str(root)
    return value == root_text or value.startswith(f"{root_text}/")


def _metadata_path_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        paths: list[str] = []
        for item in value:
            paths.extend(_metadata_path_values(item))
        return paths
    if isinstance(value, dict):
        paths = []
        for item in value.values():
            paths.extend(_metadata_path_values(item))
        return paths
    return []


def _move_project_root(old_root: Path, new_root: Path) -> bool:
    if not old_root.exists():
        return True
    try:
        new_root.parent.mkdir(parents=True, exist_ok=True)
        old_root.rename(new_root)
    except OSError:
        return False
    return True


def _path_updates(
    project: dict[str, Any],
    artifacts: list[dict[str, Any]],
    old_root: Path,
    new_root: Path,
) -> list[tuple[str, str, str | None]]:
    updates: list[tuple[str, str, str | None]] = []
    project["source_path"] = _rewrite_path(str(project.get("source_path", "")), old_root, new_root)
    project["imported_path"] = _rewrite_path(str(project.get("imported_path", "")), old_root, new_root)
    for artifact in artifacts:
        path = _rewrite_path(str(artifact.get("path", "")), old_root, new_root)
        metadata = _rewrite_metadata_paths(artifact.get("metadata_json"), old_root, new_root)
        updates.append((artifact["id"], path, metadata))
    return updates


def _rewrite_path(value: str, old_root: Path, new_root: Path) -> str:
    old_text = str(old_root)
    new_text = str(new_root)
    if value == old_text:
        return new_text
    prefix = f"{old_text}/"
    if value.startswith(prefix):
        return f"{new_text}/{value[len(prefix):]}"
    return value


def _rewrite_metadata_paths(raw_metadata: Any, old_root: Path, new_root: Path) -> str | None:
    metadata = _metadata_dict(raw_metadata)
    rewritten = _rewrite_metadata_value(metadata, old_root, new_root)
    if rewritten == metadata:
        return None
    return json.dumps(rewritten, separators=(",", ":"))


def _rewrite_metadata_value(value: Any, old_root: Path, new_root: Path) -> Any:
    if isinstance(value, str):
        return _rewrite_path(value, old_root, new_root)
    if isinstance(value, list):
        return [_rewrite_metadata_value(item, old_root, new_root) for item in value]
    if isinstance(value, dict):
        return {key: _rewrite_metadata_value(item, old_root, new_root) for key, item in value.items()}
    return value


def _metadata_dict(raw_metadata: Any) -> dict[str, Any]:
    if isinstance(raw_metadata, dict):
        return raw_metadata
    if isinstance(raw_metadata, str) and raw_metadata:
        try:
            parsed = json.loads(raw_metadata)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _rewrite_project_snapshots(project_root: Path, *, old_id: str, new_id: str) -> None:
    analysis_root = project_root / "analysis"
    for filename in PROJECT_SNAPSHOT_FILENAMES:
        _rewrite_snapshot_project_id(analysis_root / filename, old_id=old_id, new_id=new_id)


def _rewrite_snapshot_project_id(path: Path, *, old_id: str, new_id: str) -> None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return
    if not isinstance(data, dict) or data.get("project_id") != old_id:
        return
    data["project_id"] = new_id
    try:
        path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    except OSError:
        return


def _update_project_references(
    connection: sa.Connection,
    inspector: sa.Inspector,
    *,
    old_id: str,
    new_id: str,
) -> None:
    for table_name in PROJECT_REFERENCE_TABLES:
        if not inspector.has_table(table_name):
            continue
        columns = {column["name"] for column in inspector.get_columns(table_name)}
        if "project_id" not in columns:
            continue
        connection.execute(
            sa.text(f"UPDATE {table_name} SET project_id = :new_id WHERE project_id = :old_id"),
            {"old_id": old_id, "new_id": new_id},
        )


def _update_path_columns(
    connection: sa.Connection,
    *,
    project: dict[str, Any],
    artifact_updates: list[tuple[str, str, str | None]],
) -> None:
    connection.execute(
        sa.text(
            """
            UPDATE projects
            SET source_path = :source_path, imported_path = :imported_path
            WHERE id = :project_id
            """
        ),
        {
            "project_id": project["id"],
            "source_path": project["source_path"],
            "imported_path": project["imported_path"],
        },
    )
    for artifact_id, path, metadata in artifact_updates:
        connection.execute(
            sa.text("UPDATE artifacts SET path = :path WHERE id = :artifact_id"),
            {"artifact_id": artifact_id, "path": path},
        )
        if metadata is not None:
            connection.execute(
                sa.text("UPDATE artifacts SET metadata_json = :metadata WHERE id = :artifact_id"),
                {"artifact_id": artifact_id, "metadata": metadata},
            )
