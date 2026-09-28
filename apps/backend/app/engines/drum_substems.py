from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Mapping
from fractions import Fraction
from pathlib import Path

import numpy as np
import soundfile as sf

from app.config import get_settings
from app.engines.audio_encoding import DurableAudioFormat, encode_audio, validate_audio_file
from app.errors import AppError, JobCancelledError

_PARTS = ("kick", "snare", "cymbals", "toms")
_CHUNK_FRAMES = 65536
_SAFE_BOUND = 0.9
_PCM_QUANTIZATION_MARGIN = 2.0 / 32768.0


def _check_cancel(should_cancel: Callable[[], bool] | None) -> None:
    if should_cancel and should_cancel():
        raise JobCancelledError()


def _aligned_streams(paths: Mapping[str, Path]) -> tuple[list[sf.SoundFile], int, int, int]:
    opened = [sf.SoundFile(paths[part]) for part in _PARTS]
    try:
        first = opened[0]
        if first.frames <= 0 or first.channels <= 0 or first.samplerate <= 0:
            raise AppError("INVALID_AUDIO_FILE", "DrumSep produced empty audio.")
        if any(
            stream.frames != first.frames
            or stream.channels != first.channels
            or stream.samplerate != first.samplerate
            for stream in opened[1:]
        ):
            raise AppError("INVALID_AUDIO_FILE", "DrumSep parts do not align.")
        return opened, first.frames, first.channels, first.samplerate
    except Exception:
        for stream in opened:
            stream.close()
        raise


def signed_subset_bound(
    paths: Mapping[str, Path], *, should_cancel: Callable[[], bool] | None = None
) -> float:
    """Peak possible sum for every attenuation-only subset of the four parts."""
    streams, frames, _, _ = _aligned_streams(paths)
    bound = 0.0
    try:
        remaining = frames
        while remaining:
            _check_cancel(should_cancel)
            count = min(remaining, _CHUNK_FRAMES)
            chunks = [stream.read(count, dtype="float64", always_2d=True) for stream in streams]
            if any(chunk.shape[0] != count or not np.isfinite(chunk).all() for chunk in chunks):
                raise AppError("INVALID_AUDIO_FILE", "DrumSep produced nonfinite or incomplete audio.")
            stacked = np.stack(chunks)
            positive = np.maximum(stacked, 0).sum(axis=0)
            negative = np.minimum(stacked, 0).sum(axis=0)
            bound = max(bound, float(np.maximum(positive, -negative).max()))
            remaining -= count
    finally:
        for stream in streams:
            stream.close()
    return bound


def _write_scaled_float_parts(
    paths: Mapping[str, Path], destination: Path, gain: float,
    *, should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Path]:
    streams, frames, channels, sample_rate = _aligned_streams(paths)
    destination.mkdir(parents=True, exist_ok=True)
    outputs = {part: destination / f"{part}.wav" for part in _PARTS}
    writers: list[sf.SoundFile] = []
    try:
        writers = [
            sf.SoundFile(outputs[part], mode="w", samplerate=sample_rate, channels=channels, subtype="FLOAT")
            for part in _PARTS
        ]
        remaining = frames
        while remaining:
            _check_cancel(should_cancel)
            count = min(remaining, _CHUNK_FRAMES)
            for stream, writer in zip(streams, writers, strict=True):
                chunk = stream.read(count, dtype="float64", always_2d=True)
                if chunk.shape[0] != count or not np.isfinite(chunk).all():
                    raise AppError("INVALID_AUDIO_FILE", "DrumSep produced nonfinite or incomplete audio.")
                writer.write((chunk * gain).astype("float32"))
            remaining -= count
    finally:
        for stream in streams:
            stream.close()
        for writer in writers:
            writer.close()
    return outputs


def _decode_to_float(
    encoded: Path, destination: Path, *, should_cancel: Callable[[], bool] | None = None
) -> None:
    command = [
        get_settings().ffmpeg_path, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(encoded), "-map", "0:a:0", "-vn", "-c:a", "pcm_f32le", str(destination),
    ]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
    while process.poll() is None:
        if should_cancel and should_cancel():
            process.terminate()
            process.wait()
            raise JobCancelledError()
        try:
            process.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            pass
    if process.returncode != 0:
        raise AppError("PROCESSING_FAILED", "Could not decode refined drums for safety verification.")


