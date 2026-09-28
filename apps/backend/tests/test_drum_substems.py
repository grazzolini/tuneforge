from __future__ import annotations

import json
import subprocess
from itertools import combinations
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from sqlalchemy import select

from app.db import SessionLocal
from app.engines import drum_substems as engine
from app.engines.demucs_worker import drumsep_source_indices
from app.engines.drum_substems import encode_bounded_drum_parts, signed_subset_bound
from app.errors import AppError, JobCancelledError
from app.models import Artifact, Job, SyncDeleteTombstone
from app.services.artifacts import delete_project_artifact, register_artifact
from app.services.drum_substem_model import DrumSepCheckpoint, drumsep_capabilities, resolve_drumsep_checkpoint
from app.services.drum_substems import (
    delete_drum_substem_set,
    generate_drum_substems,
    validate_drum_refinement_request,
)
from app.services.projects import get_project, import_project
from app.services.sync_metadata import artifact_sync_metadata
from app.utils.hashing import file_sha256

PARTS = ("kick", "snare", "cymbals", "toms")


def _raw_parts(tmp_path: Path, arrays: dict[str, np.ndarray]) -> dict[str, Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for part, values in arrays.items():
        path = tmp_path / f"{part}.wav"
        sf.write(path, values, 44100, subtype="FLOAT")
        paths[part] = path
    return paths


def _project_with_drums(source_path: Path, tmp_path: Path) -> tuple[str, str]:
    audio, sample_rate = sf.read(source_path, dtype="float32", always_2d=True)
    audio[0, 0] = 0.1 + (sum(tmp_path.name.encode()) % 200) / 1000
    unique_source = tmp_path / "unique-source.wav"
    sf.write(unique_source, audio, sample_rate)
    with SessionLocal() as session:
        project = import_project(session, source_path=str(unique_source), copy_into_project=True, display_name=None)
        parent_path = tmp_path / "drums.wav"
        sf.write(parent_path, np.zeros((2048, 2), dtype="float32"), 44100)
        source = next(artifact for artifact in project.artifacts if artifact.type == "source_audio")
        parent = register_artifact(
            session, project_id=project.id, artifact_type="drums_stem", artifact_format="wav",
            path=parent_path, generated_by="demucs",
            metadata={
                "mode": "six_stems", "stem_model": "htdemucs_6s", "stem_source": "drums",
                "source_artifact_id": source.id, "source_artifact_type": "source_audio",
            },
        )
        result = project.id, parent.id
        session.commit()
        return result


def _install_fake_drumsep(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    checkpoint = DrumSepCheckpoint(
        "reviewed/drumsep", "a" * 40, "drumsep.safetensors", "b" * 64, 123,
        "MIT", "https://example.org/rights",
    )
    monkeypatch.setattr(
        "app.services.drum_substems.resolve_drumsep_checkpoint",
        lambda **_kwargs: (checkpoint, tmp_path / "verified.safetensors"),
    )

    def fake_separate(_source, paths, **_kwargs):
        for index, path in enumerate(paths.values(), 1):
            path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(path, np.full((2048, 2), index / 10, dtype="float32"), 44100, subtype="FLOAT")
        return {"device": "cpu"}

    monkeypatch.setattr("app.services.drum_substems.separate_sources", fake_separate)


def test_capability_is_read_only_and_uses_author_hosted_model_without_descriptor(client, monkeypatch):
    monkeypatch.setattr("app.services.drum_substem_model._manifest_path", lambda: Path("/missing/drumsep-model.json"))
    monkeypatch.setattr("app.services.drum_substem_model._google_converted_info", lambda: None)
    response = client.get("/api/v1/drum-substems/capabilities")
    assert response.status_code == 200
    capability = response.json()
    assert capability["available"] is True
    assert capability["cache_status"] == "missing"
    assert capability["download_size_bytes"] == 167400043
    assert drumsep_capabilities()["available"] is True


def test_verified_checkpoint_reuses_offline_cache_without_acquisition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
):
    from app.services import drum_substem_model as model

    cache = tmp_path / "drumsep.safetensors"
    cache.write_bytes(b"synthetic verified checkpoint fixture")
    sha = file_sha256(cache)
    descriptor = tmp_path / "drumsep-model.json"
    descriptor.write_text(json.dumps({
        "id": "drumsep", "class": "demucs.hdemucs.HDemucs",
        "repo_id": "reviewed/drumsep", "revision": "a" * 40,
        "file_name": "drumsep.safetensors", "sha256": sha,
        "size_bytes": cache.stat().st_size, "license": "MIT",
        "rights_record": "https://example.org/rights",
    }))
    monkeypatch.setattr(model, "_manifest_path", lambda: descriptor)
    monkeypatch.setattr(model, "_cached_path", lambda _checkpoint: cache)
    monkeypatch.setattr(model, "configured_stem_model_repo", lambda: None)
    monkeypatch.setattr(model, "hf_hub_download", lambda *_args, **_kwargs: pytest.fail("unexpected download"))
    checkpoint, path = resolve_drumsep_checkpoint(allow_download=False)
    assert path == cache and checkpoint.sha256 == sha
    assert resolve_drumsep_checkpoint(allow_download=True)[1] == cache
    assert model.drumsep_capabilities()["cache_status"] == "verified"
    cache.write_bytes(b"corrupt")
    with pytest.raises(RuntimeError, match="authorize download"):
        resolve_drumsep_checkpoint(allow_download=False)
    assert cache.read_bytes() == b"corrupt"
    def fail_offline(*_args, **_kwargs):
        raise RuntimeError("offline")

    monkeypatch.setattr(model, "hf_hub_download", fail_offline)
    with pytest.raises(RuntimeError, match="offline"):
        resolve_drumsep_checkpoint(allow_download=True)
    assert cache.read_bytes() == b"corrupt"


@pytest.mark.parametrize("output_format", ["wav", "flac", "mp3", "m4a"])
def test_encoder_supports_each_durable_storage_format(tmp_path: Path, output_format: str):
    t = np.arange(44100, dtype="float32") / 44100
    tone = (0.12 * np.sin(2 * np.pi * 110 * t)).astype("float32")
    arrays = {part: np.stack([tone, -tone], axis=1) for part in PARTS}
    gain = encode_bounded_drum_parts(
        _raw_parts(tmp_path / "raw", arrays), tmp_path / "publish", output_format,
        expected_frames=44100, expected_channels=2, expected_sample_rate=44100,
    )
    assert 0 < gain <= 1
    assert all((tmp_path / "publish" / f"{part}.{output_format}").is_file() for part in PARTS)


def _simulate_padded_aac_decode(
    monkeypatch: pytest.MonkeyPatch, padding: int, tail: float = 0.0, frames: int = 44100,
) -> None:
    decode = engine._decode_to_float

    def padded_decode(encoded: Path, destination: Path, *, should_cancel=None) -> None:
        decode(encoded, destination, should_cancel=should_cancel)
        samples, sample_rate = sf.read(destination, dtype="float32", always_2d=True)
        samples = samples[:frames]
        samples = (
            samples[:padding] if padding < 0 else
            np.concatenate((samples, np.full((padding, samples.shape[1]), tail, dtype="float32")))
        )
        sf.write(destination, samples, sample_rate, subtype="FLOAT")

    monkeypatch.setattr(engine, "_decode_to_float", padded_decode)


def _encode_aac_fixture(tmp_path: Path, frames: int = 44100) -> float:
    t = np.arange(frames, dtype="float32") / 44100
    tone = (0.12 * np.sin(2 * np.pi * 110 * t)).astype("float32")
    arrays = {part: np.stack([tone, -tone], axis=1) for part in PARTS}
    return encode_bounded_drum_parts(
        _raw_parts(tmp_path / "raw", arrays), tmp_path / "publish", "m4a",
        expected_frames=frames, expected_channels=2, expected_sample_rate=44100,
    )


@pytest.mark.parametrize("frames,padding", [(44100, 956), (44101, 955)])
def test_encoder_accepts_signaled_aac_padding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, frames: int, padding: int,
):
    _simulate_padded_aac_decode(monkeypatch, padding, frames=frames)
    assert 0 < _encode_aac_fixture(tmp_path / "valid", frames=frames) <= 1
    assert len(list((tmp_path / "valid" / "publish").glob("*.m4a"))) == 4


