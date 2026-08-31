from __future__ import annotations

import json
import os
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from app.engines.crema_onnx import MODEL_REVISION
from app.engines.crema_onnx import expected_model_files as expected_crema_onnx_files
from app.engines.demucs_cache import (
    DEMUCS_MANIFEST_VERSION,
    LEGACY_DEMUCS_MIGRATION,
    DemucsHfModel,
    read_demucs_hf_models,
)
from app.utils.model_cache import ExpectedModelFile, invalid_model_files, torch_checkpoint_dir

_MODEL_BUNDLE_LIST_FIELDS = (
    "torch_checkpoints",
    "demucs_hf_models",
    "whisper_models",
    "crema_onnx_files",
)


def seed_model_bundle_caches(settings: Any) -> None:
    bundle_dir = getattr(settings, "model_bundle_dir", None)
    if bundle_dir is None:
        return
    resolved_bundle_dir = Path(bundle_dir)
    entries = _validated_manifest_entries(resolved_bundle_dir)
    torch_entries = entries["torch_checkpoints"]

    _seed_entries(
        resolved_bundle_dir,
        torch_entries,
        torch_checkpoint_dir(),
    )
    _seed_entries(
        resolved_bundle_dir,
        entries["whisper_models"],
        Path(settings.lyrics_cache_dir),
    )
    crema_onnx_entries = entries["crema_onnx_files"]
    if crema_onnx_entries:
        _seed_crema_onnx_entries(
            resolved_bundle_dir,
            crema_onnx_entries,
            Path(settings.cache_root) / "models" / "crema" / "0.2.0" / MODEL_REVISION,
        )


def demucs_model_bundle_repo(bundle_dir: Path) -> Path | None:
    entries = _validated_manifest_entries(bundle_dir)["demucs_hf_models"]
    return bundle_dir / "demucs" if entries else None


def _validated_manifest_entries(bundle_dir: Path) -> dict[str, tuple[Mapping[str, Any], ...]]:
    manifest = _read_manifest(bundle_dir)
    version = _manifest_version(manifest)
    required = version == DEMUCS_MANIFEST_VERSION
    entries = {
        key: _entries(manifest, key, required=required)
        for key in _MODEL_BUNDLE_LIST_FIELDS
    }
    if version == 1:
        _reject_legacy_demucs_entries(entries["torch_checkpoints"])
    elif version == DEMUCS_MANIFEST_VERSION:
        _validate_demucs_hf_entries(bundle_dir, entries["demucs_hf_models"])
    else:
        raise RuntimeError(f"Unsupported model bundle manifest version: {version}")
    return entries


def _read_manifest(bundle_dir: Path) -> Mapping[str, Any]:
    manifest_path = bundle_dir / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"Model bundle manifest is missing: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Model bundle manifest is unreadable: {manifest_path}") from exc
    if not isinstance(manifest, Mapping):
        raise RuntimeError("Model bundle manifest must be an object")
    return manifest


def _manifest_version(manifest: Mapping[str, Any]) -> int:
    version = manifest.get("version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise RuntimeError("Model bundle manifest version must be an integer")
    return version


def _entries(
    manifest: Mapping[str, Any],
    key: str,
    *,
    required: bool = False,
) -> tuple[Mapping[str, Any], ...]:
    if required and key not in manifest:
        raise RuntimeError(f"Model bundle manifest is missing required field: {key}")
    raw_entries = manifest.get(key, [])
    if not isinstance(raw_entries, list):
        raise RuntimeError(f"Model bundle manifest field must be a list: {key}")
    if not all(isinstance(entry, Mapping) for entry in raw_entries):
        raise RuntimeError(f"Model bundle manifest entries must be objects: {key}")
    return tuple(raw_entries)


def _reject_legacy_demucs_entries(entries: tuple[Mapping[str, Any], ...]) -> None:
    for entry in entries:
        label = entry.get("label")
        file_name = entry.get("file_name")
        if (isinstance(label, str) and "demucs" in label.lower()) or (
            isinstance(file_name, str) and file_name.endswith(".th")
        ):
            raise RuntimeError(LEGACY_DEMUCS_MIGRATION)


def _validate_demucs_hf_entries(
    bundle_dir: Path,
    entries: tuple[Mapping[str, Any], ...],
) -> None:
    canonical = {model.id: model for model in read_demucs_hf_models()}
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    for entry in entries:
        model_id = _required_string(entry, "id")
        if model_id in seen_ids:
            raise RuntimeError(f"Model bundle has duplicate Demucs model id: {model_id}")
        seen_ids.add(model_id)
        model = canonical.get(model_id)
        if model is None:
            raise RuntimeError(f"Model bundle has unknown Demucs model id: {model_id}")
        _validate_demucs_hf_entry_metadata(entry, model)
        raw_files = entry.get("files")
        if not isinstance(raw_files, list) or not all(isinstance(item, Mapping) for item in raw_files):
            raise RuntimeError(f"Model bundle Demucs files must be a list of objects: {model_id}")
        expected_files = {file.file_name: file for file in model.files}
        entry_names = [_required_string(file, "file_name") for file in raw_files]
        if len(entry_names) != len(set(entry_names)) or set(entry_names) != set(expected_files):
            raise RuntimeError(f"Model bundle Demucs file set is invalid: {model_id}")
        for file_entry in raw_files:
            file_name = _required_string(file_entry, "file_name")
            expected_file = expected_files[file_name]
            expected_relative_path = (
                Path("demucs") / model.id / model.revision / expected_file.file_name
            ).as_posix()
            relative_path = _required_string(file_entry, "relative_path")
            if relative_path in seen_paths:
                raise RuntimeError(f"Model bundle has duplicate Demucs path: {relative_path}")
            seen_paths.add(relative_path)
            if (
                _required_string(file_entry, "label") != expected_file.label
                or relative_path != expected_relative_path
                or file_entry.get("size") != expected_file.size
                or _required_string(file_entry, "sha256") != expected_file.sha256
            ):
                raise RuntimeError(f"Model bundle Demucs metadata is invalid: {model_id} {file_name}")
            expected = _expected_bundle_file(bundle_dir, file_entry)
            invalid = invalid_model_files((expected,))
            if invalid:
                raise RuntimeError(f"Bundled Demucs model file is invalid: {invalid[0].path}")
    if entries and seen_ids != set(canonical):
        missing = sorted(set(canonical) - seen_ids)
        raise RuntimeError(f"Model bundle is missing supported Demucs model(s): {', '.join(missing)}")


def _validate_demucs_hf_entry_metadata(entry: Mapping[str, Any], model: DemucsHfModel) -> None:
    bag_order = entry.get("bag_order")
    if (
        entry.get("mode") != model.mode
        or entry.get("repo_id") != model.repo_id
        or entry.get("revision") != model.revision
        or entry.get("yaml_file") != model.yaml_file
        or bag_order != list(model.bag_order)
    ):
        raise RuntimeError(f"Model bundle Demucs metadata is invalid: {model.id}")


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
