from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal, cast

JobRuntimeStage = Literal[
    "queued",
    "preparing",
    "loading_model",
    "processing",
    "fallback",
    "writing",
    "finalizing",
]

JOB_RUNTIME_STAGES: frozenset[str] = frozenset(
    {
        "queued",
        "preparing",
        "loading_model",
        "processing",
        "fallback",
        "writing",
        "finalizing",
    }
)
JOB_RUNTIME_EVENT_TYPE = "tuneforge.job_runtime.v1"
_RUNTIME_LABEL_LIMIT = 160
_RUNTIME_DETAIL_LIMIT = 240
_RUNTIME_DEVICE_LIMIT = 16
_PATH_MARKERS = ("/", "\\")
_CONTROL_CHAR_PATTERN = re.compile(r"[\x00-\x1f\x7f]")
_FILENAME_TOKEN_PATTERN = re.compile(r"(?i)(?:^|\s)[^\s/\\]+\.[a-z0-9]{1,8}(?=$|\s|[,;:!?])")
_AUDIO_EXTENSION_PATTERN = re.compile(
    r"(?i)(?:^|\s)[^\s/\\]+\."
    r"(?:aac|aif|aiff|caf|flac|m4a|mp3|mp4|ogg|opus|wav|wave|webm|wma)"
    r"(?=$|\s|[,;:!?])"
)
_LOG_LIKE_PATTERN = re.compile(
    r"(?i)(?:"
    r"\b(?:stdout|stderr|traceback|stack trace)\b"
    r"|^\s*(?:debug|info|warning|warn|error|critical|trace)\s*:"
    r"|\[(?:debug|info|warning|warn|error|critical|trace)\]"
    r"|\bFile \""
    r"|^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}"
    r")"
)
_SAFE_RUNTIME_DETAIL_PHRASES = frozenset(
    {
        "CPU fallback after accelerator became unavailable.",
        "CUDA failed, retrying CPU.",
        "Demucs switched to CPU after the accelerator attempt failed.",
        "Demucs switched to CPU because the requested accelerator is unavailable.",
        "MPS failed, retrying CPU.",
        "Whisper switched to CPU after the accelerator attempt failed.",
        "Whisper switched to CPU because the requested accelerator is unavailable.",
        "Whisper switched to a smaller model after CUDA memory pressure.",
    }
)


@dataclass(frozen=True, slots=True)
class JobRuntimeEvent:
    stage: JobRuntimeStage | None = None
    stage_label: str | None = None
    runtime_device: str | None = None
    runtime_detail: str | None = None
    progress: int | None = None


def runtime_event_payload(
    *,
    stage: JobRuntimeStage | None = None,
    stage_label: str | None = None,
    runtime_device: str | None = None,
    runtime_detail: str | None = None,
    progress: int | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {"type": JOB_RUNTIME_EVENT_TYPE}
    if stage is not None:
        payload["stage"] = stage
    if stage_label is not None:
        payload["stage_label"] = stage_label
    if runtime_device is not None:
        payload["runtime_device"] = runtime_device
    if runtime_detail is not None:
        payload["runtime_detail"] = runtime_detail
    if progress is not None:
        payload["progress"] = progress
    return payload


def emit_runtime_event(
    *,
    stage: JobRuntimeStage | None = None,
    stage_label: str | None = None,
    runtime_device: str | None = None,
    runtime_detail: str | None = None,
    progress: int | None = None,
) -> None:
    print(
        json.dumps(
            runtime_event_payload(
                stage=stage,
                stage_label=stage_label,
                runtime_device=runtime_device,
                runtime_detail=runtime_detail,
                progress=progress,
            ),
            separators=(",", ":"),
        ),
        flush=True,
    )


def parse_json_payload(line: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def is_runtime_event_payload(payload: dict[str, Any] | None) -> bool:
    return bool(payload and payload.get("type") == JOB_RUNTIME_EVENT_TYPE)


def runtime_event_from_payload(payload: dict[str, Any]) -> JobRuntimeEvent | None:
    if not is_runtime_event_payload(payload):
        return None

    stage = _safe_runtime_stage(payload.get("stage"))
    stage_label = safe_runtime_label(payload.get("stage_label"))
    runtime_device = safe_runtime_device(payload.get("runtime_device"))
    runtime_detail = safe_runtime_detail(payload.get("runtime_detail"))
    progress = _safe_progress(payload.get("progress"))
    if stage is None and stage_label is None and runtime_device is None and runtime_detail is None and progress is None:
        return None
    return JobRuntimeEvent(
        stage=stage,
        stage_label=stage_label,
        runtime_device=runtime_device,
        runtime_detail=runtime_detail,
        progress=progress,
    )


def safe_runtime_label(value: object) -> str | None:
    return _safe_runtime_text(value, limit=_RUNTIME_LABEL_LIMIT)


def safe_runtime_detail(value: object) -> str | None:
    text = _safe_runtime_text(value, limit=_RUNTIME_DETAIL_LIMIT)
    if text is None or text not in _SAFE_RUNTIME_DETAIL_PHRASES:
        return None
    return text


def _safe_runtime_text(value: object, *, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    if _CONTROL_CHAR_PATTERN.search(value):
        return None
    text = " ".join(value.strip().split())
    if not text or len(text) > limit:
        return None
    if any(marker in text for marker in _PATH_MARKERS):
        return None
    if _AUDIO_EXTENSION_PATTERN.search(text) or _FILENAME_TOKEN_PATTERN.search(text):
        return None
    if _LOG_LIKE_PATTERN.search(text):
        return None
    return text


def safe_runtime_device(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    if normalized.startswith("cuda"):
        normalized = "cuda"
    if normalized not in {"cpu", "mps", "cuda"}:
        return None
    return normalized[:_RUNTIME_DEVICE_LIMIT]


def _safe_runtime_stage(value: object) -> JobRuntimeStage | None:
    if not isinstance(value, str) or value not in JOB_RUNTIME_STAGES:
        return None
    return cast(JobRuntimeStage, value)


def _safe_progress(value: object) -> int | None:
    if not isinstance(value, int):
        return None
    return min(100, max(0, value))
