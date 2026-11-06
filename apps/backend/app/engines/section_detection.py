from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import asdict
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from app.config import get_settings
from app.engines.section_fusion import refine_sections
from app.engines.section_weights import (
    preload_section_weights,
    section_weight_files,
    verified_section_weight_bytes,
)
from app.errors import AppError, JobCancelledError
from app.runtime_status import JobRuntimeEvent, runtime_event_from_payload, runtime_event_payload
from app.utils.torch_runtime import choose_torch_device

MODEL_REVISION = "all-in-one-infer-da84f96:author-379e5fd:full8:cpu-mps-cuda-fp32:bounded-embed64s:fusion-v4-edges"
MAX_DURATION_SECONDS = 926
_WORKER_ERRORS = {
    "SECTION_DEVICE_INVALID": "Section device must be auto, cpu, mps, or cuda.",
    "SECTION_DEVICE_UNAVAILABLE": "Requested section accelerator is unavailable or incompatible; select CPU or auto.",
    "SECTION_MEMORY_FAILED": "Section inference ran out of memory.",
    "SECTION_DETECTION_FAILED": "Section inference failed; verify dependencies, model cache, and input audio.",
}


def _section_device(requested: str, *, torch_module: Any) -> str:
    if requested not in {"auto", "cpu", "mps", "cuda"}:
        raise AppError("SECTION_DEVICE_INVALID", _WORKER_ERRORS["SECTION_DEVICE_INVALID"])
    try:
        selected = choose_torch_device(requested, torch_module=torch_module)
    except RuntimeError as exc:
        raise AppError("SECTION_DEVICE_UNAVAILABLE", _WORKER_ERRORS["SECTION_DEVICE_UNAVAILABLE"]) from exc
    return selected


def _primitive(value: object) -> bool:
    if isinstance(value, dict):
        return all(isinstance(k, str) and _primitive(v) for k, v in value.items())
    if isinstance(value, list):
        return all(_primitive(v) for v in value)
    return value is None or type(value) in (str, int, float, bool) and not (isinstance(value, str) and "${" in value)


