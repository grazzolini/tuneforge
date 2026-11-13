from __future__ import annotations

import fcntl
import importlib.util
import os
import shutil
import tempfile
import time
from collections.abc import Callable
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen

from app.config import get_settings
from app.errors import AppError, JobCancelledError

MEGA53_MODEL = "mega53"
MEGA53_REVISION = "v1.0.21"
MEGA53_ENGINE_REVISION = "ea7eb9c20ea0e3f94368a30fc1654b51cdd55789"
MEGA53_WEIGHTS = "mvsep_mega_model_bs_roformer_53_stems_v1.ckpt"
MEGA53_CONFIG = "mvsep_mega_model_bs_roformer_53_stems.yaml"
MEGA53_SHA256 = "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f"
MEGA53_CONFIG_SHA256 = "7e198062a251587088adb91215a4f44ab59e67bd62fcc805cf54d6e7dfc51103"
_ASSETS = (
    (MEGA53_WEIGHTS, 1368919887, MEGA53_SHA256),
    (MEGA53_CONFIG, 4184, MEGA53_CONFIG_SHA256),
)
_RELEASE_URL = "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download"
_BLOCK_BYTES = 1024 * 1024 * 4


def mega53_cache_dir() -> Path:
    return get_settings().cache_root / "models" / MEGA53_MODEL / MEGA53_REVISION


@lru_cache(maxsize=16)
def _verified_file(path: Path, identity: tuple[int, ...], digest: str) -> bool:
    checksum = sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_BLOCK_BYTES):
            checksum.update(chunk)
    return checksum.hexdigest() == digest


def _asset_verified(path: Path, size: int, digest: str) -> bool:
    try:
        stat = path.stat()
        return path.is_file() and stat.st_size == size and _verified_file(
            path, (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns), digest,
        )
    except OSError:
        return False


def _cache_verified(root: Path) -> bool:
    return all(_asset_verified(root / name, size, digest) for name, size, digest in _ASSETS)


def vocal_substem_capabilities() -> dict[str, object]:
    desktop = get_settings().runtime_platform not in {"android", "ios"}
    dependencies = ("torch", "einops", "rotary_embedding_torch", "yaml")
    missing = any(importlib.util.find_spec(name) is None for name in dependencies)
    available = desktop and not missing
    return {
        "available": available,
        "cached": available and _cache_verified(mega53_cache_dir()),
        "download_bytes": sum(size for _, size, _ in _ASSETS),
        "unavailable_reason": (
            None if available else "Refine Vocals requires the desktop Mega53 inference dependencies."
        ),
    }


def _check_cancel(should_cancel: Callable[[], bool] | None) -> None:
    if should_cancel and should_cancel():
        raise JobCancelledError()


def _download_asset(path: Path, name: str, size: int, digest: str, cancel: Callable[[], bool] | None) -> None:
    total = 0
    checksum = sha256()
    with urlopen(f"{_RELEASE_URL}/{MEGA53_REVISION}/{name}", timeout=30) as response, path.open("xb") as output:
        while True:
            _check_cancel(cancel)
            chunk = response.read(min(_BLOCK_BYTES, size - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > size:
                raise ValueError("Mega53 download exceeded its pinned size.")
            checksum.update(chunk)
            output.write(chunk)
        if total != size or checksum.hexdigest() != digest:
            raise ValueError("Mega53 download did not match its pinned fingerprint.")
        output.flush()
        os.fsync(output.fileno())


def resolve_mega53(
    *, allow_download: bool, should_cancel: Callable[[], bool] | None = None,
) -> tuple[Path, Path]:
    """Share a verified release directory across jobs and concurrent setup processes."""
    _check_cancel(should_cancel)
    root = mega53_cache_dir()
    if not _cache_verified(root):
        if not allow_download:
            raise AppError("STEM_MODEL_UNAVAILABLE", "Mega53 requires its verified model download.", status_code=409)
        try:
            root.parent.mkdir(parents=True, exist_ok=True)
            with (root.parent / ".download.lock").open("a") as lock:
                while True:
                    _check_cancel(should_cancel)
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        time.sleep(0.1)
                if not _cache_verified(root):
                    with tempfile.TemporaryDirectory(prefix=".mega53-", dir=root.parent) as staging:
                        candidate = Path(staging) / root.name
                        candidate.mkdir()
                        for name, size, digest in _ASSETS:
                            existing = root / name
                            if _asset_verified(existing, size, digest):
                                shutil.copyfile(existing, candidate / name)
                            else:
                                _download_asset(candidate / name, name, size, digest, should_cancel)
                        _check_cancel(should_cancel)
                        if not _cache_verified(candidate):
                            raise ValueError("Mega53 cache failed byte verification.")
                        if root.exists():
                            root.replace(Path(staging) / "invalid")
                        candidate.replace(root)
        except (OSError, ValueError) as exc:
            raise AppError(
                "STEM_MODEL_UNAVAILABLE", "Could not acquire the verified Mega53 model.", status_code=409,
            ) from exc
    _check_cancel(should_cancel)
    return root / MEGA53_WEIGHTS, root / MEGA53_CONFIG
