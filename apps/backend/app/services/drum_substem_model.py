from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.request import urlopen

from huggingface_hub import hf_hub_download, try_to_load_from_cache

from app.config import get_settings
from app.engines.drumsep_identity import CONVERTER_VERSION, RAW_SHA256, RAW_SIZE_BYTES
from app.errors import JobCancelledError
from app.services.stem_models import configured_stem_model_repo
from app.utils.hashing import file_sha256

DRUMSEP_MODEL_ID = "drumsep"
DRUMSEP_CHECKPOINT_CLASS = "demucs.hdemucs.HDemucs"
GOOGLE_URL = (
    "https://drive.usercontent.google.com/download"
    "?id=1-Dm666ScPkg8Gt2-lK3Ua0xOudWHZBGC&export=download&confirm=t"
)
GOOGLE_REVISION = "google-49469ca8-v1"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REVISION = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class DrumSepCheckpoint:
    repo_id: str
    revision: str
    file_name: str
    sha256: str
    size_bytes: int
    license: str | None
    rights_record: str | None
    source_kind: str = "huggingface"
    upstream_sha256: str | None = None


def _manifest_path() -> Path:
    module_path = Path(__file__).resolve()
    packaged = module_path.parents[2] / "drumsep-model.json"
    if packaged.is_file():
        return packaged
    return module_path.parents[4] / "packaging" / "demucs" / "drumsep-model.json"


