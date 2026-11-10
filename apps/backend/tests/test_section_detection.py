from __future__ import annotations

from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from sqlalchemy import select

from app.cli import prewarm_models
from app.db import SessionLocal
from app.engines import section_weights
from app.errors import AppError, JobCancelledError
from app.models import AnalysisResult, ChordTimeline, LyricsTranscript, SectionAnalysisResult, SongSection
from app.services import section_detection as service
from app.services.artifacts import register_artifact
from app.services.paths import project_stems_dir
from app.services.projects import get_project, import_project
from app.services.stem_models import SIX_STEM_SOURCES, model_output_artifact_type
from app.utils.model_cache import ExpectedModelFile


def _seed(source: Path, output_format: str = "wav") -> str:
    with SessionLocal() as session:
        project = import_project(
            session, source_path=str(source), copy_into_project=True, display_name=None, output_format=output_format
        )
        source_artifact = next(a for a in project.artifacts if a.type == "source_audio")
        from app.services.audio_working import materialize_pcm_wav

        with materialize_pcm_wav(Path(source_artifact.path)) as working:
            values, rate = sf.read(working, dtype="float32", always_2d=True)
        directory = project_stems_dir(project.id) / "generation"
        directory.mkdir(parents=True)
        for name in SIX_STEM_SOURCES:
            path = directory / f"{name}.wav"
            sf.write(path, values / 6, rate, subtype="FLOAT")
            if output_format != "wav":
                from app.engines.audio_encoding import encode_audio

                encoded = path.with_suffix(f".{output_format}")
                encode_audio(path, encoded, output_format)
                path = encoded
            register_artifact(
                session,
                project_id=project.id,
                artifact_type=model_output_artifact_type(name),
                artifact_format=output_format,
                path=path,
                generated_by="demucs",
                metadata={"stem_model": "htdemucs_6s", "source_artifact_id": source_artifact.id},
            )
        session.add(
            SongSection(
                id="manual", project_id=project.id, label="My verse", source="manual", start_seconds=0, end_seconds=1
            )
        )
        session.commit()
        return project.id


def _raw() -> dict:
    labels = np.zeros((10, 200))
    labels[8] = 0.9
    labels[9] = 0.1
    return {
        "segments": [
            {"label": "verse", "start_seconds": 0.0, "end_seconds": 1.0},
            {"label": "verse", "start_seconds": 1.0, "end_seconds": 2.0},
        ],
        "beats": [0.5, 1.0, 1.5],
        "downbeats": [0.5],
        "bpm": 120,
        "activation_fps": 100,
        "segment_activation": [0.0] * 200,
        "label_activation": labels.tolist(),
        "vocal_energy": [0.1] * 20,
        "vocal_threshold": 0.01,
    }


def _prediction(_paths=None, *, cues=None, **_kwargs) -> dict:
    from app.engines.section_fusion import refine_sections

    raw = _raw()
    return {
        "raw_sections": raw["segments"],
        "refined_sections": refine_sections(raw, cues or {"beats": [], "bars": [], "chords": [], "lyrics": []}),
    }


def test_explicit_reruns_use_transient_scores_and_current_cues_preserving_human_sections(
    client,
    sample_audio_file,
    monkeypatch,
):
    project_id = _seed(sample_audio_file)
    calls = []

    def infer(*_args, cues, **_kwargs):
        from app.engines.section_fusion import refine_sections

        calls.append(deepcopy(cues))
        raw = _raw()
        raw["label_activation"][8] = [0.515] * 200
        raw["label_activation"][9] = [0.485] * 200
        return {"raw_sections": raw["segments"], "refined_sections": refine_sections(raw, cues)}

    monkeypatch.setattr(service, "detect_sections", infer)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        first = service.generate_section_analysis(session, project)
        session.commit()
        session.refresh(first)
        original = deepcopy(first.raw_sections_json)
        assert [s["label"] for s in first.refined_sections_json] == ["verse", "verse"]
        assert first.source_artifact_id == next(a.id for a in project.artifacts if a.type == "source_audio")
        assert first.sections_json == first.refined_sections_json
        assert first.source_kind == "generated" and first.has_user_edits is False
        created_at, updated_at = first.created_at, first.updated_at
        first.sections_json = [{"start_seconds": 0, "end_seconds": 2, "label": "My chorus"}]
        first.source_kind = "tab_import"
        first.has_user_edits = True
        session.commit()
        next_update = updated_at + timedelta(seconds=1)
        monkeypatch.setattr(service, "utcnow", lambda: next_update)
        rerun = service.generate_section_analysis(session, project)
        session.commit()
        session.refresh(rerun)
        assert rerun.created_at == created_at and rerun.updated_at == next_update
        assert rerun.sections_json == rerun.refined_sections_json
        assert rerun.sections_json is not rerun.refined_sections_json
        assert rerun.source_kind == "generated" and rerun.has_user_edits is False
        # Identical successful results still advance the sync modification clock.
        next_update += timedelta(seconds=1)
        service.generate_section_analysis(session, project)
        session.commit()
        session.refresh(rerun)
        assert rerun.updated_at == next_update and rerun.created_at == created_at
        assert len(calls) == 3
        session.add(
            LyricsTranscript(
                project_id=project_id,
                segments_json=[
                    {
                        "start_seconds": 0.1,
                        "end_seconds": 0.9,
                        "words": [{"start_seconds": 0.2, "end_seconds": 0.4, "text": "hello"}],
                    },
                    {
                        "start_seconds": 1.1,
                        "end_seconds": 1.9,
                        "words": [{"start_seconds": 1.2, "end_seconds": 1.4, "text": "hello"}],
                    },
                ],
            )
        )
        session.commit()
        updated = service.generate_section_analysis(session, project)
        session.commit()
        assert len(calls) == 4 and calls[-1]["lyrics"]
        assert updated.raw_sections_json == original
        assert [s["label"] for s in updated.refined_sections_json] == ["chorus", "chorus"]
        assert session.scalar(select(SongSection)).label == "My verse"
        assert len(list(session.scalars(select(SectionAnalysisResult)))) == 1
        from sqlalchemy import inspect

        assert [c["name"] for c in inspect(session.get_bind()).get_columns("section_analysis_results")] == [
            "project_id",
            "model_revision",
            "raw_sections_json",
            "refined_sections_json",
            "source_artifact_id",
            "sections_json",
            "source_kind",
            "has_user_edits",
            "created_at",
            "updated_at",
        ]
        assert all(
            set(item) == {"start_seconds", "end_seconds", "label"}
            for item in updated.raw_sections_json + updated.refined_sections_json
        )


