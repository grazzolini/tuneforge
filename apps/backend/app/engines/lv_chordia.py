from __future__ import annotations

import importlib.metadata
import importlib.util
import io
import threading
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.engines.chord_labels import chord_label_to_segment
from app.utils.model_cache import ExpectedModelFile, InvalidModelFile, invalid_model_files

LV_CHORDIA_BACKEND_ID = "lv-chordia-submission"
LV_CHORDIA_SOURCE_REVISION = "9d7de7bbf45efa6731ec8dc62d35280f141c0702"
LV_CHORDIA_PACKAGE_VERSION = "1.1.0"

_EXPECTED_CHECKPOINTS = (
    (
        "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s0.best.sdict",
        5_746_183,
        "921b42d5d1cf9ce1c0c0e45a74d409b8066e0acec46058ef74e24ee0fb540761",
    ),
    (
        "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s1.best.sdict",
        5_746_175,
        "bcb75859e0efa256696cf5da396b320093317b9b1d9560c304f46c25fe1f8b17",
    ),
    (
        "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s2.best.sdict",
        5_746_179,
        "acddf85c3fff29954c4877021177d72e2cba9f729ce80c1010f054c477bf3f61",
    ),
    (
        "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s3.best.sdict",
        5_746_175,
        "65d81a3ab73435aaaade586981b4cabdf57b8953d76052703e6968c32ef8421c",
    ),
    (
        "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s4.best.sdict",
        5_746_227,
        "5ff6b0ec85640e17a09a9b3de68c93fdd45adc24488e8fa9be5715c28d561122",
    ),
)

_SESSIONS: dict[str, Any] = {}
_SESSION_LOCK = threading.RLock()


@dataclass(frozen=True)
class LVChordiaDetection:
    segments: list[dict[str, Any]]
    runtime_device: str
    accelerator_fallback_from: str | None = None


def lv_chordia_dependency_status(*, runtime_platform: str = "desktop") -> tuple[bool, str | None]:
    if runtime_platform in {"android", "ios", "mobile"}:
        return False, "LV Chordia is disabled on mobile"
    if importlib.util.find_spec("lv_chordia") is None:
        return False, "LV Chordia is not installed in this desktop package"
    try:
        version = importlib.metadata.version("lv-chordia")
    except importlib.metadata.PackageNotFoundError:
        return False, "LV Chordia package metadata is unavailable"
    if version != LV_CHORDIA_PACKAGE_VERSION:
        return False, f"LV Chordia {version} is not the audited {LV_CHORDIA_PACKAGE_VERSION} build"
    invalid_files = invalid_lv_chordia_model_asset_files()
    if invalid_files:
        invalid_file = invalid_files[0]
        return (
            False,
            f"Bundled LV Chordia checkpoint is {invalid_file.reason}; reinstall TuneForge to repair it",
        )
    return True, None


def invalid_lv_chordia_model_asset_files() -> tuple[InvalidModelFile, ...]:
    try:
        from lv_chordia import LVChordiaSession

        info = LVChordiaSession(chord_dict_name="submission", device="cpu").cache_info()
    except Exception:
        return (
            InvalidModelFile(
                label="LV Chordia bundled checkpoints",
                path=Path("lv_chordia"),
                reason="metadata-unavailable",
            ),
        )

    root = Path(str(info.get("path", "lv_chordia/cache_data")))
    entries = info.get("entries")
    if not isinstance(entries, list | tuple):
        return (
            InvalidModelFile(
                label="LV Chordia bundled checkpoints",
                path=root,
                reason="metadata-unavailable",
            ),
        )

    paths_by_name: dict[str, Path] = {}
    invalid_metadata: list[InvalidModelFile] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            invalid_metadata.append(
                InvalidModelFile(
                    label="LV Chordia bundled checkpoints",
                    path=root,
                    reason="metadata-entry",
                )
            )
            continue
        name = str(entry["name"])
        if name in paths_by_name:
            invalid_metadata.append(
                InvalidModelFile(label=f"LV Chordia {name}", path=root / name, reason="metadata-duplicate")
            )
            continue
        paths_by_name[name] = Path(str(entry.get("path", root / name)))

    expected_names = {name for name, _size, _sha256 in _EXPECTED_CHECKPOINTS}
    for unexpected_name in sorted(paths_by_name.keys() - expected_names):
        invalid_metadata.append(
            InvalidModelFile(
                label=f"LV Chordia {unexpected_name}",
                path=paths_by_name[unexpected_name],
                reason="metadata-unexpected",
            )
        )

    expected_files = tuple(
        ExpectedModelFile(
            label=f"LV Chordia {name}",
            path=paths_by_name.get(name, root / name),
            size=size,
            sha256=sha256,
        )
        for name, size, sha256 in _EXPECTED_CHECKPOINTS
    )
    return (*invalid_metadata, *invalid_model_files(expected_files))


