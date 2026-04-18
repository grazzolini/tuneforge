from __future__ import annotations

import argparse
import json
from pathlib import Path

import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.audio import AudioFile
from demucs.pretrained import get_model


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Separate vocals and accompaniment using Demucs.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--vocals", required=True)
    parser.add_argument("--instrumental", required=True)
    parser.add_argument("--model", default="htdemucs_ft")
    parser.add_argument("--device", default="cpu")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_path = Path(args.source)
    vocal_path = Path(args.vocals)
    instrumental_path = Path(args.instrumental)

    model = get_model(args.model)
    samplerate = int(model.samplerate)
    channels = int(getattr(model, "audio_channels", 2))
    mix = AudioFile(source_path).read(streams=0, samplerate=samplerate, channels=channels)
    if mix.dim() == 2:
        mix = mix.unsqueeze(0)

    device = torch.device(args.device)
    estimates = apply_model(model, mix, device=device, progress=False)
    estimates = estimates[0].cpu()

    sources = list(model.sources)
    vocals_index = sources.index("vocals")
    accompaniment_indices = [index for index, source in enumerate(sources) if source != "vocals"]

    vocals = estimates[vocals_index]
    instrumental = estimates[accompaniment_indices].sum(dim=0)

    vocal_path.parent.mkdir(parents=True, exist_ok=True)
    instrumental_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(vocal_path, vocals.transpose(0, 1).numpy(), samplerate)
    sf.write(instrumental_path, instrumental.transpose(0, 1).numpy(), samplerate)

    print(
        json.dumps(
            {
                "engine": "demucs",
                "model": args.model,
                "device": args.device,
            }
        )
    )


if __name__ == "__main__":
    main()
