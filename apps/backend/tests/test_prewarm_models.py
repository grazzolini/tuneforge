from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from typing import Any

import pytest

from app.cli import prewarm_models
from app.engines import crema_chords
from app.utils.model_cache import InvalidModelFile


def test_valid_whisper_cache_skips_preload(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    calls: list[str] = []

    monkeypatch.setattr(prewarm_models, "invalid_whisper_model_cache_files", lambda _model_name: ())
    monkeypatch.setattr(prewarm_models, "preload_whisper_model", lambda model_name: calls.append(model_name))

    prewarm_models._verify_or_prewarm_whisper("tiny")

    assert calls == []
    assert capsys.readouterr().out == "Whisper tiny model cache verified.\n"


@pytest.mark.parametrize("reason", ["missing", "sha256"])
def test_missing_or_invalid_whisper_cache_preloads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    reason: str,
) -> None:
    invalid_file = _invalid_file(tmp_path, label="Whisper tiny", reason=reason)
    calls: list[str] = []
    invalid_results = iter(((invalid_file,), ()))

    monkeypatch.setattr(
        prewarm_models,
        "invalid_whisper_model_cache_files",
        lambda _model_name: next(invalid_results),
    )
    monkeypatch.setattr(prewarm_models, "preload_whisper_model", lambda model_name: calls.append(model_name))

    prewarm_models._verify_or_prewarm_whisper("tiny")

    assert calls == ["tiny"]


def test_valid_beat_this_cache_skips_preload(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[str] = []

    monkeypatch.setattr(prewarm_models, "invalid_beat_this_checkpoint_cache_files", lambda _checkpoint: ())
    monkeypatch.setattr(
        prewarm_models,
        "preload_beat_this_checkpoint",
        lambda checkpoint: calls.append(checkpoint),
    )

    prewarm_models._verify_or_prewarm_beat_this("small0")

    assert calls == []
    assert capsys.readouterr().out == "beat-this small0 checkpoint cache verified.\n"


def test_valid_lv_chordia_bundle_preloads_after_integrity_check(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(prewarm_models, "lv_chordia_dependency_status", lambda: (True, None))
    monkeypatch.setattr(prewarm_models, "invalid_lv_chordia_model_asset_files", lambda: ())
    monkeypatch.setattr(prewarm_models, "preload_lv_chordia_session", lambda: calls.append("loaded"))

    prewarm_models._verify_or_prewarm_lv_chordia()

    assert calls == ["loaded"]
    assert capsys.readouterr().out == (
        "LV Chordia bundled checkpoints verified and model preloaded.\n"
    )


@pytest.mark.parametrize("reason", ["missing", "sha256"])
def test_missing_or_invalid_beat_this_cache_preloads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    reason: str,
) -> None:
    invalid_file = _invalid_file(tmp_path, label="beat-this small0", reason=reason)
    calls: list[str] = []
    invalid_results = iter(((invalid_file,), ()))

    monkeypatch.setattr(
        prewarm_models,
        "invalid_beat_this_checkpoint_cache_files",
        lambda _checkpoint: next(invalid_results),
    )
    monkeypatch.setattr(
        prewarm_models,
        "preload_beat_this_checkpoint",
        lambda checkpoint: calls.append(checkpoint),
    )

    prewarm_models._verify_or_prewarm_beat_this("small0")

    assert calls == ["small0"]


def test_crema_model_asset_verifier_uses_distribution_record(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    payload = b"crema-fixture"
    asset_path = tmp_path / "model.h5"
    asset_path.write_bytes(payload)
    package_file = _FakePackageFile(
        "crema/models/chord/model.h5",
        asset_path,
        payload=payload,
    )

    monkeypatch.setattr(crema_chords.importlib.metadata, "files", lambda _package_name: (package_file,))

    assert crema_chords.invalid_crema_model_asset_files() == ()


def test_crema_valid_asset_verification_skips_preload(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(prewarm_models, "crema_dependency_status", lambda: (True, None))
    monkeypatch.setattr(prewarm_models, "invalid_crema_model_asset_files", lambda: ())

    def fail_preload() -> None:
        raise AssertionError("Crema runtime loader should not run when assets are valid")

    monkeypatch.setattr(prewarm_models, "preload_crema_model", fail_preload)

    prewarm_models._verify_or_prewarm_crema()

    assert capsys.readouterr().out == "Crema model assets verified.\n"


def test_crema_invalid_asset_verification_falls_back_to_preload(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    invalid_file = _invalid_file(tmp_path, label="Crema model.h5", reason="metadata-sha256")
    calls: list[str] = []
    invalid_results = iter(((invalid_file,), ()))

    monkeypatch.setattr(prewarm_models, "crema_dependency_status", lambda: (True, None))
    monkeypatch.setattr(prewarm_models, "invalid_crema_model_asset_files", lambda: next(invalid_results))
    monkeypatch.setattr(prewarm_models, "preload_crema_model", lambda: calls.append("loaded"))

    prewarm_models._verify_or_prewarm_crema()

    assert calls == ["loaded"]


def test_crema_invalid_asset_verification_fails_when_assets_remain_invalid(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    invalid_file = _invalid_file(tmp_path, label="Crema model.h5", reason="metadata-sha256")
    calls: list[str] = []

    monkeypatch.setattr(prewarm_models, "crema_dependency_status", lambda: (True, None))
    monkeypatch.setattr(prewarm_models, "invalid_crema_model_asset_files", lambda: (invalid_file,))
    monkeypatch.setattr(prewarm_models, "preload_crema_model", lambda: calls.append("loaded"))

    with pytest.raises(RuntimeError, match="Crema model assets remain invalid"):
        prewarm_models._verify_or_prewarm_crema()

    assert calls == ["loaded"]


def _invalid_file(tmp_path: Path, *, label: str, reason: str) -> InvalidModelFile:
    path = tmp_path / f"{reason}.bin"
    if reason != "missing":
        path.write_bytes(b"stale")
    return InvalidModelFile(label=label, path=path, reason=reason)


class _FakeFileHash:
    mode = "sha256"

    def __init__(self, payload: bytes) -> None:
        self.value = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).decode("ascii").rstrip("=")


class _FakePackageFile:
    def __init__(self, package_path: str, local_path: Path, *, payload: bytes) -> None:
        self._package_path = package_path
        self._local_path = local_path
        self.size = len(payload)
        self.hash = _FakeFileHash(payload)

    def __str__(self) -> str:
        return self._package_path

    def locate(self) -> Any:
        return self._local_path