def detect_lv_chordia_timeline(source_path: Path) -> LVChordiaDetection:
    resolved_source = source_path.expanduser().resolve()
    if not resolved_source.is_file():
        raise ValueError("LV Chordia requires an existing local audio file")

    preferred_device = lv_chordia_runtime_device()
    try:
        annotations = _infer_on_device(resolved_source, preferred_device)
        fallback_from = None
        actual_device = preferred_device
    except Exception as exc:
        if preferred_device == "cpu" or not _is_accelerator_failure(exc):
            raise
        annotations = _infer_on_device(resolved_source, "cpu")
        fallback_from = preferred_device
        actual_device = "cpu"

    return LVChordiaDetection(
        segments=lv_chordia_annotations_to_timeline(annotations),
        runtime_device=actual_device,
        accelerator_fallback_from=fallback_from,
    )


def lv_chordia_annotations_to_timeline(annotations: Any) -> list[dict[str, Any]]:
    if not isinstance(annotations, list):
        return []
    segments: list[dict[str, Any]] = []
    for annotation in annotations:
        if not isinstance(annotation, dict):
            continue
        start_seconds = _float_or_none(annotation.get("start_time"))
        end_seconds = _float_or_none(annotation.get("end_time"))
        raw_label = annotation.get("chord")
        if (
            start_seconds is None
            or end_seconds is None
            or end_seconds <= start_seconds
            or not isinstance(raw_label, str)
        ):
            continue
        segment = chord_label_to_segment(
            raw_label,
            start_seconds=start_seconds,
            end_seconds=end_seconds,
        )
        if segments and _same_chord(segments[-1], segment):
            segments[-1]["end_seconds"] = segment["end_seconds"]
        else:
            segments.append(segment)
    return segments


def lv_chordia_runtime_device() -> str:
    try:
        import torch
    except Exception:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


def preload_lv_chordia_session() -> None:
    _session_for_device(lv_chordia_runtime_device())


def clear_lv_chordia_session_cache() -> None:
    with _SESSION_LOCK:
        sessions = tuple(_SESSIONS.values())
        _SESSIONS.clear()
        for session in sessions:
            _release_session(session)


def lv_chordia_model_metadata() -> dict[str, Any]:
    return {
        "backend_id": LV_CHORDIA_BACKEND_ID,
        "engine": "lv-chordia",
        "model": "ISMIR-2019-five-model-ensemble",
        "model_version": LV_CHORDIA_PACKAGE_VERSION,
        "source_revision": LV_CHORDIA_SOURCE_REVISION,
        "vocabulary": "submission",
        "checkpoint_count": len(_EXPECTED_CHECKPOINTS),
        "checkpoint_bytes": sum(size for _name, size, _sha256 in _EXPECTED_CHECKPOINTS),
    }


def _infer_on_device(source_path: Path, device: str) -> Any:
    with _SESSION_LOCK:
        session = _session_for_device(device)
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                return session.infer(str(source_path), "submission")
        except Exception:
            _SESSIONS.pop(device, None)
            _release_session(session)
            raise


def _session_for_device(device: str) -> Any:
    with _SESSION_LOCK:
        session = _SESSIONS.get(device)
        if session is not None:
            return session
        invalid_files = invalid_lv_chordia_model_asset_files()
        if invalid_files:
            invalid_file = invalid_files[0]
            raise RuntimeError(
                f"Bundled LV Chordia checkpoint is {invalid_file.reason}; reinstall TuneForge to repair it"
            )
        from lv_chordia import LVChordiaSession

        session = LVChordiaSession(chord_dict_name="submission", device=device)
        try:
            session.load()
        except Exception:
            _release_session(session)
            raise
        _SESSIONS[device] = session
        return session


def _release_session(session: Any) -> None:
    try:
        session.release()
    except Exception:
        pass


def _is_accelerator_failure(exc: Exception) -> bool:
    if not isinstance(exc, RuntimeError):
        return False
    message = str(exc).lower()
    return any(
        token in message
        for token in (
            "cuda error",
            "cuda out of memory",
            "mps backend out of memory",
            "not available",
            "unavailable",
            "not compiled",
            "allocation",
            "allocate",
        )
    )


def _same_chord(first: dict[str, Any], second: dict[str, Any]) -> bool:
    return (
        first.get("root_pitch_class") == second.get("root_pitch_class")
        and first.get("quality") == second.get("quality")
        and first.get("bass_pitch_class") == second.get("bass_pitch_class")
        and first.get("raw_label") == second.get("raw_label")
    )


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    return None
