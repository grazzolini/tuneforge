from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import select

from app.cli import playback_e2e_fixture
from app.models import AnalysisResult, Artifact, ChordTimeline, LyricsTranscript, Project, SongSection


def test_create_playback_e2e_fixture_seeds_project_data(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    data_dir = tmp_path / "fixture-data"
    work_dir = tmp_path / "fixture-work"

    exit_code = playback_e2e_fixture.main(
        [
            "create",
            "--data-dir",
            str(data_dir),
            "--work-dir",
            str(work_dir),
        ]
    )

    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert exit_code == 0
    assert captured.err == ""
    assert payload["project_name"] == "Tuneforge E2E Fixture"
    assert payload["duration_seconds"] > 30.0
    assert payload["bpm"] == 120.0
    assert payload["data_dir"] == str(data_dir.resolve())
    assert payload["work_dir"] == str(work_dir.resolve())
    assert payload["source_path"] == str((work_dir / "tuneforge-e2e-fixture.wav").resolve())
    assert payload["app_url_path"] == f"/#/projects/{payload['project_id']}"
    assert Path(payload["source_path"]).exists()
    assert (data_dir / "app.sqlite").exists()

    from app.db import SessionLocal

    with SessionLocal() as session:
        project = session.get(Project, payload["project_id"])
        assert project is not None
        assert project.display_name == payload["project_name"]
        assert project.duration_seconds == pytest.approx(payload["duration_seconds"])
        assert project.duration_seconds is not None
        assert project.duration_seconds > 30.0

        source_artifact = session.scalar(
            select(Artifact)
            .where(Artifact.project_id == project.id)
            .where(Artifact.type == "source_audio")
        )
        assert source_artifact is not None
        assert source_artifact.format == "wav"
        assert source_artifact.generated_by == "import"
        assert source_artifact.can_delete is False
        assert source_artifact.can_regenerate is False
        assert source_artifact.content_sha256
        assert source_artifact.metadata_json["source_path"] == payload["source_path"]
        assert Path(source_artifact.path).exists()

        analysis = session.get(AnalysisResult, project.id)
        assert analysis is not None
        assert analysis.source_artifact_id == source_artifact.id
        assert analysis.tempo_bpm == 120.0
        assert analysis.analysis_version == "fixture-v1"
        timing = analysis.timing_json
        assert timing is not None
        assert timing["source"] == "fixture"
        assert timing["beats_per_bar"] == 4
        assert len(timing["beats"]) >= 64
        assert len(timing["bars"]) >= 16
        assert timing["beats"][0] == {
            "index": 0,
            "seconds": 0.0,
            "bar_index": 0,
            "beat_in_bar": 1,
        }

        lyrics = session.get(LyricsTranscript, project.id)
        assert lyrics is not None
        assert lyrics.source_artifact_id == source_artifact.id
        assert lyrics.backend == "fixture"
        assert lyrics.has_user_edits is False
        assert lyrics.source_segments_json == lyrics.segments_json
        assert len(lyrics.segments_json) >= 8
        assert all(
            segment["end_seconds"] - segment["start_seconds"] > 3.0
            for segment in lyrics.segments_json
        )
        assert lyrics.segments_json[0]["words"][0]["text"] == "Count"

        chords = session.get(ChordTimeline, project.id)
        assert chords is not None
        assert chords.source_artifact_id == source_artifact.id
        assert chords.backend == "fixture"
        assert chords.timeline_json == chords.segments_json
        assert len(chords.segments_json) >= 8
        assert chords.segments_json[0]["label"] == "C"
        assert chords.segments_json[1]["label"] == "G"
        assert all(
            segment["end_seconds"] > segment["start_seconds"]
            for segment in chords.segments_json
        )

        sections = list(
            session.scalars(
                select(SongSection)
                .where(SongSection.project_id == project.id)
                .order_by(SongSection.start_seconds)
            )
        )
        assert [section.label for section in sections] == [
            "Intro",
            "Verse",
            "Chorus",
            "Bridge",
            "Outro",
        ]
        assert sections[0].start_seconds == 0.0
        assert sections[-1].end_seconds == pytest.approx(project.duration_seconds)
