from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.utils.torch_runtime import choose_torch_device


def make_fake_torch(
    *,
    has_mps: bool,
    has_cuda: bool,
    supported_arches: list[str] | None = None,
    device_capability: tuple[int, int] = (7, 5),
):
    return SimpleNamespace(
        version=SimpleNamespace(cuda="13.0" if has_cuda else None),
        backends=SimpleNamespace(
            mps=SimpleNamespace(
                is_available=lambda: has_mps,
            )
        ),
        cuda=SimpleNamespace(
            is_available=lambda: has_cuda,
            get_arch_list=lambda: list(supported_arches or []),
            device_count=lambda: 1 if has_cuda else 0,
            get_device_capability=lambda _index: device_capability,
        ),
    )


def test_choose_torch_device_prefers_cuda_then_mps_then_cpu():
    assert choose_torch_device(
        "auto",
        torch_module=make_fake_torch(
            has_mps=True,
            has_cuda=True,
            supported_arches=["sm_75", "sm_80"],
            device_capability=(7, 5),
        ),
    ) == "cuda"
    assert choose_torch_device("auto", torch_module=make_fake_torch(has_mps=True, has_cuda=False)) == "mps"
    assert choose_torch_device("auto", torch_module=make_fake_torch(has_mps=False, has_cuda=False)) == "cpu"


def test_choose_torch_device_rejects_unavailable_requested_backend():
    with pytest.raises(RuntimeError, match="MPS is unavailable"):
        choose_torch_device("mps", torch_module=make_fake_torch(has_mps=False, has_cuda=False))

    with pytest.raises(RuntimeError, match="CUDA is unavailable"):
        choose_torch_device("cuda", torch_module=make_fake_torch(has_mps=True, has_cuda=False))


def test_choose_torch_device_auto_falls_back_when_cuda_arch_is_unsupported():
    assert (
        choose_torch_device(
            "auto",
            torch_module=make_fake_torch(
                has_mps=False,
                has_cuda=True,
                supported_arches=["sm_75", "sm_80"],
                device_capability=(6, 1),
            ),
        )
        == "cpu"
    )