def test_failure_cancel_and_stale_cue_preserve_last_good(client, sample_audio_file, monkeypatch):
    project_id = _seed(sample_audio_file)
    monkeypatch.setattr(service, "detect_sections", _prediction)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        first = service.generate_section_analysis(session, project)
        session.commit()
        first.sections_json = [{"start_seconds": 0, "end_seconds": 2, "label": "Edited"}]
        first.source_kind = "manual"
        first.has_user_edits = True
        session.commit()
        session.refresh(first)
        fields = (
            "model_revision", "raw_sections_json", "refined_sections_json", "source_artifact_id",
            "sections_json", "source_kind", "has_user_edits", "created_at", "updated_at",
        )
        saved = {name: deepcopy(getattr(first, name)) for name in fields}

        def fail(*_args, **_kwargs):
            raise RuntimeError("inference failed")

        monkeypatch.setattr(service, "detect_sections", fail)
        with pytest.raises(RuntimeError, match="inference failed"):
            service.generate_section_analysis(session, project)
        session.rollback()
        assert {name: getattr(first, name) for name in fields} == saved
        with pytest.raises(JobCancelledError):
            service.generate_section_analysis(session, project, should_cancel=lambda: True)
        session.rollback()
        assert {name: getattr(first, name) for name in fields} == saved
        # Force new inference through a changed version, then race a cue edit.
        monkeypatch.setattr(service, "MODEL_REVISION", "next-model")

        def change_cues(*_args, **_kwargs):
            with SessionLocal() as other:
                other.add(LyricsTranscript(project_id=project_id, segments_json=[]))
                other.commit()
            return _prediction(**_kwargs)

        monkeypatch.setattr(service, "detect_sections", change_cues)
        # Empty cues have the same content; use a real timed phrase to invalidate.
        with SessionLocal() as other:
            other.add(ChordTimeline(project_id=project_id, segments_json=[]))
            other.commit()

        def changed(*args, **kwargs):
            result = change_cues(*args, **kwargs)
            with SessionLocal() as other:
                row = other.get(LyricsTranscript, project_id)
                row.segments_json = [{"start_seconds": 0.2, "end_seconds": 0.9, "text": "changed"}]
                other.commit()
            return result

        monkeypatch.setattr(service, "detect_sections", changed)
        with pytest.raises(AppError, match="changed"):
            service.generate_section_analysis(session, project)
        session.rollback()
        preserved = session.get(SectionAnalysisResult, project_id)
        assert {name: getattr(preserved, name) for name in fields} == saved


def test_detect_route_requires_complete_stems_and_runs_local_job(client, sample_audio_file, monkeypatch):
    project_id = _seed(sample_audio_file)
    monkeypatch.setattr(service, "detect_sections", _prediction)
    response = client.post(f"/api/v1/projects/{project_id}/sections/detect")
    assert response.status_code == 200
    from tests.conftest import wait_for_job

    job = wait_for_job(client, response.json()["job"]["id"])
    assert job["status"] == "completed"
    with SessionLocal() as session:
        assert session.get(SectionAnalysisResult, project_id) is not None
        stem = next(a for a in get_project(session, project_id).artifacts if a.type == "piano_stem")
        stem.metadata_json = {**stem.metadata_json, "source_artifact_id": "wrong-source"}
        session.commit()
    assert client.post(f"/api/v1/projects/{project_id}/sections/detect").status_code == 409


def test_clock_mismatch_rejected_before_inference(client, sample_audio_file):
    project_id = _seed(sample_audio_file)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        stem = next(a for a in project.artifacts if a.type == "piano_stem")
        sf.write(stem.path, np.zeros(100), 44100)
        with pytest.raises(AppError):
            service.section_inputs(session, project)


def test_section_weights_atomic_verified_cache_and_offline(tmp_path, monkeypatch):
    body = b"test safe immutable checkpoint"
    path = tmp_path / "cache" / "model.pth"
    expected = ExpectedModelFile("fold.pth", path, len(body), sha256(body).hexdigest())
    monkeypatch.setattr(section_weights, "section_weight_files", lambda: (expected,))
    calls = []
    monkeypatch.setattr(section_weights, "urlopen", lambda url, **kwargs: calls.append(url) or BytesIO(body))
    assert section_weights.preload_section_weights() == (path,)
    assert path.read_bytes() == body
    monkeypatch.setattr(section_weights, "urlopen", lambda *_args, **_kwargs: pytest.fail("offline cache downloaded"))
    assert section_weights.preload_section_weights() == (path,)
    assert len(calls) == 1
    path.write_bytes(b"corrupt")
    monkeypatch.setattr(section_weights, "urlopen", lambda *_args, **_kwargs: BytesIO(b"invalid"))
    with pytest.raises(RuntimeError, match="unavailable"):
        section_weights.preload_section_weights()
    assert path.read_bytes() == b"corrupt"
    assert not list(path.parent.glob(".download-*"))


def test_section_prewarm_cli_is_explicit(monkeypatch):
    calls = []
    monkeypatch.setattr(prewarm_models, "preload_section_weights", lambda: calls.append(True))
    assert prewarm_models.main(["--skip-demucs", "--skip-whisper", "--include-sections"]) == 0
    assert calls == [True]


@pytest.mark.parametrize(
    "model,platform,expected",
    [
        ("htdemucs_6s", "desktop", ["analyze", "stems", "chords", "lyrics", "sections"]),
        ("htdemucs_ft", "desktop", ["analyze", "stems", "chords", "lyrics"]),
        ("htdemucs_6s", "android", ["analyze", "stems", "chords", "lyrics"]),
        ("htdemucs_6s", "ios", ["analyze", "stems", "chords", "lyrics"]),
    ],
)
def test_import_appends_sections_only_for_six_stem_model(
    client, sample_audio_file, model, platform, expected, monkeypatch
):
    from types import SimpleNamespace

    from app.api.routes.projects import create_project
    from app.schemas import ProjectImportRequest

    class Recorder:
        def __init__(self):
            self.jobs = []
            self.queued = []

        def create_job(self, _session, *, job_type, **_kwargs):
            self.jobs.append(job_type)
            return SimpleNamespace(id=job_type)

        def enqueue(self, job_id):
            self.queued.append(job_id)

    from app.config import get_settings

    monkeypatch.setenv("TUNEFORGE_RUNTIME_PLATFORM", platform)
    get_settings.cache_clear()
    runner = Recorder()
    with SessionLocal() as session:
        create_project(ProjectImportRequest(source_path=str(sample_audio_file), stem_model=model), session, runner)
    assert runner.jobs == expected
    assert runner.queued == expected


def test_cancelled_engine_never_launches_worker(monkeypatch):
    from app.engines import section_detection as engine

    monkeypatch.setattr(
        engine.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("cancelled job launched worker")
    )
    with pytest.raises(JobCancelledError):
        engine.detect_sections({}, cues={}, should_cancel=lambda: True)


def test_model_configuration_rejects_interpolation_and_objects():
    from app.engines.section_detection import _primitive

    assert _primitive({"depth": 11, "nested": [True, 1.0, None, "plain"]})
    assert not _primitive({"unsafe": "${oc.env:HOME}"})
    assert not _primitive({"unsafe": object()})


