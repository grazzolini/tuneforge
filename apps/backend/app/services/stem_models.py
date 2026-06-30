from __future__ import annotations

import importlib.util
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.dependency_diagnostics import (
    DEMUCS_CACHE_REMEDIATION,
    DEMUCS_DEPENDENCY_REMEDIATION,
    dependency_diagnostic_error,
)
from app.errors import AppError
from app.utils.hashing import file_sha256

DEFAULT_STEM_MODEL_ID = "htdemucs_6s"
TWO_STEMS_MODEL_ID = "htdemucs_ft"

SIX_STEM_SOURCES = ("vocals", "drums", "bass", "guitar", "piano", "other")
TWO_STEM_SOURCES = ("vocals", "instrumental")
NON_VOCAL_SIX_STEM_SOURCES = ("drums", "bass", "guitar", "piano", "other")

STEM_SOURCE_ARTIFACT_TYPES = {
    "vocals": "vocal_stem",
    "instrumental": "instrumental_stem",
    "drums": "drums_stem",
    "bass": "bass_stem",
    "guitar": "guitar_stem",
    "piano": "piano_stem",
    "other": "other_stem",
}
STEM_ARTIFACT_TYPES = frozenset(STEM_SOURCE_ARTIFACT_TYPES.values())
STEM_ARTIFACT_TYPE_SOURCES = {artifact_type: source for source, artifact_type in STEM_SOURCE_ARTIFACT_TYPES.items()}


@dataclass(frozen=True)
class StemModelDefinition:
    id: str
    label: str
    description: str
    sources: tuple[str, ...]
    mode: str


@dataclass(frozen=True)
class StemModelAvailability:
    available: bool
    unavailable_reason: str | None = None
    remediation: str | None = None
    cache_status: str | None = None


@dataclass(frozen=True)
class StemModelManifestFile:
    name: str
    size_bytes: int
    sha256: str


STEM_MODELS: dict[str, StemModelDefinition] = {
    DEFAULT_STEM_MODEL_ID: StemModelDefinition(
        id=DEFAULT_STEM_MODEL_ID,
        label="Default (6 stems model)",
        description="Demucs six-source model that separates vocals, drums, bass, guitar, piano, and other.",
        sources=SIX_STEM_SOURCES,
        mode="six_stems",
    ),
    TWO_STEMS_MODEL_ID: StemModelDefinition(
        id=TWO_STEMS_MODEL_ID,
        label="2 stems model",
        description="Demucs fine-tuned model rendered as vocals plus a single instrumental mix.",
        sources=TWO_STEM_SOURCES,
        mode="two_stems",
    ),
}

_ALIASES = {
    "default": "default",
    "6_stems": DEFAULT_STEM_MODEL_ID,
    "six_stems": DEFAULT_STEM_MODEL_ID,
    DEFAULT_STEM_MODEL_ID: DEFAULT_STEM_MODEL_ID,
    "2_stems": TWO_STEMS_MODEL_ID,
    "two_stems": TWO_STEMS_MODEL_ID,
    "two_stem": TWO_STEMS_MODEL_ID,
    TWO_STEMS_MODEL_ID: TWO_STEMS_MODEL_ID,
}

def _load_manifest_model_files(
    repo: Path,
    model_id: str,
) -> tuple[StemModelAvailability, tuple[StemModelManifestFile, ...]]:
    manifest_path = repo / "manifest.json"
    if not manifest_path.is_file():
        return _demucs_cache_unavailable(
            "Bundled Demucs model manifest is missing, so TuneForge cannot separate stems.",
            cache_status="missing",
        ), ()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _demucs_cache_unavailable(
            "Bundled Demucs model manifest is unreadable, so TuneForge cannot separate stems.",
            cache_status="unreadable",
        ), ()

    models = manifest.get("models")
    model_entry = models.get(model_id) if isinstance(models, dict) else None
    if not isinstance(model_entry, dict):
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache is missing manifest data.",
            cache_status="missing",
        ), ()

    manifest_mode = model_entry.get("mode")
    if manifest_mode != STEM_MODELS[model_id].mode:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache metadata is corrupt.",
            cache_status="corrupt",
        ), ()

    yaml_file = model_entry.get("yaml")
    if not isinstance(yaml_file, str) or Path(yaml_file).name != yaml_file:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache metadata is corrupt.",
            cache_status="corrupt",
        ), ()

    files = model_entry.get("files")
    if not isinstance(files, list):
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache metadata is corrupt.",
            cache_status="corrupt",
        ), ()

    parsed_files: list[StemModelManifestFile] = []
    for file_entry in files:
        if not isinstance(file_entry, dict):
            return _demucs_cache_unavailable(
                f"Bundled {model_id} model cache metadata is corrupt.",
                cache_status="corrupt",
            ), ()
        name = file_entry.get("name")
        size_bytes = file_entry.get("size_bytes")
        sha256 = file_entry.get("sha256")
        if not isinstance(name, str) or not isinstance(size_bytes, int) or not isinstance(sha256, str):
            return _demucs_cache_unavailable(
                f"Bundled {model_id} model cache metadata is corrupt.",
                cache_status="corrupt",
            ), ()
        if Path(name).name != name:
            return _demucs_cache_unavailable(
                f"Bundled {model_id} model cache metadata is corrupt.",
                cache_status="corrupt",
            ), ()
        parsed_files.append(StemModelManifestFile(name=name, size_bytes=size_bytes, sha256=sha256))

    manifest_names = {file.name for file in parsed_files}
    if yaml_file not in manifest_names:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache metadata is corrupt.",
            cache_status="corrupt",
        ), ()

    return StemModelAvailability(True), tuple(parsed_files)


