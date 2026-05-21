from __future__ import annotations

import argparse
import importlib
import json
import sys
from collections.abc import Callable, Mapping, Sized
from pathlib import Path
from typing import Any

from app.errors import AppError

ServiceFunction = Callable[..., Any]


class SyncBundleCliError(RuntimeError):
    pass


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        summary = _run_command(args)
    except AppError as exc:
        sys.stderr.write(f"error: {exc.message}\n")
        return 1
    except SyncBundleCliError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    except Exception as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1

    sys.stdout.write(json.dumps(summary, sort_keys=True))
    sys.stdout.write("\n")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.sync_bundle",
        description=(
            "Export or import TuneForge sync bundle folders for external sync-tool "
            "testing, including Syncthing power-user evaluation."
        ),
        epilog=(
            "Sync only the bundle root with the external tool. Do not sync TuneForge's "
            "live app data directory."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser(
        "export",
        description=(
            "Create or refresh a sync-safe bundle from TuneForge projects. The bundle "
            "contains manifests, verified blob files, and metadata for an external "
            "folder sync tool to move between devices."
        ),
        help="Export projects into a sync-safe bundle folder.",
    )
    export_parser.add_argument(
        "--bundle-root",
        required=True,
        type=Path,
        metavar="PATH",
        help=(
            "Directory to create or update as the portable sync bundle. Point Syncthing "
            "or another external folder sync tool at this directory, not at TuneForge's "
            "app data directory."
        ),
    )
    export_parser.add_argument(
        "--project-id",
        action="append",
        dest="project_ids",
        metavar="ID",
        help="Project id to export. Repeat to export multiple projects. Defaults to all exportable projects.",
    )
    export_parser.add_argument(
        "--provider-device-id",
        metavar="ID",
        help=(
            "Stable provider device id to write into bundle metadata and peer inventory. "
            "Use the same id for repeated exports from the same source device."
        ),
    )

    import_parser = subparsers.add_parser(
        "import",
        description=(
            "Import a sync-safe bundle through TuneForge's sync staging and "
            "reconciliation services. The command validates manifests and blobs before "
            "applying project changes; it does not copy raw bundle paths directly into "
            "the live library."
        ),
        help="Import projects from a sync-safe bundle folder.",
    )
    import_parser.add_argument(
        "--bundle-root",
        required=True,
        type=Path,
        metavar="PATH",
        help=(
            "Directory containing the received sync bundle to validate and import "
            "through TuneForge services."
        ),
    )
    import_parser.add_argument(
        "--provider-device-id",
        metavar="ID",
        help=(
            "Provider device id expected in the bundle metadata or peer inventory. "
            "Pass this when the source peer should be pinned explicitly."
        ),
    )

    return parser


def _run_command(args: argparse.Namespace) -> dict[str, Any]:
    command = str(args.command)
    bundle_root = _resolve_path(args.bundle_root)

    if command == "export":
        result = _export_bundle(
            bundle_root=bundle_root,
            project_ids=args.project_ids,
            provider_device_id=args.provider_device_id,
        )
        return _build_summary(command, bundle_root, result)
    if command == "import":
        result = _import_bundle(
            bundle_root=bundle_root,
            provider_device_id=args.provider_device_id,
        )
        return _build_summary(command, bundle_root, result)

    raise SyncBundleCliError(f"unsupported command: {command}")


def _export_bundle(
    *,
    bundle_root: Path,
    project_ids: list[str] | None,
    provider_device_id: str | None,
) -> Any:
    export_sync_bundle = _load_service_function("export_sync_bundle")
    from app.db import session_scope

    with session_scope() as session:
        return export_sync_bundle(
            session,
            bundle_root=bundle_root,
            project_ids=project_ids,
            provider_device_id=provider_device_id,
        )


def _import_bundle(*, bundle_root: Path, provider_device_id: str | None) -> Any:
    import_sync_bundle = _load_service_function("import_sync_bundle")
    from app.db import session_scope

    with session_scope() as session:
        return import_sync_bundle(
            session,
            bundle_root=bundle_root,
            provider_device_id=provider_device_id,
        )


def _load_service_function(name: str) -> ServiceFunction:
    try:
        module = importlib.import_module("app.services.sync_bundle")
    except ImportError as exc:
        raise SyncBundleCliError(
            "sync bundle service is unavailable; expected app.services.sync_bundle "
            f"with callable {name}()"
        ) from exc

    function = getattr(module, name, None)
    if not callable(function):
        raise SyncBundleCliError(f"sync bundle service does not define callable {name}()")
    return function


def _build_summary(command: str, bundle_root: Path, result: Any) -> dict[str, Any]:
    return {
        "command": command,
        "bundle_root": str(bundle_root),
        "project_count": _project_count(result),
        "import_counts": _import_counts(result) if command == "import" else None,
        "blob_count": _blob_count(result),
        "bytes": _byte_count(result),
    }


def _project_count(result: Any) -> int | None:
    return _metric(
        result,
        (
            "project_count",
            "projects_count",
            "exported_project_count",
            "imported_project_count",
            "imported_projects_count",
        ),
        ("projects", "exported_projects", "imported_projects"),
    )


def _blob_count(result: Any) -> int | None:
    return _metric(
        result,
        (
            "blob_count",
            "blobs_count",
            "artifact_count",
            "artifacts_count",
            "exported_blob_count",
            "imported_blob_count",
        ),
        ("blobs", "artifacts", "exported_blobs", "imported_blobs"),
    )


def _byte_count(result: Any) -> int | None:
    return _metric(
        result,
        (
            "bytes",
            "byte_count",
            "total_bytes",
            "blob_bytes",
            "artifact_bytes",
            "total_blob_bytes",
            "total_artifact_bytes",
        ),
        (),
    )


def _import_counts(result: Any) -> dict[str, int] | None:
    for name in ("import_counts", "counts"):
        value = _read_value(result, name)
        if isinstance(value, Mapping):
            direct_counts = _int_mapping(value)
            if direct_counts:
                return direct_counts

    counts: dict[str, int] = {}
    for output_name, source_names in {
        "projects": ("imported_project_count", "imported_projects_count", "project_count"),
        "revisions": ("imported_revision_count", "imported_revisions_count", "revision_count"),
        "artifacts": ("imported_artifact_count", "imported_artifacts_count", "artifact_count"),
        "blobs": ("imported_blob_count", "imported_blobs_count", "blob_count"),
    }.items():
        value = _metric(result, source_names, ())
        if value is not None:
            counts[output_name] = value
    return counts or None


def _metric(result: Any, scalar_names: tuple[str, ...], collection_names: tuple[str, ...]) -> int | None:
    for name in scalar_names:
        value = _as_int(_read_value(result, name))
        if value is not None:
            return value

    for name in collection_names:
        value = _collection_size(_read_value(result, name))
        if value is not None:
            return value
    return None


def _read_value(result: Any, name: str) -> Any:
    if result is None:
        return None
    if isinstance(result, Mapping):
        return result.get(name)
    return getattr(result, name, None)


def _int_mapping(value: Mapping[Any, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for key, item in value.items():
        count = _as_int(item)
        if count is not None:
            counts[str(key)] = count
    return counts


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _collection_size(value: Any) -> int | None:
    if isinstance(value, str | bytes | bytearray):
        return None
    if isinstance(value, Sized):
        return len(value)
    return None


def _resolve_path(path: Path) -> Path:
    return path.expanduser().resolve()


if __name__ == "__main__":
    raise SystemExit(main())
