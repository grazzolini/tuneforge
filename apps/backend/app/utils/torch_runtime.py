from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any


def with_mps_fallback_env(base_env: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(base_env or os.environ)
    env.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    return env


def _cuda_build_supports_visible_devices(torch_module: Any) -> bool:
    cuda = getattr(torch_module, "cuda", None)
    if cuda is None:
        return False

    get_arch_list = getattr(cuda, "get_arch_list", None)
    device_count = getattr(cuda, "device_count", None)
    get_device_capability = getattr(cuda, "get_device_capability", None)
    if not callable(get_arch_list) or not callable(device_count) or not callable(get_device_capability):
        return True

    arch_list = [arch for arch in get_arch_list() if isinstance(arch, str) and arch.startswith("sm_")]
    if not arch_list:
        return True

    supported_majors = {int(arch.removeprefix("sm_")) // 10 for arch in arch_list}
    for device_index in range(max(0, int(device_count()))):
        capability = get_device_capability(device_index)
        cap_major = capability[0] if isinstance(capability, tuple) and capability else None
        if cap_major in supported_majors:
            return True
    return False


def choose_torch_device(requested: str = "auto", *, torch_module: Any) -> str:
    requested = requested.strip().lower()
    valid = {"auto", "cpu", "mps", "cuda"}
    if requested not in valid:
        raise ValueError(f"Unsupported torch device '{requested}'. Choose one of: {sorted(valid)}")

    backends = getattr(torch_module, "backends", None)
    mps_backend = getattr(backends, "mps", None) if backends is not None else None
    has_mps = False
    if mps_backend is not None and hasattr(mps_backend, "is_available"):
        has_mps = bool(mps_backend.is_available())
    has_cuda = bool(torch_module.cuda.is_available())
    has_compatible_cuda = has_cuda and _cuda_build_supports_visible_devices(torch_module)

    if requested == "auto":
        if has_compatible_cuda:
            return "cuda"
        if has_mps:
            return "mps"
        return "cpu"

    if requested == "mps" and not has_mps:
        raise RuntimeError("Requested MPS device, but MPS is unavailable on this machine.")
    if requested == "cuda" and not has_cuda:
        raise RuntimeError("Requested CUDA device, but CUDA is unavailable on this machine.")
    if requested == "cuda" and not has_compatible_cuda:
        raise RuntimeError(
            "Requested CUDA device, but the current PyTorch build does not support the visible NVIDIA GPU architecture."
        )
    return requested