def read_drumsep_checkpoint() -> DrumSepCheckpoint | None:
    """Only a reviewed, shipped descriptor may enable acquisition or inference."""
    path = _manifest_path()
    if not path.is_file():
        return None
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("DrumSep checkpoint descriptor is unreadable.") from exc
    if not isinstance(raw, dict) or set(raw) != {
        "id", "class", "repo_id", "revision", "file_name", "sha256", "size_bytes", "license", "rights_record"
    }:
        raise RuntimeError("DrumSep checkpoint descriptor has unsupported fields.")
    if raw["id"] != DRUMSEP_MODEL_ID or raw["class"] != DRUMSEP_CHECKPOINT_CLASS:
        raise RuntimeError("DrumSep checkpoint identity is unsupported.")
    repo_id = raw["repo_id"]
    revision = raw["revision"]
    file_name = raw["file_name"]
    sha256 = raw["sha256"]
    size_bytes = raw["size_bytes"]
    license_name = raw["license"]
    rights_record = raw["rights_record"]
    if (
        not isinstance(repo_id, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", repo_id) is None
        or not isinstance(revision, str) or not _REVISION.fullmatch(revision)
        or not isinstance(file_name, str) or Path(file_name).name != file_name
        or file_name != "drumsep.safetensors"
        or not isinstance(sha256, str) or not _SHA256.fullmatch(sha256)
        or not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0
        or license_name != "MIT"
        or not isinstance(rights_record, str) or not rights_record.startswith("https://")
    ):
        raise RuntimeError("DrumSep checkpoint provenance or rights are invalid.")
    return DrumSepCheckpoint(repo_id, revision, file_name, sha256, size_bytes, license_name, rights_record)


def _cached_path(checkpoint: DrumSepCheckpoint) -> Path | None:
    repo = configured_stem_model_repo()
    if repo is not None:
        return repo / DRUMSEP_MODEL_ID / checkpoint.revision / checkpoint.file_name
    try:
        resolved = try_to_load_from_cache(
            checkpoint.repo_id, checkpoint.file_name, revision=checkpoint.revision
        )
    except OSError:
        return None
    return Path(resolved) if isinstance(resolved, str) else None


def _verified(path: Path | None, checkpoint: DrumSepCheckpoint) -> bool:
    if path is None:
        return False
    try:
        return (
            path.is_file()
            and path.stat().st_size == checkpoint.size_bytes
            and file_sha256(path) == checkpoint.sha256
        )
    except OSError:
        return False


def _google_cache_dir() -> Path:
    return get_settings().cache_root / "models" / DRUMSEP_MODEL_ID / GOOGLE_REVISION


def _google_raw_path() -> Path:
    return _google_cache_dir() / "49469ca8.th"


def _google_converted_path() -> Path:
    return _google_cache_dir() / "drumsep.safetensors"


def _google_converted_info() -> tuple[str, int] | None:
    path = _google_converted_path()
    manifest = path.with_suffix(".json")
    try:
        raw: Any = json.loads(manifest.read_text(encoding="utf-8"))
        if (
            not isinstance(raw, dict)
            or set(raw) != {"converter_version", "upstream_sha256", "converted_sha256", "converted_size_bytes"}
            or raw["converter_version"] != CONVERTER_VERSION
            or raw["upstream_sha256"] != RAW_SHA256
            or not isinstance(raw["converted_sha256"], str)
            or not _SHA256.fullmatch(raw["converted_sha256"])
            or not isinstance(raw["converted_size_bytes"], int)
            or isinstance(raw["converted_size_bytes"], bool)
            or raw["converted_size_bytes"] <= 0
            or path.stat().st_size != raw["converted_size_bytes"]
            or file_sha256(path) != raw["converted_sha256"]
        ):
            return None
        return raw["converted_sha256"], raw["converted_size_bytes"]
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _google_checkpoint(sha256: str, size_bytes: int) -> DrumSepCheckpoint:
    return DrumSepCheckpoint(
        repo_id="author-hosted-google-drive", revision=GOOGLE_REVISION,
        file_name="drumsep.safetensors", sha256=sha256, size_bytes=size_bytes,
        license=None, rights_record=None, source_kind="google-author-hosted",
        upstream_sha256=RAW_SHA256,
    )


def _download_google_raw(target: Path, *, should_cancel: Callable[[], bool] | None) -> None:
    import hashlib

    digest = hashlib.sha256()
    size = 0
    with urlopen(GOOGLE_URL, timeout=30) as response, target.open("wb") as output:
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if content_type != "application/octet-stream":
            raise RuntimeError("DrumSep download returned an unexpected content type.")
        while True:
            if should_cancel and should_cancel():
                raise JobCancelledError()
            block = response.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > RAW_SIZE_BYTES:
                raise RuntimeError("DrumSep download exceeds pinned byte size.")
            digest.update(block)
            output.write(block)
    if size != RAW_SIZE_BYTES or digest.hexdigest() != RAW_SHA256:
        raise RuntimeError("DrumSep download failed pinned size or full SHA-256 verification.")


def _convert_google_raw(
    source: Path, target: Path, *, should_cancel: Callable[[], bool] | None,
    register_process: Callable[[subprocess.Popen[str]], None] | None,
    unregister_process: Callable[[], None] | None,
) -> None:
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.engines.drumsep_conversion", "--input", str(source), "--output", str(target)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True,
        )
        if register_process:
            register_process(process)
        while process.poll() is None:
            if should_cancel and should_cancel():
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
                raise JobCancelledError()
            time.sleep(0.2)
        if should_cancel and should_cancel():
            raise JobCancelledError()
        if process.returncode != 0 or not target.is_file():
            raise RuntimeError("Restricted DrumSep checkpoint conversion failed.")
    finally:
        if unregister_process and process is not None:
            unregister_process()