def test_first_use_missing_cache_reports_offline_without_partial_publication(tmp_path, monkeypatch):
    path = tmp_path / "cache" / "model.pth"
    monkeypatch.setattr(
        section_weights, "section_weight_files", lambda: (ExpectedModelFile("fold.pth", path, 10, "0" * 64),)
    )

    def offline(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(section_weights, "urlopen", offline)
    with pytest.raises(RuntimeError, match="connect once"):
        section_weights.preload_section_weights()
    assert not path.exists()
    assert not list(path.parent.glob(".download-*"))


def test_aac_m4a_uses_existing_pcm_decode_with_verified_frame_count(client, sample_audio_file, monkeypatch):
    project_id = _seed(sample_audio_file, "m4a")
    calls = []

    def inference(paths, *, frames, **kwargs):
        assert all(Path(path).suffix == ".wav" for path in paths.values())
        assert all(sf.info(path).samplerate == 44100 for path in paths.values())
        calls.append(frames)
        return _prediction(paths, **kwargs)

    monkeypatch.setattr(service, "detect_sections", inference)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        inputs = service.section_inputs(session, project)
        with service.materialize_pcm_wav(Path(inputs["files"]["source"]["path"])) as source_pcm:
            source_info = sf.info(source_pcm)
        with service._working_inputs(inputs, should_cancel=None, register_process=None, unregister_process=None) as (
            paths,
            verified_frames,
        ):
            clocks = {
                (sf.info(path).samplerate, sf.info(path).frames, sf.info(path).channels) for path in paths.values()
            }
            assert len(clocks) == 1
            rate, decoded_frames, channels = clocks.pop()
            source_frames = round(source_info.frames / source_info.samplerate * rate)
            assert rate == 44100 and channels in {1, 2}
            assert source_frames - 1 <= decoded_frames <= source_frames + 1024
            assert verified_frames == min(decoded_frames, source_frames)
        row = service.generate_section_analysis(session, project)
        session.commit()
        assert calls == [verified_frames]
        assert row.raw_sections_json == _raw()["segments"]


def test_rerun_uses_corrected_original_and_effective_cue_identity(client, sample_audio_file, monkeypatch):
    project_id = _seed(sample_audio_file)
    calls = []

    def infer(*args, cues, **kwargs):
        calls.append(deepcopy(cues))
        return _prediction(*args, cues=cues, **kwargs)

    monkeypatch.setattr(service, "detect_sections", infer)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        session.add(
            LyricsTranscript(
                project_id=project_id,
                source_kind="manual",
                segments_json=[{"start_seconds": 0.1, "end_seconds": 0.9, "text": "timed"}],
            )
        )
        session.commit()
        row = service.generate_section_analysis(session, project)
        session.commit()
        raw = deepcopy(row.raw_sections_json)
        lyrics = session.get(LyricsTranscript, project_id)
        lyrics.source_segments_json = [{"start_seconds": None, "end_seconds": None, "text": "corrected"}]
        lyrics.source_kind, lyrics.source_artifact_id = "ai", "stale-source"
        session.commit()
        row = service.generate_section_analysis(session, project)
        session.commit()
        assert len(calls) == 2 and calls[0]["lyrics"] and not calls[1]["lyrics"]
        assert calls[1]["identities"]["lyrics"]["source_kind"] == "ai"
        assert row.raw_sections_json == raw


@pytest.mark.parametrize("kind", ["symlink", "fifo", "external"])
def test_nonregular_or_unowned_inputs_rejected_before_probe(client, sample_audio_file, tmp_path, monkeypatch, kind):
    import os

    project_id = _seed(sample_audio_file)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        stem = next(a for a in project.artifacts if a.type == "piano_stem")
        path = Path(stem.path)
        if kind == "external":
            stem.path = str(sample_audio_file)
        else:
            path.unlink()
            if kind == "symlink":
                path.symlink_to(sample_audio_file)
            else:
                os.mkfifo(path)
        monkeypatch.setattr(service, "extract_audio_metadata", lambda *args: pytest.fail("probed unsafe path"))
        monkeypatch.setattr(service, "sha256_file", lambda *args: pytest.fail("hashed unsafe path"))
        with pytest.raises(AppError):
            service.section_inputs(session, project, hash_files=False)


def test_excessive_channel_profile_rejected_before_decode(client, sample_audio_file, monkeypatch):
    project_id = _seed(sample_audio_file)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        piano = next(a for a in project.artifacts if a.type == "piano_stem")
        sf.write(piano.path, np.zeros((100, 32), dtype=np.float32), 44100, subtype="FLOAT")
        inputs = service.section_inputs(session, project, hash_files=False)
        monkeypatch.setattr(service, "materialize_pcm_wav", lambda *args, **kwargs: pytest.fail("unsafe decode"))
        with pytest.raises(AppError, match="44.1"):
            with service._working_inputs(inputs, should_cancel=None, register_process=None, unregister_process=None):
                pytest.fail("unsafe profile admitted")


def test_partial_lyrics_keep_independently_timed_words_and_phrases():
    from app.engines.section_fusion import refine_sections

    cues = {
        "beats": [],
        "bars": [],
        "chords": [],
        "availability": {},
        "lyrics": [
            {
                "start_seconds": None,
                "end_seconds": None,
                "words": [
                    {"start_seconds": 0.2, "end_seconds": 0.5, "text": "timed"},
                    {"start_seconds": None, "end_seconds": 0.9, "text": "untimed"},
                ],
            },
            {
                "start_seconds": 1.1,
                "end_seconds": 1.9,
                "words": [{"start_seconds": None, "end_seconds": None, "text": "untimed"}],
            },
        ],
    }
    raw = _raw()
    for segment in raw["segments"]:
        segment["label"] = "chorus"
    raw["label_activation"][8], raw["label_activation"][9] = [0.481] * 200, [0.519] * 200
    original = deepcopy(raw)
    segments = refine_sections(raw, cues)
    assert len(segments) == 2 and segments[0]["label"] == "verse"
    assert raw == original
    cues["lyrics"] = [{"start_seconds": None, "end_seconds": None}]
    assert [s["label"] for s in refine_sections(raw, cues)] == ["chorus", "chorus"]


def test_checkpoint_deserialization_uses_captured_verified_bytes(tmp_path):
    path = tmp_path / "model.pth"
    payload = b"immutable known bytes"
    expected = ExpectedModelFile("fold", path, len(payload), sha256(payload).hexdigest())
    path.write_bytes(payload)
    captured = section_weights.verified_section_weight_bytes(expected)
    path.write_bytes(b"replacement")
    assert captured == payload
    with pytest.raises(ValueError):
        section_weights.verified_section_weight_bytes(expected)
    path.unlink()
    replacement = tmp_path / "replacement"
    replacement.write_bytes(payload)
    path.symlink_to(replacement)
    with pytest.raises(OSError):
        section_weights.verified_section_weight_bytes(expected)


def test_bounded_embedding_matches_two_temporal_convolutions():
    import torch

    from app.engines.section_detection import _bounded_embeddings

    class Embedding(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.first = torch.nn.Conv2d(1, 4, (3, 1), padding=(1, 0))
            self.second = torch.nn.Conv2d(4, 3, (3, 1), padding=(1, 0))

        def forward(self, values):
            return self.second(torch.relu(self.first(values))).mean(dim=3).transpose(1, 2)

    original = Embedding().eval()
    values = torch.randn(2, 1, 49, 5)
    with torch.inference_mode():
        assert torch.allclose(original(values), _bounded_embeddings(original, chunk_frames=16)(values), atol=1e-7)


def test_cancelled_worker_cleans_only_its_own_download_staging(tmp_path, monkeypatch):
    from app.engines import section_detection as engine

    cache = tmp_path / "cache"
    cache.mkdir()
    other = cache / ".other-download"
    other.write_bytes(b"another downloader")
    monkeypatch.setattr(
        engine, "section_weight_files", lambda: (ExpectedModelFile("fold", cache / "model.pth", 10, "0" * 64),)
    )

    class Worker:
        def __init__(self, args, **kwargs):
            self.returncode = None
            (Path(args[-1]) / ".download-partial").write_bytes(b"partial")

        def poll(self):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def wait(self, **kwargs):
            return self.returncode

    monkeypatch.setattr(engine.subprocess, "Popen", Worker)
    cancellation = iter((False, False, True))
    with pytest.raises(JobCancelledError):
        engine.detect_sections({}, cues={}, should_cancel=lambda: next(cancellation))
    assert other.read_bytes() == b"another downloader"
    assert not list(cache.glob(".section-worker-*"))


def test_decode_disk_guard_preserves_last_good(client, sample_audio_file, monkeypatch):
    from types import SimpleNamespace

    project_id = _seed(sample_audio_file)
    monkeypatch.setattr(service, "detect_sections", _prediction)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        row = service.generate_section_analysis(session, project)
        session.commit()
        saved = deepcopy(row.raw_sections_json)
        monkeypatch.setattr(service, "MODEL_REVISION", "new-version")
        monkeypatch.setattr(service.shutil, "disk_usage", lambda path: SimpleNamespace(free=0))
        with pytest.raises(AppError, match="disk space"):
            service.generate_section_analysis(session, project)
        session.rollback()
        assert session.get(SectionAnalysisResult, project_id).raw_sections_json == saved


def test_source_parent_traversal_rejected_before_hash(client, sample_audio_file, monkeypatch):
    project_id = _seed(sample_audio_file)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        source = next(a for a in project.artifacts if a.type == "source_audio")
        path = Path(source.path)
        source.path = str(path.parent / ".." / "source" / path.name)
        monkeypatch.setattr(service, "sha256_file", lambda *args: pytest.fail("hashed traversal"))
        with pytest.raises(AppError):
            service.section_inputs(session, project, hash_files=False)


def test_false_flac_duration_is_bounded_cleaned_and_preserves_previous_result(
    client,
    sample_audio_file,
    monkeypatch,
):
    from app.engines.audio_encoding import encode_audio
    from app.services import audio_working

    project_id = _seed(sample_audio_file)
    monkeypatch.setattr(service, "detect_sections", _prediction)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        row = service.generate_section_analysis(session, project)
        session.commit()
        saved = deepcopy(row.raw_sections_json)
        source = next(a for a in project.artifacts if a.type == "source_audio")
        corrupted = Path(source.path).with_suffix(".flac")
        encode_audio(Path(source.path), corrupted, "flac")
        contents = bytearray(corrupted.read_bytes())
        assert contents[:4] == b"fLaC" and contents[4] & 127 == 0
        clock = int.from_bytes(contents[18:26], "big")
        contents[18:26] = ((clock & ~((1 << 36) - 1)) | 4410).to_bytes(8, "big")
        corrupted.write_bytes(contents)
        assert service.extract_audio_metadata(corrupted)["duration_seconds"] == pytest.approx(0.1)
        # Reproduce the discrepancy with the unchanged default caller before testing
        # the opt-in bound: ffprobe says .1s while FFmpeg actually emits the full 2s.
        with audio_working.materialize_pcm_wav(corrupted) as working:
            assert sf.info(working).frames == 88200
        source.path, source.format = str(corrupted), "flac"
        source.content_sha256, source.size_bytes = sha256(contents).hexdigest(), len(contents)
        project.imported_path = str(corrupted)
        session.commit()
        observed = []
        original = audio_working.encode_audio

        def recording_encode(source_path, destination_path, output_format, **kwargs):
            original(source_path, destination_path, output_format, **kwargs)
            observed.append((destination_path, sf.info(destination_path).frames, destination_path.stat().st_size))

        monkeypatch.setattr(audio_working, "encode_audio", recording_encode)
        monkeypatch.setattr(
            service, "detect_sections", lambda *args, **kwargs: pytest.fail("false duration reached model")
        )
        with pytest.raises(AppError, match="admitted duration"):
            service.generate_section_analysis(session, project)
        session.rollback()
        assert len(observed) == 1
        path, frames, size = observed[0]
        assert 4411 < frames <= 4413
        assert size < 64 * 1024
        assert not path.exists()
        assert session.get(SectionAnalysisResult, project_id).raw_sections_json == saved


@pytest.mark.parametrize("outcome", ["cancel", "failure"])
def test_failed_or_cancelled_rerun_preserves_both_maps_and_model(client, sample_audio_file, monkeypatch, outcome):
    project_id = _seed(sample_audio_file)
    monkeypatch.setattr(service, "detect_sections", _prediction)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        row = service.generate_section_analysis(session, project)
        session.commit()
        previous = (row.model_revision, deepcopy(row.raw_sections_json), deepcopy(row.refined_sections_json))
        cancelled = [False]

        def rerun(*args, **kwargs):
            if outcome == "failure":
                raise AppError("SECTION_DETECTION_FAILED", "Synthetic model failure.")
            cancelled[0] = True
            return {
                "raw_sections": [{"start_seconds": 0.0, "end_seconds": 2.0, "label": "changed"}],
                "refined_sections": [{"start_seconds": 0.0, "end_seconds": 2.0, "label": "changed"}],
            }

        monkeypatch.setattr(service, "detect_sections", rerun)
        with pytest.raises(JobCancelledError if outcome == "cancel" else AppError):
            service.generate_section_analysis(session, project, should_cancel=lambda: cancelled[0])
        session.rollback()
        row = session.get(SectionAnalysisResult, project_id)
        assert (row.model_revision, row.raw_sections_json, row.refined_sections_json) == previous


def test_float32_scores_preserve_float64_label_threshold():
    from app.engines.section_fusion import refine_sections

    raw = _raw()
    raw["segments"] = [{"start_seconds": 0.0, "end_seconds": 2.0, "label": "verse"}]
    scores = np.zeros((10, 200), dtype=np.float32)
    scores[8], scores[9] = 0.44, 0.42
    raw["label_activation"] = scores
    float32_means = scores.mean(axis=1)
    float64_means = scores.mean(axis=1, dtype=np.float64)
    assert abs(float32_means[8] - float32_means[9]) < 0.02
    assert abs(float64_means[8] - float64_means[9]) > 0.02
    cues = {"beats": [], "bars": [], "chords": [], "lyrics": []}
    assert refine_sections(raw, cues) == raw["segments"]


@pytest.mark.parametrize("profile_name", ["TuneForge", "TuneForge Test"])
def test_worker_input_contains_only_fusion_cues_and_result_contains_only_maps(tmp_path, monkeypatch, profile_name):
    import json

    from app.config import get_settings
    from app.engines import section_detection as engine

    monkeypatch.setenv("TUNEFORGE_DATA_DIR", str(tmp_path / profile_name))
    monkeypatch.setenv("MPLCONFIGDIR", str(tmp_path / "unrelated-matplotlib"))
    get_settings.cache_clear()
    monkeypatch.setattr(
        engine,
        "section_weight_files",
        lambda: (ExpectedModelFile("fold", tmp_path / "cache" / "model.pth", 10, "0" * 64),),
    )
    cue = {
        "beats": [0.5],
        "bars": [0.5],
        "chords": [[0.0, 2.0, "C", "unused-chord-history"]],
        "identities": {"project_id": "parent-only-project", "source_segments_json": "parent-only-history"},
        "lyrics": [
            {
                "start_seconds": None,
                "end_seconds": None,
                "text": "unused-segment-text",
                "source_artifact_id": "parent-only-source",
                "words": [{"start_seconds": 0.2, "end_seconds": 0.4, "text": "effective-word", "confidence": 0.99}],
            }
        ],
    }
    compact = {"raw_sections": _raw()["segments"], "refined_sections": _raw()["segments"]}
    inputs = []

    class Worker:
        returncode = 0

        def __init__(self, args, **kwargs):
            assert kwargs["env"]["MPLCONFIGDIR"] == str(get_settings().cache_root / "matplotlib")
            directory = Path(args[3])
            inputs.append(directory / "inputs.json")
            payload = json.loads(inputs[-1].read_text())
            assert payload["cues"] == {
                "beats": [0.5],
                "bars": [0.5],
                "chords": [[0.0, 2.0, "C"]],
                "lyrics": [
                    {
                        "start_seconds": None,
                        "end_seconds": None,
                        "words": [{"start_seconds": 0.2, "end_seconds": 0.4, "text": "effective-word"}],
                    }
                ],
            }
            assert "parent-only" not in inputs[-1].read_text()
            (directory / "result.json").write_text(json.dumps(compact))

        def poll(self):
            return 0

        def wait(self, **kwargs):
            return 0

    monkeypatch.setattr(engine.subprocess, "Popen", Worker)
    assert engine.detect_sections({}, cues=cue) == compact
    assert inputs and not inputs[0].exists()


@pytest.mark.parametrize("device", ["cpu", "mps", "cuda"])
def test_engine_uses_cpu_functional_decoder_and_exact_score_transforms_without_spec_files(
    sample_audio_file,
    tmp_path,
    monkeypatch,
    device,
):
    from types import SimpleNamespace

    import torch
    from allin1_infer import helpers, postprocessing, spectrogram
    from allin1_infer.typings import Segment

    from app.engines import section_detection as engine

    def no_section_cap(*args, **kwargs):
        pytest.fail("section engine changed the framework allocator policy")

    monkeypatch.setattr(torch.mps, "set_per_process_memory_fraction", no_section_cap)
    monkeypatch.setattr(torch.cuda, "set_per_process_memory_fraction", no_section_cap)
    monkeypatch.setattr(engine, "_section_device", lambda *args, **kwargs: device)
    monkeypatch.setattr(torch.mps, "synchronize", lambda: None)
    original_to = torch.Tensor.to
    placements, execution = [], []

    def tensor_to(tensor, *args, **kwargs):
        if "device" in kwargs:
            placements.append(kwargs["device"])
            kwargs["device"] = "cpu"  # Test placement requests without requiring GPU hardware.
        return original_to(tensor, *args, **kwargs)

    monkeypatch.setattr(torch.Tensor, "to", tensor_to)
    features = np.arange(200 * 81, dtype=np.float32).reshape(200, 81)
    monkeypatch.setattr(spectrogram, "build_spec_processor", lambda: lambda signal: features.copy())
    section_logits = torch.linspace(-1.0, 1.0, 200).reshape(1, 200)
    label_logits = torch.arange(2000, dtype=torch.float32).reshape(1, 10, 200) / 1000
    logits = SimpleNamespace(logits_section=section_logits, logits_function=label_logits)
    config = object()

    class Model:
        cfg = config

        def to(self, *, device, dtype):
            placements.append(device)
            assert dtype == torch.float32
            return self

        def __call__(self, inputs):
            assert inputs.device.type == "cpu" and inputs.dtype == torch.float32
            assert np.array_equal(inputs.numpy(), np.stack([features] * 4)[None])
            return logits

    monkeypatch.setattr(engine, "_load_model", lambda staging_dir: Model())

    def functional(output, cfg):
        assert output.logits_section.device.type == output.logits_function.device.type == "cpu"
        assert torch.equal(output.logits_section, logits.logits_section)
        assert torch.equal(output.logits_function, logits.logits_function)
        assert cfg is config
        return [Segment(start=0.0, end=2.0, label="verse")]

    monkeypatch.setattr(postprocessing, "postprocess_functional_structure", functional)
    monkeypatch.setattr(helpers, "run_inference", lambda *args, **kwargs: pytest.fail("unneeded broad inference"))
    monkeypatch.setattr(sf, "write", lambda *args, **kwargs: pytest.fail("temporary float WAV write"))
    monkeypatch.setattr(np, "save", lambda *args, **kwargs: pytest.fail("spectrogram file write"))
    monkeypatch.setattr(np, "load", lambda *args, **kwargs: pytest.fail("spectrogram file read"))
    cues = {"beats": [], "bars": [], "chords": [], "lyrics": []}

    def refine(raw, actual_cues):
        assert actual_cues is cues
        assert np.array_equal(raw["segment_activation"], torch.sigmoid(section_logits[0]).numpy())
        assert np.array_equal(raw["label_activation"], torch.softmax(label_logits[0], dim=0).numpy())
        return raw["segments"]

    monkeypatch.setattr(engine, "refine_sections", refine)
    stems = {name: str(sample_audio_file) for name in SIX_STEM_SOURCES}
    result = engine.infer_sections_in_process(stems, cues=cues, device=device,
                                              on_execution_device=execution.append)
    expected = [{"start_seconds": 0.0, "end_seconds": 2.0, "label": "verse"}]
    assert result == {"raw_sections": expected, "refined_sections": expected,
                      "runtime_device": device}
    assert placements == [device, device]
    assert execution == [device, None]


def test_all_wav_job_needs_only_control_margin(client, sample_audio_file, monkeypatch):
    from types import SimpleNamespace

    project_id = _seed(sample_audio_file)
    calls = []

    def inference(*args, **kwargs):
        calls.append(True)
        return _prediction(*args, **kwargs)

    monkeypatch.setattr(service, "detect_sections", inference)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        inputs = service.section_inputs(session, project)
        assert all(Path(item["path"]).suffix == ".wav" for item in inputs["files"].values())
        clocks = [sf.info(item["path"]) for item in inputs["files"].values()]
        stem = sf.info(inputs["files"]["vocals"]["path"])
        worker_bytes = 4 * stem.frames * stem.channels * 4
        margin = 16 * 1024 * 1024
        unused_materialization = sum((info.frames + 3) * info.channels * 2 + 1024 * 1024 for info in clocks)
        free = margin + 1024 * 1024
        assert margin < free < worker_bytes + margin + unused_materialization
        monkeypatch.setattr(service.shutil, "disk_usage", lambda path: SimpleNamespace(free=free))
        row = service.generate_section_analysis(session, project)
        session.commit()
        assert calls == [True] and row.raw_sections_json == _raw()["segments"]


@pytest.mark.parametrize("channels", [1, 2])
def test_in_memory_float_signal_matches_wav_samples_and_spectrogram(tmp_path, channels):
    from allin1_infer.spectrogram import build_spec_processor
    from madmom_infer.audio.signal import Signal

    rng = np.random.default_rng(589)
    sources = [rng.normal(size=(4410, channels)).astype(np.float32) for _ in range(3)]
    audio = sources[0] + sources[1] + sources[2]
    assert np.max(np.abs(audio)) > 1
    path = tmp_path / "parity.wav"
    sf.write(path, audio, 44100, subtype="FLOAT")
    disk = Signal(path, num_channels=1)
    memory = Signal(audio, sample_rate=44100, num_channels=1)
    assert disk.sample_rate == memory.sample_rate == 44100
    assert disk.data.dtype == memory.data.dtype == np.float32
    assert np.array_equal(disk.data, memory.data)
    processor = build_spec_processor()
    assert np.array_equal(processor(disk), processor(memory))


def test_section_ensemble_matches_upstream_order_and_releases_unused_outputs(monkeypatch):
    import weakref

    import torch
    from allin1_infer.typings import AllInOneOutput

    from app.engines.section_detection import _section_ensemble

    rng = torch.Generator().manual_seed(589)
    section = [torch.randn((1, 5), generator=rng) for _ in range(8)]
    function = [torch.randn((1, 10, 5), generator=rng) for _ in range(8)]
    expected_section = torch.stack(section, dim=0).mean(dim=0)
    expected_function = torch.stack(function, dim=0).mean(dim=0)
    unused = []
    order = []

    class Fold(torch.nn.Module):
        def __init__(self, index):
            super().__init__()
            self.index = index
            self.cfg = {"fold": index}

        def forward(self, inputs):
            assert all(reference() is None for reference in unused)
            order.append(self.index)
            output = AllInOneOutput(
                logits_section=section[self.index],
                logits_function=function[self.index],
                logits_beat=torch.ones(1, 5),
                logits_downbeat=torch.ones(1, 5),
                embeddings=torch.ones(1, 4, 5, 24),
            )
            unused.extend(
                weakref.ref(tensor) for tensor in (output.logits_beat, output.logits_downbeat, output.embeddings)
            )
            return output

    original_stack = torch.stack
    stacks = []

    def record_stack(tensors, *, dim):
        stacks.append(([tuple(tensor.shape) for tensor in tensors], dim))
        return original_stack(tensors, dim=dim)

    monkeypatch.setattr(torch, "stack", record_stack)
    ensemble = _section_ensemble([Fold(index) for index in range(8)])
    with torch.inference_mode():
        result = ensemble(torch.zeros(1))
    assert order == list(range(8))
    assert stacks == [([(1, 5)] * 8, 0), ([(1, 10, 5)] * 8, 0)]
    assert all(reference() is None for reference in unused)
    assert torch.equal(result.logits_section, expected_section)
    assert torch.equal(result.logits_function, expected_function)
    assert result.logits_beat is result.logits_downbeat is result.embeddings is None
    assert ensemble.cfg == {"fold": 0}


@pytest.mark.parametrize("backend", ["built-in", "beat-this"])
@pytest.mark.parametrize("matching_source", [True, False])
def test_source_matching_saved_grid_refines_boundaries(client, tmp_path, monkeypatch, backend, matching_source):
    source_path = tmp_path / "grid.wav"
    sf.write(source_path, np.zeros(4 * 44100, dtype=np.float32), 44100)
    project_id = _seed(source_path)

    def inference(*args, cues, **kwargs):
        from app.engines.section_fusion import refine_sections

        raw = _raw()
        raw["segments"] = [
            {"start_seconds": 0.0, "end_seconds": 2.0, "label": "verse"},
            {"start_seconds": 2.0, "end_seconds": 4.0, "label": "verse"},
        ]
        raw["vocal_energy"] = [0.1] * 40
        raw["segment_activation"] = [0.0] * 400
        raw["segment_activation"][250] = 0.9
        raw["label_activation"] = np.tile(np.array([0.0] * 8 + [0.9, 0.1])[:, None], (1, 400))
        assert cues["beats"] == cues["bars"] == ([2.5] if matching_source else [])
        return {"raw_sections": raw["segments"], "refined_sections": refine_sections(raw, cues)}

    monkeypatch.setattr(service, "detect_sections", inference)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        source = next(a for a in project.artifacts if a.type == "source_audio")
        session.add(
            AnalysisResult(
                project_id=project_id,
                source_artifact_id=source.id if matching_source else "other-source",
                timing_json={"beats": [{"seconds": 2.5}], "bars": [{"start_seconds": 2.5}]},
                metadata_json={"analysis_backend": backend},
            )
        )
        session.commit()
        row = service.generate_section_analysis(session, project)
        session.commit()
        expected = 2.5 if matching_source else 2.0
        assert row.refined_sections_json[0]["end_seconds"] == row.refined_sections_json[1]["start_seconds"] == expected


@pytest.mark.parametrize("backend", ["built-in", "beat-this"])
def test_saved_grid_change_during_inference_preserves_previous_maps(client, sample_audio_file, monkeypatch, backend):
    project_id = _seed(sample_audio_file)
    monkeypatch.setattr(service, "detect_sections", _prediction)
    with SessionLocal() as session:
        project = get_project(session, project_id)
        first = service.generate_section_analysis(session, project)
        session.commit()
        previous = (deepcopy(first.raw_sections_json), deepcopy(first.refined_sections_json))
        source = next(a for a in project.artifacts if a.type == "source_audio")
        session.add(
            AnalysisResult(
                project_id=project_id,
                source_artifact_id=source.id,
                timing_json={"beats": [{"seconds": 0.5}], "bars": [{"start_seconds": 0.5}]},
                metadata_json={"analysis_backend": backend},
            )
        )
        session.commit()

        def change_grid(*args, cues, **kwargs):
            with SessionLocal() as other:
                analysis = other.get(AnalysisResult, project_id)
                analysis.timing_json = {"beats": [{"seconds": 1.5}], "bars": [{"start_seconds": 1.5}]}
                other.commit()
            return _prediction(*args, cues=cues, **kwargs)

        monkeypatch.setattr(service, "detect_sections", change_grid)
        with pytest.raises(AppError, match="changed"):
            service.generate_section_analysis(session, project)
        session.rollback()
        row = session.get(SectionAnalysisResult, project_id)
        assert (row.raw_sections_json, row.refined_sections_json) == previous


@pytest.mark.parametrize(
    "chords,expected",
    [
        ([[0.0, 2.0, "N"]], "uncertain"),
        ([[0.0, 2.0, "N.C."]], "uncertain"),
        ([[0.0, 2.0, "X"]], "uncertain"),
        ([[0.0, 0.2, "C"], [1.0, 1.2, "D"]], "uncertain"),
        ([[0.0, 0.2, "C"], [1.0, 1.2, "C"]], "chorus"),
        ([[0.0, 0.4, "C"], [1.6, 2.0, "C"]], "uncertain"),
    ],
)
def test_harmonic_recurrence_uses_only_actual_chord_overlap(chords, expected):
    from app.engines.section_fusion import refine_sections

    raw = _raw()
    raw["label_activation"][8], raw["label_activation"][9] = [0.5] * 200, [0.5] * 200
    refined = refine_sections(raw, {"beats": [], "bars": [], "chords": chords, "lyrics": []})
    assert [segment["label"] for segment in refined] == [expected, expected]


@pytest.mark.parametrize(
    "first,second,expected",
    [
        ("Olá!", "OLÁ!", "chorus"),
        ("你好，", "你好！", "chorus"),
        ("Straße", "STRASSE", "chorus"),
        ("नमस्ते", "नमस्ते", "chorus"),
        ("你好", "世界", "verse"),
    ],
)
def test_repeated_lyrics_use_unicode_normalization(first, second, expected):
    from app.engines.section_fusion import refine_sections

    raw = _raw()
    raw["label_activation"][8], raw["label_activation"][9] = [0.515] * 200, [0.485] * 200
    lyrics = [
        {
            "start_seconds": 0.1,
            "end_seconds": 0.9,
            "words": [{"start_seconds": 0.2, "end_seconds": 0.4, "text": first}],
        },
        {
            "start_seconds": 1.1,
            "end_seconds": 1.9,
            "words": [{"start_seconds": 1.2, "end_seconds": 1.4, "text": second}],
        },
    ]
    refined = refine_sections(raw, {"beats": [], "bars": [], "chords": [], "lyrics": lyrics})
    assert [segment["label"] for segment in refined] == [expected, expected]


def test_weight_prewarm_repairs_matching_symlink_without_changing_target(tmp_path, monkeypatch):
    payload = b"verified original bytes"
    target = tmp_path / "original"
    target.write_bytes(payload)
    path = tmp_path / "cache" / "fold.pth"
    path.parent.mkdir()
    path.symlink_to(target)
    expected = ExpectedModelFile("fold.pth", path, len(payload), sha256(payload).hexdigest())
    monkeypatch.setattr(section_weights, "section_weight_files", lambda: (expected,))
    monkeypatch.setattr(section_weights, "urlopen", lambda *args, **kwargs: BytesIO(payload))
    assert section_weights.preload_section_weights() == (path,)
    assert not path.is_symlink() and path.read_bytes() == payload
    assert target.read_bytes() == payload


@pytest.mark.parametrize("concurrent_symlink", [False, True])
def test_weight_download_error_accepts_only_verified_regular_concurrent_file(tmp_path, monkeypatch, concurrent_symlink):
    payload = b"verified original bytes"
    target = tmp_path / "original"
    target.write_bytes(payload)
    path = tmp_path / "cache" / "fold.pth"
    expected = ExpectedModelFile("fold.pth", path, len(payload), sha256(payload).hexdigest())
    monkeypatch.setattr(section_weights, "section_weight_files", lambda: (expected,))

    def raced(*args, **kwargs):
        if concurrent_symlink:
            path.symlink_to(target)
        else:
            path.write_bytes(payload)
        raise OSError("synthetic download failure")

    monkeypatch.setattr(section_weights, "urlopen", raced)
    if concurrent_symlink:
        with pytest.raises(RuntimeError, match="unavailable"):
            section_weights.preload_section_weights()
        assert path.is_symlink()
    else:
        assert section_weights.preload_section_weights() == (path,)
    assert target.read_bytes() == payload
    assert not list(path.parent.glob(".download-*"))


def test_weight_final_check_rejects_symlink_substitution(tmp_path, monkeypatch):
    payload = b"verified original bytes"
    target = tmp_path / "original"
    target.write_bytes(payload)
    path = tmp_path / "cache" / "fold.pth"
    expected = ExpectedModelFile("fold.pth", path, len(payload), sha256(payload).hexdigest())
    monkeypatch.setattr(section_weights, "section_weight_files", lambda: (expected,))
    monkeypatch.setattr(section_weights, "urlopen", lambda *args, **kwargs: BytesIO(payload))
    replace = Path.replace

    def substituted(candidate, destination):
        result = replace(candidate, destination)
        destination.unlink()
        destination.symlink_to(target)
        return result

    monkeypatch.setattr(Path, "replace", substituted)
    with pytest.raises(RuntimeError, match="cache failed byte verification"):
        section_weights.preload_section_weights()
    assert path.is_symlink() and target.read_bytes() == payload


@pytest.mark.parametrize("label", ["start", "end"])
def test_refinement_preserves_model_edge_labels_with_or_without_cues(label):
    from app.engines.section_fusion import refine_sections

    raw = _raw()
    raw["segments"] = [{"start_seconds": 0.0, "end_seconds": 2.0, "label": label}]
    for cues in (
        {"beats": [], "bars": [], "chords": [], "lyrics": []},
        {"beats": [0.5, 1.0], "bars": [0.5], "chords": [[0.0, 2.0, "C"]], "lyrics": []},
    ):
        assert refine_sections(raw, cues)[0]["label"] == label


@pytest.mark.parametrize(
    ("requested", "cuda", "mps", "expected"),
    [("auto", True, True, "cuda"), ("auto", False, True, "mps"), ("auto", False, False, "cpu"),
     ("cpu", True, True, "cpu"), ("mps", False, True, "mps"), ("cuda", True, False, "cuda")],
)
def test_section_device_uses_shared_accelerator_priority(requested, cuda, mps, expected):
    from types import SimpleNamespace

    from app.engines.section_detection import _section_device

    torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: cuda),
                            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)))
    assert _section_device(requested, torch_module=torch) == expected


