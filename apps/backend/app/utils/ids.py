from __future__ import annotations

from secrets import token_hex


def new_id(prefix: str) -> str:
    return f"{prefix}_{token_hex(6)}"

