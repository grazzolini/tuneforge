from __future__ import annotations

from secrets import token_hex


def new_id(prefix: str) -> str:
    return f"{prefix}_{token_hex(6)}"


def new_artifact_id() -> str:
    return f"art_{token_hex(14)}"
