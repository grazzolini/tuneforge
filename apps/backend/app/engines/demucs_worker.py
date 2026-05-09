from __future__ import annotations

import argparse
import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.audio import AudioFile
from demucs.pretrained import get_model

from app.utils.torch_runtime import choose_torch_device


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Separate vocals and accompaniment using Demucs.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--vocals")
    parser.add_argument("--instrumental")
    parser.add_argument(
        "--stem",
        action="append",
        default=[],
        help="Write an individual model source as source=/path/to/output.wav. May be repeated.",
    )
    parser.add_argument("--model", default="htdemucs_ft")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--model-repo", default=None)
    return parser.parse_args()


def _parse_stem_outputs(values: list[str]) -> dict[str, Path]:
    outputs: dict[str, Path] = {}
    for value in values:
        source, separator, raw_path = value.partition("=")
        if not separator or not source or not raw_path:
            raise ValueError(f"Invalid --stem value: {value}")
        outputs[source] = Path(raw_path)
    return outputs


@contextmanager
def _trusted_demucs_checkpoint_loading() -> Iterator[None]:
    original_load = torch.load

    def trusted_load(*args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("weights_only", False)
        return original_load(*args, **kwargs)

    torch.load = trusted_load  # type: ignore[assignment]
    try:
        yield
    finally:
        torch.load = original_load  # type: ignore[assignment]


def main() -> None:
    args = parse_args()
    source_path = Path(args.source)
    resolved_device = choose_torch_device(args.device, torch_module=torch)

    model_repo = Path(args.model_repo) if args.model_repo else None
    with _trusted_demucs_checkpoint_loading():
        model = get_model(args.model, repo=model_repo)
    samplerate = int(model.samplerate)
    channels = int(getattr(model, "audio_channels", 2))
    mix = AudioFile(source_path).read(streams=0, samplerate=samplerate, channels=channels)
    if mix.dim() == 2:
        mix = mix.unsqueeze(0)

    device = torch.device(resolved_device)
    estimates = apply_model(model, mix, device=device, progress=False)
    estimates = estimates[0].cpu()

    sources = list(model.sources)
    stem_outputs = _parse_stem_outputs(args.stem)
    written_sources: list[str] = []

    if stem_outputs:
        for source, output_path in stem_outputs.items():
            source_index = sources.index(source)
            estimate = estimates[source_index]
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(output_path, estimate.transpose(0, 1).numpy(), samplerate)
            written_sources.append(source)
    else:
        if not args.vocals or not args.instrumental:
            raise ValueError("--vocals and --instrumental are required when --stem is not used.")
        vocal_path = Path(args.vocals)
        instrumental_path = Path(args.instrumental)
        vocals_index = sources.index("vocals")
        accompaniment_indices = [index for index, source in enumerate(sources) if source != "vocals"]

        vocals = estimates[vocals_index]
        instrumental = estimates[accompaniment_indices].sum(dim=0)

        vocal_path.parent.mkdir(parents=True, exist_ok=True)
        instrumental_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(vocal_path, vocals.transpose(0, 1).numpy(), samplerate)
        sf.write(instrumental_path, instrumental.transpose(0, 1).numpy(), samplerate)
        written_sources = ["vocals", "instrumental"]

    print(
        json.dumps(
            {
                "engine": "demucs",
                "model": args.model,
                "requested_device": args.device,
                "device": resolved_device,
                "model_repo": str(model_repo) if model_repo is not None else None,
                "sources": written_sources,
            }
        )
    )


if __name__ == "__main__":
    main()
