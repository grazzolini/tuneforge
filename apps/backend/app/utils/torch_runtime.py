from __future__ import annotations

import os
from typing import Any


def with_mps_fallback_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base_env or os.environ)
    env.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    return env


def choose_torch_device(requested: str = "auto", *, torch_module: Any) -> str:
    requested = requested.strip().lower()
    valid = {"auto", "cpu", "mps", "cuda"}
    if requested not in valid:
        raise ValueError(f"Unsupported torch device '{requested}'. Choose one of: {sorted(valid)}")

    backends = getattr(torch_module, "backends", None)
    mps_backend = getattr(backends, "mps", None) if backends is not None else None
    has_mps = bool(mps_backend) and bool(mps_backend.is_available())
    has_cuda = bool(torch_module.cuda.is_available())

    if requested == "auto":
        if has_cuda:
            return "cuda"
        if has_mps:
            return "mps"
        return "cpu"

    if requested == "mps" and not has_mps:
        raise RuntimeError("Requested MPS device, but MPS is unavailable on this machine.")
    if requested == "cuda" and not has_cuda:
        raise RuntimeError("Requested CUDA device, but CUDA is unavailable on this machine.")
    return requested
