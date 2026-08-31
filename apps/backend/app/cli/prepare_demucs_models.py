from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

from app.engines.demucs_cache import (
    format_invalid_demucs_hf_cache_files,
    invalid_demucs_hf_cache_files,
    preload_demucs_hf_cache,
    read_demucs_hf_models,
    resolved_demucs_hf_cache_files,
    validate_demucs_model_repo,
)


def default_prepared_demucs_model_repo_path() -> Path:
    return (
        Path(__file__).resolve().parents[4]
        / "apps"
        / "desktop"
        / "src-tauri"
        / "resources"
        / "backend"
        / "models"
        / "demucs"
    )


def prepare_demucs_model_repo(
    output: Path,
    *,
    cache_dir: Path | None = None,
    cache_only: bool = False,
    manifest_path: Path | None = None,
) -> None:
    if cache_only:
        invalid = invalid_demucs_hf_cache_files(manifest_path=manifest_path, cache_dir=cache_dir)
        if invalid:
            raise RuntimeError(
                "Demucs Hugging Face cache-only preparation requires valid cached files: "
                f"{format_invalid_demucs_hf_cache_files(invalid)}"
            )
    else:
        preload_demucs_hf_cache(manifest_path=manifest_path, cache_dir=cache_dir)

    models = read_demucs_hf_models(manifest_path)
    resolved_files = {
        model.id: resolved_demucs_hf_cache_files(
            model.id,
            manifest_path=manifest_path,
            cache_dir=cache_dir,
        )
        for model in models
    }
    output_parent = output.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}.prepare-", dir=output_parent) as staging_dir:
        staging_root = Path(staging_dir)
        for model in models:
            destination = staging_root / model.id / model.revision
            destination.mkdir(parents=True)
            for file in resolved_files[model.id]:
                shutil.copy2(file.path, destination / file.path.name)

        for model in models:
            validate_demucs_model_repo(staging_root, model.id, manifest_path=manifest_path)

        if output.exists():
            if not output.is_dir():
                raise RuntimeError(f"Demucs model repository output is not a directory: {output}")
            shutil.rmtree(output)
        shutil.move(str(staging_root), output)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        prepare_demucs_model_repo(
            _resolve_cli_path(args.output),
            cache_dir=_resolve_cli_path(args.cache) if args.cache is not None else None,
            cache_only=args.cache_only or _env_flag("TUNEFORGE_DEMUCS_CACHE_ONLY"),
        )
    except Exception as exc:
        print(f"Demucs model preparation failed: {exc}", file=sys.stderr)
        return 1
    print(f"Prepared Demucs model repo in {args.output}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.prepare_demucs_models",
        description="Prepare a verified local Demucs model repository from the Hugging Face cache.",
    )
    parser.add_argument("--output", type=Path, default=default_prepared_demucs_model_repo_path())
    parser.add_argument("--cache", type=Path, help="Explicit Hugging Face Hub cache root.")
    parser.add_argument(
        "--cache-only",
        action="store_true",
        help="Require valid cached files and do not download missing or corrupt files.",
    )
    return parser


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in {"1", "true", "yes"}


def _resolve_cli_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    base_dir = os.environ.get("TUNEFORGE_DEMUCS_PREPARE_BASE_DIR")
    return (Path(base_dir) if base_dir else Path.cwd()) / path


if __name__ == "__main__":
    raise SystemExit(main())
