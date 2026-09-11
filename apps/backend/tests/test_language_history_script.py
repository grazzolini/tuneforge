from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "language-history.py"


def test_language_history_tracks_every_observed_language_and_uses_stable_fallback_colors(tmp_path: Path):
    module = _load_script_module()
    snapshot_dir = _write_snapshots(tmp_path)

    snapshots = module.load_snapshots(snapshot_dir)

    assert module.history_languages(snapshots) == ["TypeScript", "Python", "Rust", "CSS", "Shell"]
    assert module.history_values(snapshots, "Rust") == [0.0, 17.5, 25.0]
    assert module.history_values(snapshots, "Shell") == [0.0, 0.0, 1.0]
    assert module.color_for("Haskell") == module.color_for("Haskell")


def test_language_history_frame_includes_chart_and_expands_for_full_legend(tmp_path: Path):
    module = _load_script_module()
    snapshot_dir = _write_snapshots(tmp_path)
    snapshots = module.load_snapshots(snapshot_dir)

    image = module.draw_frame(snapshots, snapshots[-1])

    assert image.size == (900, 684)
    assert image.getbbox() == (0, 0, 900, 684)


def test_language_history_writes_csv_with_zeroes_for_absent_languages(tmp_path: Path):
    module = _load_script_module()
    snapshot_dir = _write_snapshots(tmp_path)
    output_path = tmp_path / "language-history.csv"

    module.write_csv(module.load_snapshots(snapshot_dir), output_path)

    rows = output_path.read_text(encoding="utf-8").splitlines()
    assert rows[0].endswith(",CSS,Python,Rust,Shell,TypeScript")
    assert rows[1].endswith(",0.00,60.00,0.00,0.00,40.00")
    assert rows[-1].endswith(",4.00,29.00,25.00,1.00,41.00")


def test_render_only_inputs_copy_without_media_files(tmp_path: Path):
    module = _load_script_module()
    source = module.OutputPaths(tmp_path / "source")
    source.root.mkdir()
    source.commits.write_text("a\n", encoding="utf-8")
    _write_snapshots(source.root)
    source.gif.write_bytes(b"old-animation")
    destination = module.OutputPaths(tmp_path / "destination")
    destination.root.mkdir()

    module.copy_existing_inputs(source, destination)

    assert destination.commits.read_text(encoding="utf-8") == "a\n"
    assert (destination.snapshots / "0003.json").is_file()
    assert not destination.gif.exists()


def _load_script_module() -> Any:
    spec = importlib.util.spec_from_file_location("language_history_script", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_snapshots(tmp_path: Path) -> Path:
    directory = tmp_path / "linguist-json"
    directory.mkdir()
    metadata = [
        (1, "a" * 40, "2026-04-18", "initial implementation"),
        (2, "b" * 40, "2026-05-18", "add Rust shell"),
        (3, "c" * 40, "2026-09-11", "current state"),
    ]
    (directory / "meta.tsv").write_text(
        "".join(f"{index}\t{revision}\t{date}\t{subject}\n" for index, revision, date, subject in metadata),
        encoding="utf-8",
    )
    _write_snapshot(directory / "0001.json", {"Python": (600, 60.0), "TypeScript": (400, 40.0)})
    _write_snapshot(
        directory / "0002.json",
        {"Python": (500, 50.0), "Rust": (175, 17.5), "TypeScript": (325, 32.5)},
    )
    _write_snapshot(
        directory / "0003.json",
        {
            "CSS": (40, 4.0),
            "Python": (290, 29.0),
            "Rust": (250, 25.0),
            "Shell": (10, 1.0),
            "TypeScript": (410, 41.0),
        },
    )
    return directory


def _write_snapshot(path: Path, values: dict[str, tuple[int, float]]) -> None:
    payload = {
        language: {"size": size, "percentage": f"{percentage:.2f}"}
        for language, (size, percentage) in values.items()
    }
    path.write_text(
        json.dumps(payload),
        encoding="utf-8",
    )