def test_encoder_checks_full_padded_aac_tail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _simulate_padded_aac_decode(monkeypatch, 956, tail=1.0)
    with pytest.raises(AppError, match="safe encoded sample bound"):
        _encode_aac_fixture(tmp_path)


@pytest.mark.parametrize("padding", [-1, 1024])
def test_encoder_rejects_non_padding_aac_lengths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, padding: int,
):
    _simulate_padded_aac_decode(monkeypatch, padding)
    with pytest.raises(AppError, match="do not align"):
        _encode_aac_fixture(tmp_path)


@pytest.mark.parametrize("field,value", [("start_pts", 1), ("duration_ts", 44101)])
def test_encoder_rejects_padded_aac_with_wrong_timeline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, value: int,
):
    _simulate_padded_aac_decode(monkeypatch, 956)
    run = subprocess.run

    def wrong_timeline(command, **kwargs):
        result = run(command, **kwargs)
        if "stream=start_pts,duration_ts,time_base" in command:
            payload = json.loads(result.stdout)
            payload["streams"][0][field] = value
            return subprocess.CompletedProcess(result.args, result.returncode, json.dumps(payload), result.stderr)
        return result

    monkeypatch.setattr(subprocess, "run", wrong_timeline)
    with pytest.raises(AppError, match="do not align"):
        _encode_aac_fixture(tmp_path)


