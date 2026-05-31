from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "beat-candidates.py"


def test_beat_candidates_script_writes_read_only_text_and_json_reports(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module()
    data_dir = _create_data_dir(tmp_path)
    output_dir = tmp_path / "beat-candidates"
    before = _snapshot_files(data_dir)
    calls: list[Path] = []

    monkeypatch.setattr(module.beat_this_engine, "beat_this_dependency_status", lambda: (True, None))

    def fake_detect(path: Path, *, duration_seconds: float | None = None) -> dict[str, Any]:
        assert duration_seconds == 4.0
        calls.append(path)
        return _timing_payload()

    monkeypatch.setattr(module.beat_this_engine, "detect_beat_this_timing", fake_detect)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "beat-candidates.py",
            "--data-dir",
            str(data_dir),
            "--output-dir",
            str(output_dir),
        ],
    )

    assert module.main() == 0

    assert _snapshot_files(data_dir) == before
    assert [path.name for path in calls] == ["source.wav", "drums.wav", "bass.wav"]
    stdout = capsys.readouterr().out
    assert "Product behavior: Advanced Beat Analysis uses source audio only." in stdout

    text_report = (output_dir / "beat-candidates.txt").read_text(encoding="utf-8")
    assert "stem_signal.has_signal=true" in text_report
    json_report = json.loads((output_dir / "beat-candidates.json").read_text(encoding="utf-8"))
    assert json_report["product_behavior"] == "advanced beat analysis uses source audio only"
    candidates = json_report["projects"][0]["candidates"]
    assert [candidate["input"] for candidate in candidates] == ["source", "drums", "bass"]
    assert {candidate["status"] for candidate in candidates} == {"ok"}
    assert candidates[1]["stem_signal_has_signal"] is True


@pytest.mark.parametrize("filename", ["beat-candidates.txt", "beat-candidates.json"])
def test_beat_candidates_script_rejects_output_symlink_into_data_dir(
    tmp_path: Path,
    monkeypatch,
    capsys,
    filename: str,
) -> None:
    module = _load_script_module()
    data_dir = _create_data_dir(tmp_path)
    output_dir = tmp_path / "beat-candidates"
    output_dir.mkdir()
    protected_path = data_dir / "projects" / "project-a" / "source.wav"
    symlink_path = output_dir / filename
    symlink_path.symlink_to(protected_path)
    before = _snapshot_files(data_dir)

    monkeypatch.setattr(module.beat_this_engine, "beat_this_dependency_status", lambda: (True, None))
    monkeypatch.setattr(module.beat_this_engine, "detect_beat_this_timing", lambda *_args, **_kwargs: _timing_payload())
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "beat-candidates.py",
            "--data-dir",
            str(data_dir),
            "--output-dir",
            str(output_dir),
        ],
    )

    assert module.main() == 2

    assert _snapshot_files(data_dir) == before
    assert symlink_path.is_symlink()
    assert symlink_path.resolve() == protected_path.resolve()
    assert "Output path must not target the TuneForge data dir" in capsys.readouterr().err


def _load_script_module() -> Any:
    spec = importlib.util.spec_from_file_location("beat_candidates_script", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _create_data_dir(tmp_path: Path) -> Path:
    data_dir = tmp_path / "tuneforge-data"
    data_dir.mkdir()
    source_path = data_dir / "projects" / "project-a" / "source.wav"
    stems_dir = data_dir / "projects" / "project-a" / "stems"
    drums_path = stems_dir / "drums.wav"
    bass_path = stems_dir / "bass.wav"
    for path in (source_path, drums_path, bass_path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(path.name.encode("utf-8"))
    _write_database(data_dir / "app.sqlite", source_path, drums_path, bass_path)
    return data_dir


def _write_database(database_path: Path, source_path: Path, drums_path: Path, bass_path: Path) -> None:
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                imported_path TEXT NOT NULL,
                duration_seconds REAL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE artifacts (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                type TEXT NOT NULL,
                path TEXT NOT NULL,
                metadata_json JSON NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects (id, display_name, imported_path, duration_seconds)
            VALUES ('project-a', 'Project A', ?, 4.0)
            """,
            (str(source_path),),
        )
        connection.execute(
            """
            INSERT INTO artifacts (id, project_id, type, path, metadata_json, created_at)
            VALUES ('source-art', 'project-a', 'source_audio', ?, '{}', '2026-01-01T00:00:00Z')
            """,
            (str(source_path),),
        )
        for source_name, path in (("drums", drums_path), ("bass", bass_path)):
            metadata = {
                "source_artifact_id": "source-art",
                "source_artifact_type": "source_audio",
                "stem_signal": {
                    "version": 1,
                    "has_signal": True,
                },
            }
            connection.execute(
                """
                INSERT INTO artifacts (id, project_id, type, path, metadata_json, created_at)
                VALUES (?, 'project-a', ?, ?, ?, '2026-01-01T00:00:01Z')
                """,
                (
                    f"{source_name}-art",
                    f"{source_name}_stem",
                    str(path),
                    json.dumps(metadata),
                ),
            )


def _timing_payload() -> dict[str, Any]:
    return {
        "beats_per_bar": 4,
        "source": "beat-this",
        "meter": "4/4",
        "meter_confidence": 1.0,
        "downbeat_source": "beat-this",
        "downbeat_confidence": 1.0,
        "beats": [
            {"index": 0, "seconds": 0.0, "bar_index": 1, "beat_in_bar": 1},
            {"index": 1, "seconds": 0.5, "bar_index": 1, "beat_in_bar": 2},
            {"index": 2, "seconds": 1.0, "bar_index": 1, "beat_in_bar": 3},
            {"index": 3, "seconds": 1.5, "bar_index": 1, "beat_in_bar": 4},
            {"index": 4, "seconds": 2.0, "bar_index": 2, "beat_in_bar": 1},
        ],
        "bars": [
            {"index": 1, "start_seconds": 0.0, "end_seconds": 2.0},
            {"index": 2, "start_seconds": 2.0, "end_seconds": 4.0},
        ],
    }


def _snapshot_files(root: Path) -> dict[str, tuple[int, str]]:
    snapshot: dict[str, tuple[int, str]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            snapshot[str(path.relative_to(root))] = (path.stat().st_size, digest)
    return snapshot
