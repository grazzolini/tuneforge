from __future__ import annotations

import argparse
import json
import platform
import re
import resource
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.audio import AudioFile

from app.engines.demucs_cache import load_demucs_model
from app.services.metadata import extract_audio_metadata
from app.services.stem_models import configured_stem_model_repo
from app.utils.torch_runtime import choose_torch_device

DEFAULT_BENCHMARK_MODELS = ("htdemucs_ft", "htdemucs_6s")
DEFAULT_OUTPUT_DIR = Path("/private/tmp/tuneforge-stem-bench")
TWO_STEM_BENCHMARK_MODELS = {"htdemucs_ft"}


@dataclass(frozen=True)
class LoadedStemModel:
    name: str
    model: Any
    sources: list[str]
    samplerate: int
    channels: int
    load_seconds: float
    resolved_device: str


@dataclass(frozen=True)
class FailedStemModel:
    name: str
    error: str
    load_seconds: float
    resolved_device: str | None


def build_benchmark_report(
    audio_paths: list[Path],
    *,
    model_names: list[str] | None = None,
    device: str = "auto",
    output_dir: Path = DEFAULT_OUTPUT_DIR,
) -> dict[str, Any]:
    resolved_audio_paths = [path.expanduser().resolve() for path in audio_paths]
    selected_model_names = model_names or list(DEFAULT_BENCHMARK_MODELS)
    resolved_output_dir = output_dir.expanduser().resolve()
    resolved_output_dir.mkdir(parents=True, exist_ok=True)

    model_loads = [_load_stem_model(model_name, device=device) for model_name in selected_model_names]
    return {
        "output_dir": str(resolved_output_dir),
        "device_request": device,
        "models": selected_model_names,
        "tracks": [
            {
                "audio_path": str(audio_path),
                "track_duration_seconds": _track_duration_seconds(audio_path),
                "results": [
                    _benchmark_model_for_track(model_load, audio_path, resolved_output_dir)
                    for model_load in model_loads
                ],
            }
            for audio_path in resolved_audio_paths
        ],
    }


def summarize_report(report: dict[str, Any]) -> str:
    lines = [
        f"Stem benchmark output: {report['output_dir']}",
        f"Device request: {report['device_request']}",
    ]
    for track in report["tracks"]:
        lines.append(f"Track: {track['audio_path']} ({track['track_duration_seconds']}s)")
        for result in track["results"]:
            if not result["available"]:
                lines.append(f"- {result['model']}: unavailable ({result['error']})")
                continue
            output_size_mb = result["output_size_bytes"] / (1024 * 1024)
            runtime_ratio = result["runtime_ratio"]
            ratio_text = f"{runtime_ratio:.2f}x track" if isinstance(runtime_ratio, (int, float)) else "unknown ratio"
            lines.append(
                "- {model}: load {load:.3f}s, separate {separate:.3f}s, "
                "{ratio}, {device}, {sources}, {size:.1f} MB".format(
                    model=result["model"],
                    load=result["model_load_seconds"],
                    separate=result["separation_seconds"],
                    ratio=ratio_text,
                    device=result["device"].upper(),
                    sources=", ".join(result["sources"]),
                    size=output_size_mb,
                )
            )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark TuneForge Demucs stem separation models.")
    parser.add_argument(
        "--audio",
        action="append",
        required=True,
        type=Path,
        help="Path to an audio file. Repeat to benchmark multiple tracks.",
    )
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        help="Demucs model name. Repeat to benchmark multiple models. Defaults to htdemucs_ft and htdemucs_6s.",
    )
    parser.add_argument("--device", default="auto", help="Torch device: auto, cpu, mps, or cuda.")
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        type=Path,
        help="Directory for generated benchmark stems.",
    )
    parser.add_argument("--json-only", action="store_true", help="Only write machine-readable JSON to stdout.")
    args = parser.parse_args(argv)

    report = build_benchmark_report(
        args.audio,
        model_names=args.models,
        device=args.device,
        output_dir=args.output_dir,
    )
    sys.stdout.write(json.dumps(report, indent=2))
    sys.stdout.write("\n")
    if not args.json_only:
        sys.stderr.write(summarize_report(report))
        sys.stderr.write("\n")
    return 0


def _load_stem_model(model_name: str, *, device: str) -> LoadedStemModel | FailedStemModel:
    resolved_device: str | None = None
    started_at = time.perf_counter()
    try:
        resolved_device = choose_torch_device(device, torch_module=torch)
        model = load_demucs_model(model_name, model_repo=configured_stem_model_repo())
        return LoadedStemModel(
            name=model_name,
            model=model,
            sources=list(model.sources),
            samplerate=int(model.samplerate),
            channels=int(getattr(model, "audio_channels", 2)),
            load_seconds=round(time.perf_counter() - started_at, 6),
            resolved_device=resolved_device,
        )
    except Exception as exc:  # pragma: no cover - command reports model runtime failures.
        return FailedStemModel(
            name=model_name,
            error=str(exc),
            load_seconds=round(time.perf_counter() - started_at, 6),
            resolved_device=resolved_device,
        )


