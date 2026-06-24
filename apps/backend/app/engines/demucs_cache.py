from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.utils.model_cache import (
    ExpectedModelFile,
    InvalidModelFile,
    invalid_model_files,
    torch_checkpoint_dir,
)

DEFAULT_DEMUCS_MODEL_IDS = ("htdemucs_6s", "htdemucs_ft")


@dataclass(frozen=True)
class DemucsCacheFile:
    file_name: str
    size: int
    sha256: str


@dataclass(frozen=True)
class DemucsCacheModel:
    id: str
    files: tuple[DemucsCacheFile, ...]


@dataclass(frozen=True)
class DemucsPreloadResult:
    model_id: str
    cache_hit: bool


@dataclass(frozen=True)
class InvalidDemucsCacheFile:
    file_name: str
    reason: str
    path: Path


def default_demucs_model_manifest_path() -> Path:
    return Path(__file__).resolve().parents[4] / "packaging" / "demucs" / "models.json"


def preload_demucs_torch_cache(
    *,
    manifest_path: Path | None = None,
    checkpoint_dir: Path | None = None,
    model_ids: Sequence[str] = DEFAULT_DEMUCS_MODEL_IDS,
    get_model_func: Callable[[str], object] | None = None,
) -> tuple[DemucsPreloadResult, ...]:
    resolved_manifest_path = manifest_path or default_demucs_model_manifest_path()
    resolved_checkpoint_dir = checkpoint_dir or torch_checkpoint_dir()
    models = _read_manifest_models(resolved_manifest_path, model_ids=model_ids)
    resolved_checkpoint_dir.mkdir(parents=True, exist_ok=True)

    if get_model_func is None:
        from demucs.pretrained import get_model

        get_model_func = get_model

    results: list[DemucsPreloadResult] = []
    for model in models:
        invalid_files = _invalid_cache_files(resolved_checkpoint_dir, model)
        if not invalid_files:
            results.append(DemucsPreloadResult(model_id=model.id, cache_hit=True))
            continue

        from app.engines.demucs_worker import _trusted_demucs_checkpoint_loading

        with _trusted_demucs_checkpoint_loading():
            get_model_func(model.id)

        remaining_invalid_files = _invalid_cache_files(resolved_checkpoint_dir, model)
        if remaining_invalid_files:
            details = ", ".join(
                f"{invalid_file.file_name} ({invalid_file.reason})"
                for invalid_file in remaining_invalid_files
            )
            raise RuntimeError(f"Demucs model cache is missing or invalid after preload for {model.id}: {details}")
        results.append(DemucsPreloadResult(model_id=model.id, cache_hit=False))
    return tuple(results)


def invalid_demucs_torch_cache_files(
    *,
    manifest_path: Path | None = None,
    checkpoint_dir: Path | None = None,
    model_ids: Sequence[str] = DEFAULT_DEMUCS_MODEL_IDS,
) -> tuple[InvalidModelFile, ...]:
    return invalid_model_files(
        expected_demucs_torch_cache_files(
            manifest_path=manifest_path,
            checkpoint_dir=checkpoint_dir,
            model_ids=model_ids,
        )
    )


def expected_demucs_torch_cache_files(
    *,
    manifest_path: Path | None = None,
    checkpoint_dir: Path | None = None,
    model_ids: Sequence[str] = DEFAULT_DEMUCS_MODEL_IDS,
) -> tuple[ExpectedModelFile, ...]:
    resolved_manifest_path = manifest_path or default_demucs_model_manifest_path()
    resolved_checkpoint_dir = checkpoint_dir or torch_checkpoint_dir()
    models = _read_manifest_models(resolved_manifest_path, model_ids=model_ids)
    expected_files: list[ExpectedModelFile] = []
    for model in models:
        expected_files.extend(
            ExpectedModelFile(
                label=f"Demucs {model.id} {file.file_name}",
                path=resolved_checkpoint_dir / file.file_name,
                size=file.size,
                sha256=file.sha256,
            )
            for file in model.files
        )
    return tuple(expected_files)


def _read_manifest_models(manifest_path: Path, *, model_ids: Sequence[str]) -> tuple[DemucsCacheModel, ...]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    raw_models = manifest.get("models")
    if not isinstance(raw_models, list):
        raise RuntimeError("Demucs model manifest must contain a models list.")

    models_by_id = {
        str(model["id"]): _parse_manifest_model(model)
        for model in raw_models
        if isinstance(model, dict) and isinstance(model.get("id"), str)
    }
    missing_model_ids = [model_id for model_id in model_ids if model_id not in models_by_id]
    if missing_model_ids:
        raise RuntimeError(f"Demucs model manifest is missing model(s): {', '.join(missing_model_ids)}")
    return tuple(models_by_id[model_id] for model_id in model_ids)


def _parse_manifest_model(model: dict[str, Any]) -> DemucsCacheModel:
    raw_files = model.get("files")
    if not isinstance(raw_files, list):
        raise RuntimeError(f"Demucs model manifest entry has invalid files: {model.get('id')}")
    files: list[DemucsCacheFile] = []
    for file_entry in raw_files:
        if not isinstance(file_entry, dict):
            raise RuntimeError(f"Demucs model manifest entry has invalid file: {model.get('id')}")
        file_name = file_entry.get("fileName")
        file_size = file_entry.get("size")
        file_sha256 = file_entry.get("sha256")
        if not isinstance(file_name, str) or Path(file_name).name != file_name:
            raise RuntimeError(f"Demucs model manifest entry has invalid file name: {model.get('id')}")
        if not isinstance(file_size, int) or file_size <= 0:
            raise RuntimeError(f"Demucs model manifest entry has invalid file size: {model.get('id')}")
        if not isinstance(file_sha256, str):
            raise RuntimeError(f"Demucs model manifest entry has invalid file hash: {model.get('id')}")
        files.append(DemucsCacheFile(file_name=file_name, size=file_size, sha256=file_sha256))
    return DemucsCacheModel(id=str(model["id"]), files=tuple(files))


def _invalid_cache_files(checkpoint_dir: Path, model: DemucsCacheModel) -> tuple[InvalidDemucsCacheFile, ...]:
    invalid_files: list[InvalidDemucsCacheFile] = []
    for expected_file in model.files:
        path = checkpoint_dir / expected_file.file_name
        if not path.is_file():
            invalid_files.append(
                InvalidDemucsCacheFile(file_name=expected_file.file_name, reason="missing", path=path)
            )
            continue
        if path.stat().st_size != expected_file.size:
            invalid_files.append(
                InvalidDemucsCacheFile(file_name=expected_file.file_name, reason="size", path=path)
            )
            continue
        if invalid_model_files(
            (
                ExpectedModelFile(
                    label=f"Demucs {model.id} {expected_file.file_name}",
                    path=path,
                    size=expected_file.size,
                    sha256=expected_file.sha256,
                ),
            )
        ):
            invalid_files.append(
                InvalidDemucsCacheFile(file_name=expected_file.file_name, reason="sha256", path=path)
            )
    return tuple(invalid_files)
