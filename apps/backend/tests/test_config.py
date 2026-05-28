from __future__ import annotations

import pytest

from app.config import _parse_additional_cors_origins


def test_additional_cors_origins_accepts_loopback_http_origins() -> None:
    assert _parse_additional_cors_origins(
        "http://127.0.0.1:5173, http://localhost:1420/"
    ) == (
        "http://127.0.0.1:5173",
        "http://localhost:1420",
    )


@pytest.mark.parametrize(
    "origin",
    [
        "https://127.0.0.1:5173",
        "http://0.0.0.0:5173",
        "http://example.com:5173",
        "http://127.0.0.1:5173/path",
        "http://127.0.0.1:999999",
        "http://127.0.0.1",
    ],
)
def test_additional_cors_origins_rejects_non_loopback_http_origins(origin: str) -> None:
    with pytest.raises(ValueError):
        _parse_additional_cors_origins(origin)
