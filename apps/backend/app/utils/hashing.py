from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def stable_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def file_sha256(path: Path, *, block_size: int = 1024 * 1024) -> str | None:
    try:
        with path.open("rb") as handle:
            digest = hashlib.sha256()
            while chunk := handle.read(block_size):
                digest.update(chunk)
            return digest.hexdigest()
    except OSError:
        return None
