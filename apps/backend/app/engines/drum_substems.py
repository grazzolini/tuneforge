from __future__ import annotations

import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path

from app.engines import stem_audio_encoding
from app.engines.audio_encoding import DurableAudioFormat

_PARTS = ("kick", "snare", "cymbals", "toms")


def signed_subset_bound(
    paths: Mapping[str, Path], *, should_cancel: Callable[[], bool] | None = None
) -> float:
    return stem_audio_encoding.signed_subset_bound(
        {part: paths[part] for part in _PARTS}, should_cancel=should_cancel,
    )


def encode_bounded_drum_parts(
    raw_paths: Mapping[str, Path], publish_dir: Path, output_format: DurableAudioFormat,
    *, expected_frames: int, expected_channels: int, expected_sample_rate: int,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> float:
    return stem_audio_encoding.encode_bounded_parts(
        {part: raw_paths[part] for part in _PARTS}, publish_dir, output_format, stem_name="Drums",
        expected_frames=expected_frames, expected_channels=expected_channels,
        expected_sample_rate=expected_sample_rate, should_cancel=should_cancel,
        register_process=register_process, unregister_process=unregister_process,
    )
