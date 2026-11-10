from __future__ import annotations

import os
import shutil
import stat
import tempfile
from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen

from app.utils.model_cache import ExpectedModelFile, torch_checkpoint_dir

WEIGHT_REVISION = "379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19"
WEIGHT_SIZE = 1400571
WEIGHTS = (
    ("harmonix-fold0-0vra4ys2.pth", "0db596dfb0995f41d62f6267d76a9d54c046f1649bd35e1dbeca0c5f9a7b8acd"),
    ("harmonix-fold1-3ozjhtsj.pth", "607b4864eaabccd4f6951410d5ea6676666ad1cfa6ce2e18bc99f3824b77c3b7"),
    ("harmonix-fold2-gmgo0nsy.pth", "67c28ec7ca612d365e5fcb152f6530eb53e34c4303940afb30fd17a295c958a4"),
    ("harmonix-fold3-i92b7m8p.pth", "446d05672b2669cdb7d9b8bbbc228a4f3592484335a7995cca89a744e3950ddc"),
    ("harmonix-fold4-1bql5qo0.pth", "96327222ab9b33c005388b788ba602f529aa03cc4dde1c859c011f1004490493"),
    ("harmonix-fold5-x4z5zeef.pth", "c87f162a1090290bcbb863688746784919cf912c56744fb3d81a1a7dba3b114e"),
    ("harmonix-fold6-x7t226rq.pth", "13e7e639bf30fcd3fa049ad863088773a4e57b06d7c68581385b3ef625c60688"),
    ("harmonix-fold7-qwwskhg6.pth", "b888b7fba95efa3d5a37ca013fe7efe2741621ea9ca335e6b2723e4fd0fade57"),
)


def section_weight_files() -> tuple[ExpectedModelFile, ...]:
    root = torch_checkpoint_dir() / "tuneforge-all-in-one" / WEIGHT_REVISION
    return tuple(ExpectedModelFile(name, root / name, WEIGHT_SIZE, digest) for name, digest in WEIGHTS)


def preload_section_weights(*, staging_dir: Path | None = None) -> tuple[Path, ...]:
    """Download immutable original-author assets; verify before atomic publication."""
    expected = section_weight_files()
    for item in expected:
        if _valid_section_weight(item):
            continue
        item.path.parent.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(item.path.parent).free < item.size + 1024 * 1024:
            raise RuntimeError("Not enough disk space to cache the section model.")
        descriptor, temporary = tempfile.mkstemp(prefix=".download-", dir=staging_dir or item.path.parent)
        candidate = Path(temporary)
        try:
            with os.fdopen(descriptor, "wb") as output:
                url = f"https://huggingface.co/taejunkim/allinone/resolve/{WEIGHT_REVISION}/{item.label}"
                with urlopen(url, timeout=60) as response:
                    remaining = item.size + 1
                    while remaining and (chunk := response.read(min(65536, remaining))):
                        output.write(chunk)
                        remaining -= len(chunk)
            if not _valid_section_weight(ExpectedModelFile(item.label, candidate, item.size, item.sha256)):
                raise RuntimeError("Section model download failed byte verification.")
            candidate.replace(item.path)
        except Exception as exc:
            # Another downloader may have completed while this one failed.
            if not _valid_section_weight(item):
                raise RuntimeError("Section model unavailable; connect once and retry, or run setup:dev.") from exc
        finally:
            candidate.unlink(missing_ok=True)
    if not all(_valid_section_weight(item) for item in expected):
        raise RuntimeError("Section model cache failed byte verification.")
    return tuple(item.path for item in expected)


def verified_section_weight_bytes(expected: ExpectedModelFile) -> bytes:
    """Read the exact bounded regular-file bytes that will be deserialized."""
    descriptor = os.open(expected.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected.size:
            raise ValueError("Invalid section checkpoint file.")
        payload = source.read(expected.size + 1)
    if len(payload) != expected.size or sha256(payload).hexdigest() != expected.sha256:
        raise ValueError("Invalid section checkpoint bytes.")
    return payload


def _valid_section_weight(expected: ExpectedModelFile) -> bool:
    try:
        verified_section_weight_bytes(expected)
    except OSError, ValueError:
        return False
    return True
