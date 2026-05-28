from __future__ import annotations

import hashlib
import json
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