def _resolve_google_checkpoint(
    *, allow_download: bool, should_cancel: Callable[[], bool] | None,
    register_process: Callable[[subprocess.Popen[str]], None] | None,
    unregister_process: Callable[[], None] | None,
) -> tuple[DrumSepCheckpoint, Path]:
    converted_info = _google_converted_info()
    if converted_info is not None:
        return _google_checkpoint(*converted_info), _google_converted_path()
    cache_dir = _google_cache_dir()
    raw_path = _google_raw_path()
    raw_verified = (
        raw_path.is_file() and raw_path.stat().st_size == RAW_SIZE_BYTES
        and file_sha256(raw_path) == RAW_SHA256
    )
    if not raw_verified and not allow_download:
        raise RuntimeError("Verified DrumSep checkpoint is missing; authorize download to refine drums.")
    cache_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".drumsep-", dir=cache_dir) as staged_name:
        staged = Path(staged_name)
        if not raw_verified:
            staged_raw = staged / "49469ca8.th"
            _download_google_raw(staged_raw, should_cancel=should_cancel)
            if should_cancel and should_cancel():
                raise JobCancelledError()
            os.replace(staged_raw, raw_path)
        staged_converted = staged / "drumsep.safetensors"
        _convert_google_raw(
            raw_path, staged_converted, should_cancel=should_cancel,
            register_process=register_process, unregister_process=unregister_process,
        )
        if should_cancel and should_cancel():
            raise JobCancelledError()
        converted_sha = file_sha256(staged_converted)
        converted_size = staged_converted.stat().st_size
        if converted_size <= 0 or converted_sha is None:
            raise RuntimeError("Converted DrumSep checkpoint is unreadable or empty.")
        staged_manifest = staged / "drumsep.json"
        staged_manifest.write_text(json.dumps({
            "converter_version": CONVERTER_VERSION, "upstream_sha256": RAW_SHA256,
            "converted_sha256": converted_sha, "converted_size_bytes": converted_size,
        }), encoding="utf-8")
        if should_cancel and should_cancel():
            raise JobCancelledError()
        os.replace(staged_converted, _google_converted_path())
        os.replace(staged_manifest, _google_converted_path().with_suffix(".json"))
    return _google_checkpoint(converted_sha, converted_size), _google_converted_path()


def drumsep_capabilities() -> dict[str, object]:
    platform_supported = get_settings().runtime_platform not in {"android", "ios", "mobile"} and sys.platform in {
        "darwin", "linux"
    }
    try:
        checkpoint = read_drumsep_checkpoint()
    except RuntimeError:
        checkpoint = None
        descriptor_invalid = True
    else:
        descriptor_invalid = False
    cached = _verified(_cached_path(checkpoint), checkpoint) if checkpoint else _google_converted_info() is not None
    if not platform_supported:
        reason = "Drum refinement is available on native macOS and Linux only."
    elif descriptor_invalid:
        reason = "DrumSep checkpoint provenance or rights are invalid."
    else:
        reason = None
    return {
        "platform_supported": platform_supported,
        "available": platform_supported and not descriptor_invalid,
        "unavailable_reason": reason,
        "model_id": DRUMSEP_MODEL_ID,
        "checkpoint_sha256": checkpoint.sha256 if checkpoint else RAW_SHA256,
        "checkpoint_revision": checkpoint.revision if checkpoint else GOOGLE_REVISION,
        "cache_status": "verified" if cached else "missing",
        "download_size_bytes": checkpoint.size_bytes if checkpoint else RAW_SIZE_BYTES,
    }


def resolve_drumsep_checkpoint(
    *, allow_download: bool, should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> tuple[DrumSepCheckpoint, Path]:
    if not drumsep_capabilities()["platform_supported"]:
        raise RuntimeError("Drum refinement is available on native macOS and Linux only.")
    checkpoint = read_drumsep_checkpoint()
    if checkpoint is None:
        return _resolve_google_checkpoint(
            allow_download=allow_download, should_cancel=should_cancel,
            register_process=register_process, unregister_process=unregister_process,
        )
    path = _cached_path(checkpoint)
    if not _verified(path, checkpoint):
        if not allow_download:
            raise RuntimeError("Verified DrumSep checkpoint is missing; authorize download to refine drums.")
        if configured_stem_model_repo() is not None:
            raise RuntimeError("Configured local DrumSep model repository is missing a verified checkpoint.")
        downloaded = hf_hub_download(
            checkpoint.repo_id, checkpoint.file_name, revision=checkpoint.revision,
            force_download=path is not None,
        )
        path = Path(downloaded)
    if not _verified(path, checkpoint):
        raise RuntimeError("Downloaded DrumSep checkpoint failed full SHA-256 verification.")
    assert path is not None
    return checkpoint, path
