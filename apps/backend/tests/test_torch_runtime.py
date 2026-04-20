from __future__ import annotations

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
