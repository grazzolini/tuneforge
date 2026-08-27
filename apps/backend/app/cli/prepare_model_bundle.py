from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from pathlib import Path

from app.config import get_settings
from app.engines.beat_this import (
    BEAT_THIS_CHECKPOINT,
    expected_beat_this_checkpoint_file,
    invalid_beat_this_checkpoint_cache_files,
    preload_beat_this_checkpoint,
)
from app.engines.crema_onnx import (
    MODEL_REVISION,
    ensure_crema_onnx_files,
    invalid_crema_onnx_files,
)
from app.engines.crema_onnx import (
    expected_model_files as expected_crema_onnx_files,
)
from app.engines.demucs_cache import (
    expected_demucs_torch_cache_files,
    invalid_demucs_torch_cache_files,
    preload_demucs_torch_cache,
)
from app.engines.lyrics import (
    expected_whisper_model_cache_file,
    invalid_whisper_model_cache_files,
    preload_whisper_model,
    resolve_whisper_model_candidates,
)
from app.utils.model_cache import ExpectedModelFile, invalid_model_files, remove_invalid_model_files


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    settings = get_settings()
    lyrics_models = resolve_whisper_model_candidates(args.lyrics_model or settings.lyrics_model, device="cuda")

    try:
        prepare_model_bundle(
            output_dir=args.output,
            include_beat_this=args.include_beat_this,
            include_crema_onnx=args.include_crema_onnx,
            lyrics_models=lyrics_models,
        )
    except Exception as exc:
        sys.stderr.write(f"Model bundle preparation failed: {exc}\n")
        return 1
    return 0


def prepare_model_bundle(
    *,
    output_dir: Path,
    include_beat_this: bool = False,
    include_crema_onnx: bool = False,
    lyrics_models: Sequence[str],
) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    torch_entries = _prepare_demucs_entries(output_dir)
    whisper_entries = _prepare_whisper_entries(output_dir, lyrics_models)
    if include_beat_this:
        torch_entries.extend(_prepare_beat_this_entries(output_dir))
    crema_onnx_entries = _prepare_crema_onnx_entries(output_dir) if include_crema_onnx else []

    (output_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "prepared_at": datetime.now(UTC).isoformat(),
                "torch_checkpoints": torch_entries,
                "whisper_models": whisper_entries,
                "crema_onnx_files": crema_onnx_entries,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    sys.stdout.write(f"Prepared model bundle in {output_dir}\n")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.prepare_model_bundle",
        description="Prepare package model bundle resources from verified default caches.",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--include-beat-this", action="store_true")
    parser.add_argument("--include-crema-onnx", action="store_true")
    parser.add_argument("--lyrics-model", default=None)
    return parser


def _prepare_demucs_entries(output_dir: Path) -> list[dict[str, object]]:
    invalid_files = invalid_demucs_torch_cache_files()
    if invalid_files:
        remove_invalid_model_files(invalid_files)
        preload_demucs_torch_cache()
    _raise_if_invalid("Demucs", invalid_demucs_torch_cache_files())
    return [
        _copy_to_bundle(output_dir, expected_file, Path("torch") / "hub" / "checkpoints" / expected_file.path.name)
        for expected_file in expected_demucs_torch_cache_files()
    ]


def _prepare_whisper_entries(output_dir: Path, lyrics_models: Sequence[str]) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    copied_paths: set[str] = set()
    for model_name in lyrics_models:
        invalid_files = invalid_whisper_model_cache_files(model_name)
        if invalid_files:
            remove_invalid_model_files(invalid_files)
            preload_whisper_model(model_name)
        _raise_if_invalid(f"Whisper {model_name}", invalid_whisper_model_cache_files(model_name))
        expected_file = expected_whisper_model_cache_file(model_name)
        relative_path = Path("whisper") / expected_file.path.name
        entry = _copy_to_bundle(output_dir, expected_file, relative_path)
        entry["model"] = model_name
        if str(relative_path) not in copied_paths:
            copied_paths.add(str(relative_path))
            entries.append(entry)
    return entries


def _prepare_beat_this_entries(output_dir: Path) -> list[dict[str, object]]:
    invalid_files = invalid_beat_this_checkpoint_cache_files(BEAT_THIS_CHECKPOINT)
    if invalid_files:
        remove_invalid_model_files(invalid_files)
        preload_beat_this_checkpoint(BEAT_THIS_CHECKPOINT)
    _raise_if_invalid("beat-this", invalid_beat_this_checkpoint_cache_files(BEAT_THIS_CHECKPOINT))
    expected_file = expected_beat_this_checkpoint_file(BEAT_THIS_CHECKPOINT)
    entry = _copy_to_bundle(
        output_dir,
        expected_file,
        Path("torch") / "hub" / "checkpoints" / expected_file.path.name,
    )
    entry["checkpoint"] = BEAT_THIS_CHECKPOINT
    return [entry]


def _prepare_crema_onnx_entries(output_dir: Path) -> list[dict[str, object]]:
    if invalid_crema_onnx_files():
        ensure_crema_onnx_files()
    _raise_if_invalid("Crema ONNX", invalid_crema_onnx_files())
    relative_root = Path("crema") / "0.2.0" / MODEL_REVISION
    return [
        _copy_to_bundle(output_dir, expected_file, relative_root / expected_file.path.name)
        for expected_file in expected_crema_onnx_files()
    ]


def _copy_to_bundle(
    output_dir: Path,
    expected_file: ExpectedModelFile,
    relative_path: Path,
) -> dict[str, object]:
    destination = output_dir / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(expected_file.path, destination)
    copied_expected = ExpectedModelFile(
        label=expected_file.label,
        path=destination,
        size=expected_file.size,
        sha256=expected_file.sha256,
    )
    _raise_if_invalid(expected_file.label, invalid_model_files((copied_expected,)))
    return {
        "label": expected_file.label,
        "file_name": expected_file.path.name,
        "relative_path": relative_path.as_posix(),
        "size": expected_file.size,
        "sha256": expected_file.sha256,
    }


def _raise_if_invalid(label: str, invalid_files: Iterable[object]) -> None:
    invalid_tuple = tuple(invalid_files)
    if invalid_tuple:
        raise RuntimeError(f"{label} cache remains invalid after preload")


if __name__ == "__main__":
    raise SystemExit(main())
