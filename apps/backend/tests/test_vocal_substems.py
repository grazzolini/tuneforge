from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.engines import stem_audio_encoding
from app.engines import vocal_refinement as engine
from app.errors import AppError, JobCancelledError
from app.models import Artifact, Job, Project, SyncDeleteTombstone
from app.services import vocal_substem_model as model
from app.services import vocal_substems as service
from app.services.artifacts import delete_project_artifact, register_artifact
from app.services.jobs import InProcessJobRunner
from app.services.paths import project_stems_dir
from app.services.projects import import_project
from app.services.vocal_audio_conversion import convert_vocal_audio_groups
from app.utils.hashing import file_sha256
from tests.conftest import wait_for_job


def _audio(frames: int = 11025) -> np.ndarray:
    phase = np.arange(frames, dtype=np.float32) * (2 * np.pi * 440 / 44100)
    return np.stack((np.sin(phase), np.cos(phase)), axis=-1) * 0.1


@pytest.fixture
def project_and_parent(client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    path = tmp_path / "source.wav"
    signal = _audio()
    # Distinct imports with reproducible synthetic samples.
    signal[0, 0] = len(tmp_path.name) / 1000 + sum(tmp_path.name.encode()) / 1e6
    sf.write(path, signal, 44100)
    with SessionLocal() as session:
        project = import_project(session, source_path=str(path), copy_into_project=True, display_name=None)
        source = next(artifact for artifact in project.artifacts if artifact.type == "source_audio")
        parent_path = project_stems_dir(project.id) / "vocals.wav"
        parent_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(parent_path, signal, 44100)
        parent = register_artifact(
            session, project_id=project.id, artifact_type="vocal_stem", artifact_format="wav",
            path=parent_path, metadata={
                "stem_model": "htdemucs_6s", "mode": "six_stems", "source_artifact_id": source.id,
            },
        )
        result = project.id, parent.id
        session.commit()
    monkeypatch.setattr(service, "resolve_mega53", lambda **_: (tmp_path / "model", tmp_path / "config"))

    def infer(_mix: Path, parent: Path, outputs: list[Path], **_options: Any) -> str:
        signal, rate = sf.read(parent, dtype="float32")
        sf.write(outputs[0], signal, rate, subtype="FLOAT")
        sf.write(outputs[1], np.zeros_like(signal), rate, subtype="FLOAT")
        return "cpu"

    def fake_run(mix: Path, parent: Path, outputs: list[Path], *_args: Any, **options: Any) -> str:
        return infer(mix, parent, outputs, **options)

    monkeypatch.setattr(service, "run_vocal_refinement", fake_run)
    get_settings().cache_root.mkdir(parents=True, exist_ok=True)
    return result


def _refine(session, project, parent, output_format="wav", **options):
    payload = service.validate_vocal_refinement_request(
        session, project_id=project.id, parent_id=parent.id, output_format=output_format,
    )
    result = service.generate_vocal_substems(
        session, project=project, payload={**payload, "vocals_artifact_id": parent.id},
        output_format=output_format, **options,
    )
    session.commit()
    return result


def test_refinement_route_publishes_one_generation(project_and_parent, client, monkeypatch):
    def infer(_mix: Path, parent: Path, outputs: list[Path], *_args, **_options) -> str:
        signal, rate = sf.read(parent, dtype="float32")
        backing = 12 * signal
        sf.write(outputs[0], signal - backing, rate, subtype="FLOAT")
        sf.write(outputs[1], backing, rate, subtype="FLOAT")
        return "cpu"

    monkeypatch.setattr(service, "run_vocal_refinement", infer)
    project_id, parent_id = project_and_parent
    endpoint = f"/api/v1/projects/{project_id}/vocal-substems"
    response = client.post(endpoint, json={"vocals_artifact_id": parent_id, "output_format": "flac"})
    assert response.status_code == 200
    job = wait_for_job(client, response.json()["job"]["id"])
    assert job["status"] == "completed", job.get("error_message")
    assert job["runtime_device"] == "cpu"
    assert len(job["result_artifact_ids"]) == 2
    rows = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    children = [row for row in rows if row["id"] in job["result_artifact_ids"]]
    assert {child["type"] for child in children} == {"lead_vocal_substem", "backing_vocal_substem"}
    assert all(child["format"] == "flac" and child["file_integrity"] == "verified" for child in children)
    parent = next(row for row in rows if row["id"] == parent_id)
    gain = parent["metadata"]["vocal_substems"]["applied_gain"]
    assert gain == pytest.approx(0.75, abs=1e-3)
    assert all(child["metadata"]["applied_gain"] == gain for child in children)
    assert client.delete(f"{endpoint}/{parent_id}").status_code == 200
    rows = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    assert {row["id"] for row in rows}.isdisjoint(job["result_artifact_ids"])
    assert "vocal_substems" not in next(row for row in rows if row["id"] == parent_id)["metadata"]


def test_generation_deletion_and_rebuild(project_and_parent):
    project_id, parent_id = project_and_parent
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        parent = session.get(Artifact, parent_id)
        first = _refine(session, project, parent)
        assert [child.type for child in first.artifacts] == ["lead_vocal_substem", "backing_vocal_substem"]
        assert first.installed_dir.name.startswith("vocalset_")
        assert not sf.read(first.artifacts[1].path)[0].any()
        for child in first.artifacts:
            assert Path(child.path).is_file()
        delete_project_artifact(session, project_id=project_id, artifact_id=first.artifacts[0].id)
        session.commit()
        group = service.vocal_membership(parent)
        assert group["excluded_parts"] == ["lead"]
        assert group["child_artifact_ids"] == {"backing": first.artifacts[1].id}
        second = _refine(session, project, parent)
        assert service.vocal_membership(parent)["excluded_parts"] == []
        assert not first.installed_dir.exists()
        assert set(session.scalars(select(SyncDeleteTombstone.target_id))) >= {child.id for child in first.artifacts}
        assert first.installed_dir != second.installed_dir


def test_failure_and_conversion_preserve_coherent_generation(project_and_parent, monkeypatch):
    project_id, parent_id = project_and_parent
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        parent = session.get(Artifact, parent_id)
        saved = _refine(session, project, parent)
        old_group = dict(service.vocal_membership(parent))
        payload = service.validate_vocal_refinement_request(
            session, project_id=project_id, parent_id=parent_id, output_format="flac",
        )
        source = session.get(Artifact, payload["source_artifact_id"])
        inputs = [source, parent, *saved.artifacts]
        snapshots = [{
            "artifact_id": artifact.id, "format": artifact.format, "content_sha256": artifact.content_sha256,
            "updated_at": artifact.updated_at.isoformat(),
        } for artifact in inputs]

        def fail(*_args, **_options):
            raise AppError("PROCESSING_FAILED", "Synthetic codec failure.")

        with monkeypatch.context() as patch:
            patch.setattr(service, "encode_vocal_parts", fail)
            with pytest.raises(AppError, match="Synthetic codec failure"):
                _refine(session, project, parent, "flac")
        session.rollback()
        assert service.vocal_membership(parent) == old_group
        assert all(Path(artifact.path).is_file() for artifact in inputs)
        claimed, converted = convert_vocal_audio_groups(
            session, project_id=project_id, snapshots=snapshots, output_format="flac",
        )
        assert claimed == set(converted) == {artifact.id for artifact in inputs}
        assert all(artifact.format == "flac" for artifact in inputs)
        group = service.vocal_membership(parent)
        assert group["generation_id"] == old_group["generation_id"]
        assert group["applied_gain"] == old_group["applied_gain"] == 1.0
        assert all(child.metadata_json["applied_gain"] == 1.0 for child in saved.artifacts)
        assert group["generation_parent_sha256"] == old_group["parent_sha256"]
        assert group["generation_source_sha256"] == old_group["source_sha256"]
        assert group["parent_sha256"] == file_sha256(Path(parent.path))
        assert group["source_sha256"] == file_sha256(Path(source.path))
        assert service.validated_vocal_members(parent, source, {artifact.id: artifact for artifact in inputs})


@pytest.mark.parametrize("failure", ["register", "commit", "cancel"])
def test_failed_pair_publication_keeps_the_prior_set(project_and_parent, monkeypatch, failure):
    project_id, parent_id = project_and_parent
    runner = InProcessJobRunner(SessionLocal, max_workers=1)
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        parent = session.get(Artifact, parent_id)
        first = _refine(session, project, parent)
        group = dict(service.vocal_membership(parent))
        prior_ids = {child.id for child in first.artifacts}
        tombstones = set(session.scalars(select(SyncDeleteTombstone.target_id)))
        payload = service.validate_vocal_refinement_request(
            session, project_id=project_id, parent_id=parent_id, output_format="flac",
        )
        job = runner.create_job(
            session, project_id=project_id, job_type="vocal_substems", payload={
                **payload, "vocals_artifact_id": parent_id, "output_format": "flac",
            },
        )
        session.commit()
        job_id = job.id

    register = service.register_artifact
    registered = []

    def register_then_fail(session, **kwargs):
        if kwargs["artifact_type"] == "backing_vocal_substem" and failure == "register":
            raise RuntimeError("Synthetic registration failure.")
        artifact = register(session, **kwargs)
        registered.append(artifact.id)
        return artifact

    def fail_commit(session):
        job = session.get(Job, job_id)
        if job is not None and job.status == "completed":
            raise RuntimeError("Synthetic commit failure.")

    monkeypatch.setattr(service, "register_artifact", register_then_fail)
    if failure == "cancel":
        monkeypatch.setattr(runner, "is_cancel_requested", lambda _id: len(registered) == 2)
    if failure == "commit":
        event.listen(Session, "before_commit", fail_commit)
    try:
        runner._execute_job(job_id)
    finally:
        if failure == "commit":
            event.remove(Session, "before_commit", fail_commit)
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        assert job.status == ("cancelled" if failure == "cancel" else "failed")
        assert not job.result_artifact_ids_json
        parent = session.get(Artifact, parent_id)
        assert service.vocal_membership(parent) == group
        assert {child.id for child in service.vocal_parts_for_parent(session, parent)} == prior_ids
        assert set(session.scalars(select(SyncDeleteTombstone.target_id))) == tombstones
        assert set(first.installed_dir.parent.iterdir()) == {first.installed_dir}
        assert all(Path(child.path).is_file() for child in service.vocal_parts_for_parent(session, parent))


@pytest.mark.parametrize("cancel", [False, True])
def test_partial_group_conversion_install_rolls_back(project_and_parent, monkeypatch, cancel):
    project_id, parent_id = project_and_parent
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        parent = session.get(Artifact, parent_id)
        saved = _refine(session, project, parent)
        group = dict(service.vocal_membership(parent))
        source = session.get(Artifact, group["source_artifact_id"])
        members = [source, parent, *saved.artifacts]
        original = {row.id: (row.path, row.content_sha256) for row in members}
        snapshots = [{
            "artifact_id": row.id, "content_sha256": row.content_sha256,
            "format": row.format, "updated_at": row.updated_at.isoformat(),
        } for row in members]
        installed = []
        hardlink = Path.hardlink_to

        def install_or_fail(path, target):
            if installed and not cancel:
                raise OSError("Synthetic second installation failure.")
            hardlink(path, target)
            installed.append(path)

        monkeypatch.setattr(Path, "hardlink_to", install_or_fail)
        error_type = JobCancelledError if cancel else OSError
        with pytest.raises(error_type):
            convert_vocal_audio_groups(
                session, project_id=project_id, snapshots=snapshots, output_format="flac",
                should_cancel=lambda: cancel and len(installed) == len(members),
            )
        assert installed and not any(path.exists() for path in installed)
        assert {row.id: (row.path, row.content_sha256) for row in members} == original
        assert service.vocal_membership(parent) == group
        assert all(file_sha256(Path(path)) == digest for path, digest in original.values())
        assert not list(session.scalars(select(SyncDeleteTombstone.target_id).where(
            SyncDeleteTombstone.project_id == project_id,
        )))


@pytest.mark.parametrize("output_format", ["wav", "flac", "mp3", "m4a"])
@pytest.mark.parametrize("overloaded", [False, True])
def test_codec_preserves_vocal_timeline_and_common_gain(tmp_path, output_format, overloaded):
    paths = [tmp_path / f"{part}.wav" for part in engine.PARTS]
    signal = _audio(16381)
    lead, backing = (-5 * signal, 12 * signal) if overloaded else (0.8 * signal, 0.0001 * signal)
    assert np.abs(lead + backing).max() < 0.9
    for samples, path in zip((lead, backing), paths, strict=True):
        sf.write(path, samples, 44100, subtype="FLOAT")
    publish = tmp_path / "publish"
    gain = engine.encode_vocal_parts(
        paths, publish, output_format, expected_frames=len(signal), expected_channels=2, expected_sample_rate=44100,
    )
    if overloaded:
        backing_peak = float(np.abs(backing).max())
        assert backing_peak > 1
        assert 0.5 < gain <= 0.9 / backing_peak
    else:
        assert gain == 1.0

    decoded = []
    for part, samples in zip(engine.PARTS, (lead, backing), strict=True):
        path = tmp_path / f"decoded-{part}.wav"
        engine.decode_float(publish / f"{part}.{output_format}", path)
        actual, rate = sf.read(path, always_2d=True)
        assert (actual.shape, rate) == (samples.shape, 44100)
        expected = samples * gain
        if output_format in {"wav", "flac"}:
            np.testing.assert_allclose(actual, expected, atol=1 / 32768)
        else:
            assert np.linalg.norm(actual - expected) < 0.1 * max(
                np.linalg.norm(expected), 0.001 * np.sqrt(expected.size),
            )
        decoded.append(actual)

    for subset in (*decoded, decoded[0] + decoded[1]):
        assert np.abs(subset).max() <= 0.9


@pytest.mark.parametrize("output_format", ["wav", "m4a"])
def test_vocal_encoder_rejects_silent_replacement(tmp_path, monkeypatch, output_format):
    signal = _audio(16381)
    paths = [tmp_path / f"{part}.wav" for part in engine.PARTS]
    for path in paths:
        sf.write(path, signal, 44100, subtype="FLOAT")
    silent = tmp_path / "silent.wav"
    sf.write(silent, np.zeros_like(signal), 44100, subtype="FLOAT")
    encode = stem_audio_encoding.encode_audio

    def encode_with_silent_backing(source, destination, output_format, **options):
        encode(silent if destination.stem == "backing" else source, destination, output_format, **options)

    monkeypatch.setattr(stem_audio_encoding, "encode_audio", encode_with_silent_backing)
    publish = tmp_path / "publish"
    with pytest.raises(AppError, match="changed (sample gain|timing or gain)"):
        engine.encode_vocal_parts(
            paths, publish, output_format,
            expected_frames=len(signal), expected_channels=2, expected_sample_rate=44100,
        )
    assert not publish.exists()


@pytest.mark.parametrize(
    "frames,channels,rate,nonfinite,error",
    [
        (63, 2, 44100, False, "original Vocals stem"),
        (64, 1, 44100, False, "original Vocals stem"),
        (64, 2, 48000, False, "original Vocals stem"),
        (64, 2, 44100, True, "nonfinite"),
    ],
)
def test_vocal_encoder_rejects_invalid_parts(tmp_path, frames, channels, rate, nonfinite, error):
    paths = [tmp_path / f"{part}.wav" for part in engine.PARTS]
    samples = np.zeros((frames, channels), dtype="float32")
    if nonfinite:
        samples[-1, 0] = np.nan
    for path in paths:
        sf.write(path, samples, rate, subtype="FLOAT")

    publish = tmp_path / "publish"
    with pytest.raises(AppError, match=error):
        engine.encode_vocal_parts(
            paths, publish, "wav", expected_frames=64, expected_channels=2, expected_sample_rate=44100,
        )
    assert not publish.exists()


def test_fresh_worker_retry_cleans_partial_files_and_does_not_retry_cancel(tmp_path, monkeypatch):
    commands = []
    events = []
    files = [tmp_path / f"{part}.wav" for part in engine.PARTS]

    def fake_attempt(command, *_args):
        commands.append(command)
        if len(commands) == 1:
            files[0].touch()
            return None, "mps"
        assert not files[0].exists()
        return "cpu", None

    monkeypatch.setattr(engine, "_worker_attempt", fake_attempt)
    args = (tmp_path / "mix", tmp_path / "parent", files, tmp_path / "checkpoint", tmp_path / "config")
    assert engine.run_vocal_refinement(*args, device="auto", on_runtime_event=events.append) == "cpu"
    assert [command[-1] for command in commands] == ["auto", "cpu"]
    assert commands[0][:-1] == commands[1][:-1]
    assert events[0].runtime_detail == "MPS failed, retrying CPU."
    with pytest.raises(JobCancelledError):
        engine.run_vocal_refinement(*args, device="mps", should_cancel=lambda: True)
    assert len(commands) == 2


def test_capability_and_verified_offline_cache(tmp_path, monkeypatch):
    root = tmp_path / "verified"
    monkeypatch.setattr(model, "mega53_cache_dir", lambda: root)
    fixtures = {model.MEGA53_WEIGHTS: b"synthetic weights", model.MEGA53_CONFIG: b"synthetic config"}
    root.mkdir()
    for name, data in fixtures.items():
        (root / name).write_bytes(data)
    monkeypatch.setattr(model, "_ASSETS", tuple(
        (name, len(data), file_sha256(root / name)) for name, data in fixtures.items()
    ))
    monkeypatch.setattr(model, "urlopen", lambda *_args, **_kwargs: pytest.fail("unexpected download"))
    assert model.vocal_substem_capabilities()["cached"] is True
    assert model.resolve_mega53(allow_download=False) == (root / model.MEGA53_WEIGHTS, root / model.MEGA53_CONFIG)
    (root / model.MEGA53_CONFIG).write_bytes(b"corrupt")
    assert model.vocal_substem_capabilities()["cached"] is False
    with pytest.raises(AppError, match="verified model download"):
        model.resolve_mega53(allow_download=False)
