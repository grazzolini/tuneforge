from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from app.config import get_settings
from app.engines.beat_this import (
    BEAT_THIS_CHECKPOINT,
    invalid_beat_this_checkpoint_cache_files,
    preload_beat_this_checkpoint,
)
from app.engines.crema_chords import (
    crema_dependency_status,
    invalid_crema_model_asset_files,
    preload_crema_model,
)
from app.engines.demucs_cache import (
    invalid_demucs_torch_cache_files,
    preload_demucs_torch_cache,
)
from app.engines.lyrics import invalid_whisper_model_cache_files, preload_whisper_model
from app.utils.model_cache import (
    InvalidModelFile,
    format_invalid_model_files,
    remove_invalid_model_files,
)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    settings = get_settings()

    try:
        if not args.skip_demucs:
            _verify_or_prewarm_demucs()
        if not args.skip_whisper:
            _verify_or_prewarm_whisper(settings.lyrics_model)
        if args.include_crema:
            _verify_or_prewarm_crema()
        if args.include_beat_this:
            _verify_or_prewarm_beat_this(args.beat_this_checkpoint)
    except Exception as exc:
        sys.stderr.write(f"Model prewarm failed: {exc}\n")
        return 1

    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.prewarm_models",
        description="Verify and prewarm local model caches for development setup.",
    )
    parser.add_argument("--skip-demucs", action="store_true", help="Skip Demucs checkpoint cache.")
    parser.add_argument("--skip-whisper", action="store_true", help="Skip Whisper lyrics model cache.")
    parser.add_argument(
        "--include-beat-this",
        action="store_true",
        help="Verify/prewarm the optional beat-this checkpoint cache.",
    )
    parser.add_argument(
        "--include-crema",
        action="store_true",
        help="Verify/prewarm the optional crema chord model.",
    )
    parser.add_argument("--beat-this-checkpoint", default=BEAT_THIS_CHECKPOINT)
    return parser


def _verify_or_prewarm_demucs() -> None:
    invalid_files = invalid_demucs_torch_cache_files()
    if not invalid_files:
        sys.stdout.write("Demucs model cache verified.\n")
        return

    _print_invalid_files("Demucs", invalid_files)
    remove_invalid_model_files(invalid_files)
    for result in preload_demucs_torch_cache():
        if result.cache_hit:
            sys.stdout.write(f"Demucs {result.model_id} checkpoint cache hit.\n")
        else:
            sys.stdout.write(f"Preloaded Demucs {result.model_id} checkpoint(s).\n")


def _verify_or_prewarm_whisper(model_name: str) -> None:
    invalid_files = invalid_whisper_model_cache_files(model_name)
    if not invalid_files:
        sys.stdout.write(f"Whisper {model_name} model cache verified.\n")
        return

    _print_invalid_files("Whisper", invalid_files)
    if _has_unsupported_cache_files(invalid_files):
        sys.stdout.write(f"Whisper {model_name} model cache verification skipped.\n")
        return
    remove_invalid_model_files(invalid_files)
    preload_whisper_model(model_name)
    invalid_after_prewarm = invalid_whisper_model_cache_files(model_name)
    if invalid_after_prewarm:
        raise RuntimeError(f"Whisper cache remains invalid: {format_invalid_model_files(invalid_after_prewarm)}")
    sys.stdout.write(f"Preloaded Whisper {model_name} model.\n")


def _verify_or_prewarm_beat_this(checkpoint: str) -> None:
    invalid_files = invalid_beat_this_checkpoint_cache_files(checkpoint)
    if not invalid_files:
        sys.stdout.write(f"beat-this {checkpoint} checkpoint cache verified.\n")
        return

    _print_invalid_files("beat-this", invalid_files)
    if _has_unsupported_cache_files(invalid_files):
        sys.stdout.write(f"beat-this {checkpoint} checkpoint cache verification skipped.\n")
        return
    remove_invalid_model_files(invalid_files)
    preload_beat_this_checkpoint(checkpoint)
    invalid_after_prewarm = invalid_beat_this_checkpoint_cache_files(checkpoint)
    if invalid_after_prewarm:
        raise RuntimeError(
            f"beat-this cache remains invalid: {format_invalid_model_files(invalid_after_prewarm)}"
        )
    sys.stdout.write(f"Preloaded beat-this {checkpoint} checkpoint.\n")


def _verify_or_prewarm_crema() -> None:
    available, reason = crema_dependency_status()
    if not available:
        raise RuntimeError(reason or "crema is unavailable")
    invalid_files = invalid_crema_model_asset_files()
    if not invalid_files:
        sys.stdout.write("Crema model assets verified.\n")
        return

    sys.stdout.write(f"Crema model assets invalid: {format_invalid_model_files(invalid_files)}\n")
    preload_crema_model()
    invalid_after_prewarm = invalid_crema_model_asset_files()
    if invalid_after_prewarm:
        raise RuntimeError(
            f"Crema model assets remain invalid: {format_invalid_model_files(invalid_after_prewarm)}"
        )
    sys.stdout.write("Preloaded Crema model.\n")


def _print_invalid_files(label: str, invalid_files: Sequence[InvalidModelFile]) -> None:
    sys.stdout.write(f"{label} model cache invalid: {format_invalid_model_files(invalid_files)}\n")


def _has_unsupported_cache_files(invalid_files: Sequence[InvalidModelFile]) -> bool:
    return any(invalid_file.reason.startswith("unsupported") for invalid_file in invalid_files)


if __name__ == "__main__":
    raise SystemExit(main())
