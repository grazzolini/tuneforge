from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import struct
import sys
import wave
from copy import deepcopy
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import AnalysisResult, Artifact, ChordTimeline, LyricsTranscript, Project, SongSection
from app.services.projects import import_project
from app.services.sync_identity import source_hash_to_project_id
from app.utils.hashing import file_sha256
from app.utils.ids import new_id

DEFAULT_PROJECT_NAME = "Tuneforge E2E Fixture"
FIXTURE_FILE_NAME = "tuneforge-e2e-fixture.wav"
FIXTURE_DURATION_SECONDS = 40.0
FIXTURE_BPM = 120.0
FIXTURE_SAMPLE_RATE = 22_050
BEATS_PER_BAR = 4


class PlaybackE2EFixtureCliError(RuntimeError):
    pass


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        summary = _run_command(args)
    except AppError as exc:
        sys.stderr.write(f"error: {exc.message}\n")
        return 1
    except PlaybackE2EFixtureCliError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    except Exception as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1

    sys.stdout.write(json.dumps(summary, sort_keys=True))
    sys.stdout.write("\n")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.playback_e2e_fixture",
        description="Create a deterministic local playback E2E fixture project.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_parser = subparsers.add_parser(
        "create",
        help="Create or refresh the playback E2E fixture.",
    )
    create_parser.add_argument("--data-dir", required=True, type=Path, metavar="PATH")
    create_parser.add_argument("--work-dir", required=True, type=Path, metavar="PATH")
    create_parser.add_argument(
        "--project-name",
        default=DEFAULT_PROJECT_NAME,
        help=f"Visible project name. Defaults to {DEFAULT_PROJECT_NAME!r}.",
    )
    return parser


def _run_command(args: argparse.Namespace) -> dict[str, Any]:
    if args.command != "create":
        raise PlaybackE2EFixtureCliError(f"unsupported command: {args.command}")

    data_dir = _resolve_path(args.data_dir)
    work_dir = _resolve_path(args.work_dir)
    project_name = _normalize_project_name(args.project_name)
    _configure_backend(data_dir)
    source_path = _write_fixture_wav(work_dir)

    from app.db import session_scope

    with session_scope() as session:
        project = _import_or_get_project(
            session,
            source_path=source_path,
            project_name=project_name,
        )
        source_artifact = _source_artifact(session, project_id=project.id)
        _seed_fixture_data(
            session,
            project=project,
            source_artifact=source_artifact,
        )
        session.flush()
        session.refresh(project)
        return _build_summary(
            project=project,
            data_dir=data_dir,
            work_dir=work_dir,
            source_path=source_path,
        )


def _resolve_path(path: Path) -> Path:
    return path.expanduser().resolve()


