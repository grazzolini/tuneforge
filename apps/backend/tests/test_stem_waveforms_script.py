from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "stem-waveforms.py"
SAMPLE_RATE = 8_000
STEM_ARTIFACT_TYPES = {
    "vocals": "vocal_stem",
    "instrumental": "instrumental_stem",
    "drums": "drums_stem",
    "bass": "bass_stem",
    "guitar": "guitar_stem",
    "piano": "piano_stem",
    "other": "other_stem",
}


@dataclass(frozen=True)
class StemFixture:
    name: str
    amplitude: float


@dataclass(frozen=True)
class ProjectFixture:
    title: str
    seed: str
    stems: tuple[StemFixture, ...]

    @property
    def project_id(self) -> str:
        return f"proj_sha256_{hashlib.sha256(self.seed.encode()).hexdigest()}"

    @property
    def storage_key(self) -> str:
        return f"proj_{self.project_id.removeprefix('proj_sha256_')[:24]}"


def test_stem_waveforms_writes_svg_summary_without_touching_data_dir(tmp_path: Path):
    project = ProjectFixture(
        title="Loud Project",
        seed="loud-project",
        stems=(
            StemFixture("drums", 0.7),
            StemFixture("bass", 0.0),
        ),
    )
    data_dir = _create_data_dir(tmp_path, [project])
    output_dir = tmp_path / "waveforms"
    before = _snapshot_files(data_dir)

    result = _run_script(data_dir=data_dir, output_dir=output_dir, width=360)

    assert _snapshot_files(data_dir) == before
    summary = _json_stdout(result)
    assert summary["projects_written"] == 1
    assert summary["stems_scanned"] == 2
    assert summary["thresholds"]["peak"] == pytest.approx(0.001)
    assert summary["thresholds"]["rms"] == pytest.approx(0.00005)

    svg = _read_one_svg(output_dir)
    assert project.title in svg
    assert "drums" in svg
    assert "bass" in svg
    _assert_label_status(svg, label="drums", status="PASS")
    _assert_label_status(svg, label="bass", status="NO SIGNAL")
    _assert_contains_any(svg, ("peak", "rms", "active"), description="threshold labels")
    _assert_contains_any(svg, ("0.001", "1e-03", "1.0e-03"), description="peak threshold")
    _assert_contains_any(svg, ("0.00005", "5e-05", "5.0e-05"), description="rms threshold")
    _assert_contains_any(svg, ("0.20", "0.2"), description="active-duration threshold")


def test_project_id_filter_is_repeatable_and_limits_output_to_selected_storage_keys(tmp_path: Path):
    selected_drums = ProjectFixture(
        title="Selected Drums",
        seed="selected-drums",
        stems=(StemFixture("drums", 0.6),),
    )
    selected_vocals = ProjectFixture(
        title="Selected Vocals",
        seed="selected-vocals",
        stems=(StemFixture("vocals", 0.5),),
    )
    excluded = ProjectFixture(
        title="Excluded Bass",
        seed="excluded-bass",
        stems=(StemFixture("bass", 0.6),),
    )
    data_dir = _create_data_dir(tmp_path, [selected_drums, selected_vocals, excluded])
    output_dir = tmp_path / "filtered-waveforms"
    before = _snapshot_files(data_dir)

    result = _run_script(
        data_dir=data_dir,
        output_dir=output_dir,
        project_ids=(selected_drums.project_id, selected_vocals.project_id),
        width=280,
    )

    assert _snapshot_files(data_dir) == before
    summary = _json_stdout(result)
    assert summary["projects_written"] == 2
    assert summary["stems_scanned"] == 2

    svgs = sorted(output_dir.glob("*.svg"))
    assert len(svgs) == 2
    combined_svg = "\n".join(path.read_text() for path in svgs)
    assert selected_drums.title in combined_svg
    assert selected_vocals.title in combined_svg
    assert excluded.title not in combined_svg
    assert not any(excluded.storage_key in path.stem for path in svgs)