def test_refinement_request_requires_six_stem_parent_and_vetted_model(
    client, tmp_path: Path, sample_stereo_audio_file: Path, monkeypatch: pytest.MonkeyPatch,
):
    project_id, parent_id = _project_with_drums(sample_stereo_audio_file, tmp_path)
    missing = client.post(
        f"/api/v1/projects/{project_id}/drum-substems",
        json={"drums_artifact_id": "missing"},
    )
    assert missing.status_code == 422
    monkeypatch.setattr("app.services.drum_substems.drumsep_capabilities", lambda: {"available": False})
    blocked = client.post(
        f"/api/v1/projects/{project_id}/drum-substems",
        json={"drums_artifact_id": parent_id},
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "STEM_MODEL_UNAVAILABLE"
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        parent.metadata_json = {**parent.metadata_json, "mode": "two_stems"}
        session.commit()
    unsupported = client.post(
        f"/api/v1/projects/{project_id}/drum-substems",
        json={"drums_artifact_id": parent_id},
    )
    assert unsupported.status_code == 422


def test_drum_substem_routes_are_in_openapi(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/v1/drum-substems/capabilities" in paths
    assert "post" in paths["/api/v1/projects/{project_id}/drum-substems"]
    assert "delete" in paths["/api/v1/projects/{project_id}/drum-substems/{drums_artifact_id}"]


def test_signed_subset_bound_covers_every_muted_subset_and_chunk_boundary(tmp_path: Path):
    frames = 65536 + 37
    arrays = {part: np.zeros((frames, 2), dtype="float32") for part in PARTS}
    arrays["kick"][-1] = [0.8, -0.8]
    arrays["snare"][-1] = [0.7, -0.7]
    arrays["cymbals"][-1] = [-1.0, 1.0]
    arrays["toms"][-1] = [0.6, -0.6]
    paths = _raw_parts(tmp_path, arrays)
    assert signed_subset_bound(paths) == pytest.approx(2.1, abs=1e-6)
    for count in range(1, 5):
        for subset in combinations(PARTS, count):
            signal = sum(arrays[part] for part in subset)
            assert np.max(np.abs(signal)) <= signed_subset_bound(paths) + 1e-6


def test_encoder_uses_common_gain_and_verifies_decoded_files(tmp_path: Path):
    arrays = {part: np.full((128, 2), 0.6, dtype="float32") for part in PARTS}
    gain = encode_bounded_drum_parts(
        _raw_parts(tmp_path, arrays), tmp_path / "publish", "wav",
        expected_frames=128, expected_channels=2, expected_sample_rate=44100,
    )
    assert gain <= 0.9 / 2.4
    assert gain > 0.37
    encoded = {part: tmp_path / "publish" / f"{part}.wav" for part in PARTS}
    assert signed_subset_bound(encoded) <= 0.9
    levels = [float(sf.read(path, always_2d=True)[0][0, 0]) for path in encoded.values()]
    assert max(levels) - min(levels) < 1e-4


def test_encoder_silence_and_nonfinite_input(tmp_path: Path):
    silent = _raw_parts(tmp_path / "silent", {
        part: np.zeros((64, 2), dtype="float32") for part in PARTS
    })
    assert encode_bounded_drum_parts(
        silent, tmp_path / "silent-publish", "wav",
        expected_frames=64, expected_channels=2, expected_sample_rate=44100,
    ) == 1.0
    arrays = {part: np.zeros((64, 2), dtype="float32") for part in PARTS}
    arrays["kick"][0, 0] = np.nan
    with pytest.raises(AppError, match="nonfinite"):
        signed_subset_bound(_raw_parts(tmp_path / "nonfinite", arrays))


@pytest.mark.parametrize("frames,rate", [(127, 44100), (128, 48000)])
def test_encoder_rejects_equal_but_parent_misaligned_parts(tmp_path: Path, frames: int, rate: int):
    paths = {}
    for part in PARTS:
        path = tmp_path / f"{part}.wav"
        sf.write(path, np.zeros((frames, 2), dtype="float32"), rate, subtype="FLOAT")
        paths[part] = path
    with pytest.raises(AppError, match="original Drums stem"):
        encode_bounded_drum_parts(
            paths, tmp_path / "publish", "wav",
            expected_frames=128, expected_channels=2, expected_sample_rate=44100,
        )


def test_drumsep_checkpoint_source_mapping_is_explicit():
    assert drumsep_source_indices(["platillos", "toms", "bombo", "redoblante"]) == {
        "kick": 2, "snare": 3, "cymbals": 0, "toms": 1,
    }
    with pytest.raises(ValueError, match="unexpected source labels"):
        drumsep_source_indices(["kick", "snare", "cymbals", "toms"])


def test_split_set_delete_rejects_active_export(tmp_path: Path, sample_stereo_audio_file: Path):
    project_id, parent_id = _project_with_drums(sample_stereo_audio_file, tmp_path)
    with SessionLocal() as session:
        session.add(Job(id="export_drum_busy", project_id=project_id, type="export", status="running"))
        session.commit()
        with pytest.raises(AppError, match="Audio jobs are active"):
            delete_drum_substem_set(session, project_id=project_id, parent_id=parent_id)
        assert session.get(Artifact, parent_id) is not None


def test_duplicate_refinement_job_is_rejected(
    tmp_path: Path, sample_stereo_audio_file: Path, monkeypatch: pytest.MonkeyPatch,
):
    project_id, parent_id = _project_with_drums(sample_stereo_audio_file, tmp_path)
    monkeypatch.setattr("app.services.drum_substems.drumsep_capabilities", lambda: {"available": True})
    with SessionLocal() as session:
        session.add(Job(
            id="drum_job_busy", project_id=project_id, type="drum_substems", status="pending",
            payload_json={"drums_artifact_id": parent_id},
        ))
        session.commit()
        with pytest.raises(AppError, match="already active"):
            validate_drum_refinement_request(
                session, project_id=project_id, parent_id=parent_id, output_format="wav",
            )


def test_cancel_during_registration_keeps_previous_generation(
    tmp_path: Path, sample_stereo_audio_file: Path, monkeypatch: pytest.MonkeyPatch,
):
    project_id, parent_id = _project_with_drums(sample_stereo_audio_file, tmp_path)
    _install_fake_drumsep(monkeypatch, tmp_path)
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        first = generate_drum_substems(
            session, project=get_project(session, project_id), parent_id=parent_id,
            parent_sha256=parent.content_sha256, output_format="wav", force=False,
            allow_download=False,
        )
        session.commit()
        old_ids = {child.id for child in first}
        old_manifest = dict(parent.metadata_json["drum_substems"])

    from app.services import drum_substems as service

    original_register = service.register_artifact
    cancellation = {"requested": False}

    def cancel_after_first_registration(*args, **kwargs):
        artifact = original_register(*args, **kwargs)
        cancellation["requested"] = True
        return artifact

    monkeypatch.setattr(service, "register_artifact", cancel_after_first_registration)
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        with pytest.raises(JobCancelledError):
            generate_drum_substems(
                session, project=get_project(session, project_id), parent_id=parent_id,
                parent_sha256=parent.content_sha256, output_format="wav", force=True,
                allow_download=False, should_cancel=lambda: cancellation["requested"],
            )
        session.rollback()
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        assert parent.metadata_json["drum_substems"] == old_manifest
        assert {child.id for child in service.drum_parts_for_parent(session, parent)} == old_ids
    monkeypatch.setattr(service, "register_artifact", original_register)
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        restarted = generate_drum_substems(
            session, project=get_project(session, project_id), parent_id=parent_id,
            parent_sha256=parent.content_sha256, output_format="wav", force=True,
            allow_download=False,
        )
        session.commit()
        assert len(restarted) == 4
        assert not old_ids.intersection(child.id for child in restarted)


def test_parent_hash_race_keeps_previous_generation(
    tmp_path: Path, sample_stereo_audio_file: Path, monkeypatch: pytest.MonkeyPatch,
):
    project_id, parent_id = _project_with_drums(sample_stereo_audio_file, tmp_path)
    _install_fake_drumsep(monkeypatch, tmp_path)
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        first = generate_drum_substems(
            session, project=get_project(session, project_id), parent_id=parent_id,
            parent_sha256=parent.content_sha256, output_format="wav", force=False,
            allow_download=False,
        )
        session.commit()
        old_ids = {child.id for child in first}
        old_manifest = dict(parent.metadata_json["drum_substems"])
        original_hash = parent.content_sha256
        parent_path = Path(parent.path)

    from app.services import drum_substems as service

    original_encode = service.encode_bounded_drum_parts

    def mutate_parent_after_encoding(*args, **kwargs):
        gain = original_encode(*args, **kwargs)
        sf.write(parent_path, np.ones((2048, 2), dtype="float32") * 0.01, 44100)
        assert file_sha256(parent_path) != original_hash
        return gain

    monkeypatch.setattr(service, "encode_bounded_drum_parts", mutate_parent_after_encoding)
    with SessionLocal() as session:
        with pytest.raises(AppError, match="Drums stem is missing or changed"):
            generate_drum_substems(
                session, project=get_project(session, project_id), parent_id=parent_id,
                parent_sha256=original_hash, output_format="wav", force=True,
                allow_download=False,
            )
        session.rollback()
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        assert parent.metadata_json["drum_substems"] == old_manifest
        assert {child.id for child in service.drum_parts_for_parent(session, parent)} == old_ids


def test_artifact_list_reports_missing_and_corrupt_drum_children(
    client, tmp_path: Path, sample_stereo_audio_file: Path, monkeypatch: pytest.MonkeyPatch,
):
    project_id, parent_id = _project_with_drums(sample_stereo_audio_file, tmp_path)
    _install_fake_drumsep(monkeypatch, tmp_path)
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        children = generate_drum_substems(
            session, project=get_project(session, project_id), parent_id=parent_id,
            parent_sha256=parent.content_sha256, output_format="wav", force=False,
            allow_download=False,
        )
        session.commit()
        first_path = Path(children[0].path)
        second_path = Path(children[1].path)
        first_id, second_id = children[0].id, children[1].id
    first_path.unlink()
    second_path.write_bytes(b"corrupt")
    response = client.get(f"/api/v1/projects/{project_id}/artifacts")
    assert response.status_code == 200
    integrity = {item["id"]: item["file_integrity"] for item in response.json()["artifacts"]}
    assert integrity[first_id] == "missing"
    assert integrity[second_id] == "corrupt"


def test_refinement_manifest_exclusions_tombstones_and_sync_metadata(
    tmp_path: Path, sample_stereo_audio_file: Path, monkeypatch: pytest.MonkeyPatch,
):
    project_id, parent_id = _project_with_drums(sample_stereo_audio_file, tmp_path)
    _install_fake_drumsep(monkeypatch, tmp_path)
    with SessionLocal() as session:
        parent = session.get(Artifact, parent_id)
        assert parent is not None
        children = generate_drum_substems(
            session, project=get_project(session, project_id), parent_id=parent_id,
            parent_sha256=parent.content_sha256, output_format="wav", force=False,
            allow_download=False,
        )
        session.commit()
        assert len(children) == 4
        session.refresh(parent)
        manifest = artifact_sync_metadata(parent)["drum_substems"]
        assert manifest["expected_parts"] == list(PARTS)
        assert manifest["excluded_parts"] == []
        assert manifest["parent_sha256"] == parent.content_sha256
        assert len(manifest["child_artifact_ids"]) == 4
        assert all(artifact_sync_metadata(child)["checkpoint_sha256"] == "b" * 64 for child in children)
        delete_project_artifact(session, project_id=project_id, artifact_id=children[0].id)
        session.commit()
        session.refresh(parent)
        assert parent.metadata_json["drum_substems"]["excluded_parts"] == ["kick"]
        assert "kick" not in parent.metadata_json["drum_substems"]["child_artifact_ids"]
        tombstone = session.scalar(select(SyncDeleteTombstone).where(SyncDeleteTombstone.target_id == children[0].id))
        assert tombstone is not None
        assert tombstone.prior_metadata_json["metadata"]["parent_sha256"] == parent.content_sha256
        delete_project_artifact(session, project_id=project_id, artifact_id=parent_id)
        session.commit()
        assert not session.scalars(select(Artifact).where(
            Artifact.project_id == project_id,
            Artifact.type.in_(("kick_drum_substem", "snare_drum_substem", "cymbals_drum_substem", "toms_drum_substem")),
        )).all()