def configured_stem_model_repo() -> Path | None:
    return get_settings().demucs_model_repo


def list_stem_model_infos() -> list[dict[str, Any]]:
    return [_model_info(model) for model in STEM_MODELS.values()]


def resolve_stem_model(
    requested_model: str | None,
    *,
    require_available: bool = False,
) -> StemModelDefinition:
    model_id = resolve_stem_model_id(requested_model)
    model = STEM_MODELS[model_id]
    availability = stem_model_availability(model_id)
    if require_available and not availability.available:
        raise dependency_diagnostic_error(
            "STEM_MODEL_UNAVAILABLE",
            availability.unavailable_reason or f"{model.label} is unavailable.",
            dependency="demucs",
            operation="stem_separation",
            remediation=availability.remediation or DEMUCS_DEPENDENCY_REMEDIATION,
            status_code=409,
            cache_status=availability.cache_status,
        )
    return model


def resolve_stem_model_id(requested_model: str | None) -> str:
    requested = (requested_model or "default").strip()
    alias = _ALIASES.get(requested)
    if alias is None:
        raise AppError(
            "UNSUPPORTED_STEM_MODEL",
            f"Unsupported stem model: {requested}.",
            status_code=422,
            details={"supported_models": sorted(STEM_MODELS)},
        )
    if alias != "default":
        return alias

    configured = _ALIASES.get(get_settings().stem_model, DEFAULT_STEM_MODEL_ID)
    if configured == "default":
        configured = DEFAULT_STEM_MODEL_ID
    return configured if configured in STEM_MODELS else DEFAULT_STEM_MODEL_ID


def stem_model_availability(model_id: str) -> StemModelAvailability:
    if get_settings().runtime_platform in {"android", "ios", "mobile"}:
        return StemModelAvailability(False, "stem separation is disabled on mobile")

    repo = configured_stem_model_repo()
    if repo is None:
        if importlib.util.find_spec("demucs") is None:
            return StemModelAvailability(
                False,
                "Demucs is unavailable, so TuneForge cannot separate stems.",
                DEMUCS_DEPENDENCY_REMEDIATION,
            )
        return StemModelAvailability(True)
    if not repo.is_dir():
        return _demucs_cache_unavailable(
            "Bundled Demucs model assets are missing, so TuneForge cannot separate stems.",
            cache_status="missing",
        )

    manifest_availability, manifest_files = _load_manifest_model_files(repo, model_id)
    if not manifest_availability.available:
        return manifest_availability

    missing_files: list[str] = []
    unreadable_files: list[str] = []
    for file in manifest_files:
        try:
            is_file = (repo / file.name).is_file()
        except OSError:
            unreadable_files.append(file.name)
            continue
        if not is_file:
            missing_files.append(file.name)
    if unreadable_files:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache is unreadable.",
            cache_status="unreadable",
        )
    if missing_files:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache is missing required files.",
            cache_status="missing",
        )

    wrong_size_files: list[str] = []
    for file in manifest_files:
        try:
            actual_size = (repo / file.name).stat().st_size
        except OSError:
            unreadable_files.append(file.name)
            continue
        if actual_size != file.size_bytes:
            wrong_size_files.append(file.name)
    if unreadable_files:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache is unreadable.",
            cache_status="unreadable",
        )
    if wrong_size_files:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache is corrupt.",
            cache_status="corrupt",
        )

    wrong_hash_files: list[str] = []
    for file in manifest_files:
        actual_sha256 = file_sha256(repo / file.name)
        if actual_sha256 is None:
            unreadable_files.append(file.name)
            continue
        if actual_sha256 != file.sha256:
            wrong_hash_files.append(file.name)
    if unreadable_files:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache is unreadable.",
            cache_status="unreadable",
        )
    if wrong_hash_files:
        return _demucs_cache_unavailable(
            f"Bundled {model_id} model cache is corrupt.",
            cache_status="corrupt",
        )
    if importlib.util.find_spec("demucs") is None:
        return StemModelAvailability(
            False,
            "Demucs is unavailable, so TuneForge cannot separate stems.",
            DEMUCS_DEPENDENCY_REMEDIATION,
        )
    return StemModelAvailability(True)


def model_output_artifact_type(source: str) -> str:
    try:
        return STEM_SOURCE_ARTIFACT_TYPES[source]
    except KeyError as exc:
        raise AppError("UNSUPPORTED_STEM_SOURCE", f"Unsupported stem source: {source}.", status_code=422) from exc


def stem_source_for_artifact_type(artifact_type: str) -> str | None:
    return STEM_ARTIFACT_TYPE_SOURCES.get(artifact_type)


def _demucs_cache_unavailable(message: str, *, cache_status: str) -> StemModelAvailability:
    if cache_status == "unreadable":
        remediation = (
            "Fix local cache permissions or re-run setup from an account that can read the model cache."
        )
    elif cache_status == "corrupt":
        remediation = "Re-run local setup to replace Demucs model assets, then retry stem separation."
    else:
        remediation = DEMUCS_CACHE_REMEDIATION
    return StemModelAvailability(False, message, remediation, cache_status)


def _model_info(model: StemModelDefinition) -> dict[str, Any]:
    availability = stem_model_availability(model.id)
    payload = {
        **asdict(model),
        "default": model.id == resolve_stem_model_id(None),
        "source_count": len(model.sources),
        "availability": "available" if availability.available else "unavailable",
        "available": availability.available,
        "unavailable_reason": availability.unavailable_reason,
    }
    payload["sourceCount"] = payload["source_count"]
    return payload