def _has_exact_aac_timeline(encoded: Path, frames: int, decoded_frames: int, sample_rate: int) -> bool:
    padding = decoded_frames - frames
    if padding <= 0 or padding >= 1024 or decoded_frames != ((frames + 1023) // 1024) * 1024:
        return False
    command = [
        get_settings().ffprobe_path, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=start_pts,duration_ts,time_base", "-of", "json", str(encoded),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        streams = json.loads(result.stdout)["streams"]
        if len(streams) != 1:
            return False
        stream = streams[0]
        return (
            int(stream["start_pts"]) == 0
            and int(stream["duration_ts"]) * Fraction(stream["time_base"])
            == Fraction(frames, sample_rate)
        )
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError,
            KeyError, IndexError, TypeError, ValueError, ZeroDivisionError):
        return False


def encode_bounded_drum_parts(
    raw_paths: Mapping[str, Path], publish_dir: Path, output_format: DurableAudioFormat,
    *, expected_frames: int, expected_channels: int, expected_sample_rate: int,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> float:
    """Encode one common-gain four-part set; verify the decoded result before publication."""
    raw_streams, frames, channels, sample_rate = _aligned_streams(raw_paths)
    for stream in raw_streams:
        stream.close()
    if (frames, channels, sample_rate) != (
        expected_frames, expected_channels, expected_sample_rate,
    ):
        raise AppError("INVALID_AUDIO_FILE", "DrumSep parts do not align with the original Drums stem.")
    raw_bound = signed_subset_bound(raw_paths, should_cancel=should_cancel)
    gain = min(1.0, _SAFE_BOUND / raw_bound) if raw_bound else 1.0
    for attempt in range(3):
        _check_cancel(should_cancel)
        attempt_dir = publish_dir.parent / f"attempt-{attempt}"
        scaled = _write_scaled_float_parts(raw_paths, attempt_dir / "scaled", gain,
                                           should_cancel=should_cancel)
        encoded_dir = attempt_dir / "encoded"
        encoded_dir.mkdir(parents=True, exist_ok=True)
        encoded = {part: encoded_dir / f"{part}.{output_format}" for part in _PARTS}
        for part in _PARTS:
            encode_audio(scaled[part], encoded[part], output_format, should_cancel=should_cancel,
                         register_process=register_process, unregister_process=unregister_process,
                         movie_timescale=sample_rate if output_format == "m4a" else None)
            validate_audio_file(encoded[part], output_format)
        decoded_dir = attempt_dir / "decoded"
        decoded_dir.mkdir()
        decoded = {part: decoded_dir / f"{part}.wav" for part in _PARTS}
        for part in _PARTS:
            _decode_to_float(encoded[part], decoded[part], should_cancel=should_cancel)
        decoded_streams, decoded_frames, decoded_channels, decoded_sample_rate = _aligned_streams(decoded)
        for stream in decoded_streams:
            stream.close()
        if (
            decoded_channels != expected_channels
            or decoded_sample_rate != expected_sample_rate
            or (
                decoded_frames != expected_frames
                and (
                    output_format != "m4a"
                    or any(
                        not _has_exact_aac_timeline(
                            encoded[part], expected_frames, decoded_frames, expected_sample_rate,
                        )
                        for part in _PARTS
                    )
                )
            )
        ):
            raise AppError("INVALID_AUDIO_FILE", "Encoded drum parts do not align with the original Drums stem.")
        decoded_bound = signed_subset_bound(decoded, should_cancel=should_cancel)
        if decoded_bound <= _SAFE_BOUND:
            encoded_dir.replace(publish_dir)
            return gain
        gain *= min(1.0, (_SAFE_BOUND - _PCM_QUANTIZATION_MARGIN) / decoded_bound)
    raise AppError("PROCESSING_FAILED", "Refined drums exceeded the safe encoded sample bound.")