def _benchmark_model_for_track(
    model_load: LoadedStemModel | FailedStemModel,
    audio_path: Path,
    output_dir: Path,
) -> dict[str, Any]:
    if isinstance(model_load, FailedStemModel):
        return _failed_result(model_load, audio_path, model_load.error)

    started_at = time.perf_counter()
    try:
        mix = AudioFile(audio_path).read(
            streams=0,
            samplerate=model_load.samplerate,
            channels=model_load.channels,
        )
        if mix.dim() == 2:
            mix = mix.unsqueeze(0)

        estimates = apply_model(
            model_load.model,
            mix,
            device=torch.device(model_load.resolved_device),
            progress=False,
        )
        estimates = estimates[0].cpu()
        separation_seconds = round(time.perf_counter() - started_at, 6)
        output_files = _write_stem_outputs(
            model_load,
            audio_path,
            output_dir,
            estimates,
        )
        track_duration = _track_duration_seconds(audio_path)
        return {
            "model": model_load.name,
            "available": True,
            "error": None,
            "audio_path": str(audio_path),
            "track_duration_seconds": track_duration,
            "model_load_seconds": model_load.load_seconds,
            "separation_seconds": separation_seconds,
            "runtime_ratio": _runtime_ratio(separation_seconds, track_duration),
            "device": model_load.resolved_device,
            "sources": [output["source"] for output in output_files],
            "model_sources": model_load.sources,
            "output_files": output_files,
            "output_size_bytes": sum(int(output["size_bytes"]) for output in output_files),
            "peak_memory_bytes": _peak_memory_bytes(),
        }
    except Exception as exc:  # pragma: no cover - command reports separation runtime failures.
        return _failed_result(model_load, audio_path, str(exc))


def _failed_result(
    model_load: LoadedStemModel | FailedStemModel,
    audio_path: Path,
    error: str,
) -> dict[str, Any]:
    track_duration = _track_duration_seconds(audio_path)
    return {
        "model": model_load.name,
        "available": False,
        "error": error,
        "audio_path": str(audio_path),
        "track_duration_seconds": track_duration,
        "model_load_seconds": model_load.load_seconds,
        "separation_seconds": None,
        "runtime_ratio": None,
        "device": model_load.resolved_device,
        "sources": [],
        "model_sources": getattr(model_load, "sources", []),
        "output_files": [],
        "output_size_bytes": 0,
        "peak_memory_bytes": _peak_memory_bytes(),
    }


def _write_stem_outputs(
    model_load: LoadedStemModel,
    audio_path: Path,
    output_dir: Path,
    estimates: torch.Tensor,
) -> list[dict[str, Any]]:
    track_output_dir = output_dir / _safe_name(audio_path.stem) / _safe_name(model_load.name)
    track_output_dir.mkdir(parents=True, exist_ok=True)
    if _should_write_two_stem_baseline(model_load):
        return _write_two_stem_outputs(model_load, estimates, track_output_dir)
    return [
        _write_stem_file(source, estimates[index], track_output_dir, model_load.samplerate)
        for index, source in enumerate(model_load.sources)
    ]


def _write_two_stem_outputs(
    model_load: LoadedStemModel,
    estimates: torch.Tensor,
    output_dir: Path,
) -> list[dict[str, Any]]:
    vocals_index = model_load.sources.index("vocals")
    accompaniment_indices = [index for index, source in enumerate(model_load.sources) if source != "vocals"]
    vocals = estimates[vocals_index]
    instrumental = estimates[accompaniment_indices].sum(dim=0)
    return [
        _write_stem_file("vocals", vocals, output_dir, model_load.samplerate),
        _write_stem_file("instrumental", instrumental, output_dir, model_load.samplerate),
    ]


def _write_stem_file(source: str, estimate: torch.Tensor, output_dir: Path, samplerate: int) -> dict[str, Any]:
    output_path = output_dir / f"{_safe_name(source)}.wav"
    sf.write(output_path, estimate.transpose(0, 1).numpy(), samplerate)
    return {
        "source": source,
        "path": str(output_path),
        "size_bytes": output_path.stat().st_size,
    }


def _should_write_two_stem_baseline(model_load: LoadedStemModel) -> bool:
    return model_load.name in TWO_STEM_BENCHMARK_MODELS and "vocals" in model_load.sources


def _track_duration_seconds(audio_path: Path) -> float | None:
    try:
        info = sf.info(str(audio_path))
    except RuntimeError:
        return _ffprobe_duration_seconds(audio_path)
    if info.samplerate > 0:
        return round(float(info.frames / info.samplerate), 3)
    return _ffprobe_duration_seconds(audio_path)


def _ffprobe_duration_seconds(audio_path: Path) -> float | None:
    try:
        duration = extract_audio_metadata(audio_path).get("duration_seconds")
    except Exception:
        return None
    return round(float(duration), 3) if isinstance(duration, (int, float)) else None


def _runtime_ratio(runtime_seconds: float, track_duration_seconds: float | None) -> float | None:
    if not track_duration_seconds or track_duration_seconds <= 0:
        return None
    return round(runtime_seconds / track_duration_seconds, 6)


def _peak_memory_bytes() -> int:
    max_rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    if platform.system() == "Darwin":
        return max_rss
    return max_rss * 1024


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    return cleaned.strip("._-") or "item"


if __name__ == "__main__":
    raise SystemExit(main())
