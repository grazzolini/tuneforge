from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient


def test_health_reports_versions_from_version_file(tmp_path: Path, monkeypatch) -> None:
    version_file = tmp_path / "version.json"
    version_file.write_text(
        json.dumps(
            {
                "backend": {"package_version": "9.8.7", "git_ref": "backend-ref"},
                "frontend": {"package_version": "6.5.4", "git_ref": "frontend-ref"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("TUNEFORGE_VERSION_FILE", str(version_file))

    from app.main import app
    from app.version import get_build_versions

    get_build_versions.cache_clear()
    with TestClient(app) as client:
        payload = client.get("/api/v1/health").json()
    get_build_versions.cache_clear()

    assert payload["version"] == "backend-ref"
    assert payload["backend_version"] == {"package_version": "9.8.7", "git_ref": "backend-ref"}
    assert payload["frontend_version"] == {"package_version": "6.5.4", "git_ref": "frontend-ref"}


def test_health_reports_env_git_ref_without_version_file(monkeypatch) -> None:
    monkeypatch.delenv("TUNEFORGE_VERSION_FILE", raising=False)
    monkeypatch.setenv("TUNEFORGE_GIT_REF", "dev-ref")
    monkeypatch.setenv("TUNEFORGE_BACKEND_PACKAGE_VERSION", "1.2.3")
    monkeypatch.setenv("TUNEFORGE_FRONTEND_PACKAGE_VERSION", "4.5.6")

    from app.main import app
    from app.version import get_build_versions

    get_build_versions.cache_clear()
    with TestClient(app) as client:
        payload = client.get("/api/v1/health").json()
    get_build_versions.cache_clear()

    assert payload["version"] == "dev-ref"
    assert payload["backend_version"] == {"package_version": "1.2.3", "git_ref": "dev-ref"}
    assert payload["frontend_version"] == {"package_version": "4.5.6", "git_ref": "dev-ref"}