def test_lv_chordia_uses_architecture_aware_torch_device(monkeypatch: pytest.MonkeyPatch):
    from app.engines import lv_chordia

    fake_torch = make_fake_torch(
        has_mps=False,
        has_cuda=True,
        supported_arches=["sm_75", "sm_80"],
        device_capability=(6, 1),
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    assert lv_chordia.lv_chordia_runtime_device() == "cpu"


def test_lv_chordia_prewarm_retries_recognized_accelerator_failure_on_cpu(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.engines import lv_chordia

    calls: list[str] = []

    def fake_session_for_device(device: str) -> object:
        calls.append(device)
        if device == "mps":
            raise RuntimeError("MPS backend out of memory")
        return object()

    monkeypatch.setattr(lv_chordia, "lv_chordia_runtime_device", lambda: "mps")
    monkeypatch.setattr(lv_chordia, "_session_for_device", fake_session_for_device)

    lv_chordia.preload_lv_chordia_session()

    assert calls == ["mps", "cpu"]


def test_lv_chordia_prewarm_propagates_unrecognized_failure_without_cpu_retry(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.engines import lv_chordia

    calls: list[str] = []
    original_error = RuntimeError("LV Chordia checkpoint is corrupt")

    def fake_session_for_device(device: str) -> object:
        calls.append(device)
        raise original_error

    monkeypatch.setattr(lv_chordia, "lv_chordia_runtime_device", lambda: "cuda")
    monkeypatch.setattr(lv_chordia, "_session_for_device", fake_session_for_device)

    with pytest.raises(RuntimeError) as exc_info:
        lv_chordia.preload_lv_chordia_session()

    assert exc_info.value is original_error
    assert calls == ["cuda"]


def test_choose_torch_device_rejects_requested_cuda_when_arch_is_unsupported():
    with pytest.raises(RuntimeError, match="does not support the visible NVIDIA GPU architecture"):
        choose_torch_device(
            "cuda",
            torch_module=make_fake_torch(
                has_mps=False,
                has_cuda=True,
                supported_arches=["sm_75", "sm_80"],
                device_capability=(6, 1),
            ),
        )


def test_choose_torch_device_rejects_unknown_backend():
    with pytest.raises(ValueError, match="Unsupported torch device"):
        choose_torch_device("metal", torch_module=make_fake_torch(has_mps=True, has_cuda=False))


def test_demucs_worker_uses_trusted_checkpoint_loading(monkeypatch):
    from app.engines import demucs_worker

    calls: list[dict[str, object]] = []

    def fake_load(*args: object, **kwargs: object) -> dict[str, object]:
        del args
        calls.append(dict(kwargs))
        return {}

    monkeypatch.setattr(demucs_worker.torch, "load", fake_load)

    with demucs_worker._trusted_demucs_checkpoint_loading():
        demucs_worker.torch.load("checkpoint.th", "cpu")

    assert calls == [{"weights_only": False}]
    assert demucs_worker.torch.load is fake_load


def test_demucs_torch_preload_skips_model_load_when_cache_is_valid(tmp_path: Path):
    from app.engines.demucs_cache import preload_demucs_torch_cache

    checkpoint_dir = tmp_path / "checkpoints"
    first_file = _write_checkpoint(checkpoint_dir, "first.th", b"first")
    second_file = _write_checkpoint(checkpoint_dir, "second.th", b"second")
    manifest_path = _write_demucs_manifest(
        tmp_path,
        {
            "model-a": [first_file],
            "model-b": [second_file],
        },
    )
    calls: list[str] = []

    results = preload_demucs_torch_cache(
        manifest_path=manifest_path,
        checkpoint_dir=checkpoint_dir,
        model_ids=("model-a", "model-b"),
        get_model_func=lambda model_id: calls.append(model_id),
    )

    assert calls == []
    assert [(result.model_id, result.cache_hit) for result in results] == [
        ("model-a", True),
        ("model-b", True),
    ]


def test_demucs_torch_preload_loads_only_affected_model(tmp_path: Path):
    from app.engines.demucs_cache import preload_demucs_torch_cache

    checkpoint_dir = tmp_path / "checkpoints"
    first_file = _write_checkpoint(checkpoint_dir, "first.th", b"first")
    missing_file = _expected_checkpoint("missing.th", b"missing")
    manifest_path = _write_demucs_manifest(
        tmp_path,
        {
            "model-a": [first_file],
            "model-b": [missing_file],
        },
    )
    calls: list[str] = []

    def fake_get_model(model_id: str) -> None:
        calls.append(model_id)
        _write_checkpoint(checkpoint_dir, "missing.th", b"missing")

    results = preload_demucs_torch_cache(
        manifest_path=manifest_path,
        checkpoint_dir=checkpoint_dir,
        model_ids=("model-a", "model-b"),
        get_model_func=fake_get_model,
    )

    assert calls == ["model-b"]
    assert [(result.model_id, result.cache_hit) for result in results] == [
        ("model-a", True),
        ("model-b", False),
    ]


def test_demucs_torch_preload_raises_when_loaded_model_remains_invalid(tmp_path: Path):
    from app.engines.demucs_cache import preload_demucs_torch_cache

    checkpoint_dir = tmp_path / "checkpoints"
    manifest_path = _write_demucs_manifest(
        tmp_path,
        {
            "model-a": [_expected_checkpoint("missing.th", b"missing")],
        },
    )

    with pytest.raises(RuntimeError, match="missing.th \\(missing\\)"):
        preload_demucs_torch_cache(
            manifest_path=manifest_path,
            checkpoint_dir=checkpoint_dir,
            model_ids=("model-a",),
            get_model_func=lambda _model_id: None,
        )


def test_model_cache_verification_accepts_valid_files(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    path = tmp_path / "model.bin"
    path.write_bytes(b"model")

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=path,
                size=5,
                sha256=hashlib.sha256(b"model").hexdigest(),
            ),
        ),
    )

    assert invalid_files == ()


def test_model_cache_verification_rejects_missing_files(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=tmp_path / "missing.bin",
                size=5,
                sha256=hashlib.sha256(b"model").hexdigest(),
            ),
        ),
    )

    assert invalid_files[0].reason == "missing"


def test_model_cache_verification_rejects_wrong_size(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    path = tmp_path / "model.bin"
    path.write_bytes(b"model")

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=path,
                size=6,
                sha256=hashlib.sha256(b"model").hexdigest(),
            ),
        ),
    )

    assert invalid_files[0].reason == "size"


def test_model_cache_verification_rejects_wrong_hash(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    path = tmp_path / "model.bin"
    path.write_bytes(b"model")

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=path,
                size=5,
                sha256=hashlib.sha256(b"other").hexdigest(),
            ),
        ),
    )

    assert invalid_files[0].reason == "sha256"


