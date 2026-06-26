from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import status

from app.errors import AppError, JobCancelledError
from app.runtime_status import is_runtime_event_payload, parse_json_payload
from app.utils.torch_runtime import with_mps_fallback_env


def _require_demucs_dependency() -> None:
    if importlib.util.find_spec("demucs") is None:
        raise AppError(
            "DEPENDENCY_MISSING",
            "Demucs is required for stem separation. Install the backend stem dependencies first.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


def separate_two_stems(
    source_path: Path,
    vocal_path: Path,
    instrumental_path: Path,
    *,
    model: str = "htdemucs_ft",
    device: str = "cpu",
    model_repo: Path | None = None,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> dict[str, object]:
    _require_demucs_dependency()

    command = [
        sys.executable,
        "-m",
        "app.engines.demucs_worker",
        "--source",
        str(source_path),
        "--vocals",
        str(vocal_path),
        "--instrumental",
        str(instrumental_path),
        "--model",
        model,
        "--device",
        device,
    ]
    if model_repo is not None:
        command.extend(["--model-repo", str(model_repo)])

    return _run_demucs_worker(
        command,
        expected_outputs=[vocal_path, instrumental_path],
        model=model,
        device=device,
        on_progress=on_progress,
        should_cancel=should_cancel,
        register_process=register_process,
        unregister_process=unregister_process,
    )


def separate_sources(
    source_path: Path,
    output_paths: Mapping[str, Path],
    *,
    model: str,
    device: str = "cpu",
    model_repo: Path | None = None,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> dict[str, object]:
    _require_demucs_dependency()

    command = [
        sys.executable,
        "-m",
        "app.engines.demucs_worker",
        "--source",
        str(source_path),
        "--model",
        model,
        "--device",
        device,
    ]
    for source, output_path in output_paths.items():
        command.extend(["--stem", f"{source}={output_path}"])
    if model_repo is not None:
        command.extend(["--model-repo", str(model_repo)])

    return _run_demucs_worker(
        command,
        expected_outputs=list(output_paths.values()),
        model=model,
        device=device,
        on_progress=on_progress,
        should_cancel=should_cancel,
        register_process=register_process,
        unregister_process=unregister_process,
    )


def _run_demucs_worker(
    command: list[str],
    *,
    expected_outputs: list[Path],
    model: str,
    device: str,
    on_progress: Callable[[int], None] | None,
    should_cancel: Callable[[], bool] | None,
    register_process: Callable[[subprocess.Popen[str]], None] | None,
    unregister_process: Callable[[], None] | None,
) -> dict[str, object]:
    if on_progress:
        on_progress(10)

    process: subprocess.Popen[str] | None = None
    stdout = ""
    stderr = ""
    runtime_event_callback = getattr(on_progress, "runtime_event", None)
    try:
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=with_mps_fallback_env(os.environ),
            )
            if register_process:
                register_process(process)

            stdout_lines: list[str] = []
            stderr_lines: list[str] = []
            stdout_reader = _start_output_reader(
                getattr(process, "stdout", None),
                stdout_lines,
                runtime_event_callback if callable(runtime_event_callback) else None,
            )
            stderr_reader = _start_output_reader(getattr(process, "stderr", None), stderr_lines)
            using_readers = stdout_reader is not None or stderr_reader is not None

            progress = 15
            started_at = time.monotonic()
            while process.poll() is None:
                if should_cancel and should_cancel():
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=2)
                    raise JobCancelledError()

                elapsed = time.monotonic() - started_at
                next_progress = min(88, 15 + int(elapsed * 4))
                if on_progress and next_progress > progress:
                    progress = next_progress
                    on_progress(progress)
                time.sleep(0.25)

            if using_readers:
                if stdout_reader is not None:
                    stdout_reader.join(timeout=2)
                if stderr_reader is not None:
                    stderr_reader.join(timeout=2)
                stdout = "".join(stdout_lines)
                stderr = "".join(stderr_lines)
            else:
                stdout, stderr = process.communicate()
        finally:
            if unregister_process:
                unregister_process()

        if process.returncode != 0:
            if should_cancel and should_cancel():
                raise JobCancelledError()
            raise AppError(
                "PROCESSING_FAILED",
                "Demucs failed to separate the track.",
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                details={"stdout": (stdout or "").strip(), "stderr": (stderr or "").strip()},
            )

        if any(not output_path.exists() for output_path in expected_outputs):
            raise AppError(
                "PROCESSING_FAILED",
                "Demucs completed without producing the expected stem files.",
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                details={"stdout": (stdout or "").strip(), "stderr": (stderr or "").strip()},
            )

        if on_progress:
            on_progress(98)

        metadata_line = next(
            (
                line
                for line in reversed((stdout or "").splitlines())
                if line.strip() and not is_runtime_event_payload(parse_json_payload(line.strip()))
            ),
            None,
        )
        if metadata_line:
            try:
                return json.loads(metadata_line)
            except json.JSONDecodeError:
                pass

        return {
            "engine": "demucs",
            "model": model,
            "device": device,
        }
    finally:
        if process and process.poll() is None:
            process.kill()


def _start_output_reader(
    pipe: object,
    lines: list[str],
    on_payload: Callable[[dict[str, object]], None] | None = None,
) -> threading.Thread | None:
    if pipe is None or not hasattr(pipe, "__iter__"):
        return None

    def read_lines() -> None:
        for line in pipe:
            lines.append(line)
            payload = parse_json_payload(str(line).strip())
            if payload is not None and on_payload is not None and is_runtime_event_payload(payload):
                on_payload(payload)

    thread = threading.Thread(target=read_lines, name="tuneforge-demucs-output-reader", daemon=True)
    thread.start()
    return thread


def mix_audio_files(
    source_paths: list[Path],
    output_path: Path,
    *,
    subtype: str = "FLOAT",
    block_size: int = 131_072,
) -> None:
    if not source_paths:
        raise AppError("INVALID_REQUEST", "At least one stem file is required for audio mixing.")

    handles = []
    try:
        for source_path in source_paths:
            handles.append(sf.SoundFile(source_path, mode="r"))
        samplerate = handles[0].samplerate
        channels = handles[0].channels
        if any(handle.samplerate != samplerate or handle.channels != channels for handle in handles):
            raise AppError("PROCESSING_FAILED", "Stem files have incompatible sample rates or channel counts.")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with sf.SoundFile(
            output_path,
            mode="w",
            samplerate=samplerate,
            channels=channels,
            format="WAV",
            subtype=subtype,
        ) as output:
            while True:
                blocks = [handle.read(block_size, dtype="float32", always_2d=True) for handle in handles]
                if blocks[0].shape[0] == 0:
                    break
                frame_count = min(block.shape[0] for block in blocks)
                if frame_count == 0:
                    break
                mixed = np.zeros((frame_count, channels), dtype=np.float32)
                for block in blocks:
                    mixed += block[:frame_count]
                output.write(mixed)
    finally:
        for handle in handles:
            handle.close()