def _bounded_embeddings(original: Any, *, chunk_frames: int = 6400) -> Any:
    import torch

    class BoundedEmbeddings(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.original = original

        def forward(self, values: Any) -> Any:
            length = values.shape[2]
            outputs = []
            for start in range(0, length, chunk_frames):
                end = min(length, start + chunk_frames)
                left, right = max(0, start - 2), min(length, end + 2)
                # Exactly the two temporal kernel-3 convolutions' receptive halo.
                result = self.original(values[:, :, left:right, :])
                outputs.append(result[:, start - left : end - left, :])
            return torch.cat(outputs, dim=1)

    return BoundedEmbeddings()


def _section_ensemble(models: list[Any]) -> Any:
    import torch
    from allin1_infer.typings import AllInOneOutput

    class SectionEnsemble(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.cfg = models[0].cfg.copy()
            self.models = torch.nn.ModuleList(models)

        def forward(self, inputs: Any) -> Any:
            section_logits = []
            function_logits = []
            for model in self.models:
                output = model(inputs)
                section_logits.append(output.logits_section)
                function_logits.append(output.logits_function)
                del output
            return AllInOneOutput(
                logits_section=torch.stack(section_logits, dim=0).mean(dim=0),
                logits_function=torch.stack(function_logits, dim=0).mean(dim=0),
            )

    return SectionEnsemble().eval()


def _load_model(staging_dir: Path | None = None) -> Any:
    import torch
    from allin1_infer.models.allinone import AllInOne
    from omegaconf import OmegaConf

    models = []
    preload_section_weights(staging_dir=staging_dir)
    for expected in section_weight_files():
        checkpoint = torch.load(BytesIO(verified_section_weight_bytes(expected)), weights_only=True, map_location="cpu")
        if not isinstance(checkpoint, dict) or set(checkpoint) != {"state_dict", "config"}:
            raise ValueError("Unexpected section checkpoint structure.")
        config = checkpoint["config"]
        if not _primitive(config):
            raise ValueError("Unsafe section checkpoint configuration.")
        architecture = (
            config["depth"],
            config["dim_embed"],
            config["dim_input"],
            config["sample_rate"],
            config["fps"],
            config["data"]["num_instruments"],
            config["data"]["num_labels"],
        )
        if architecture != (11, 24, 81, 44100, 100, 4, 10):
            raise ValueError("Unexpected section model architecture.")
        state = checkpoint["state_dict"]
        if not isinstance(state, dict) or not all(
            type(v) is torch.Tensor and bool(torch.isfinite(v).all()) for v in state.values()
        ):
            raise ValueError("Invalid section model tensors.")
        model = AllInOne(OmegaConf.create(config))
        model.load_state_dict(state, strict=True)
        model.embeddings = _bounded_embeddings(model.embeddings)
        models.append(model.eval())
    return _section_ensemble(models)


def infer_sections_in_process(
    stems: dict[str, str],
    *,
    cues: dict[str, Any],
    frames: int | None = None,
    staging_dir: Path | None = None,
    device: str | None = None,
    on_runtime_event: Callable[[JobRuntimeEvent], None] | None = None,
    on_execution_device: Callable[[str | None], None] | None = None,
) -> dict[str, Any]:
    import torch
    from allin1_infer.postprocessing import postprocess_functional_structure
    from allin1_infer.spectrogram import build_spec_processor
    from madmom_infer.audio.signal import Signal

    selected_device = _section_device(device or get_settings().section_device, torch_module=torch)
    torch.set_num_threads(4)
    processor = build_spec_processor()
    specs = []
    vocal_energy: list[float] = []
    vocal_threshold = 0.0
    # Decode stems on their original sample clock; sum the residual sources linearly.
    for name in ("bass", "drums", "other", "vocals"):
        names = ("other", "guitar", "piano") if name == "other" else (name,)
        audio = None
        for source in names:
            info = sf.info(stems[source])
            if info.samplerate != 44100 or info.channels not in {1, 2} or info.duration > MAX_DURATION_SECONDS + 0.1:
                raise ValueError("Unsupported section input dimensions.")
            value, sample_rate = sf.read(stems[source], frames=frames or -1, dtype="float32", always_2d=True)
            if not np.isfinite(value).all():
                raise ValueError("Non-finite section input.")
            audio = value if audio is None else audio + value
        if audio is None:
            raise ValueError("Missing section input.")
        if name == "vocals":
            mono = audio.mean(axis=1)
            step = max(1, round(sample_rate * 0.1))
            vocal_energy = [float(np.sqrt(np.mean(mono[i : i + step] ** 2))) for i in range(0, len(mono), step)]
            vocal_threshold = max(1e-5, float(np.sqrt(np.mean(mono**2))) * 0.15)
        specs.append(processor(Signal(audio, sample_rate=sample_rate, num_channels=1)))
    spectrogram = np.stack(specs)
    del audio, value, mono, specs
    with torch.inference_mode():
        if on_runtime_event:
            on_runtime_event(JobRuntimeEvent(stage="loading_model", stage_label="Loading section model.", progress=20))
        model = _load_model(staging_dir)
        if on_execution_device:
            on_execution_device(selected_device)
        model = model.to(device=selected_device, dtype=torch.float32)
        inputs = torch.from_numpy(spectrogram).unsqueeze(0).to(device=selected_device, dtype=torch.float32)
        if selected_device == "mps":
            torch.mps.synchronize()
        if on_runtime_event:
            on_runtime_event(JobRuntimeEvent(stage="processing", stage_label="Detecting sections.",
                                             runtime_device=selected_device, progress=30))
        logits = model(inputs)
        # Functional decoding/refinement stays on CPU; never invoke the upstream broad device resolver.
        from allin1_infer.typings import AllInOneOutput

        logits = AllInOneOutput(logits_section=logits.logits_section.cpu(),
                                logits_function=logits.logits_function.cpu())
        if on_execution_device:
            on_execution_device(None)
        segments = postprocess_functional_structure(logits, model.cfg)
        boundary_scores = torch.sigmoid(logits.logits_section[0]).cpu().numpy()
        label_scores = torch.softmax(logits.logits_function[0], dim=0).cpu().numpy()
    del model, inputs, logits, spectrogram
    if not np.isfinite(boundary_scores).all() or not np.isfinite(label_scores).all():
        raise ValueError("Invalid section predictions.")
    transient = {
        "segments": [
            {"label": s["label"], "start_seconds": s["start"], "end_seconds": s["end"]} for s in map(asdict, segments)
        ],
        "segment_activation": boundary_scores,
        "label_activation": label_scores,
        "vocal_energy": vocal_energy,
        "vocal_threshold": vocal_threshold,
    }
    return {"raw_sections": transient["segments"], "refined_sections": refine_sections(transient, cues),
            "runtime_device": selected_device}


def _fusion_cues(cues: dict[str, Any]) -> dict[str, Any]:
    return {
        "beats": cues.get("beats", []),
        "bars": cues.get("bars", []),
        "chords": [item[:3] for item in cues.get("chords", [])],
        "lyrics": [
            {
                "start_seconds": segment.get("start_seconds"),
                "end_seconds": segment.get("end_seconds"),
                "words": [
                    {
                        "start_seconds": word.get("start_seconds"),
                        "end_seconds": word.get("end_seconds"),
                        "text": word.get("text", ""),
                    }
                    for word in segment.get("words", [])
                ],
            }
            for segment in cues.get("lyrics", [])
        ],
    }


def detect_sections(
    stems: dict[str, str],
    *,
    cues: dict[str, Any],
    frames: int | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
    device: str | None = None,
    on_runtime_event: Callable[[JobRuntimeEvent], None] | None = None,
) -> dict[str, Any]:
    if should_cancel and should_cancel():
        raise JobCancelledError()
    requested_device = device or get_settings().section_device
    if requested_device not in {"auto", "cpu", "mps", "cuda"}:
        raise AppError("SECTION_DEVICE_INVALID", _WORKER_ERRORS["SECTION_DEVICE_INVALID"])
    cache_root = section_weight_files()[0].path.parent
    cache_root.mkdir(parents=True, exist_ok=True)
    matplotlib_cache = get_settings().cache_root / "matplotlib"
    matplotlib_cache.mkdir(parents=True, exist_ok=True)
    worker_env = {**os.environ, "MPLCONFIGDIR": str(matplotlib_cache), "PYTORCH_ENABLE_MPS_FALLBACK": "0"}
    for attempt in range(2):
        if should_cancel and should_cancel():
            raise JobCancelledError()
        retry_device = None
        with (
            tempfile.TemporaryDirectory(prefix=".section-worker-", dir=cache_root) as staging,
            tempfile.TemporaryDirectory(prefix="tuneforge-sections-") as temporary,
        ):
            directory = Path(temporary)
            (directory / "inputs.json").write_text(
                json.dumps({"stems": stems, "frames": frames, "cues": _fusion_cues(cues), "device": requested_device})
            )
            process = subprocess.Popen(
                [sys.executable, "-m", "app.engines.section_detection", str(directory), staging],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
                env=worker_env,
            )
            try:
                if register_process:
                    register_process(process)
                last_status = None

                def report_status(status_path: Path = directory / "status.json") -> None:
                    nonlocal last_status
                    if status_path.exists():
                        status = status_path.read_text()
                        if status != last_status:
                            last_status = status
                            event = runtime_event_from_payload(json.loads(status))
                            if event and on_runtime_event:
                                on_runtime_event(event)

                while True:
                    report_status()
                    if should_cancel and should_cancel():
                        raise JobCancelledError()
                    try:
                        process.wait(timeout=0.2)
                        break
                    except subprocess.TimeoutExpired:
                        pass
                report_status()
                if should_cancel and should_cancel():
                    raise JobCancelledError()
                if process.returncode == 0:
                    return json.loads((directory / "result.json").read_text())
                error_path = directory / "error.json"
                code = json.loads(error_path.read_text()).get("code") if error_path.exists() else None
                code = code if code in _WORKER_ERRORS else "SECTION_DETECTION_FAILED"
                execution_path = directory / "execution.json"
                attempted = json.loads(execution_path.read_text()).get("device") if execution_path.exists() else None
                if attempt == 0 and attempted in {"mps", "cuda"} and code not in {
                    "SECTION_DEVICE_INVALID", "SECTION_DEVICE_UNAVAILABLE",
                }:
                    retry_device = attempted
                else:
                    raise AppError(code, _WORKER_ERRORS[code])
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                if unregister_process:
                    unregister_process()
        # Accelerator child and its temporary files are gone before any CPU retry.
        if should_cancel and should_cancel():
            raise JobCancelledError()
        if on_runtime_event:
            on_runtime_event(JobRuntimeEvent(stage="fallback", stage_label="Retrying section detection on CPU.",
                                             runtime_detail=f"{str(retry_device).upper()} failed, retrying CPU."))
        requested_device = "cpu"
    raise AssertionError("Section inference attempts exhausted.")


def _run_worker(root: Path, staging_dir: Path) -> None:
    def execution_device(device: str | None) -> None:
        temporary = root / "execution.pending"
        temporary.write_text(json.dumps({"device": device}))
        temporary.replace(root / "execution.json")

    def report(event: JobRuntimeEvent) -> None:
        temporary = root / "status.pending"
        temporary.write_text(json.dumps(runtime_event_payload(**asdict(event))))
        temporary.replace(root / "status.json")

    try:
        payload = json.loads((root / "inputs.json").read_text())
        prediction = infer_sections_in_process(
            payload["stems"], cues=payload["cues"], frames=payload["frames"], staging_dir=staging_dir,
            device=payload["device"], on_runtime_event=report, on_execution_device=execution_device,
        )
        (root / "result.json").write_text(json.dumps(prediction, allow_nan=False))
    except Exception as exc:
        code = exc.code if isinstance(exc, AppError) else "SECTION_DETECTION_FAILED"
        if isinstance(exc, MemoryError) or isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower():
            code = "SECTION_MEMORY_FAILED"
        (root / "error.json").write_text(json.dumps({"code": code}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    _run_worker(Path(sys.argv[1]), Path(sys.argv[2]))
