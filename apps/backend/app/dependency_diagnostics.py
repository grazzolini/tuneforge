from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from fastapi import status

from app.errors import AppError
from app.utils.model_cache import InvalidModelFile

HOST_FFMPEG_REMEDIATION = (
    "Install FFmpeg locally and make sure this host-installed tool is available on PATH."
)
DEMUCS_DEPENDENCY_REMEDIATION = (
    "Install the local backend stem dependencies, then retry stem separation."
)
DEMUCS_CACHE_REMEDIATION = (
    "Re-run local setup to download Demucs model assets, then retry stem separation."
)
WHISPER_DEPENDENCY_REMEDIATION = (
    "Install the local backend lyrics dependencies, then retry lyrics generation."
)
WHISPER_CACHE_REMEDIATION = (
    "Re-run local setup to download the Whisper model asset, then retry lyrics generation."
)
SAFE_DIAGNOSTIC_DETAIL_KEYS = frozenset({"dependency", "operation", "remediation", "cache_status"})
OPERATION_LABELS = {
    "audio_import_normalization": "audio import normalization",
    "audio_transform": "audio transform",
    "lyrics_transcription": "lyrics generation",
    "metadata_extraction": "metadata extraction",
    "stem_separation": "stem separation",
}
IMPORT_FAILURE_MARKERS = (
    "modulenotfounderror",
    "importerror",
    "no module named",
    "cannot import name",
    "dlopen",
    "shared object file",
    "symbol not found",
)


def dependency_diagnostic_error(
    code: str,
    message: str,
    *,
    dependency: str,
    operation: str,
    remediation: str,
    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR,
    cache_status: str | None = None,
) -> AppError:
    details = {
        "dependency": dependency,
        "operation": operation_label(operation),
        "remediation": remediation,
    }
    if cache_status is not None:
        details["cache_status"] = cache_status
    return AppError(code, message, status_code=status_code, details=details)


def missing_host_tool_error(*, tool: str, operation: str, impact: str) -> AppError:
    return dependency_diagnostic_error(
        "DEPENDENCY_MISSING",
        f"{tool} is missing, so TuneForge cannot {impact}.",
        dependency=tool,
        operation=operation,
        remediation=HOST_FFMPEG_REMEDIATION,
    )


def demucs_dependency_missing_error(*, dependency: str = "demucs") -> AppError:
    return dependency_diagnostic_error(
        "DEPENDENCY_MISSING",
        "Demucs is unavailable, so TuneForge cannot separate stems.",
        dependency=dependency,
        operation="stem_separation",
        remediation=DEMUCS_DEPENDENCY_REMEDIATION,
    )


def demucs_failure_error(*, cache_status: str | None = None) -> AppError:
    if cache_status == "missing":
        message = "Demucs model cache is missing, so TuneForge cannot separate stems."
        remediation = DEMUCS_CACHE_REMEDIATION
    elif cache_status == "corrupt":
        message = "Demucs model cache is corrupt, so TuneForge cannot separate stems."
        remediation = (
            "Re-run local setup to replace Demucs model assets, then retry stem separation."
        )
    elif cache_status == "unreadable":
        message = "Demucs model cache is unreadable, so TuneForge cannot separate stems."
        remediation = (
            "Fix local cache permissions or re-run setup from an account that can read the model cache."
        )
    elif cache_status == "download_failed":
        message = "Demucs model download failed, so TuneForge cannot separate stems."
        remediation = "Check local network access for first-run model download, then retry setup."
    else:
        message = "Demucs is unavailable, so TuneForge cannot separate stems."
        remediation = (
            "Verify local Demucs setup and model assets, then retry stem separation."
        )
    return dependency_diagnostic_error(
        "PROCESSING_FAILED",
        message,
        dependency="demucs",
        operation="stem_separation",
        remediation=remediation,
        cache_status=cache_status,
    )


def whisper_dependency_missing_error(*, dependency: str = "openai-whisper") -> AppError:
    return dependency_diagnostic_error(
        "DEPENDENCY_MISSING",
        "Whisper is unavailable, so TuneForge cannot generate lyrics.",
        dependency=dependency,
        operation="lyrics_transcription",
        remediation=WHISPER_DEPENDENCY_REMEDIATION,
    )


