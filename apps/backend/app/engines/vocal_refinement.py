from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Callable, Sequence
from fractions import Fraction
from pathlib import Path
from queue import Empty, SimpleQueue
from threading import Thread

import numpy as np
import soundfile as sf

from app.config import get_settings
from app.engines.audio_encoding import DurableAudioFormat
from app.engines.stem_audio_encoding import encode_bounded_parts
from app.errors import AppError, JobCancelledError
from app.runtime_status import JobRuntimeEvent, parse_json_payload, runtime_event_from_payload
from app.utils.torch_runtime import with_mps_fallback_env

RATE = 44100
PARTS = ("lead", "backing")
_BLOCK = 65536
ProcessCallback = Callable[[subprocess.Popen[str]], None]


def check_cancel(should_cancel: Callable[[], bool] | None) -> None:
    if should_cancel and should_cancel():
        raise JobCancelledError()


def _stop(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _capture(command: list[str]) -> dict[str, object]:
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=20)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise AppError("INVALID_AUDIO_FILE", "Could not inspect the vocal refinement timeline.") from exc


def _audio_stream(path: Path) -> dict[str, object]:
    result = _capture([
        get_settings().ffprobe_path, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=channels,sample_rate,start_pts,duration_ts,time_base,codec_name",
        "-of", "json", str(path),
    ])
    streams = result.get("streams")
    if not isinstance(streams, list) or not streams or not isinstance(streams[0], dict):
        raise AppError("INVALID_AUDIO_FILE", "Vocal refinement audio does not contain a readable stream.")
    return streams[0]


def _aac_frames(stream: dict[str, object], rate: int, decoded_frames: int) -> int:
    try:
        if stream["codec_name"] != "aac" or stream.get("start_pts") not in (0, "0"):
            return decoded_frames
        duration = Fraction(str(stream["duration_ts"])) * Fraction(str(stream["time_base"])) * rate
    except (ValueError, KeyError, ZeroDivisionError):
        return decoded_frames
    if duration.denominator == 1 and 0 < decoded_frames - duration.numerator < 1024:
        return duration.numerator
    return decoded_frames


def decode_float(
    source: Path, output: Path, *,
    canonical: bool = False, trim_aac: bool = True, length: int | None = None,
    allow_aac_alignment: bool = False,
    should_cancel: Callable[[], bool] | None = None,
    register_process: ProcessCallback | None = None, unregister_process: Callable[[], None] | None = None,
) -> None:
    """Decode through the same float and rate conversion used by Demucs, with bounded disk blocks."""
    stream = _audio_stream(source)
    channels, rate = int(str(stream["channels"])), int(str(stream["sample_rate"]))
    if canonical:
        rate = RATE
    raw = output.with_suffix(".raw")
    command = [
        get_settings().ffmpeg_path, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(source), "-map", "0:a:0", "-vn", "-threads", "1", "-ar", str(rate),
        "-c:a", "pcm_f32le", "-f", "f32le", str(raw),
    ]
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        try:
            if register_process:
                register_process(process)
            while process.poll() is None:
                check_cancel(should_cancel)
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    continue
        finally:
            _stop(process)
            if unregister_process:
                unregister_process()
        check_cancel(should_cancel)
        if process.returncode != 0:
            raise AppError("INVALID_AUDIO_FILE", "Could not decode audio for vocal refinement.")
        width = channels * 4
        size = raw.stat().st_size
        if not size or size % width:
            raise AppError("INVALID_AUDIO_FILE", "Decoded vocal refinement audio is incomplete.")
        decoded_frames = size // width
        frames = _aac_frames(stream, rate, decoded_frames) if trim_aac else decoded_frames
        target = frames if length is None else length
        if target != frames and (
            not allow_aac_alignment or abs(target - frames) >= 1024
        ):
            raise AppError("INVALID_AUDIO_FILE", "Source and six-stem Vocals timelines do not align.")
        with raw.open("rb") as handle, sf.SoundFile(
            output, mode="w", samplerate=rate, channels=2 if canonical else channels,
            subtype="FLOAT", format="RF64",
        ) as writer:
            remaining = min(frames, target)
            while remaining:
                check_cancel(should_cancel)
                count = min(remaining, _BLOCK)
                block = np.fromfile(handle, dtype="<f4", count=count * channels).reshape(count, channels)
                if not np.isfinite(block).all():
                    raise AppError("INVALID_AUDIO_FILE", "Decoded vocal refinement audio is nonfinite.")
                if canonical:
                    block = np.repeat(block, 2, axis=1) if channels == 1 else block[:, :2]
                writer.write(block)
                remaining -= count
            if target > frames:
                writer.write(np.zeros((target - frames, 2 if canonical else channels), dtype=np.float32))
    finally:
        raw.unlink(missing_ok=True)


