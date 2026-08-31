from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from huggingface_hub import hf_hub_download, try_to_load_from_cache

from app.utils.model_cache import ExpectedModelFile, invalid_model_files

DEFAULT_DEMUCS_MODEL_IDS = ("htdemucs_6s", "htdemucs_ft")
DEMUCS_MANIFEST_VERSION = 2
LEGACY_DEMUCS_MIGRATION = (
    "Legacy Demucs .th assets are unsupported; recreate using current TuneForge "
    "(`pnpm models:demucs:prepare`)."
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class DemucsHfFile:
    label: str
    file_name: str
    size: int
    sha256: str


@dataclass(frozen=True)
class DemucsHfModel:
    id: str
    mode: str
    repo_id: str
    revision: str
    yaml_file: str
    bag_order: tuple[str, ...]
    files: tuple[DemucsHfFile, ...]


@dataclass(frozen=True)
class DemucsPreloadResult:
    model_id: str
    cache_hit: bool


@dataclass(frozen=True)
class InvalidDemucsHfCacheFile:
    model_id: str
    file_name: str
    reason: str
    path: Path | None


def default_demucs_model_manifest_path() -> Path:
    module_path = Path(__file__).resolve()
    packaged_path = module_path.parents[2] / "demucs-models.json"
    if packaged_path.is_file():
        return packaged_path
    return module_path.parents[4] / "packaging" / "demucs" / "models.json"


def read_demucs_hf_models(
    manifest_path: Path | None = None,
    *,
    model_ids: Sequence[str] = DEFAULT_DEMUCS_MODEL_IDS,
) -> tuple[DemucsHfModel, ...]:
    resolved_path = manifest_path or default_demucs_model_manifest_path()
    try:
        manifest = json.loads(resolved_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Demucs model manifest is unreadable: {resolved_path}") from exc
    if not isinstance(manifest, Mapping) or manifest.get("version") != DEMUCS_MANIFEST_VERSION:
        raise RuntimeError(f"Demucs model manifest must use version {DEMUCS_MANIFEST_VERSION}.")
    raw_models = manifest.get("models")
    if not isinstance(raw_models, list) or not raw_models:
        raise RuntimeError("Demucs model manifest must contain a non-empty models list.")

    models: list[DemucsHfModel] = []
    seen_ids: set[str] = set()
    for raw_model in raw_models:
        if not isinstance(raw_model, Mapping):
            raise RuntimeError("Demucs model manifest entries must be objects.")
        model = _parse_manifest_model(raw_model)
        if model.id in seen_ids:
            raise RuntimeError(f"Demucs model manifest has duplicate model id: {model.id}")
        seen_ids.add(model.id)
        models.append(model)

    models_by_id = {model.id: model for model in models}
    missing_ids = [model_id for model_id in model_ids if model_id not in models_by_id]
    if missing_ids:
        raise RuntimeError(f"Demucs model manifest is missing model(s): {', '.join(missing_ids)}")
    return tuple(models_by_id[model_id] for model_id in model_ids)


def invalid_demucs_hf_cache_files(
    *,
    model_ids: Sequence[str] = DEFAULT_DEMUCS_MODEL_IDS,
    manifest_path: Path | None = None,
    cache_dir: Path | None = None,
) -> tuple[InvalidDemucsHfCacheFile, ...]:
    return tuple(
        invalid_file
        for model in read_demucs_hf_models(manifest_path, model_ids=model_ids)
        for invalid_file in _invalid_hf_cache_files(model, cache_dir)
    )


def format_invalid_demucs_hf_cache_files(invalid_files: Sequence[InvalidDemucsHfCacheFile]) -> str:
    return "; ".join(
        f"{invalid_file.model_id} {invalid_file.file_name}: {invalid_file.reason}"
        for invalid_file in invalid_files
    )


def preload_demucs_hf_cache(
    *,
    model_ids: Sequence[str] = DEFAULT_DEMUCS_MODEL_IDS,
    manifest_path: Path | None = None,
    cache_dir: Path | None = None,
) -> tuple[DemucsPreloadResult, ...]:
    models = read_demucs_hf_models(manifest_path, model_ids=model_ids)
    results: list[DemucsPreloadResult] = []
    for model in models:
        invalid_before = _invalid_hf_cache_files(model, cache_dir)
        if not invalid_before:
            results.append(DemucsPreloadResult(model_id=model.id, cache_hit=True))
            continue
        _download_invalid_hf_files(model, invalid_before, cache_dir)
        invalid_after = _invalid_hf_cache_files(model, cache_dir)
        if invalid_after:
            raise RuntimeError(
                f"Demucs Hugging Face cache is missing or invalid after download for {model.id}: "
                f"{format_invalid_demucs_hf_cache_files(invalid_after)}"
            )
        results.append(DemucsPreloadResult(model_id=model.id, cache_hit=False))
    return tuple(results)


def resolved_demucs_hf_cache_files(
    model_id: str,
    *,
    manifest_path: Path | None = None,
    cache_dir: Path | None = None,
) -> tuple[ExpectedModelFile, ...]:
    model = read_demucs_hf_models(manifest_path, model_ids=(model_id,))[0]
    invalid = _invalid_hf_cache_files(model, cache_dir)
    if invalid:
        raise RuntimeError(
            f"Demucs Hugging Face cache is missing or invalid for {model.id}: "
            f"{format_invalid_demucs_hf_cache_files(invalid)}"
        )
    expected: list[ExpectedModelFile] = []
    for file in model.files:
        path = _cached_hf_path(model, file, cache_dir)
        if path is None:
            raise RuntimeError(f"Demucs Hugging Face cache resolution failed for {model.id}.")
        expected.append(ExpectedModelFile(f"Demucs {model.id} {file.label}", path, file.size, file.sha256))
    return tuple(expected)


def validate_demucs_model_repo(
    repo: Path,
    model_id: str,
    *,
    manifest_path: Path | None = None,
) -> tuple[Path, ...]:
    if not repo.is_dir():
        raise RuntimeError(f"Demucs model repository is missing: {repo}")
    if _contains_legacy_demucs_files(repo):
        raise RuntimeError(LEGACY_DEMUCS_MIGRATION)
    model = read_demucs_hf_models(manifest_path, model_ids=(model_id,))[0]
    model_root = repo / model.id / model.revision
    expected = tuple(
        ExpectedModelFile(
            label=f"Demucs {model.id} {file.label}",
            path=model_root / file.file_name,
            size=file.size,
            sha256=file.sha256,
        )
        for file in model.files
    )
    invalid = invalid_model_files(expected)
    if invalid:
        details = "; ".join(f"{item.path.name}: {item.reason}" for item in invalid)
        raise RuntimeError(f"Demucs {model.id} repository is missing or invalid: {details}")
    return tuple(item.path for item in expected)


def load_demucs_model(
    model_id: str,
    *,
    model_repo: Path | None = None,
    manifest_path: Path | None = None,
    cache_dir: Path | None = None,
) -> Any:
    model = read_demucs_hf_models(manifest_path, model_ids=(model_id,))[0]
    if model_repo is not None:
        paths = validate_demucs_model_repo(model_repo, model_id, manifest_path=manifest_path)
    else:
        invalid = _invalid_hf_cache_files(model, cache_dir)
        if invalid:
            _download_invalid_hf_files(model, invalid, cache_dir)
        invalid = _invalid_hf_cache_files(model, cache_dir)
        if invalid:
            raise RuntimeError(
                f"Demucs Hugging Face cache is missing or invalid for {model.id}: "
                f"{format_invalid_demucs_hf_cache_files(invalid)}"
            )
        resolved_paths = tuple(_cached_hf_path(model, file, cache_dir) for file in model.files)
        if any(path is None for path in resolved_paths):
            raise RuntimeError(f"Demucs Hugging Face cache resolution failed for {model.id}.")
        paths = tuple(path for path in resolved_paths if path is not None)

    paths_by_name = {path.name: path for path in paths}
    bag = _read_bag_definition(paths_by_name[model.yaml_file], model)
    from demucs.apply import BagOfModels
    from demucs.hf import load_safetensors_model

    loaded_models = [
        load_safetensors_model(paths_by_name[f"{signature}.safetensors"])
        for signature in model.bag_order
    ]
    loaded = BagOfModels(loaded_models, bag.get("weights"), bag.get("segment"))
    loaded.eval()
    return loaded


def _parse_manifest_model(raw_model: Mapping[str, Any]) -> DemucsHfModel:
    model_id = _safe_path_component(_required_string(raw_model, "id"), "model id")
    mode = _required_string(raw_model, "mode")
    repo_id = _required_string(raw_model, "repo_id")
    revision = _required_string(raw_model, "revision")
    yaml_file = _safe_file_name(_required_string(raw_model, "yaml_file"), model_id)
    if repo_id.count("/") != 1 or any(part in {"", ".", ".."} for part in repo_id.split("/")):
        raise RuntimeError(f"Demucs model manifest has invalid repo_id for {model_id}.")
    if not _REVISION_RE.fullmatch(revision):
        raise RuntimeError(f"Demucs model manifest has invalid revision for {model_id}.")

    raw_order = raw_model.get("bag_order")
    if not isinstance(raw_order, list) or not raw_order or not all(isinstance(item, str) for item in raw_order):
        raise RuntimeError(f"Demucs model manifest has invalid bag_order for {model_id}.")
    bag_order = tuple(raw_order)
    if len(set(bag_order)) != len(bag_order) or any(Path(item).name != item for item in bag_order):
        raise RuntimeError(f"Demucs model manifest has duplicate or invalid bag_order for {model_id}.")

    raw_files = raw_model.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise RuntimeError(f"Demucs model manifest has invalid files for {model_id}.")
    files: list[DemucsHfFile] = []
    seen_names: set[str] = set()
    for raw_file in raw_files:
        if not isinstance(raw_file, Mapping):
            raise RuntimeError(f"Demucs model manifest has invalid file entry for {model_id}.")
        label = _required_string(raw_file, "label")
        file_name = _safe_file_name(_required_string(raw_file, "file_name"), model_id)
        size = raw_file.get("size")
        sha256 = _required_string(raw_file, "sha256")
        if file_name in seen_names:
            raise RuntimeError(f"Demucs model manifest has duplicate file: {file_name}")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise RuntimeError(f"Demucs model manifest has invalid size for {file_name}.")
        if not _SHA256_RE.fullmatch(sha256):
            raise RuntimeError(f"Demucs model manifest has invalid sha256 for {file_name}.")
        seen_names.add(file_name)
        files.append(DemucsHfFile(label=label, file_name=file_name, size=size, sha256=sha256))

    expected_names = {yaml_file, *(f"{signature}.safetensors" for signature in bag_order)}
    if seen_names != expected_names or any(name.endswith(".th") for name in seen_names):
        raise RuntimeError(f"Demucs model manifest has an invalid file set for {model_id}.")
    return DemucsHfModel(
        id=model_id,
        mode=mode,
        repo_id=repo_id,
        revision=revision,
        yaml_file=yaml_file,
        bag_order=bag_order,
        files=tuple(files),
    )


def _invalid_hf_cache_files(
    model: DemucsHfModel,
    cache_dir: Path | None,
) -> tuple[InvalidDemucsHfCacheFile, ...]:
    invalid: list[InvalidDemucsHfCacheFile] = []
    for file in model.files:
        path = _cached_hf_path(model, file, cache_dir)
        if path is None:
            invalid.append(InvalidDemucsHfCacheFile(model.id, file.file_name, "missing", None))
            continue
        failures = invalid_model_files(
            (ExpectedModelFile(f"Demucs {model.id} {file.label}", path, file.size, file.sha256),)
        )
        if failures:
            invalid.append(InvalidDemucsHfCacheFile(model.id, file.file_name, failures[0].reason, path))
    return tuple(invalid)


def _cached_hf_path(model: DemucsHfModel, file: DemucsHfFile, cache_dir: Path | None) -> Path | None:
    try:
        if cache_dir is None:
            resolved = try_to_load_from_cache(model.repo_id, file.file_name, revision=model.revision)
        else:
            resolved = try_to_load_from_cache(
                model.repo_id,
                file.file_name,
                revision=model.revision,
                cache_dir=cache_dir,
            )
    except OSError:
        return None
    return Path(resolved) if isinstance(resolved, str) else None


def _download_invalid_hf_files(
    model: DemucsHfModel,
    invalid_files: Sequence[InvalidDemucsHfCacheFile],
    cache_dir: Path | None,
) -> None:
    for invalid in invalid_files:
        if cache_dir is None:
            hf_hub_download(
                model.repo_id,
                invalid.file_name,
                revision=model.revision,
                force_download=invalid.reason != "missing",
            )
        else:
            hf_hub_download(
                model.repo_id,
                invalid.file_name,
                revision=model.revision,
                cache_dir=cache_dir,
                force_download=invalid.reason != "missing",
            )


def _read_bag_definition(yaml_path: Path, model: DemucsHfModel) -> Mapping[str, Any]:
    try:
        raw = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise RuntimeError(f"Demucs bag definition is unreadable: {yaml_path}") from exc
    if not isinstance(raw, Mapping) or raw.get("models") != list(model.bag_order):
        raise RuntimeError(f"Demucs bag order does not match the pinned manifest for {model.id}.")
    return raw


def _contains_legacy_demucs_files(repo: Path) -> bool:
    try:
        return any(repo.rglob("*.th"))
    except OSError:
        return False


def _safe_file_name(value: str, model_id: str) -> str:
    if Path(value).name != value or "/" in value or "\\" in value:
        raise RuntimeError(f"Demucs model manifest has invalid file name for {model_id}.")
    return value


def _safe_path_component(value: str, label: str) -> str:
    if value in {".", ".."} or Path(value).name != value or "/" in value or "\\" in value:
        raise RuntimeError(f"Demucs model manifest has invalid {label}: {value}")
    return value


def _required_string(entry: Mapping[str, Any], key: str) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"Demucs model manifest entry has invalid {key}.")
    return value
