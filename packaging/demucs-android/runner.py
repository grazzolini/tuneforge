"""Offline Android CPU stem worker: Torch4/inter1, pthread OpenBLAS1."""
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import sys
import time
import wave

SOURCES = ["drums", "bass", "other", "vocals", "guitar", "piano"]
THREAD_ENV = ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "BLIS_NUM_THREADS"]


def emit(progress, phase, **fields):
    print(json.dumps({"progress": progress, "phase": phase, **fields}), flush=True)


def forbid_external(event, args):
    if event in {"socket.connect", "socket.bind", "subprocess.Popen", "os.system", "os.posix_spawn"}:
        raise RuntimeError("DEMUCS_EXTERNAL_OPERATION_FORBIDDEN")



def openblas_library():
    path = Path(__file__).resolve().parent.parent / "lib/libopenblas.so"
    expected = os.environ.get("TUNEFORGE_DEMUCS_OPENBLAS_SHA256", "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError("DEMUCS_BLAS_INTEGRITY_FAILED")
    library = ctypes.CDLL(str(path))
    for name in ["openblas_get_num_threads", "openblas_get_parallel"]:
        function = getattr(library, name)
        function.argtypes = []
        function.restype = ctypes.c_int
    library.openblas_set_num_threads.argtypes = [ctypes.c_int]
    library.openblas_set_num_threads.restype = None
    library.openblas_get_config.argtypes = []
    library.openblas_get_config.restype = ctypes.c_char_p
    library.openblas_set_num_threads(1)
    return library, expected


def thread_evidence(torch, library, blas_sha256):
    config = library.openblas_get_config().decode("ascii")
    evidence = {"threads": torch.get_num_threads(), "interop_threads": torch.get_num_interop_threads(),
                "blas_threads": library.openblas_get_num_threads(), "blas_parallel": library.openblas_get_parallel(),
                "blas_implementation": "pthread", "openblas_sha256": blas_sha256, "openblas_config": config}
    if (evidence["threads"] != 4 or evidence["interop_threads"] != 1 or evidence["blas_threads"] != 1
            or evidence["blas_parallel"] != 1 or not config.startswith("OpenBLAS 0.3.34 ")
            or "ARMV8" not in config or "USE64BITINT" in config
            or len(config) > 256 or not re.fullmatch(r"[A-Za-z0-9 ._+=-]+", config)):
        raise RuntimeError("DEMUCS_THREAD_CONFIGURATION_INVALID")
    return evidence


def main():
    if len(sys.argv) != 4 or any(os.environ.get(name) != "1" for name in THREAD_ENV):
        raise ValueError("DEMUCS_THREAD_CONFIGURATION_INVALID")
    source, output, model_path = map(Path, sys.argv[1:])
    if not source.is_file() or not output.is_dir() or any(output.iterdir()):
        raise ValueError("DEMUCS_PATHS_INVALID")
    started = time.monotonic()
    sys.addaudithook(forbid_external)
    emit(1, "imports")
    import numpy as np
    import torch
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    blas, blas_sha256 = openblas_library()
    metrics = thread_evidence(torch, blas, blas_sha256)
    emit(2, "runtime_config", **metrics)
    # Model construction is exclusively the strict, fixed-hash safetensors
    # reader. Keep legacy Torch deserialization unavailable to this worker.
    def no_pickle(*args, **kwargs):
        raise RuntimeError("DEMUCS_PICKLE_FORBIDDEN")
    torch.load = no_pickle
    torch.serialization.load = no_pickle
    from exact_safetensors import load_model
    from demucs_infer.apply import apply_model
    emit(3, "model_loading", threads=torch.get_num_threads(), interop_threads=torch.get_num_interop_threads(), python=sys.version.split()[0], torch=torch.__version__, numpy=np.__version__)
    model = load_model(model_path).eval()
    if list(model.sources) != SOURCES or model.audio_channels != 2 or model.samplerate != 44100:
        raise ValueError("DEMUCS_MODEL_CONTRACT_INVALID")
    metrics = thread_evidence(torch, blas, blas_sha256)
    emit(7, "decode")
    with wave.open(str(source), "rb") as handle:
        if (handle.getnchannels(), handle.getframerate(), handle.getsampwidth(), handle.getcomptype()) != (2, 44100, 2, "NONE"):
            raise ValueError("DEMUCS_INPUT_FORMAT_INVALID")
        frames = handle.getnframes()
        if frames < 1:
            raise ValueError("DEMUCS_INPUT_EMPTY")
        pcm = handle.readframes(frames)
    if len(pcm) != frames * 4:
        raise ValueError("DEMUCS_INPUT_TRUNCATED")
    mix = torch.from_numpy(np.frombuffer(pcm, dtype="<i2").reshape(-1, 2).astype("float32").T.copy() / 32768).unsqueeze(0)
    del pcm
    calls = [0]
    expected_calls = max(1, math.ceil((frames + 44100) / (float(model.segment) * 44100 * .75)))
    def before(module, args):
        calls[0] += 1
        emit(min(94, 10 + int(84 * (calls[0] - 1) / expected_calls)), "inference", forward=calls[0])
    model.register_forward_pre_hook(before)
    random.seed(586)
    torch.manual_seed(586)
    inference_started = time.monotonic()
    with torch.inference_mode():
        estimates = apply_model(model, mix, device="cpu", shifts=1, split=True, overlap=.25, transition_power=1, segment=None, progress=False, num_workers=0)
    inference_s = time.monotonic() - inference_started
    metrics = thread_evidence(torch, blas, blas_sha256)
    if list(estimates.shape) != [1, 6, 2, frames] or not bool(torch.isfinite(estimates).all()):
        raise ValueError("DEMUCS_OUTPUT_INVALID")
    emit(95, "write_outputs")
    outputs = []
    for index, name in enumerate(SOURCES):
        stem = estimates[0, index].transpose(0, 1).contiguous().numpy()
        encoded = np.clip(np.floor(stem * 32768), -32768, 32767).astype("<i2").tobytes()
        path = output / (name + ".wav")
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(44100)
            handle.writeframes(encoded)
        outputs.append({"source": name, "file": path.name, "frames": frames, "channels": 2, "samplerate": 44100, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    result = {"success": True, "frames": frames, "sources": SOURCES, "outputs": outputs, "inference_s": inference_s, "elapsed_s": time.monotonic() - started, **metrics, "model_forward_calls": calls[0]}
    temporary = output / ".result.json.tmp"
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(output / "result.json")
    emit(100, "complete", inference_s=inference_s, elapsed_s=result["elapsed_s"], frames=frames, **metrics)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(0, "failed", error=type(error).__name__, code=str(error) if str(error).startswith("DEMUCS_") else "DEMUCS_WORKER_FAILED")
        raise SystemExit(1) from None