def run_vocal_refinement(
    mix: Path, parent: Path, raw_paths: Sequence[Path], checkpoint: Path, config: Path, *,
    device: str,
    on_runtime_event: Callable[[JobRuntimeEvent], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: ProcessCallback | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> str:
    command = [
        sys.executable, "-m", "app.engines.vocal_refinement_worker", "--mix", str(mix), "--parent", str(parent),
        "--lead", str(raw_paths[0]), "--backing", str(raw_paths[1]),
        "--checkpoint", str(checkpoint), "--config", str(config),
    ]
    for requested in (device.strip().lower(), "cpu"):
        check_cancel(should_cancel)
        result, failed_accelerator = _worker_attempt(
            [*command, "--device", requested], on_runtime_event, should_cancel, register_process, unregister_process,
        )
        if result:
            return result
        if not failed_accelerator or requested == "cpu":
            break
        for path in raw_paths:
            path.unlink(missing_ok=True)
        if on_runtime_event:
            on_runtime_event(JobRuntimeEvent(
                stage="fallback", stage_label=f"Falling back from {failed_accelerator.upper()} to CPU.",
                runtime_device="cpu", runtime_detail=f"{failed_accelerator.upper()} failed, retrying CPU.",
            ))
    raise AppError("PROCESSING_FAILED", "Mega53 could not refine the Vocals stem.")


def _worker_attempt(
    command: list[str],
    on_runtime_event: Callable[[JobRuntimeEvent], None] | None,
    should_cancel: Callable[[], bool] | None,
    register_process: ProcessCallback | None,
    unregister_process: Callable[[], None] | None,
) -> tuple[str | None, str | None]:
    lines: SimpleQueue[str] = SimpleQueue()
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=with_mps_fallback_env(),
    )
    assert process.stdout is not None
    stdout = process.stdout

    def read_lines() -> None:
        with stdout:
            for line in stdout:
                lines.put(line)

    reader = Thread(target=read_lines, daemon=True)
    result = None
    failed_accelerator = None

    def drain() -> None:
        nonlocal result, failed_accelerator
        while True:
            try:
                payload = parse_json_payload(lines.get_nowait())
            except Empty:
                return
            if not payload:
                continue
            event = runtime_event_from_payload(payload)
            if event and on_runtime_event:
                on_runtime_event(event)
            if payload.get("device") in ("cpu", "mps", "cuda"):
                result = payload["device"]
            if payload.get("accelerator_failed") in ("mps", "cuda"):
                failed_accelerator = payload["accelerator_failed"]

    reader.start()
    try:
        if register_process:
            register_process(process)
        while process.poll() is None:
            check_cancel(should_cancel)
            drain()
            try:
                process.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                continue
        reader.join()
        check_cancel(should_cancel)
        drain()
        return result if process.returncode == 0 else None, failed_accelerator if process.returncode == 2 else None
    finally:
        _stop(process)
        reader.join()
        if unregister_process:
            unregister_process()


def require_unit_peak(path: Path, should_cancel: Callable[[], bool] | None = None) -> None:
    with sf.SoundFile(path) as stream:
        for block in stream.blocks(blocksize=_BLOCK, dtype="float32", always_2d=True):
            check_cancel(should_cancel)
            if not np.isfinite(block).all() or float(np.abs(block).max()) > 1.0:
                raise AppError("PROCESSING_FAILED", "A refined vocal part exceeds the available sample range.")


def validate_conversion(
    original: Path, decoded: Path, output_format: DurableAudioFormat, *,
    original_is_lossless: bool, should_cancel: Callable[[], bool] | None = None, verified_padding_frames: int = 0,
) -> None:
    with sf.SoundFile(original) as before, sf.SoundFile(decoded) as after:
        if (
            after.frames != before.frames + verified_padding_frames
            or after.channels != before.channels
            or after.samplerate != before.samplerate
        ):
            raise AppError("INVALID_AUDIO_FILE", "Encoded vocal refinement audio changed its timeline or channels.")
        energy = decoded_energy = correlation = 0.0
        exact = original_is_lossless and output_format in {"wav", "flac"}
        for block in before.blocks(blocksize=_BLOCK, dtype="float64", always_2d=True):
            check_cancel(should_cancel)
            other = after.read(len(block), dtype="float64", always_2d=True)
            if exact and np.abs(block - other).max() > 1.001 / 32768:
                raise AppError("PROCESSING_FAILED", "Lossless vocal refinement encoding changed sample gain.")
            energy += float(np.square(block).sum())
            decoded_energy += float(np.square(other).sum())
            correlation += float((block * other).sum())
        if not exact:
            meaningful = energy > before.frames * before.channels * 1e-9
            if meaningful and (not 0.75 <= correlation / energy <= 1.25 or decoded_energy > 1.5 * energy):
                raise AppError("PROCESSING_FAILED", "Encoded vocal refinement audio changed timing or gain.")
            if not meaningful and decoded_energy > before.frames * before.channels * 1e-8:
                raise AppError("PROCESSING_FAILED", "Encoding introduced unexpected signal into a quiet vocal part.")


def encode_vocal_parts(
    paths: Sequence[Path], output_dir: Path, output_format: DurableAudioFormat, *,
    expected_frames: int, expected_channels: int, expected_sample_rate: int,
    should_cancel: Callable[[], bool] | None = None,
    register_process: ProcessCallback | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> float:
    def verify_part(scaled: Path, decoded: Path, padding_frames: int) -> None:
        validate_conversion(
            scaled, decoded, output_format, original_is_lossless=True,
            should_cancel=should_cancel, verified_padding_frames=padding_frames,
        )

    return encode_bounded_parts(
        dict(zip(PARTS, paths, strict=True)), output_dir, output_format, stem_name="Vocals",
        expected_frames=expected_frames, expected_channels=expected_channels,
        expected_sample_rate=expected_sample_rate, should_cancel=should_cancel,
        register_process=register_process, unregister_process=unregister_process, verify_part=verify_part,
    )
