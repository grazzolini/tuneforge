from __future__ import annotations

import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from subprocess import Popen

from app.engines.audio_encoding import encode_audio, validate_audio_file


@contextmanager
def materialize_pcm_wav(
    source_path: Path,
    *,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> Iterator[Path]:
    if source_path.suffix.lower() == ".wav":
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
        )
        validate_audio_file(working_path, "wav")
        yield working_path
