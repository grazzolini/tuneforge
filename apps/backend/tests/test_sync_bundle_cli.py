from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.cli import sync_bundle


def test_root_sync_bundle_script_invokes_backend_cli_runner() -> None:
    package_json = Path(__file__).resolve().parents[3] / "package.json"
    scripts = json.loads(package_json.read_text(encoding="utf-8"))["scripts"]

    assert "scripts/run-backend-module.sh app.cli.sync_bundle" in scripts["sync:bundle"]
    assert 'if [[ "${1:-}" == "--" ]]; then shift; fi' in scripts["sync:bundle"]


def test_cli_help_describes_bundle_paths_and_import_flow(capsys: pytest.CaptureFixture[str]) -> None:
    root_help = _help_output(["--help"], capsys)
    export_help = _help_output(["export", "--help"], capsys)
    import_help = _help_output(["import", "--help"], capsys)
    normalized_root_help = _normalize_help(root_help)
    normalized_export_help = _normalize_help(export_help)
    normalized_import_help = _normalize_help(import_help)

    assert "usage: python -m app.cli.sync_bundle" in normalized_root_help
    assert "external sync-tool testing" in normalized_root_help
    assert "Do not sync TuneForge's live app data directory." in normalized_root_help

    assert "--bundle-root PATH" in normalized_export_help
    assert "Point Syncthing or another external folder sync tool at this directory" in normalized_export_help
    assert "--provider-device-id ID" in normalized_export_help
    assert "Use the same id for repeated exports from the same source device." in normalized_export_help

    assert "--bundle-root PATH" in normalized_import_help
    assert "TuneForge's sync staging and reconciliation services" in normalized_import_help
    assert "--provider-device-id ID" in normalized_import_help
    assert "bundle metadata or peer inventory" in normalized_import_help
    assert "source peer should be pinned explicitly" in normalized_import_help


def test_export_cli_calls_service_with_repeatable_project_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_root = tmp_path / "bundle"
    calls: list[dict[str, Any]] = []

    def fake_export_sync_bundle(
        session: Any,
        *,
        bundle_root: Path,
        project_ids: list[str] | None,
        provider_device_id: str | None,
    ) -> dict[str, Any]:
        calls.append(
            {
                "session": session,
                "bundle_root": bundle_root,
                "project_ids": project_ids,
                "provider_device_id": provider_device_id,
            }
        )
        return {"project_count": len(project_ids or []), "blob_count": 3, "bytes": 128}

    monkeypatch.setattr(sync_bundle, "_load_service_function", lambda name: fake_export_sync_bundle)

    exit_code = sync_bundle.main(
        [
            "export",
            "--bundle-root",
            str(bundle_root),
            "--project-id",
            "project-a",
            "--project-id",
            "project-b",
            "--provider-device-id",
            "device-a",
        ]
    )

    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert exit_code == 0
    assert captured.err == ""
    assert calls == [
        {
            "session": calls[0]["session"],
            "bundle_root": bundle_root.resolve(),
            "project_ids": ["project-a", "project-b"],
            "provider_device_id": "device-a",
        }
    ]
    assert payload == {
        "blob_count": 3,
        "bundle_root": str(bundle_root.resolve()),
        "bytes": 128,
        "command": "export",
        "import_counts": None,
        "project_count": 2,
    }


def test_import_cli_calls_service_and_emits_import_counts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_root = tmp_path / "bundle"
    calls: list[dict[str, Any]] = []

    def fake_import_sync_bundle(
        session: Any,
        *,
        bundle_root: Path,
        provider_device_id: str | None,
    ) -> dict[str, Any]:
        calls.append(
            {
                "session": session,
                "bundle_root": bundle_root,
                "provider_device_id": provider_device_id,
            }
        )
        return {"import_counts": {"projects": 1, "revisions": 4}, "blob_count": 5, "bytes": 256}

    monkeypatch.setattr(sync_bundle, "_load_service_function", lambda name: fake_import_sync_bundle)

    exit_code = sync_bundle.main(
        [
            "import",
            "--bundle-root",
            str(bundle_root),
            "--provider-device-id",
            "device-b",
        ]
    )

    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert exit_code == 0
    assert captured.err == ""
    assert calls == [
        {
            "session": calls[0]["session"],
            "bundle_root": bundle_root.resolve(),
            "provider_device_id": "device-b",
        }
    ]
    assert payload == {
        "blob_count": 5,
        "bundle_root": str(bundle_root.resolve()),
        "bytes": 256,
        "command": "import",
        "import_counts": {"projects": 1, "revisions": 4},
        "project_count": None,
    }


def test_cli_reports_service_errors_nonzero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fake_export_sync_bundle(
        session: Any,
        *,
        bundle_root: Path,
        project_ids: list[str] | None,
        provider_device_id: str | None,
    ) -> dict[str, Any]:
        raise RuntimeError("bundle failed")

    monkeypatch.setattr(sync_bundle, "_load_service_function", lambda name: fake_export_sync_bundle)

    exit_code = sync_bundle.main(["export", "--bundle-root", str(tmp_path / "bundle")])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert captured.err == "error: bundle failed\n"


def _help_output(argv: list[str], capsys: pytest.CaptureFixture[str]) -> str:
    with pytest.raises(SystemExit) as exc:
        sync_bundle.main(argv)

    captured = capsys.readouterr()
    assert exc.value.code == 0
    assert captured.err == ""
    return captured.out


def _normalize_help(output: str) -> str:
    return " ".join(output.split())
