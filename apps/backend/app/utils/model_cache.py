from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path


@dataclass(frozen=True)
class ExpectedModelFile:
    label: str
    path: Path
    size: int
    sha256: str


@dataclass(frozen=True)
class InvalidModelFile:
    label: str
    path: Path
    reason: str
    expected_size: int | None = None
    actual_size: int | None = None


def torch_checkpoint_dir(env: Mapping[str, str] | None = None) -> Path:
    current_env = env or os.environ
    torch_home = current_env.get("TORCH_HOME")
    if torch_home:
        return Path(torch_home).expanduser().resolve() / "hub" / "checkpoints"

    xdg_cache_home = current_env.get("XDG_CACHE_HOME")
    if xdg_cache_home:
        return Path(xdg_cache_home).expanduser().resolve() / "torch" / "hub" / "checkpoints"

    return Path.home() / ".cache" / "torch" / "hub" / "checkpoints"


def whisper_cache_dir(env: Mapping[str, str] | None = None) -> Path:
    current_env = env or os.environ
    xdg_cache_home = current_env.get("XDG_CACHE_HOME")
    if xdg_cache_home:
        return Path(xdg_cache_home).expanduser().resolve() / "whisper"
    return Path.home() / ".cache" / "whisper"


def invalid_model_files(expected_files: Sequence[ExpectedModelFile]) -> tuple[InvalidModelFile, ...]:
    invalid_files = tuple(_invalid_model_file(expected_file) for expected_file in expected_files)
    return tuple(invalid_file for invalid_file in invalid_files if invalid_file is not None)


def format_invalid_model_files(invalid_files: Sequence[InvalidModelFile]) -> str:
    return "; ".join(
        f"{invalid_file.label}: {invalid_file.reason} at {invalid_file.path}"
        for invalid_file in invalid_files
    )


def remove_invalid_model_files(invalid_files: Sequence[InvalidModelFile]) -> None:
    for invalid_file in invalid_files:
        if (
            invalid_file.reason == "missing"
            or invalid_file.reason.startswith("unsupported")
            or not invalid_file.path.is_file()
        ):
            continue
        invalid_file.path.unlink()


def sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024 * 8):
            digest.update(chunk)
    return digest.hexdigest()


def _invalid_model_file(expected_file: ExpectedModelFile) -> InvalidModelFile | None:
    if not expected_file.path.is_file():
        return InvalidModelFile(
            label=expected_file.label,
            path=expected_file.path,
            reason="missing",
            expected_size=expected_file.size,
        )

    actual_size = expected_file.path.stat().st_size
    if actual_size != expected_file.size:
        return InvalidModelFile(
            label=expected_file.label,
            path=expected_file.path,
            reason="size",
            expected_size=expected_file.size,
            actual_size=actual_size,
        )

    if sha256_file(expected_file.path) != expected_file.sha256:
        return InvalidModelFile(
            label=expected_file.label,
            path=expected_file.path,
            reason="sha256",
            expected_size=expected_file.size,
            actual_size=actual_size,
        )
    return None
