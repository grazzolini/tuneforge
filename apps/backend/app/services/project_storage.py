from __future__ import annotations

import errno
import logging
import os
import stat
import threading
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import AnalysisResult, Artifact, ChordTimeline, LyricsTranscript, Project
from app.services.paths import project_root

logger = logging.getLogger(__name__)

_PENDING_PROJECT_IDS = "project_storage_pending_ids"
_PREPARED_RECONCILIATIONS = "project_storage_prepared_reconciliations"
_FAILED_PROJECT_IDS: set[str] = set()
_FAILED_PROJECT_IDS_LOCK = threading.Lock()


@dataclass(frozen=True, slots=True)
class ProjectStorageReconciliation:
    project_id: str
    data_root: Path
    projects_root: Path
    project_root: Path
    owned_paths: frozenset[Path]
    delete_project_root: bool


class UnsafeProjectStorageError(RuntimeError):
    pass


def queue_project_storage_reconciliation(session: Session, project_id: str) -> None:
    pending = session.info.setdefault(_PENDING_PROJECT_IDS, set())
    if isinstance(pending, set):
        pending.add(project_id)


def prepare_project_storage_reconciliations(session: Session) -> None:
    pending = session.info.get(_PENDING_PROJECT_IDS)
    project_ids = pending.copy() if isinstance(pending, set) else set()
    with _FAILED_PROJECT_IDS_LOCK:
        project_ids.update(_FAILED_PROJECT_IDS)
    if not project_ids:
        return

    session.flush()
    artifacts = tuple(session.scalars(select(Artifact)))
    plans = [
        _build_reconciliation(session, project_id, artifacts=artifacts)
        for project_id in sorted(project_ids)
    ]
    session.info[_PREPARED_RECONCILIATIONS] = plans


def drain_project_storage_reconciliations(session: Session) -> None:
    prepared_plans = session.info.pop(_PREPARED_RECONCILIATIONS, [])
    session.info.pop(_PENDING_PROJECT_IDS, None)
    plans = prepared_plans if isinstance(prepared_plans, list) else []
    for plan in plans:
        if not isinstance(plan, ProjectStorageReconciliation):
            continue
        try:
            reconcile_project_storage(plan)
        except (OSError, UnsafeProjectStorageError) as exc:
            with _FAILED_PROJECT_IDS_LOCK:
                _FAILED_PROJECT_IDS.add(plan.project_id)
            logger.warning(
                "Project storage cleanup deferred for %s after %s.",
                plan.project_id,
                type(exc).__name__,
            )
        else:
            with _FAILED_PROJECT_IDS_LOCK:
                _FAILED_PROJECT_IDS.discard(plan.project_id)


def discard_project_storage_reconciliations(session: Session) -> None:
    session.info.pop(_PREPARED_RECONCILIATIONS, None)
    session.info.pop(_PENDING_PROJECT_IDS, None)


def _build_reconciliation(
    session: Session,
    project_id: str,
    *,
    artifacts: tuple[Artifact, ...],
) -> ProjectStorageReconciliation:
    settings = get_settings()
    root = _lexical_absolute(project_root(project_id))
    projects_root = _lexical_absolute(settings.projects_root)
    data_root = _lexical_absolute(settings.data_root)
    if _relative_path(root, projects_root) is None or _relative_path(projects_root, data_root) is None:
        raise UnsafeProjectStorageError("Canonical project root escapes TuneForge data storage.")

    project = session.get(Project, project_id)
    delete_project_root = project is None or project.sync_status == "deleted"
    owned_paths: set[Path] = set()
    for artifact in artifacts:
        _add_owned_path(owned_paths, artifact.path, root)
        if artifact.type == "source_audio":
            original_copy_path = artifact.metadata_json.get("original_copy_path")
            if isinstance(original_copy_path, str):
                _add_owned_path(owned_paths, original_copy_path, root)

    if not delete_project_root:
        if project is None:
            raise RuntimeError("Live project reconciliation requires a project row.")
        _add_owned_path(owned_paths, project.imported_path, root)
        if session.get(AnalysisResult, project_id) is not None:
            owned_paths.add(Path("analysis") / "analysis.json")
        if session.get(ChordTimeline, project_id) is not None:
            owned_paths.add(Path("analysis") / "chords.json")
        if session.get(LyricsTranscript, project_id) is not None:
            owned_paths.add(Path("analysis") / "lyrics.json")
    owned_paths = _with_owned_prefixes(owned_paths)

    return ProjectStorageReconciliation(
        project_id=project_id,
        data_root=data_root,
        projects_root=projects_root,
        project_root=root,
        owned_paths=frozenset(owned_paths),
        delete_project_root=delete_project_root,
    )


def _add_owned_path(owned_paths: set[Path], raw_path: str, root: Path) -> None:
    relative = _relative_path(_lexical_absolute(Path(raw_path)), root)
    if relative is not None and relative.parts:
        owned_paths.add(relative)


