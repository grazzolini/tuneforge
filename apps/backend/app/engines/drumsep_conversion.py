"""Convert the one pinned, author-hosted DrumSep checkpoint to strict safetensors."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from demucs_infer.hdemucs import HDemucs
from safetensors.torch import save_file

from app.engines.demucs_safetensors import load_safetensors_model
from app.engines.drumsep_identity import RAW_SHA256, RAW_SIZE_BYTES
from app.utils.hashing import file_sha256

_CLASS_TAG = "demucs.hdemucs.HDemucs"
_SOURCES = ("bombo", "redoblante", "platillos", "toms")


def convert_pinned_checkpoint(source: Path, target: Path) -> None:
    """Never load a .th without the pinned byte hash and restricted global list."""
    if source.stat().st_size != RAW_SIZE_BYTES or file_sha256(source) != RAW_SHA256:
        raise ValueError("DrumSep upstream checkpoint failed full SHA-256 verification.")
    if torch.serialization.get_unsafe_globals_in_checkpoint(source) != [_CLASS_TAG]:
        raise ValueError("DrumSep upstream checkpoint contains unsupported globals.")
    with torch.serialization.safe_globals([(HDemucs, _CLASS_TAG)]):
        package = torch.load(source, map_location="cpu", weights_only=True)
    if not isinstance(package, dict) or set(package) != {
        "args", "klass", "kwargs", "metrics", "state", "training_args"
    }:
        raise ValueError("DrumSep upstream checkpoint has unsupported fields.")
    kwargs = package["kwargs"]
    if (
        package["klass"] is not HDemucs or package["args"] != ()
        or not isinstance(kwargs, dict)
        or tuple(kwargs.get("sources", ())) != _SOURCES
        or kwargs.get("audio_channels") != 2
        or kwargs.get("samplerate") != 44100
    ):
        raise ValueError("DrumSep upstream checkpoint identity is unsupported.")
    model = HDemucs(**kwargs)
    model.load_state_dict(package["state"], strict=True)
    state = {name: tensor.detach().contiguous().cpu() for name, tensor in model.state_dict().items()}
    for name, tensor in state.items():
        if not torch.equal(tensor, package["state"][name]):
            raise ValueError("DrumSep model load changed upstream checkpoint tensors.")
    metadata = {"klass": _CLASS_TAG, "args": "[]", "kwargs": json.dumps(kwargs, sort_keys=True)}
    save_file(state, str(target), metadata=metadata)
    converted = load_safetensors_model(target)
    for name, tensor in state.items():
        if not torch.equal(tensor, converted.state_dict()[name]):
            raise ValueError("DrumSep conversion changed checkpoint tensors.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    convert_pinned_checkpoint(args.input, args.output)


if __name__ == "__main__":
    main()