def test_demucs_model_cache_verifier_reads_manifest_without_loader(tmp_path: Path):
    from app.engines.demucs_cache import invalid_demucs_torch_cache_files

    checkpoint_dir = tmp_path / "checkpoints"
    first_file = _write_checkpoint(checkpoint_dir, "first.th", b"first")
    second_file = _write_checkpoint(checkpoint_dir, "second.th", b"second")
    manifest_path = _write_demucs_manifest(
        tmp_path,
        {
            "model-a": [first_file],
            "model-b": [second_file],
        },
    )

    invalid_files = invalid_demucs_torch_cache_files(
        manifest_path=manifest_path,
        checkpoint_dir=checkpoint_dir,
        model_ids=("model-a", "model-b"),
    )

    assert invalid_files == ()


def test_whisper_model_cache_verifier_uses_configured_model_spec(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines.lyrics import (
        WHISPER_MODEL_CACHE_SPECS,
        WhisperModelCacheSpec,
        invalid_whisper_model_cache_files,
    )

    payload = b"whisper-fixture"
    monkeypatch.setitem(
        WHISPER_MODEL_CACHE_SPECS,
        "fixture",
        WhisperModelCacheSpec(
            file_name="fixture.pt",
            size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        ),
    )
    (tmp_path / "fixture.pt").write_bytes(payload)

    invalid_files = invalid_whisper_model_cache_files("fixture", cache_dir=tmp_path)

    assert invalid_files == ()


def test_beat_this_model_cache_verifier_uses_torch_checkpoint_spec(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines.beat_this import (
        BEAT_THIS_CHECKPOINT_SPECS,
        BeatThisCheckpointSpec,
        invalid_beat_this_checkpoint_cache_files,
    )

    payload = b"beat-this-fixture"
    checkpoint_dir = tmp_path / "checkpoints"
    checkpoint_dir.mkdir()
    monkeypatch.setitem(
        BEAT_THIS_CHECKPOINT_SPECS,
        "fixture",
        BeatThisCheckpointSpec(
            file_name="beat_this-fixture.ckpt",
            size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        ),
    )
    (checkpoint_dir / "beat_this-fixture.ckpt").write_bytes(payload)

    invalid_files = invalid_beat_this_checkpoint_cache_files("fixture", checkpoint_dir=checkpoint_dir)

    assert invalid_files == ()


def test_whisper_default_cache_uses_upstream_location(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from app.config import get_settings

    monkeypatch.delenv("TUNEFORGE_LYRICS_CACHE_DIR", raising=False)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    get_settings.cache_clear()

    try:
        assert get_settings().lyrics_cache_dir == tmp_path / "xdg-cache" / "whisper"
    finally:
        get_settings.cache_clear()


def test_whisper_cache_override_expands_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from app.config import get_settings

    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("TUNEFORGE_LYRICS_CACHE_DIR", "~/lyrics-cache")
    get_settings.cache_clear()

    try:
        assert get_settings().lyrics_cache_dir == home / "lyrics-cache"
    finally:
        get_settings.cache_clear()


def test_model_bundle_seeds_missing_caches(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.utils.model_bundle import seed_model_bundle_caches

    bundle_dir = tmp_path / "bundle"
    torch_source = bundle_dir / "torch" / "hub" / "checkpoints" / "model.th"
    whisper_source = bundle_dir / "whisper" / "lyrics.pt"
    torch_source.parent.mkdir(parents=True)
    whisper_source.parent.mkdir(parents=True)
    torch_source.write_bytes(b"torch-model")
    whisper_source.write_bytes(b"whisper-model")
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )
    torch_home = tmp_path / "torch-home"
    lyrics_cache = tmp_path / "lyrics"
    monkeypatch.setenv("TORCH_HOME", str(torch_home))

    seed_model_bundle_caches(
        SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=lyrics_cache)
    )

    assert (torch_home / "hub" / "checkpoints" / "model.th").read_bytes() == b"torch-model"
    assert (lyrics_cache / "lyrics.pt").read_bytes() == b"whisper-model"


def test_model_bundle_skips_valid_cache(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.utils import model_bundle

    bundle_dir = tmp_path / "bundle"
    torch_source = bundle_dir / "torch" / "hub" / "checkpoints" / "model.th"
    whisper_source = bundle_dir / "whisper" / "lyrics.pt"
    torch_source.parent.mkdir(parents=True)
    whisper_source.parent.mkdir(parents=True)
    torch_source.write_bytes(b"torch-model")
    whisper_source.write_bytes(b"whisper-model")
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )
    torch_home = tmp_path / "torch-home"
    lyrics_cache = tmp_path / "lyrics"
    destination = torch_home / "hub" / "checkpoints" / "model.th"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"torch-model")
    monkeypatch.setenv("TORCH_HOME", str(torch_home))

    calls: list[Path] = []

    def fake_copy2(source: Path, destination_path: Path) -> None:
        calls.append(Path(source))
        destination_path.write_bytes(Path(source).read_bytes())

    monkeypatch.setattr(model_bundle.shutil, "copy2", fake_copy2)

    model_bundle.seed_model_bundle_caches(
        SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=lyrics_cache)
    )

    assert calls == [whisper_source]
    assert destination.read_bytes() == b"torch-model"


