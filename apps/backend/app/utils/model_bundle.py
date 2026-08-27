from __future__ import annotations

import json
import os
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from app.engines.crema_onnx import MODEL_REVISION
from app.engines.crema_onnx import expected_model_files as expected_crema_onnx_files
from app.utils.model_cache import ExpectedModelFile, invalid_model_files, torch_checkpoint_dir


def seed_model_bundle_caches(settings: Any) -> None:
    bundle_dir = getattr(settings, "model_bundle_dir", None)
    if bundle_dir is None:
        return
    resolved_bundle_dir = Path(bundle_dir)
    manifest_path = resolved_bundle_dir / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"Model bundle manifest is missing: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    _seed_entries(
        resolved_bundle_dir,
        _entries(manifest, "torch_checkpoints"),
        torch_checkpoint_dir(),
    )
    _seed_entries(
        resolved_bundle_dir,
        _entries(manifest, "whisper_models"),
        Path(settings.lyrics_cache_dir),
    )
    crema_onnx_entries = _entries(manifest, "crema_onnx_files")
    if crema_onnx_entries:
        _seed_crema_onnx_entries(
            resolved_bundle_dir,
            crema_onnx_entries,
            Path(settings.cache_root) / "models" / "crema" / "0.2.0" / MODEL_REVISION,
        )


def _entries(manifest: Mapping[str, Any], key: str) -> tuple[Mapping[str, Any], ...]:
    raw_entries = manifest.get(key, [])
    if not isinstance(raw_entries, list):
        raise RuntimeError(f"Model bundle manifest field must be a list: {key}")
    return tuple(entry for entry in raw_entries if isinstance(entry, Mapping))


def _seed_entries(bundle_dir: Path, entries: tuple[Mapping[str, Any], ...], cache_dir: Path) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        expected = _expected_bundle_file(bundle_dir, entry)
        invalid_source = invalid_model_files((expected,))
        if invalid_source:
            raise RuntimeError(f"Bundled model file is invalid: {invalid_source[0].path}")

        destination = cache_dir / expected.path.name
        destination_expected = ExpectedModelFile(
            label=expected.label,
            path=destination,
            size=expected.size,
            sha256=expected.sha256,
        )
        if not invalid_model_files((destination_expected,)):
            continue
        _copy_verified_model_file(expected, destination)


def _seed_crema_onnx_entries(
    bundle_dir: Path,
    entries: tuple[Mapping[str, Any], ...],
    cache_dir: Path,
) -> None:
    expected_by_name = {expected.path.name: expected for expected in expected_crema_onnx_files(cache_dir)}
    entry_names = [_required_string(entry, "file_name") for entry in entries]
    if len(entry_names) != len(expected_by_name) or set(entry_names) != set(expected_by_name):
        raise RuntimeError("Crema ONNX model bundle must contain the exact pinned file set")
    for entry in entries:
        name = _required_string(entry, "file_name")
        expected = expected_by_name[name]
        expected_relative_path = (Path("crema") / "0.2.0" / MODEL_REVISION / name).as_posix()
        if (
            _required_string(entry, "relative_path") != expected_relative_path
            or entry.get("size") != expected.size
            or _required_string(entry, "sha256") != expected.sha256
        ):
            raise RuntimeError(f"Crema ONNX model bundle metadata is invalid: {name}")
    _seed_entries(bundle_dir, entries, cache_dir)


def _expected_bundle_file(bundle_dir: Path, entry: Mapping[str, Any]) -> ExpectedModelFile:
    label = _required_string(entry, "label")
    relative_path = _required_string(entry, "relative_path")
    size = entry.get("size")
    sha256 = _required_string(entry, "sha256")
    if not isinstance(size, int) or size <= 0:
        raise RuntimeError(f"Model bundle entry has invalid size: {label}")
    source_path = (bundle_dir / relative_path).resolve()
    if not source_path.is_relative_to(bundle_dir.resolve()):
        raise RuntimeError(f"Model bundle entry escapes bundle directory: {label}")
    return ExpectedModelFile(label=label, path=source_path, size=size, sha256=sha256)


def _required_string(entry: Mapping[str, Any], key: str) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"Model bundle entry has invalid {key}")
    return value


def _copy_verified_model_file(expected: ExpectedModelFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    temp_path.unlink(missing_ok=True)
    try:
        shutil.copy2(expected.path, temp_path)
        temp_expected = ExpectedModelFile(
            label=expected.label,
            path=temp_path,
            size=expected.size,
            sha256=expected.sha256,
        )
        invalid_temp = invalid_model_files((temp_expected,))
        if invalid_temp:
            raise RuntimeError(f"Copied model file is invalid: {temp_path}")
        temp_path.replace(destination)
    finally:
        temp_path.unlink(missing_ok=True)