@pytest.mark.parametrize("requested", ["mps", "cuda", "invalid"])
def test_section_device_unavailable_and_invalid_requests_fail_clearly(requested):
    from types import SimpleNamespace

    from app.engines.section_detection import _section_device

    torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False),
                            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)))
    with pytest.raises(AppError) as error:
        _section_device(requested, torch_module=torch)
    assert error.value.code == ("SECTION_DEVICE_INVALID" if requested == "invalid" else "SECTION_DEVICE_UNAVAILABLE")


def test_cancel_during_worker_inference_reports_device_and_cleans_up(tmp_path, monkeypatch):
    import json

    from app.engines import section_detection as engine
    from app.runtime_status import runtime_event_payload

    monkeypatch.setattr(engine, "section_weight_files", lambda: (
        ExpectedModelFile("fold", tmp_path / "cache" / "model.pth", 10, "0" * 64),
    ))
    monkeypatch.setenv("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    monkeypatch.setenv("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.9")
    events, workers, directories = [], [], []

    class Worker:
        def __init__(self, args, **kwargs):
            self.returncode = None
            self.terminated = False
            workers.append(self)
            directory = Path(args[3])
            directories.append(directory)
            assert kwargs["env"]["PYTORCH_ENABLE_MPS_FALLBACK"] == "0"
            assert kwargs["env"]["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] == "0.9"
            assert json.loads((directory / "inputs.json").read_text())["device"] == "mps"
            (directory / "status.json").write_text(json.dumps(runtime_event_payload(
                stage="processing", stage_label="Detecting sections.", runtime_device="mps",
            )))

        def poll(self):
            return self.returncode

        def terminate(self):
            self.terminated = True
            self.returncode = -15

        def wait(self, **kwargs):
            return self.returncode

    monkeypatch.setattr(engine.subprocess, "Popen", Worker)
    with pytest.raises(JobCancelledError):
        engine.detect_sections({}, cues={}, device="mps", on_runtime_event=events.append,
                               should_cancel=lambda: bool(events))
    assert events[0].stage == "processing" and events[0].runtime_device == "mps"
    assert workers[0].terminated and all(not directory.exists() for directory in directories)


@pytest.mark.parametrize("failure", [MemoryError("private path"), RuntimeError("MPS backend out of memory: private")])
def test_worker_resource_errors_are_safe_and_do_not_publish_result(tmp_path, monkeypatch, failure):
    import json

    from app.engines import section_detection as engine

    (tmp_path / "inputs.json").write_text(json.dumps({"stems": {}, "cues": {}, "frames": None, "device": "mps"}))

    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(engine, "infer_sections_in_process", fail)
    with pytest.raises(SystemExit):
        engine._run_worker(tmp_path, tmp_path)
    assert json.loads((tmp_path / "error.json").read_text()) == {"code": "SECTION_MEMORY_FAILED"}
    assert not (tmp_path / "result.json").exists()


@pytest.fixture
def section_workers(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    from app.engines import section_detection as engine
    from app.runtime_status import runtime_event_payload

    def configure(outcomes):
        state = SimpleNamespace(attempts=[], workers=[], directories=[], registered=[], unregistered=[])
        monkeypatch.setattr(engine, "section_weight_files", lambda: (
            ExpectedModelFile("fold", tmp_path / "cache" / "model.pth", 10, "0" * 64),
        ))
        original_run = engine.subprocess.run
        original_popen = engine.subprocess.Popen

        def run(args, *a, **kw):
            assert args[0] != "ps", "unexpected RSS watchdog"
            return original_run(args, *a, **kw)

        monkeypatch.setattr(engine.subprocess, "run", run)

        class Worker:
            def __init__(self, args, **kwargs):
                if state.workers:
                    assert state.workers[-1].poll() is not None
                    assert len(state.unregistered) == len(state.workers)
                    assert not state.directories[-1].exists()
                outcome = outcomes[len(state.workers)]
                self.returncode = None if outcome.get("running") else outcome.get("exit", 1)
                self.terminated = False
                directory = Path(args[3])
                state.directories.append(directory)
                state.workers.append(self)
                state.attempts.append(json.loads((directory / "inputs.json").read_text())["device"])
                assert set(directory.iterdir()) == {directory / "inputs.json"}
                (directory / "execution.json").write_text(json.dumps({"device": outcome.get("execution")}))
                error = {"code": outcome.get("code", "SECTION_DETECTION_FAILED")}
                (directory / "error.json").write_text(json.dumps(error))
                if outcome.get("actual"):
                    (directory / "status.json").write_text(json.dumps(runtime_event_payload(
                        stage="processing", stage_label="Detecting sections.", runtime_device=outcome["actual"],
                    )))
                prediction = {"raw_sections": _raw()["segments"], "refined_sections": _raw()["segments"],
                              "runtime_device": outcome.get("actual")}
                # Failed attempts also leave a stale output; it must never become the retry's result.
                output = prediction if self.returncode == 0 else {"stale": True}
                (directory / "result.json").write_text(json.dumps(output))

            def poll(self):
                return self.returncode

            def wait(self, **kwargs):
                if self.returncode is None:
                    raise engine.subprocess.TimeoutExpired("synthetic worker", 0.2)
                return self.returncode

            def terminate(self):
                self.terminated = True
                self.returncode = -15

        def launch(args, **kwargs):
            if len(args) > 2 and args[2] == "app.engines.section_detection":
                return Worker(args, **kwargs)
            return original_popen(args, **kwargs)

        monkeypatch.setattr(engine.subprocess, "Popen", launch)
        state.register = state.registered.append
        state.unregister = lambda: state.unregistered.append(True)
        return state

    return configure


@pytest.mark.parametrize("device", ["mps", "cuda"])
@pytest.mark.parametrize("placed", [False, True])
def test_accelerator_execution_retries_in_fresh_cpu_worker(section_workers, device, placed):
    from app.engines import section_detection as engine

    state = section_workers([
        {"execution": device, "actual": device if placed else None},
        {"exit": 0, "execution": None, "actual": "cpu"},
    ])
    events = []
    result = engine.detect_sections({}, cues={}, device="auto", on_runtime_event=events.append,
                                    register_process=state.register, unregister_process=state.unregister)
    assert state.attempts == ["auto", "cpu"]
    assert result["runtime_device"] == "cpu" and "stale" not in result
    assert [event.runtime_device for event in events if event.runtime_device] == ([device] if placed else []) + ["cpu"]
    fallback = next(event for event in events if event.stage == "fallback")
    assert fallback.runtime_device is None
    assert fallback.runtime_detail == f"{device.upper()} failed, retrying CPU."
    assert len(state.unregistered) == 2 and all(not path.exists() for path in state.directories)


@pytest.mark.parametrize("execution,code", [
    ("cpu", "SECTION_MEMORY_FAILED"), (None, "SECTION_DETECTION_FAILED"),
    (None, "SECTION_DEVICE_INVALID"), (None, "SECTION_DEVICE_UNAVAILABLE"),
])
def test_cpu_and_nonexecution_failures_do_not_retry(section_workers, execution, code):
    from app.engines import section_detection as engine

    state = section_workers([{"execution": execution, "code": code}])
    with pytest.raises(AppError) as error:
        engine.detect_sections({}, cues={}, device="auto", register_process=state.register,
                               unregister_process=state.unregister)
    assert error.value.code == code and state.attempts == ["auto"]


@pytest.mark.parametrize("cancel_phase", ["before", "between", "during"])
def test_cancellation_prevents_or_terminates_cpu_retry(section_workers, cancel_phase):
    from app.engines import section_detection as engine

    state = section_workers([{"execution": "mps", "actual": "mps"},
                             {"running": True, "execution": "cpu", "actual": "cpu"}])
    cancelled = cancel_phase == "before"

    def report(event):
        nonlocal cancelled
        if (cancel_phase == "between" and event.stage == "fallback"
                or cancel_phase == "during" and event.runtime_device == "cpu"):
            cancelled = True

    with pytest.raises(JobCancelledError):
        engine.detect_sections({}, cues={}, device="mps", should_cancel=lambda: cancelled,
                               on_runtime_event=report, register_process=state.register,
                               unregister_process=state.unregister)
    assert len(state.attempts) == {"before": 0, "between": 1, "during": 2}[cancel_phase]
    assert all(not path.exists() for path in state.directories)
    if cancel_phase == "during":
        assert state.workers[-1].terminated


@pytest.mark.parametrize("outcome", ["failure", "cancel"])
def test_failed_or_cancelled_cpu_retry_preserves_previous_maps(
    client, sample_audio_file, monkeypatch, section_workers, outcome,
):
    from app.config import get_settings

    project_id = _seed(sample_audio_file)
    monkeypatch.setenv("TUNEFORGE_SECTION_DEVICE", "mps")
    get_settings.cache_clear()
    state = section_workers([{"execution": "mps", "actual": "mps"},
                             {"execution": "cpu", "actual": "cpu", "running": outcome == "cancel"}])
    cancelled = False

    def report(event):
        nonlocal cancelled
        cancelled = outcome == "cancel" and event.runtime_device == "cpu"

    original = _raw()["segments"]
    with SessionLocal() as session:
        session.add(SectionAnalysisResult(project_id=project_id, model_revision="previous",
                                         raw_sections_json=original, refined_sections_json=original))
        session.commit()
        with pytest.raises(JobCancelledError if outcome == "cancel" else AppError):
            service.generate_section_analysis(session, get_project(session, project_id),
                                              should_cancel=lambda: cancelled, on_runtime_event=report,
                                              register_process=state.register, unregister_process=state.unregister)
        session.rollback()
        row = session.get(SectionAnalysisResult, project_id)
        assert row.model_revision == "previous"
        assert row.raw_sections_json == row.refined_sections_json == original
        assert session.scalar(select(SongSection)).label == "My verse"
    assert state.attempts == ["mps", "cpu"]
