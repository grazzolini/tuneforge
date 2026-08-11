from __future__ import annotations

import importlib.metadata
import json
import logging
import os
import subprocess
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

UNKNOWN_VERSION = "unknown"

logger = logging.getLogger("tuneforge.version")


@dataclass(frozen=True)
class VersionInfo:
    package_version: str
    git_ref: str


@dataclass(frozen=True)
class BuildVersions:
    backend: VersionInfo
    frontend: VersionInfo


def package_version() -> str:
    return _backend_package_version()


@lru_cache(maxsize=1)
def get_build_versions() -> BuildVersions:
    version_file = _version_file_path()
    if version_file is not None:
        versions = _read_build_versions(version_file)
        if versions is not None:
            return versions

    workspace_root = _workspace_root()
    git_ref = _git_ref(workspace_root)
    return BuildVersions(
        backend=VersionInfo(
            package_version=_env_value("TUNEFORGE_BACKEND_PACKAGE_VERSION") or _backend_package_version(),
            git_ref=git_ref,
        ),
        frontend=VersionInfo(
            package_version=_env_value("TUNEFORGE_FRONTEND_PACKAGE_VERSION")
            or _frontend_package_version(workspace_root),
            git_ref=git_ref,
        ),
    )


def _env_value(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def _version_file_path() -> Path | None:
    configured = _env_value("TUNEFORGE_VERSION_FILE")
    if configured is None:
        return None
    return Path(configured).expanduser().resolve()


def _backend_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _workspace_root() -> Path | None:
    backend_root = _backend_root()
    if backend_root.name == "backend" and backend_root.parent.name == "apps":
        return backend_root.parent.parent
    return None


def _backend_package_version() -> str:
    try:
        return importlib.metadata.version("tuneforge-backend")
    except importlib.metadata.PackageNotFoundError:
        return _read_package_version(_backend_root() / "pyproject.toml") or UNKNOWN_VERSION


def _frontend_package_version(workspace_root: Path | None) -> str:
    if workspace_root is None:
        return UNKNOWN_VERSION
    return _read_package_version(workspace_root / "apps" / "desktop" / "package.json") or UNKNOWN_VERSION


def _read_package_version(package_path: Path) -> str | None:
    if not package_path.exists():
        return None
    try:
        if package_path.suffix == ".json":
            parsed = json.loads(package_path.read_text(encoding="utf-8"))
            version = parsed.get("version")
            return version if isinstance(version, str) and version.strip() else None

        parsed_toml = tomllib.loads(package_path.read_text(encoding="utf-8"))
        version = parsed_toml.get("project", {}).get("version")
        return version if isinstance(version, str) and version.strip() else None
    except (OSError, json.JSONDecodeError, tomllib.TOMLDecodeError) as error:
        logger.warning("Could not read package version from %s: %s", package_path, error)
        return None


def _git_ref(workspace_root: Path | None) -> str:
    env_git_ref = _env_value("TUNEFORGE_GIT_REF")
    if env_git_ref is not None:
        return env_git_ref
    if workspace_root is None:
        return UNKNOWN_VERSION
    try:
        return subprocess.run(
            ["git", "describe", "--tags", "--long", "--dirty", "--always", "--abbrev=8"],
            cwd=workspace_root,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        logger.warning("Could not resolve git ref: %s", error)
        return UNKNOWN_VERSION


def _read_build_versions(version_file: Path) -> BuildVersions | None:
    try:
        parsed = json.loads(version_file.read_text(encoding="utf-8"))
        backend = _parse_version_info(parsed.get("backend"))
        frontend = _parse_version_info(parsed.get("frontend"))
    except (OSError, json.JSONDecodeError) as error:
        logger.warning("Could not read build version file %s: %s", version_file, error)
        return None

    if backend is None or frontend is None:
        logger.warning("Build version file %s did not contain backend and frontend versions.", version_file)
        return None
    return BuildVersions(backend=backend, frontend=frontend)


def _parse_version_info(value: Any) -> VersionInfo | None:
    if not isinstance(value, dict):
        return None
    package_version_value = value.get("package_version")
    git_ref_value = value.get("git_ref")
    if not isinstance(package_version_value, str) or not isinstance(git_ref_value, str):
        return None
    package_version_value = package_version_value.strip()
    git_ref_value = git_ref_value.strip()
    if not package_version_value or not git_ref_value:
        return None
    return VersionInfo(package_version=package_version_value, git_ref=git_ref_value)
