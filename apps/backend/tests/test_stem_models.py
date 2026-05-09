from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.config import get_settings
from app.services.stem_models import resolve_stem_model

from .conftest import wait_for_job

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def test_stem_models_route_exposes_default_and_two_stems_model(client):
    response = client.get("/api/v1/stem-models")

    assert response.status_code == 200
    models = response.json()["models"]
    assert [(model["id"], model["label"]) for model in models] == [
        ("htdemucs_6s", "Default (6 stems model)"),
        ("htdemucs_ft", "2 stems model"),
    ]
    assert models[0]["default"] is True
    assert models[0]["sourceCount"] == 6
    assert models[1]["sourceCount"] == 2


def test_stem_model_resolver_defaults_to_six_stems_model():
    assert resolve_stem_model(None).id == "htdemucs_6s"


def test_unconfigured_model_repo_fails_stem_job(client, sample_stereo_audio_file, monkeypatch):
    monkeypatch.delenv("TUNEFORGE_DEMUCS_MODEL_REPO")
    get_settings.cache_clear()

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "failed"
    assert final_job["error_message"] == "Bundled Demucs model repo is not configured"


def test_configured_missing_model_repo_fails_stem_job(client, sample_stereo_audio_file, tmp_path, monkeypatch):
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(tmp_path / "missing-demucs"))
    get_settings.cache_clear()

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "failed"
    assert "Bundled Demucs model repo is missing" in final_job["error_message"]


def test_configured_model_repo_requires_manifest(client, sample_stereo_audio_file, tmp_path, monkeypatch):
    repo = tmp_path / "demucs-without-manifest"
    repo.mkdir()
    (repo / "htdemucs_6s.yaml").touch()
    (repo / "5c90dfd2-34c22ccb.th").touch()
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(repo))
    get_settings.cache_clear()

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "failed"
    assert final_job["error_message"] == "Bundled Demucs model manifest is missing"


def test_configured_model_repo_checks_manifest_sizes(client, sample_stereo_audio_file, tmp_path, monkeypatch):
    repo = tmp_path / "demucs-wrong-size"
    repo.mkdir()
    (repo / "htdemucs_6s.yaml").write_text("model", encoding="utf-8")
    (repo / "5c90dfd2-34c22ccb.th").touch()
    _write_six_stem_manifest(repo, yaml_size=999)
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(repo))
    get_settings.cache_clear()

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "failed"
    assert final_job["error_message"] == "Bundled htdemucs_6s files have unexpected sizes: htdemucs_6s.yaml"


def test_configured_model_repo_checks_manifest_hashes(client, sample_stereo_audio_file, tmp_path, monkeypatch):
    repo = tmp_path / "demucs-wrong-hash"
    repo.mkdir()
    (repo / "htdemucs_6s.yaml").touch()
    (repo / "5c90dfd2-34c22ccb.th").touch()
    _write_six_stem_manifest(repo, yaml_sha256="0" * 64)
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(repo))
    get_settings.cache_clear()

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "failed"
    assert final_job["error_message"] == "Bundled htdemucs_6s files have unexpected hashes: htdemucs_6s.yaml"


def _write_six_stem_manifest(
    repo: Path,
    *,
    yaml_size: int = 0,
    yaml_sha256: str = EMPTY_SHA256,
) -> None:
    (repo / "manifest.json").write_text(
        json.dumps(
            {
                "models": {
                    "htdemucs_6s": {
                        "mode": "six_stems",
                        "yaml": "htdemucs_6s.yaml",
                        "files": [
                            {"name": "htdemucs_6s.yaml", "size_bytes": yaml_size, "sha256": yaml_sha256},
                            {"name": "5c90dfd2-34c22ccb.th", "size_bytes": 0, "sha256": EMPTY_SHA256},
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