def test_model_bundle_replaces_invalid_cache(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.utils.model_bundle import seed_model_bundle_caches

    bundle_dir = tmp_path / "bundle"
    torch_source = bundle_dir / "torch" / "hub" / "checkpoints" / "model.th"
    whisper_source = bundle_dir / "whisper" / "lyrics.pt"
    torch_source.parent.mkdir(parents=True)
    whisper_source.parent.mkdir(parents=True)
    torch_source.write_bytes(b"torch-model")
    whisper_source.write_bytes(b"whisper-model")
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )
    torch_home = tmp_path / "torch-home"
    torch_destination = torch_home / "hub" / "checkpoints" / "model.th"
    torch_destination.parent.mkdir(parents=True)
    torch_destination.write_bytes(b"stale")
    lyrics_cache = tmp_path / "lyrics"
    monkeypatch.setenv("TORCH_HOME", str(torch_home))

    seed_model_bundle_caches(
        SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=lyrics_cache)
    )

    assert torch_destination.read_bytes() == b"torch-model"


def test_model_bundle_rejects_missing_bundled_file(tmp_path: Path):
    from app.utils.model_bundle import seed_model_bundle_caches

    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )

    with pytest.raises(RuntimeError, match="Bundled model file is invalid"):
        seed_model_bundle_caches(
            SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=tmp_path / "lyrics")
        )


def test_model_cache_verifier_imports_no_ml_runtimes():
    script = (
        "import json, sys; "
        "import app.cli.prewarm_models; "
        "print(json.dumps({name: name in sys.modules "
        "for name in ['torch', 'whisper', 'beat_this', 'demucs', 'crema', 'tensorflow', 'keras']}))"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
    )

    imported = json.loads(completed.stdout)
    assert imported == {
        "torch": False,
        "whisper": False,
        "beat_this": False,
        "demucs": False,
        "crema": False,
        "tensorflow": False,
        "keras": False,
    }


def _expected_checkpoint(file_name: str, contents: bytes) -> dict[str, object]:
    return {
        "fileName": file_name,
        "size": len(contents),
        "sha256": hashlib.sha256(contents).hexdigest(),
    }


def _write_checkpoint(checkpoint_dir: Path, file_name: str, contents: bytes) -> dict[str, object]:
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    (checkpoint_dir / file_name).write_bytes(contents)
    return _expected_checkpoint(file_name, contents)


def _write_demucs_manifest(tmp_path: Path, models: dict[str, list[dict[str, object]]]) -> Path:
    manifest_path = tmp_path / "models.json"
    manifest_path.write_text(
        json.dumps(
            {
                "rootUrl": "https://example.invalid/",
                "models": [
                    {
                        "id": model_id,
                        "yaml": f"{model_id}.yaml",
                        "files": files,
                    }
                    for model_id, files in models.items()
                ],
            }
        ),
        encoding="utf-8",
    )
    return manifest_path


def _write_model_bundle_manifest(
    bundle_dir: Path,
    *,
    torch_payload: bytes,
    whisper_payload: bytes,
) -> None:
    (bundle_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "torch_checkpoints": [
                    {
                        "label": "fixture torch",
                        "file_name": "model.th",
                        "relative_path": "torch/hub/checkpoints/model.th",
                        "size": len(torch_payload),
                        "sha256": hashlib.sha256(torch_payload).hexdigest(),
                    }
                ],
                "whisper_models": [
                    {
                        "label": "fixture whisper",
                        "file_name": "lyrics.pt",
                        "relative_path": "whisper/lyrics.pt",
                        "size": len(whisper_payload),
                        "sha256": hashlib.sha256(whisper_payload).hexdigest(),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