def whisper_failure_error(*, cache_status: str | None = None) -> AppError:
    if cache_status == "missing":
        message = "Whisper model cache is missing, so TuneForge cannot generate lyrics."
        remediation = WHISPER_CACHE_REMEDIATION
    elif cache_status == "corrupt":
        message = "Whisper model cache is corrupt, so TuneForge cannot generate lyrics."
        remediation = (
            "Re-run local setup to replace the Whisper model asset, then retry lyrics generation."
        )
    elif cache_status == "unreadable":
        message = "Whisper model cache is unreadable, so TuneForge cannot generate lyrics."
        remediation = (
            "Fix local cache permissions or re-run setup from an account that can read the model cache."
        )
    elif cache_status == "download_failed":
        message = "Whisper model download failed, so TuneForge cannot generate lyrics."
        remediation = "Check local network access for first-run model download, then retry setup."
    elif cache_status == "unsupported":
        message = "Whisper model is unsupported, so TuneForge cannot generate lyrics."
        remediation = "Choose a supported local Whisper model, then retry lyrics generation."
    else:
        message = "Whisper is unavailable, so TuneForge cannot generate lyrics."
        remediation = (
            "Verify local Whisper runtime and model cache setup, then retry lyrics generation."
        )
    return dependency_diagnostic_error(
        "PROCESSING_FAILED",
        message,
        dependency="whisper",
        operation="lyrics_transcription",
        remediation=remediation,
        cache_status=cache_status,
    )


def cache_status_from_invalid_files(invalid_files: Sequence[InvalidModelFile]) -> str | None:
    if not invalid_files:
        return None
    reasons = {invalid_file.reason for invalid_file in invalid_files}
    if any("permission" in reason or reason == "unreadable" for reason in reasons):
        return "unreadable"
    if any(
        reason in {"sha256", "size", "metadata-sha256"}
        or "hash" in reason
        or "corrupt" in reason
        for reason in reasons
    ):
        return "corrupt"
    if "unsupported-model" in reasons:
        return "unsupported"
    if "missing" in reasons:
        return "missing"
    return "unreadable"


def operation_label(operation: str) -> str:
    normalized = operation.strip()
    if not normalized:
        return operation
    return OPERATION_LABELS.get(normalized, normalized.replace("_", " "))


def safe_dependency_remediation(details: Mapping[str, object]) -> str | None:
    if not set(details).issubset(SAFE_DIAGNOSTIC_DETAIL_KEYS):
        return None
    remediation = details.get("remediation")
    if not isinstance(remediation, str):
        return None
    normalized = remediation.strip()
    if (
        not normalized
        or any(character in normalized for character in "\r\n\t\\/")
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        return None
    return normalized


def _normalized_failure_text(text_parts: Iterable[object]) -> str:
    return " ".join(str(part).lower() for part in text_parts if part is not None)


def has_dependency_import_failure_text(text_parts: Iterable[object]) -> bool:
    text = _normalized_failure_text(text_parts)
    return any(marker in text for marker in IMPORT_FAILURE_MARKERS)


def dependency_from_import_failure_text(
    text_parts: Iterable[object],
    module_dependencies: Mapping[str, str],
) -> str | None:
    text = _normalized_failure_text(text_parts)
    if not any(marker in text for marker in IMPORT_FAILURE_MARKERS):
        return None
    for module_name, dependency in module_dependencies.items():
        module = module_name.lower()
        if any(
            marker in text
            for marker in (
                f"no module named '{module}'",
                f'no module named "{module}"',
                f"import {module}",
                f"from {module}",
                f"{module}.",
            )
        ):
            return dependency
    return None


def cache_status_from_failure_text(text_parts: Iterable[object]) -> str | None:
    text = _normalized_failure_text(text_parts)
    if not text:
        return None
    if any(marker in text for marker in IMPORT_FAILURE_MARKERS):
        return None
    if any(
        marker in text
        for marker in (
            "http error",
            "urlerror",
            "ssl",
            "timed out",
            "connection",
            "download",
            "temporary failure",
            "network is unreachable",
        )
    ):
        return "download_failed"
    if "permission denied" in text or "permissionerror" in text:
        return "unreadable"
    if any(
        marker in text
        for marker in (
            "checksum",
            "sha256",
            "hash mismatch",
            "corrupt",
            "unexpected size",
            "eof",
            "invalid load key",
            "unpicklingerror",
            "failed finding central directory",
            "not a zip archive",
        )
    ):
        return "corrupt"
    if any(
        marker in text
        for marker in (
            "no such file",
            "not found",
            "missing",
        )
    ):
        return "missing"
    return None
