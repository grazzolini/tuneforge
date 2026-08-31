from __future__ import annotations

import json
from pathlib import Path

import soundfile as sf

from app.config import get_settings
from app.db import SessionLocal
from app.services.projects import import_project
from app.services.stem_models import configured_stem_model_repo, resolve_stem_model

from .conftest import wait_for_job


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


def _create_project_without_import_jobs(source_path: Path) -> str:
    with SessionLocal() as session:
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=True,
            display_name=None,
        )
        project_id = project.id
        session.commit()
    return project_id


def test_unconfigured_model_repo_uses_pinned_hugging_face_cache(client, sample_stereo_audio_file, monkeypatch):
    monkeypatch.delenv("TUNEFORGE_DEMUCS_MODEL_REPO", raising=False)
    get_settings.cache_clear()
    seen_model_repos: list[Path | None] = []

    def fake_separate_sources(
        source_path: Path,
        output_paths: dict[str, Path],
        *,
        model: str,
        device: str,
        model_repo: Path | None = None,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        del model, device, should_cancel, register_process, unregister_process
        seen_model_repos.append(model_repo)
        signal, sample_rate = sf.read(source_path, always_2d=True)
        for output_path in output_paths.values():
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(output_path, signal, sample_rate)
        if on_progress:
            on_progress(98)
        return {"engine": "demucs", "model": "htdemucs_6s", "requested_device": "auto", "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_sources", fake_separate_sources)

    project_id = _create_project_without_import_jobs(sample_stereo_audio_file)
    stem_job = client.post(
        f"/api/v1/projects/{project_id}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "completed"
    assert seen_model_repos == [None]


def test_configured_missing_model_repo_fails_stem_job(client, sample_stereo_audio_file, tmp_path, monkeypatch):
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(tmp_path / "missing-demucs"))
    get_settings.cache_clear()

    project_id = _create_project_without_import_jobs(sample_stereo_audio_file)
    stem_job = client.post(
        f"/api/v1/projects/{project_id}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "failed"
    assert final_job["error_message"] == (
        "Bundled Demucs model assets are missing, so TuneForge cannot separate stems. "
        "Next: Re-run local setup to download Demucs model assets, then retry stem separation."
    )


def test_configured_legacy_model_repo_fails_with_migration_guidance(
    client, sample_stereo_audio_file, tmp_path, monkeypatch
):
    repo = tmp_path / "legacy-demucs"
    repo.mkdir()
    (repo / "htdemucs_6s.yaml").touch()
    (repo / "5c90dfd2-34c22ccb.th").touch()
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(repo))
    get_settings.cache_clear()

    project_id = _create_project_without_import_jobs(sample_stereo_audio_file)
    stem_job = client.post(
        f"/api/v1/projects/{project_id}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav"},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "failed"
    assert final_job["error_message"] == (
        "Legacy Demucs .th assets are unsupported; recreate using current TuneForge "
        "(`pnpm models:demucs:prepare`). Next: Legacy Demucs .th assets are unsupported; "
        "recreate using current TuneForge (`pnpm models:demucs:prepare`)."
    )


def test_explicit_model_repo_wins_over_model_bundle(tmp_path: Path, monkeypatch):
    explicit_repo = tmp_path / "explicit"
    bundle = tmp_path / "bundle"
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(explicit_repo))
    monkeypatch.setenv("TUNEFORGE_MODEL_BUNDLE_DIR", str(bundle))
    get_settings.cache_clear()

    assert configured_stem_model_repo() == explicit_repo


def test_v1_non_demucs_model_bundle_falls_through_to_hugging_face(tmp_path: Path, monkeypatch):
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "manifest.json").write_text(
        json.dumps({"version": 1, "torch_checkpoints": []}),
        encoding="utf-8",
    )
    monkeypatch.delenv("TUNEFORGE_DEMUCS_MODEL_REPO", raising=False)
    monkeypatch.setenv("TUNEFORGE_MODEL_BUNDLE_DIR", str(bundle))
    get_settings.cache_clear()

    assert configured_stem_model_repo() is None


def test_v2_empty_demucs_model_bundle_falls_through_to_hugging_face(tmp_path: Path, monkeypatch):
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "manifest.json").write_text(
        json.dumps(
            {
                "version": 2,
                "torch_checkpoints": [],
                "demucs_hf_models": [],
                "whisper_models": [],
                "crema_onnx_files": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("TUNEFORGE_DEMUCS_MODEL_REPO", raising=False)
    monkeypatch.setenv("TUNEFORGE_MODEL_BUNDLE_DIR", str(bundle))
    get_settings.cache_clear()

    assert configured_stem_model_repo() is None


def test_valid_demucs_model_bundle_has_inference_precedence(tmp_path: Path, monkeypatch):
    bundle = tmp_path / "bundle"
    monkeypatch.delenv("TUNEFORGE_DEMUCS_MODEL_REPO", raising=False)
    monkeypatch.setenv("TUNEFORGE_MODEL_BUNDLE_DIR", str(bundle))
    monkeypatch.setattr(
        "app.services.stem_models.demucs_model_bundle_repo",
        lambda configured_bundle: configured_bundle / "demucs",
    )
    get_settings.cache_clear()

    assert configured_stem_model_repo() == bundle / "demucs"
