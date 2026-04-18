from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

from fastapi import status

from app.errors import AppError, JobCancelledError
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

    if on_progress:
        on_progress(10)

    process: subprocess.Popen[str] | None = None
    stdout = ""
    stderr = ""
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

            stdout, stderr = process.communicate()
        finally:
            if unregister_process:
                unregister_process()

        if process.returncode != 0:
            raise AppError(
                "PROCESSING_FAILED",
                "Demucs failed to separate the track.",
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                details={"stdout": (stdout or "").strip(), "stderr": (stderr or "").strip()},
            )

        if not vocal_path.exists() or not instrumental_path.exists():
            raise AppError(
                "PROCESSING_FAILED",
                "Demucs completed without producing the expected stem files.",
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                details={"stdout": (stdout or "").strip(), "stderr": (stderr or "").strip()},
            )

        if on_progress:
            on_progress(98)

        metadata_line = next(
            (line for line in reversed((stdout or "").splitlines()) if line.strip()),
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
