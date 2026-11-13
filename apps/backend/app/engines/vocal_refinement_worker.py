"""Isolated, offline Mega53 inference. A failed accelerator attempt exits before CPU retry."""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from torch import Tensor
from torch.nn import functional as F

from app.engines.mega_roformer import CHUNK_FRAMES, SAMPLE_RATE, load_mega_roformer
from app.runtime_status import emit_runtime_event
from app.utils.torch_runtime import choose_torch_device

_ACCELERATOR_BUDGET = 8 * 1024**3


class AcceleratorFailure(RuntimeError):
    pass


def hybrid_mask(parent: Tensor, heads: Tensor, n_fft: int, hop: int) -> Tensor:
    length = parent.shape[-1]
    window = torch.hann_window(n_fft, device=parent.device)
    spectrum = torch.stft(parent, n_fft, hop, window=window, return_complex=True)
    power = torch.stft(heads.reshape(-1, length), n_fft, hop, window=window, return_complex=True).abs().square()
    power = power.reshape(2, *spectrum.shape)
    second = power[1] / (torch.maximum(power.sum(0), spectrum.abs().square()) + 1e-10)
    spectra = torch.stack([(1 - second) * spectrum, second * spectrum])
    return torch.istft(spectra.reshape(-1, *spectrum.shape[-2:]), n_fft, hop,
                       window=window, length=length).reshape(2, *parent.shape)


def _read_reflected(
    stream: sf.SoundFile, start: int, size: int, length: int, chunk: int,
) -> Tensor:
    indices = np.arange(start, start + size)
    indices = np.where(indices < 0, -indices, indices)
    indices = np.where(indices >= length, 2 * length - 2 - indices, indices)
    if indices.max() >= stream.frames or indices.min() < 0:
        raise ValueError("Decoded input ended before its admitted timeline.")
    first, last = int(indices.min()), int(indices.max())
    stream.seek(first)
    data = stream.read(last - first + 1, dtype="float32", always_2d=True)
    if data.shape[0] != last - first + 1 or not np.isfinite(data).all():
        raise ValueError("Decoded vocal refinement input is incomplete or nonfinite.")
    part = torch.from_numpy(data[indices - first].T.copy())
    return F.pad(part, (0, chunk - size), mode="reflect" if size > chunk // 2 else "constant")


def write_hybrid_chunks(
    mix: sf.SoundFile, parent: sf.SoundFile, writers: tuple[sf.SoundFile, sf.SoundFile],
    estimate: Callable[[Tensor, Tensor], Tensor], *, chunk: int = CHUNK_FRAMES, report: bool = True,
) -> None:
    length = parent.frames
    if length < 1 or mix.frames != length or any(
        stream.samplerate != SAMPLE_RATE or stream.channels != 2 for stream in (mix, parent)
    ):
        raise ValueError("Vocal refinement inputs do not have aligned stereo timelines.")
    step = chunk // 2
    border = step if length > chunk else 0
    total = length + 2 * border
    fade = chunk // 10
    base = torch.ones(chunk)
    base[:fade] = torch.linspace(0, 1, fade)
    base[-fade:] = torch.linspace(1, 0, fade)
    accum = torch.zeros((2, 2, chunk))
    weights = torch.zeros(chunk)
    count = (total + step - 1) // step

    for index, start in enumerate(range(0, total, step)):
        size = min(chunk, total - start)
        mix_chunk = _read_reflected(mix, start - border, size, length, chunk)
        parent_chunk = _read_reflected(parent, start - border, size, length, chunk)
        prediction = estimate(mix_chunk, parent_chunk)
        if prediction.shape != (2, 2, chunk) or not torch.isfinite(prediction).all().item():
            raise ValueError("Mega53 produced invalid vocal refinement samples.")
        if (prediction.sum(0) - parent_chunk).abs().max().item() > 1e-4:
            raise ValueError("Refined vocal parts do not reconstruct the parent.")
        blend = base.clone()
        if start == 0:
            blend[:fade] = 1
        if start + step >= total:
            blend[-fade:] = 1
        accum[..., :size] += prediction[..., :size] * blend[:size]
        weights[:size] += blend[:size]

        lo = max(0, border - start)
        hi = min(step, border + length - start, total - start)
        if hi > lo:
            if not torch.all(weights[lo:hi] > 0).item():
                raise ValueError("Mega53 overlap left an unweighted frame.")
            output = accum[..., lo:hi] / weights[lo:hi]
            for writer, samples in zip(writers, output, strict=True):
                writer.write(samples.T.numpy())
        accum[..., :step] = accum[..., step:].clone()
        accum[..., step:] = 0
        weights[:step] = weights[step:].clone()
        weights[step:] = 0
        if report:
            emit_runtime_event(progress=20 + 58 * (index + 1) // count)


def _configure_device(name: str) -> torch.device:
    device = torch.device(name)
    if name == "mps":
        torch.mps.set_per_process_memory_fraction(min(1., _ACCELERATOR_BUDGET / torch.mps.recommended_max_memory()))
    if name == "cuda":
        torch.cuda.set_per_process_memory_fraction(
            min(1., _ACCELERATOR_BUDGET / torch.cuda.get_device_properties(device).total_memory), device,
        )
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
    return device


def _run(args: argparse.Namespace) -> str:
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    name = choose_torch_device(args.device, torch_module=torch)
    emit_runtime_event(stage="loading_model", stage_label=f"Loading Mega53 for {name.upper()}.", runtime_device=name)
    model = load_mega_roformer(args.checkpoint, args.config)
    try:
        device = _configure_device(name)
        model.to(device)
    except (RuntimeError, MemoryError) as exc:
        if name != "cpu":
            raise AcceleratorFailure(name) from exc
        raise

    def estimate(mix: Tensor, parent: Tensor) -> Tensor:
        try:
            spectral = "cpu" if name == "mps" else device
            heads = model(mix.unsqueeze(0).to(device))[0]
            output = hybrid_mask(parent.to(spectral), heads.to(spectral), model.n_fft, model.hop).cpu()
            if name == "mps":
                torch.mps.synchronize()
                if torch.mps.driver_allocated_memory() > _ACCELERATOR_BUDGET:
                    raise MemoryError("Mega53 MPS allocation exceeded its worker budget.")
            return output
        except (RuntimeError, MemoryError) as exc:
            if name != "cpu":
                raise AcceleratorFailure(name) from exc
            raise

    emit_runtime_event(stage="processing", stage_label=f"Refining vocals on {name.upper()}.", runtime_device=name)
    with torch.inference_mode(), ExitStack() as stack:
        mix_stream = stack.enter_context(sf.SoundFile(args.mix))
        parent_stream = stack.enter_context(sf.SoundFile(args.parent))
        writers = tuple(stack.enter_context(sf.SoundFile(
            path, mode="w", samplerate=SAMPLE_RATE, channels=2, subtype="FLOAT", format="RF64",
        )) for path in (args.lead, args.backing))
        write_hybrid_chunks(mix_stream, parent_stream, (writers[0], writers[1]), estimate)
    return name


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("mix", "parent", "lead", "backing", "checkpoint", "config"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--device", required=True)
    args = parser.parse_args()
    try:
        device = _run(args)
    except AcceleratorFailure as exc:
        print(json.dumps({"accelerator_failed": str(exc)}), flush=True)
        return 2
    print(json.dumps({"device": device}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
