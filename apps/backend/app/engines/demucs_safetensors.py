from __future__ import annotations

import json
from collections.abc import Mapping
from fractions import Fraction
from pathlib import Path
from typing import Any

from demucs_infer.htdemucs import HTDemucs
from safetensors import safe_open

# Adapted from Demucs' MIT-licensed Hugging Face safetensors loader:
# https://github.com/facebookresearch/demucs/blob/main/demucs/hf.py
_MODEL_CLASS_TAG = "demucs.htdemucs.HTDemucs"
_METADATA_KEYS = frozenset({"klass", "args", "kwargs"})


def load_safetensors_model(path: str | Path) -> HTDemucs:
    """Load the pinned native HTDemucs safetensors format without pickle imports."""
    with safe_open(str(path), framework="pt") as file:
        metadata = file.metadata()
        tensors = {key: file.get_tensor(key) for key in file.keys()}

    if set(metadata) != _METADATA_KEYS:
        raise ValueError("Unsupported Demucs safetensors metadata fields.")
    if metadata["klass"] != _MODEL_CLASS_TAG:
        raise ValueError(f"Unsupported Demucs safetensors model class: {metadata['klass']}")

    args = _decode_metadata_json(metadata["args"], "args")
    kwargs = _decode_metadata_json(metadata["kwargs"], "kwargs")
    if not isinstance(args, list):
        raise ValueError("Demucs safetensors args metadata must be a JSON list.")
    if not isinstance(kwargs, Mapping) or not all(isinstance(key, str) for key in kwargs):
        raise ValueError("Demucs safetensors kwargs metadata must be a JSON object.")

    model = HTDemucs(*args, **kwargs)
    model.load_state_dict(tensors, strict=True)
    return model


def _decode_metadata_json(value: str, field: str) -> Any:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Demucs safetensors {field} metadata is not valid JSON.") from exc
    return _decode_json(decoded)


def _decode_json(value: Any) -> Any:
    if isinstance(value, dict):
        if "_type" in value:
            if set(value) != {"_type", "numerator", "denominator"} or value["_type"] != "fraction":
                raise ValueError("Unsupported Demucs safetensors structured value.")
            numerator = value["numerator"]
            denominator = value["denominator"]
            if (
                not isinstance(numerator, int)
                or isinstance(numerator, bool)
                or not isinstance(denominator, int)
                or isinstance(denominator, bool)
                or denominator == 0
            ):
                raise ValueError("Demucs safetensors fraction must contain integer values.")
            return Fraction(numerator, denominator)
        return {key: _decode_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_json(item) for item in value]
    return value
