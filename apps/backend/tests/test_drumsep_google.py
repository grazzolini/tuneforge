from __future__ import annotations

import io
from pathlib import Path

import pytest

from app.engines.drumsep_identity import RAW_SHA256, RAW_SIZE_BYTES
from app.errors import JobCancelledError
from app.services import drum_substem_model as model
from app.utils.hashing import file_sha256


class _Response(io.BytesIO):
    def __init__(self, body: bytes, content_type: str = "application/octet-stream") -> None:
        super().__init__(body)
        self.headers = {"Content-Type": content_type}


def _google_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> bytes:
    raw = b"synthetic immutable upstream bytes"
    monkeypatch.setattr(model, "_manifest_path", lambda: tmp_path / "no-descriptor.json")
    monkeypatch.setattr(model, "_google_cache_dir", lambda: tmp_path / "cache")
    monkeypatch.setattr(model, "RAW_SIZE_BYTES", len(raw))
    monkeypatch.setattr(model, "RAW_SHA256", file_sha256(_write(tmp_path / "expected", raw)))
    monkeypatch.setattr(
        model, "_convert_google_raw", lambda _source, target, **_kwargs: target.write_bytes(b"converted"),
    )
    return raw


def _write(path: Path, contents: bytes) -> Path:
    path.write_bytes(contents)
    return path


def test_capability_is_read_only_and_download_requires_consent(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _google_fixture(monkeypatch, tmp_path)
    monkeypatch.setattr(model, "urlopen", lambda *_args, **_kwargs: pytest.fail("unexpected network"))
    capability = model.drumsep_capabilities()
    assert capability["available"] is True
    assert capability["cache_status"] == "missing"
    assert capability["download_size_bytes"] == model.RAW_SIZE_BYTES
    assert not (tmp_path / "cache").exists()
    with pytest.raises(RuntimeError, match="authorize download"):
        model.resolve_drumsep_checkpoint(allow_download=False)


def test_fixed_google_acquisition_and_verified_offline_reuse(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    raw = _google_fixture(monkeypatch, tmp_path)
    urls: list[str] = []

    def download(url: str, *, timeout: int) -> _Response:
        urls.append(url)
        assert timeout == 30
        return _Response(raw)

    monkeypatch.setattr(model, "urlopen", download)
    checkpoint, converted = model.resolve_drumsep_checkpoint(allow_download=True)
    assert urls == [model.GOOGLE_URL]
    assert checkpoint.source_kind == "google-author-hosted"
    assert checkpoint.upstream_sha256 == model.RAW_SHA256
    assert checkpoint.license is None and checkpoint.rights_record is None
    assert converted.read_bytes() == b"converted"
    assert model._google_raw_path().read_bytes() == raw
    assert model.drumsep_capabilities()["cache_status"] == "verified"
    monkeypatch.setattr(model, "urlopen", lambda *_args, **_kwargs: pytest.fail("unexpected network"))
    monkeypatch.setattr(model, "_convert_google_raw", lambda *_args, **_kwargs: pytest.fail("unexpected conversion"))
    assert model.resolve_drumsep_checkpoint(allow_download=False)[1] == converted


@pytest.mark.parametrize("body,content_type", [
    (b"<html>confirm</html>", "text/html"),
    (b"truncated", "application/octet-stream"),
    (b"x" * 64, "application/octet-stream"),
])
def test_bad_download_does_not_publish_cache(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, body: bytes, content_type: str,
) -> None:
    _google_fixture(monkeypatch, tmp_path)
    monkeypatch.setattr(model, "urlopen", lambda *_args, **_kwargs: _Response(body, content_type))
    with pytest.raises(RuntimeError):
        model.resolve_drumsep_checkpoint(allow_download=True)
    assert not model._google_raw_path().exists()
    assert not model._google_converted_path().exists()
    assert not list((tmp_path / "cache").glob(".drumsep-*"))


def test_cancel_preserves_verified_raw_and_offline_retry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    raw = _google_fixture(monkeypatch, tmp_path)
    raw_path = model._google_raw_path()
    raw_path.parent.mkdir(parents=True)
    raw_path.write_bytes(raw)
    monkeypatch.setattr(model, "urlopen", lambda *_args, **_kwargs: pytest.fail("unexpected network"))
    with pytest.raises(JobCancelledError):
        model.resolve_drumsep_checkpoint(allow_download=False, should_cancel=lambda: True)
    assert raw_path.read_bytes() == raw
    assert not list(raw_path.parent.glob(".drumsep-*"))
    assert model.resolve_drumsep_checkpoint(allow_download=False)[1].is_file()


def test_corrupt_conversion_rebuilds_from_verified_raw_offline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    raw = _google_fixture(monkeypatch, tmp_path)
    monkeypatch.setattr(model, "urlopen", lambda *_args, **_kwargs: _Response(raw))
    _, converted = model.resolve_drumsep_checkpoint(allow_download=True)
    converted.write_bytes(b"corrupt")
    monkeypatch.setattr(model, "urlopen", lambda *_args, **_kwargs: pytest.fail("unexpected network"))
    assert model.resolve_drumsep_checkpoint(allow_download=False)[1].read_bytes() == b"converted"


def test_pinned_identity_is_not_a_bundle_asset() -> None:
    assert RAW_SIZE_BYTES == 167400043
    assert RAW_SHA256 == "aefaa8543c9b9c75e22f5f32b53ab86dfe416457849af1383ff1aef83401423f"