def _normalize_project_name(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise PlaybackE2EFixtureCliError("--project-name cannot be empty")
    return normalized


def _configure_backend(data_dir: Path) -> None:
    os.environ["TUNEFORGE_DATA_DIR"] = str(data_dir)
    from app.config import ensure_data_dirs, get_settings
    from app.db import reconfigure_engine, run_migrations

    get_settings.cache_clear()
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    with contextlib.redirect_stderr(io.StringIO()):
        run_migrations(settings)


def _write_fixture_wav(work_dir: Path) -> Path:
    work_dir.mkdir(parents=True, exist_ok=True)
    source_path = work_dir / FIXTURE_FILE_NAME
    total_frames = int(FIXTURE_SAMPLE_RATE * FIXTURE_DURATION_SECONDS)
    chord_frequencies = (
        (261.63, 329.63, 392.0),
        (196.0, 246.94, 293.66),
        (220.0, 261.63, 329.63),
        (174.61, 220.0, 261.63),
    )

    with wave.open(str(source_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(FIXTURE_SAMPLE_RATE)
        frames = bytearray()
        for frame_index in range(total_frames):
            seconds = frame_index / FIXTURE_SAMPLE_RATE
            chord = chord_frequencies[int(seconds // 4.0) % len(chord_frequencies)]
            harmonic = sum(math.sin(2.0 * math.pi * frequency * seconds) for frequency in chord)
            beat_phase = seconds % (60.0 / FIXTURE_BPM)
            pulse = math.exp(-((beat_phase / 0.015) ** 2))
            sample = (0.16 * harmonic) + (0.32 * pulse)
            clipped = max(-0.95, min(0.95, sample))
            frames.extend(struct.pack("<h", int(clipped * 32767)))
        output.writeframes(frames)

    return source_path


def _import_or_get_project(
    session: Session,
    *,
    source_path: Path,
    project_name: str,
) -> Project:
    source_sha256 = file_sha256(source_path)
    if source_sha256 is None:
        raise PlaybackE2EFixtureCliError(f"could not hash fixture WAV: {source_path}")

    expected_project_id = source_hash_to_project_id(source_sha256)
    project = session.get(Project, expected_project_id)
    if project is None or project.sync_status == "deleted":
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=True,
            display_name=project_name,
        )
    project.display_name = project_name
    return project


def _source_artifact(session: Session, *, project_id: str) -> Artifact:
    artifact = session.scalar(
        select(Artifact)
        .where(Artifact.project_id == project_id)
        .where(Artifact.type == "source_audio")
        .order_by(Artifact.created_at.desc(), Artifact.id.desc())
    )
    if artifact is None:
        raise PlaybackE2EFixtureCliError(f"project {project_id} has no source_audio artifact")
    return artifact


def _seed_fixture_data(
    session: Session,
    *,
    project: Project,
    source_artifact: Artifact,
) -> None:
    _upsert_analysis(session, project=project, source_artifact=source_artifact)
    _upsert_lyrics(session, project=project, source_artifact=source_artifact)
    _upsert_chords(session, project=project, source_artifact=source_artifact)
    _replace_sections(session, project=project)


def _upsert_analysis(
    session: Session,
    *,
    project: Project,
    source_artifact: Artifact,
) -> None:
    analysis = session.get(AnalysisResult, project.id)
    if analysis is None:
        analysis = AnalysisResult(project_id=project.id)
        session.add(analysis)

    analysis.source_artifact_id = source_artifact.id
    analysis.estimated_key = "C major"
    analysis.key_confidence = 0.94
    analysis.estimated_reference_hz = 440.0
    analysis.tuning_offset_cents = 0.0
    analysis.tempo_bpm = FIXTURE_BPM
    analysis.timing_json = _timing_payload()
    analysis.analysis_version = "fixture-v1"


def _upsert_lyrics(
    session: Session,
    *,
    project: Project,
    source_artifact: Artifact,
) -> None:
    segments = _lyrics_segments()
    lyrics = session.get(LyricsTranscript, project.id)
    if lyrics is None:
        lyrics = LyricsTranscript(project_id=project.id)
        session.add(lyrics)

    lyrics.backend = "fixture"
    lyrics.source_artifact_id = source_artifact.id
    lyrics.source_kind = "fixture"
    lyrics.requested_device = None
    lyrics.device = None
    lyrics.model_name = "deterministic"
    lyrics.language = "en"
    lyrics.language_override = None
    lyrics.source_segments_json = deepcopy(segments)
    lyrics.segments_json = deepcopy(segments)
    lyrics.has_user_edits = False


def _upsert_chords(
    session: Session,
    *,
    project: Project,
    source_artifact: Artifact,
) -> None:
    segments = _chord_segments()
    chords = session.get(ChordTimeline, project.id)
    if chords is None:
        chords = ChordTimeline(project_id=project.id)
        session.add(chords)

    chords.backend = "fixture"
    chords.source_artifact_id = source_artifact.id
    chords.source_segments_json = deepcopy(segments)
    chords.segments_json = deepcopy(segments)
    chords.timeline_json = deepcopy(segments)
    chords.source_kind = "generated"
    chords.metadata_json = {
        "backend_id": "fixture",
        "backend_label": "Deterministic Fixture",
        "bpm": FIXTURE_BPM,
    }
    chords.has_user_edits = False


def _replace_sections(session: Session, *, project: Project) -> None:
    existing_sections = list(
        session.scalars(
            select(SongSection)
            .where(SongSection.project_id == project.id)
            .where(SongSection.source == "fixture")
        )
    )
    for section in existing_sections:
        session.delete(section)
    session.flush()

    for label, start_seconds, end_seconds in (
        ("Intro", 0.0, 4.0),
        ("Verse", 4.0, 16.0),
        ("Chorus", 16.0, 28.0),
        ("Bridge", 28.0, 34.0),
        ("Outro", 34.0, FIXTURE_DURATION_SECONDS),
    ):
        session.add(
            SongSection(
                id=new_id("sec"),
                project_id=project.id,
                label=label,
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                source="fixture",
                metadata_json={"fixture": True},
            )
        )


def _timing_payload() -> dict[str, Any]:
    beat_seconds = 60.0 / FIXTURE_BPM
    total_beats = int(FIXTURE_DURATION_SECONDS / beat_seconds)
    beats = [
        {
            "index": index,
            "seconds": round(index * beat_seconds, 6),
            "bar_index": index // BEATS_PER_BAR,
            "beat_in_bar": (index % BEATS_PER_BAR) + 1,
        }
        for index in range(total_beats)
    ]
    bars = [
        {
            "index": bar_index,
            "start_seconds": round(bar_index * BEATS_PER_BAR * beat_seconds, 6),
            "end_seconds": round(
                min((bar_index + 1) * BEATS_PER_BAR * beat_seconds, FIXTURE_DURATION_SECONDS),
                6,
            ),
        }
        for bar_index in range(math.ceil(total_beats / BEATS_PER_BAR))
    ]
    return {
        "beats_per_bar": BEATS_PER_BAR,
        "source": "fixture",
        "meter": "4/4",
        "meter_confidence": 1.0,
        "downbeat_source": "fixture",
        "downbeat_confidence": 1.0,
        "beats": beats,
        "bars": bars,
    }


def _lyrics_segments() -> list[dict[str, Any]]:
    return [
        _lyric_segment(0.5, 4.5, "Count in steady"),
        _lyric_segment(4.5, 8.5, "Verse line one"),
        _lyric_segment(8.5, 12.5, "Verse line two"),
        _lyric_segment(12.5, 16.5, "Lift into chorus"),
        _lyric_segment(16.5, 21.0, "Chorus anchor phrase"),
        _lyric_segment(21.0, 25.5, "Chorus answer phrase"),
        _lyric_segment(28.0, 32.5, "Bridge opens wide"),
        _lyric_segment(34.0, 38.5, "Outro lands clean"),
    ]


def _lyric_segment(start_seconds: float, end_seconds: float, text: str) -> dict[str, Any]:
    words = text.split()
    word_duration = (end_seconds - start_seconds) / max(1, len(words))
    return {
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "text": text,
        "words": [
            {
                "text": word,
                "start_seconds": round(start_seconds + index * word_duration, 6),
                "end_seconds": round(start_seconds + (index + 1) * word_duration, 6),
                "confidence": 1.0,
            }
            for index, word in enumerate(words)
        ],
    }


def _chord_segments() -> list[dict[str, Any]]:
    progression = (
        ("C", "C", 0, "major"),
        ("G", "G", 7, "major"),
        ("Am", "Am", 9, "minor"),
        ("F", "F", 5, "major"),
    )
    segments: list[dict[str, Any]] = []
    segment_seconds = 4.0
    for index in range(int(FIXTURE_DURATION_SECONDS / segment_seconds)):
        label, display_label, pitch_class, quality = progression[index % len(progression)]
        start_seconds = index * segment_seconds
        segments.append(
            {
                "start_seconds": start_seconds,
                "end_seconds": min(start_seconds + segment_seconds, FIXTURE_DURATION_SECONDS),
                "label": label,
                "display_label": display_label,
                "raw_label": label,
                "confidence": 0.98,
                "pitch_class": pitch_class,
                "root_pitch_class": pitch_class,
                "quality": quality,
            }
        )
    return segments


def _build_summary(
    *,
    project: Project,
    data_dir: Path,
    work_dir: Path,
    source_path: Path,
) -> dict[str, Any]:
    return {
        "app_url_path": f"/#/projects/{project.id}",
        "bpm": FIXTURE_BPM,
        "data_dir": str(data_dir),
        "duration_seconds": project.duration_seconds or FIXTURE_DURATION_SECONDS,
        "project_id": project.id,
        "project_name": project.display_name,
        "source_path": str(source_path),
        "work_dir": str(work_dir),
    }


if __name__ == "__main__":
    raise SystemExit(main())
