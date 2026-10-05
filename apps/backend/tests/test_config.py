from __future__ import annotations

from pathlib import Path

import pytest

from app.config import _parse_additional_cors_origins, _parse_backend_host, get_settings

_BACKEND_HOST_ERROR = r"TUNEFORGE_HOST must be one of: 127\.0\.0\.1, localhost\."


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("127.0.0.1", "127.0.0.1"),
        ("localhost", "localhost"),
        (" localhost ", "localhost"),
    ],
)
def test_backend_host_accepts_named_loopback_values(host: str, expected: str) -> None:
    assert _parse_backend_host(host) == expected


@pytest.mark.parametrize(
    "host",
    [
        "",
        " ",
        "0.0.0.0",
        "8.8.8.8",
        "10.0.0.1",
        "192.168.1.10",
        "example.com",
        "dev.local",
        "http://127.0.0.1",
        "https://localhost",
        "127.0.0.1:8765",
        "localhost:8765",
        "127.0.0.1/api",
        "localhost/api",
        "::1",
        "[::1]",
    ],
)
def test_backend_host_rejects_non_loopback_or_shaped_values(host: str) -> None:
    with pytest.raises(ValueError, match=_BACKEND_HOST_ERROR):
        _parse_backend_host(host)


def test_get_settings_uses_backend_host_parser(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TUNEFORGE_HOST", " localhost ")
    get_settings.cache_clear()
    try:
        assert get_settings().backend_host == "localhost"
    finally:
        get_settings.cache_clear()


def test_get_settings_rejects_invalid_backend_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TUNEFORGE_HOST", "0.0.0.0")
    get_settings.cache_clear()
    try:
        with pytest.raises(ValueError, match=_BACKEND_HOST_ERROR):
            get_settings()
    finally:
        get_settings.cache_clear()


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


@pytest.mark.parametrize("platform", ["darwin", "linux"])
def test_storage_defaults_use_shared_definition(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, platform: str
) -> None:
    from app import storage_profile
    from app.config import _default_data_root

    relative = "Library/Application Support/Renamed" if platform == "darwin" else ".local/share/renamed"
    monkeypatch.setitem(storage_profile._PROFILE["backend"], platform, relative)
    monkeypatch.setattr(storage_profile.sys, "platform", platform)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("TUNEFORGE_DATA_DIR")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "ignored-xdg"))
    assert _default_data_root() == tmp_path / relative
    monkeypatch.setenv("TUNEFORGE_DATA_DIR", str(tmp_path / "explicit"))
    assert _default_data_root() == (tmp_path / "explicit").resolve()


def test_model_defaults_use_shared_definition(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from app import storage_profile
    from app.utils.model_cache import torch_checkpoint_dir, whisper_cache_dir

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setitem(storage_profile._PROFILE, "modelCache", ".renamed-cache")
    assert whisper_cache_dir({"unrelated": "value"}) == tmp_path / ".renamed-cache/whisper"
    assert torch_checkpoint_dir({"unrelated": "value"}) == tmp_path / ".renamed-cache/torch/hub/checkpoints"