def test_stem_waveforms_ignores_orphan_wavs_not_registered_as_artifacts(tmp_path: Path):
    project = ProjectFixture(
        title="Registered Only",
        seed="registered-only",
        stems=(StemFixture("drums", 0.7),),
    )
    data_dir = _create_data_dir(tmp_path, [project])
    orphan_path = (
        data_dir
        / "projects"
        / project.storage_key
        / "stems"
        / "orphan-source"
        / "htdemucs"
        / "orphan-stemset"
        / "vocals.wav"
    )
    orphan_path.parent.mkdir(parents=True)
    _write_wav(orphan_path, 0.8)
    output_dir = tmp_path / "registered-waveforms"
    before = _snapshot_files(data_dir)

    result = _run_script(data_dir=data_dir, output_dir=output_dir, width=240)

    assert _snapshot_files(data_dir) == before
    summary = _json_stdout(result)
    assert summary["projects_written"] == 1
    assert summary["stems_scanned"] == 1
    svg = _read_one_svg(output_dir)
    assert "drums" in svg
    assert "vocals" not in svg


def test_analyze_stem_width_one_reads_bounded_chunks(monkeypatch: pytest.MonkeyPatch):
    module = _load_script_module()
    fake_audio = _FakeSoundFile(total_frames=SAMPLE_RATE * 10)

    monkeypatch.setattr(module.sf, "SoundFile", lambda *_args, **_kwargs: fake_audio)

    metrics = module.analyze_stem(
        Path("registered.wav"),
        width=1,
        thresholds=module.Thresholds(
            peak=0.001,
            rms=0.00005,
            active_duration=0.0,
            window_seconds=0.05,
        ),
    )

    assert metrics.inspected_duration_seconds == pytest.approx(10.0)
    assert max(fake_audio.read_sizes) == SAMPLE_RATE
    assert len(fake_audio.read_sizes) > 1


def _create_data_dir(tmp_path: Path, projects: list[ProjectFixture]) -> Path:
    data_dir = tmp_path / "tuneforge-data"
    data_dir.mkdir()
    stem_paths: dict[tuple[str, str], Path] = {}
    for project in projects:
        stems_dir = data_dir / "projects" / project.storage_key / "stems" / "source-fixture" / "htdemucs" / "separated"
        stems_dir.mkdir(parents=True)
        for stem in project.stems:
            stem_path = stems_dir / f"{stem.name}.wav"
            _write_wav(stem_path, stem.amplitude)
            stem_paths[(project.project_id, stem.name)] = stem_path
    _write_database(data_dir / "app.sqlite", projects, stem_paths)
    return data_dir


def _write_database(
    path: Path,
    projects: list[ProjectFixture],
    stem_paths: dict[tuple[str, str], Path],
) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                source_key_override TEXT,
                source_sha256 TEXT,
                source_path TEXT NOT NULL,
                imported_path TEXT NOT NULL,
                duration_seconds REAL,
                sample_rate INTEGER,
                channels INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                sync_status TEXT NOT NULL,
                sync_status_reason TEXT,
                sync_required_artifact_ids_json TEXT NOT NULL,
                sync_provider_device_ids_json TEXT NOT NULL,
                sync_conflict_count INTEGER NOT NULL,
                sync_status_updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE artifacts (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                type TEXT NOT NULL,
                format TEXT NOT NULL,
                path TEXT NOT NULL,
                metadata_json JSON NOT NULL,
                cache_key TEXT,
                created_at TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                generated_by TEXT NOT NULL,
                can_delete BOOLEAN NOT NULL,
                can_regenerate BOOLEAN NOT NULL,
                content_sha256 TEXT
            )
            """
        )
        for project in projects:
            source_sha256 = project.project_id.removeprefix("proj_sha256_")
            conn.execute(
                """
                INSERT INTO projects (
                    id,
                    display_name,
                    source_key_override,
                    source_sha256,
                    source_path,
                    imported_path,
                    duration_seconds,
                    sample_rate,
                    channels,
                    created_at,
                    updated_at,
                    sync_status,
                    sync_status_reason,
                    sync_required_artifact_ids_json,
                    sync_provider_device_ids_json,
                    sync_conflict_count,
                    sync_status_updated_at
                )
                VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
                """,
                (
                    project.project_id,
                    project.title,
                    source_sha256,
                    f"/fixtures/{project.storage_key}.wav",
                    f"projects/{project.storage_key}/source.wav",
                    0.5,
                    SAMPLE_RATE,
                    1,
                    "2026-05-29T00:00:00Z",
                    "2026-05-29T00:00:00Z",
                    "local",
                    "[]",
                    "[]",
                    0,
                    "2026-05-29T00:00:00Z",
                ),
            )
            for stem in project.stems:
                stem_path = stem_paths[(project.project_id, stem.name)]
                metadata = {
                    "mode": "six_stems",
                    "stem_model": "htdemucs",
                    "stem_model_label": "fixture model",
                    "stem_source": stem.name,
                    "source_artifact_id": "source-fixture",
                    "source_artifact_type": "source_audio",
                }
                conn.execute(
                    """
                    INSERT INTO artifacts (
                        id,
                        project_id,
                        type,
                        format,
                        path,
                        metadata_json,
                        cache_key,
                        created_at,
                        size_bytes,
                        generated_by,
                        can_delete,
                        can_regenerate,
                        content_sha256
                    )
                    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"art_{project.storage_key}_{stem.name}",
                        project.project_id,
                        STEM_ARTIFACT_TYPES[stem.name],
                        "wav",
                        str(stem_path.resolve()),
                        json.dumps(metadata),
                        "2026-05-29T00:00:00Z",
                        stem_path.stat().st_size,
                        "demucs",
                        1,
                        1,
                        hashlib.sha256(stem_path.read_bytes()).hexdigest(),
                    ),
                )


