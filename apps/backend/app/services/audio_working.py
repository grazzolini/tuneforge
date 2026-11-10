from __future__ import annotations

import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from subprocess import Popen

import soundfile as sf

from app.engines.audio_encoding import encode_audio, validate_audio_file
from app.errors import AppError


@contextmanager
def materialize_pcm_wav(
    source_path: Path,
    *,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
    frame_limit: int | None = None,
    expected_sample_rate: int | None = None,
    expected_channels: int | None = None,
) -> Iterator[Path]:
    max_output_seconds: float | None = None
    max_output_bytes: int | None = None
    if frame_limit is not None:
        if frame_limit < 1 or not expected_sample_rate or not expected_channels:
            raise ValueError("Bounded decoding requires positive frame, sample-rate and channel limits.")
        # Two sentinel samples avoid time-base rounding hiding a one-sample excess.
        # The byte cap also bounds malformed streams whose decoded dimensions differ.
        max_output_seconds = (frame_limit + 2) / expected_sample_rate
        max_output_bytes = (frame_limit + 2) * expected_channels * 2 + 1024 * 1024

    def validate_bound(path: Path) -> None:
        if frame_limit is None:
            return
        info = sf.info(path)
        if info.frames > frame_limit or info.samplerate != expected_sample_rate or info.channels != expected_channels:
            raise AppError(
                "SECTION_DECODE_LIMIT", "Decoded audio exceeds its admitted duration or dimensions.", status_code=409
            )

    if source_path.suffix.lower() == ".wav":
        validate_bound(source_path)
        yield source_path
        return

    with tempfile.TemporaryDirectory(prefix="tuneforge-working-audio-") as temp_dir:
        working_path = Path(temp_dir) / "source.wav"
        encode_audio(
            source_path,
            working_path,
            "wav",
            should_cancel=should_cancel,
            register_process=register_process,
            unregister_process=unregister_process,
            max_output_seconds=max_output_seconds,
            max_output_bytes=max_output_bytes,
        )
        validate_audio_file(working_path, "wav")
        validate_bound(working_path)
        yield working_path
