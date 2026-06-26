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

from app.runtime_status import emit_runtime_event
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


def _device_label(device: str) -> str:
    return device.upper()


def _resolve_demucs_device(requested_device: str) -> str:
    try:
        return choose_torch_device(requested_device, torch_module=torch)
    except RuntimeError:
        normalized = requested_device.strip().lower()
        if normalized in {"mps", "cuda"}:
            emit_runtime_event(
                stage="fallback",
                stage_label=f"Falling back from {normalized.upper()} to CPU.",
                runtime_device="cpu",
                runtime_detail="Demucs switched to CPU because the requested accelerator is unavailable.",
            )
            return "cpu"
        raise


def _separate_with_device(
    args: argparse.Namespace,
    *,
    source_path: Path,
    device_name: str,
    model_repo: Path | None,
) -> list[str]:
    emit_runtime_event(
        stage="loading_model",
        stage_label=f"Loading Demucs model on {_device_label(device_name)}.",
        runtime_device=device_name,
    )
    with _trusted_demucs_checkpoint_loading():
        model = get_model(args.model, repo=model_repo)
    samplerate = int(model.samplerate)
    channels = int(getattr(model, "audio_channels", 2))
    mix = AudioFile(source_path).read(streams=0, samplerate=samplerate, channels=channels)
    if mix.dim() == 2:
        mix = mix.unsqueeze(0)

    emit_runtime_event(
        stage="processing",
        stage_label=f"Separating stems on {_device_label(device_name)}.",
        runtime_device=device_name,
    )
    device = torch.device(device_name)
    estimates = apply_model(model, mix, device=device, progress=False)
    estimates = estimates[0].cpu()

    emit_runtime_event(
        stage="writing",
        stage_label="Writing separated stems.",
        runtime_device=device_name,
    )
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

    return written_sources


def main() -> None:
    args = parse_args()
    source_path = Path(args.source)
    model_repo = Path(args.model_repo) if args.model_repo else None
    resolved_device = _resolve_demucs_device(args.device)
    try:
        written_sources = _separate_with_device(
            args,
            source_path=source_path,
            device_name=resolved_device,
            model_repo=model_repo,
        )
    except Exception:
        if resolved_device == "cpu":
            raise
        emit_runtime_event(
            stage="fallback",
            stage_label=f"Falling back from {resolved_device.upper()} to CPU.",
            runtime_device="cpu",
            runtime_detail="Demucs switched to CPU after the accelerator attempt failed.",
        )
        resolved_device = "cpu"
        written_sources = _separate_with_device(
            args,
            source_path=source_path,
            device_name=resolved_device,
            model_repo=model_repo,
        )

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
