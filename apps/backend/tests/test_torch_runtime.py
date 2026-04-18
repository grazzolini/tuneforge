from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.utils.torch_runtime import choose_torch_device


def make_fake_torch(*, has_mps: bool, has_cuda: bool):
    return SimpleNamespace(
        backends=SimpleNamespace(
            mps=SimpleNamespace(
                is_available=lambda: has_mps,
            )
        ),
        cuda=SimpleNamespace(
            is_available=lambda: has_cuda,
        ),
    )


def test_choose_torch_device_prefers_cuda_then_mps_then_cpu():
    assert choose_torch_device("auto", torch_module=make_fake_torch(has_mps=True, has_cuda=True)) == "cuda"
    assert choose_torch_device("auto", torch_module=make_fake_torch(has_mps=True, has_cuda=False)) == "mps"
    assert choose_torch_device("auto", torch_module=make_fake_torch(has_mps=False, has_cuda=False)) == "cpu"


def test_choose_torch_device_rejects_unavailable_requested_backend():
    with pytest.raises(RuntimeError, match="MPS is unavailable"):
        choose_torch_device("mps", torch_module=make_fake_torch(has_mps=False, has_cuda=False))

    with pytest.raises(RuntimeError, match="CUDA is unavailable"):
        choose_torch_device("cuda", torch_module=make_fake_torch(has_mps=True, has_cuda=False))


def test_choose_torch_device_rejects_unknown_backend():
    with pytest.raises(ValueError, match="Unsupported torch device"):
        choose_torch_device("metal", torch_module=make_fake_torch(has_mps=True, has_cuda=False))
