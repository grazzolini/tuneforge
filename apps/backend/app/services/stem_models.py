from __future__ import annotations

import importlib.util
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings
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
        return StemModelAvailability(False, "Bundled Demucs model manifest is missing"), ()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return StemModelAvailability(False, "Bundled Demucs model manifest is unreadable"), ()

    models = manifest.get("models")
    model_entry = models.get(model_id) if isinstance(models, dict) else None
    if not isinstance(model_entry, dict):
        return StemModelAvailability(False, f"Bundled {model_id} manifest entry is missing"), ()

    manifest_mode = model_entry.get("mode")
    if manifest_mode != STEM_MODELS[model_id].mode:
        return StemModelAvailability(False, f"Bundled {model_id} manifest mode is invalid"), ()

    yaml_file = model_entry.get("yaml")
    if not isinstance(yaml_file, str) or Path(yaml_file).name != yaml_file:
        return StemModelAvailability(False, f"Bundled {model_id} manifest yaml is invalid"), ()

    files = model_entry.get("files")
    if not isinstance(files, list):
        return StemModelAvailability(False, f"Bundled {model_id} manifest files are invalid"), ()

    parsed_files: list[StemModelManifestFile] = []
    for file_entry in files:
        if not isinstance(file_entry, dict):
            return StemModelAvailability(False, f"Bundled {model_id} manifest files are invalid"), ()
        name = file_entry.get("name")
        size_bytes = file_entry.get("size_bytes")
        sha256 = file_entry.get("sha256")
        if not isinstance(name, str) or not isinstance(size_bytes, int) or not isinstance(sha256, str):
            return StemModelAvailability(False, f"Bundled {model_id} manifest files are invalid"), ()
        if Path(name).name != name:
            return StemModelAvailability(False, f"Bundled {model_id} manifest files are invalid"), ()
        parsed_files.append(StemModelManifestFile(name=name, size_bytes=size_bytes, sha256=sha256))

    manifest_names = {file.name for file in parsed_files}
    if yaml_file not in manifest_names:
        return StemModelAvailability(False, f"Bundled {model_id} manifest yaml is missing from files"), ()

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
        raise AppError(
            "STEM_MODEL_UNAVAILABLE",
            availability.unavailable_reason or f"{model.label} is unavailable.",
            status_code=409,
            details={"stem_model": model_id},
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
            return StemModelAvailability(False, "Demucs is not installed")
        return StemModelAvailability(True)
    if not repo.is_dir():
        return StemModelAvailability(False, f"Bundled Demucs model repo is missing: {repo}")

    manifest_availability, manifest_files = _load_manifest_model_files(repo, model_id)
    if not manifest_availability.available:
        return manifest_availability

    missing_files = [file.name for file in manifest_files if not (repo / file.name).is_file()]
    if missing_files:
        return StemModelAvailability(
            False,
            f"Bundled {model_id} files are missing: {', '.join(missing_files)}",
        )
    wrong_size_files = [
        file.name for file in manifest_files if (repo / file.name).stat().st_size != file.size_bytes
    ]
    if wrong_size_files:
        return StemModelAvailability(
            False,
            f"Bundled {model_id} files have unexpected sizes: {', '.join(wrong_size_files)}",
        )
    wrong_hash_files = [
        file.name for file in manifest_files if file_sha256(repo / file.name) != file.sha256
    ]
    if wrong_hash_files:
        return StemModelAvailability(
            False,
            f"Bundled {model_id} files have unexpected hashes: {', '.join(wrong_hash_files)}",
        )
    if importlib.util.find_spec("demucs") is None:
        return StemModelAvailability(False, "Demucs is not installed")
    return StemModelAvailability(True)


def model_output_artifact_type(source: str) -> str:
    try:
        return STEM_SOURCE_ARTIFACT_TYPES[source]
    except KeyError as exc:
        raise AppError("UNSUPPORTED_STEM_SOURCE", f"Unsupported stem source: {source}.", status_code=422) from exc


def stem_source_for_artifact_type(artifact_type: str) -> str | None:
    return STEM_ARTIFACT_TYPE_SOURCES.get(artifact_type)


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