def _write_wav(path: Path, amplitude: float) -> None:
    duration_seconds = 0.5
    if amplitude == 0.0:
        signal = np.zeros(int(SAMPLE_RATE * duration_seconds), dtype=np.float32)
    else:
        timeline = np.linspace(0.0, duration_seconds, int(SAMPLE_RATE * duration_seconds), endpoint=False)
        signal = (amplitude * np.sin(2 * np.pi * 220.0 * timeline)).astype(np.float32)
    sf.write(path, signal, SAMPLE_RATE, subtype="FLOAT")


def _run_script(
    *,
    data_dir: Path,
    output_dir: Path,
    project_ids: tuple[str, ...] = (),
    width: int,
) -> subprocess.CompletedProcess[str]:
    assert SCRIPT_PATH.exists(), f"{SCRIPT_PATH} missing; Worker A must add script before tests can pass."
    command = [
        sys.executable,
        str(SCRIPT_PATH),
        "--data-dir",
        str(data_dir),
        "--output-dir",
        str(output_dir),
        "--width",
        str(width),
    ]
    for project_id in project_ids:
        command.extend(["--project-id", project_id])
    return subprocess.run(
        command,
        cwd=BACKEND_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def _snapshot_files(root: Path) -> dict[str, tuple[int, str]]:
    snapshot: dict[str, tuple[int, str]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            snapshot[str(path.relative_to(root))] = (path.stat().st_size, digest)
    return snapshot


def _json_stdout(result: subprocess.CompletedProcess[str]) -> Any:
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"Expected JSON stdout, got: {result.stdout!r}\nstderr: {result.stderr!r}"
        ) from exc


def _read_one_svg(output_dir: Path) -> str:
    svgs = sorted(output_dir.glob("*.svg"))
    assert len(svgs) == 1
    return svgs[0].read_text()


def _load_script_module() -> Any:
    spec = importlib.util.spec_from_file_location("stem_waveforms_script", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _FakeSoundFile:
    def __init__(self, *, total_frames: int) -> None:
        self.samplerate = SAMPLE_RATE
        self.channels = 1
        self.frames = total_frames
        self._remaining = total_frames
        self.read_sizes: list[int] = []

    def __enter__(self) -> _FakeSoundFile:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, frames: int, *, dtype: str, always_2d: bool) -> np.ndarray:
        assert dtype == "float32"
        assert always_2d is True
        self.read_sizes.append(frames)
        frame_count = min(frames, self._remaining)
        self._remaining -= frame_count
        return np.zeros((frame_count, 1), dtype=np.float32)


def _assert_label_status(svg: str, *, label: str, status: str) -> None:
    label_pattern = re.escape(label)
    status_pattern = re.escape(status)
    pattern = (
        rf"({label_pattern}[\s\S]{{0,800}}{status_pattern})"
        rf"|({status_pattern}[\s\S]{{0,800}}{label_pattern})"
    )
    assert re.search(pattern, svg, flags=re.IGNORECASE), f"Expected {label!r} row to include {status!r}."


def _assert_contains_any(svg: str, candidates: tuple[str, ...], *, description: str) -> None:
    normalized = svg.lower()
    assert any(candidate.lower() in normalized for candidate in candidates), f"Missing {description}: {candidates!r}"