def reconcile_project_storage(plan: ProjectStorageReconciliation) -> None:
    projects_root_identity = _validate_storage_roots(plan)
    root_identity = _path_identity(plan.project_root)
    _require_stable_directory(plan.projects_root, projects_root_identity)
    if root_identity is None:
        return

    if stat.S_ISLNK(root_identity.st_mode):
        _unlink_entry(
            plan.projects_root,
            projects_root_identity,
            plan.project_root,
            root_identity,
        )
        return
    if not stat.S_ISDIR(root_identity.st_mode):
        raise UnsafeProjectStorageError("Canonical project root is not a directory.")

    _reconcile_directory(
        plan.project_root,
        root_identity,
        relative_root=Path(),
        owned_paths=plan.owned_paths,
    )
    if plan.delete_project_root:
        _remove_directory(
            plan.projects_root,
            projects_root_identity,
            plan.project_root,
            root_identity,
        )


def _validate_storage_roots(plan: ProjectStorageReconciliation) -> os.stat_result:
    if _relative_path(plan.projects_root, plan.data_root) is None:
        raise UnsafeProjectStorageError("Projects root escapes TuneForge data storage.")
    if _relative_path(plan.project_root, plan.projects_root) is None:
        raise UnsafeProjectStorageError("Project root escapes TuneForge project storage.")

    data_root_identity = _path_identity(plan.data_root)
    if data_root_identity is None or not stat.S_ISDIR(data_root_identity.st_mode):
        raise UnsafeProjectStorageError("TuneForge data root is unavailable or unsafe.")

    current = plan.data_root
    current_identity = data_root_identity
    projects_relative = plan.projects_root.relative_to(plan.data_root)
    for part in projects_relative.parts:
        next_path = current / part
        next_identity = _path_identity(next_path)
        if next_identity is None or not stat.S_ISDIR(next_identity.st_mode):
            raise UnsafeProjectStorageError("TuneForge projects root contains an unsafe component.")
        _require_stable_directory(current, current_identity)
        current = next_path
        current_identity = next_identity
    return current_identity


def _reconcile_directory(
    directory: Path,
    directory_identity: os.stat_result,
    *,
    relative_root: Path,
    owned_paths: frozenset[Path],
) -> None:
    _require_stable_directory(directory, directory_identity)
    with os.scandir(directory) as iterator:
        entries = list(iterator)
    _require_stable_directory(directory, directory_identity)

    for entry in entries:
        child = directory / entry.name
        relative = relative_root / entry.name
        try:
            child_identity = entry.stat(follow_symlinks=False)
        except FileNotFoundError:
            continue

        if stat.S_ISDIR(child_identity.st_mode):
            _reconcile_directory(
                child,
                child_identity,
                relative_root=relative,
                owned_paths=owned_paths,
            )
            if relative not in owned_paths:
                _remove_directory(directory, directory_identity, child, child_identity, missing_ok=True)
            continue

        if relative in owned_paths:
            continue
        if stat.S_ISREG(child_identity.st_mode) or stat.S_ISLNK(child_identity.st_mode):
            _unlink_entry(directory, directory_identity, child, child_identity)


def _unlink_entry(
    parent: Path,
    parent_identity: os.stat_result,
    path: Path,
    expected_identity: os.stat_result,
) -> None:
    _require_stable_directory(parent, parent_identity)
    current_identity = _path_identity(path)
    if current_identity is None:
        return
    if not _same_identity(current_identity, expected_identity):
        raise UnsafeProjectStorageError("Storage entry changed before cleanup.")
    os.unlink(path)


def _remove_directory(
    parent: Path,
    parent_identity: os.stat_result,
    path: Path,
    expected_identity: os.stat_result,
    *,
    missing_ok: bool = False,
) -> None:
    _require_stable_directory(parent, parent_identity)
    current_identity = _path_identity(path)
    if current_identity is None:
        if missing_ok:
            return
        raise UnsafeProjectStorageError("Storage directory disappeared before cleanup.")
    if not _same_identity(current_identity, expected_identity) or not stat.S_ISDIR(current_identity.st_mode):
        raise UnsafeProjectStorageError("Storage directory changed before cleanup.")
    try:
        os.rmdir(path)
    except OSError as exc:
        if missing_ok and exc.errno == errno.ENOTEMPTY:
            return
        raise


def _require_stable_directory(path: Path, expected_identity: os.stat_result) -> None:
    current_identity = _path_identity(path)
    if (
        current_identity is None
        or not stat.S_ISDIR(current_identity.st_mode)
        or not _same_identity(current_identity, expected_identity)
    ):
        raise UnsafeProjectStorageError("Storage parent changed before cleanup.")


def _path_identity(path: Path) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino, stat.S_IFMT(left.st_mode)) == (
        right.st_dev,
        right.st_ino,
        stat.S_IFMT(right.st_mode),
    )


def _lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.path.normpath(path)))


def _relative_path(path: Path, root: Path) -> Path | None:
    try:
        return path.relative_to(root)
    except ValueError:
        return None


def _with_owned_prefixes(paths: set[Path]) -> set[Path]:
    protected: set[Path] = set()
    for path in paths:
        for index in range(1, len(path.parts) + 1):
            protected.add(Path(*path.parts[:index]))
    return protected
