"""Synthetic Python producers/exporters exercised by the native reconciliation regression tests."""

from __future__ import annotations

import argparse
import json
import math
import os
import time
import wave
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal, run_migrations
from app.engines.lyrics import LyricsTranscription
from app.models import AnalysisResult, Artifact, ChordTimeline, LyricsTranscript
from app.services import analysis, chords, lyrics, stems
from app.services.chord_backends import ChordDetectionResult, CremaChordBackend, FastChordBackend
from app.services.projects import import_project
from app.services.stem_models import STEM_MODELS
from app.services.sync_bundle import export_sync_bundle
from app.services.sync_reconciliation_apply import apply_sync_reconciliation
from app.services.sync_revisions import materialize_result_revisions


def write_tone(path: Path, hz: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(
            b"".join(
                int(8000 * math.sin(2 * math.pi * hz * index / 8000)).to_bytes(2, "little", signed=True)
                for index in range(4000)
            )
        )


def build(root: Path, *, count: int, variant: str) -> None:
    assert get_settings().data_root == (root / "backend-data").resolve()
    assert Path(os.environ["TUNEFORGE_SYNC_TRANSPORT_DATA_DIR"]).resolve() == (root / "transport-data").resolve()
    started = time.perf_counter()
    run_migrations()
    metrics = {"empty_migration_ms": round((time.perf_counter() - started) * 1000, 2)}
    advanced = False

    def separate(_source, plan, **_kwargs):
        for index, item in enumerate(plan):
            write_tone(item.path, 210 + index * 37 + (100 if advanced else 0))
        return {}

    def analyze(*_args, **_kwargs):
        return {
            "estimated_key": "G major" if advanced else "C major",
            "key_confidence": 0.9,
            "estimated_reference_hz": 441.0 if advanced else 440.0,
            "tuning_offset_cents": 1.0 if advanced else 0.0,
            "tempo_bpm": 128.0 if advanced else 100.0,
            "timing": {"beats_per_bar": 4, "source": "beat-this" if advanced else "built-in", "beats": [], "bars": []},
        }

    def detect(_source, backend_id):
        return ChordDetectionResult(
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 0.5,
                    "label": "G" if backend_id == "crema-advanced" else "C",
                    "confidence": 0.8,
                }
            ],
            backend_id=backend_id,
            metadata={"fixture": "synthetic"},
            runtime_device="cpu",
        )

    def transcribe(*_args, **_kwargs):
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device="cpu",
            device="cpu",
            model="turbo",
            language="pt",
            segments=[
                {"start_seconds": 0.0, "end_seconds": 0.5, "text": "Canção 🎵" if advanced else "Synthetic lyric"}
            ],
        )

    with (
        patch.object(stems, "resolve_stem_model", lambda requested, **_kwargs: STEM_MODELS[requested]),
        patch.object(stems, "_separate_with_model", separate),
        patch.object(
            chords,
            "resolve_chord_backend",
            lambda backend, **_kwargs: CremaChordBackend() if backend == "crema-advanced" else FastChordBackend(),
        ),
        patch.object(chords, "_detect_timeline", detect),
        patch.object(analysis, "_analyze_track_with_backend", analyze),
        patch.object(analysis, "utcnow", lambda: datetime(2026, 1, 2 if advanced else 1, tzinfo=UTC)),
        patch.object(lyrics, "transcribe_project_lyrics", transcribe),
        SessionLocal() as session,
    ):
        projects = []
        for index in range(count):
            source = root / f"synthetic-{index}.wav"
            write_tone(source, 350 + index)
            project = import_project(
                session,
                source_path=str(source),
                copy_into_project=True,
                display_name=f"Synthetic {index}",
                output_format="m4a",
            )
            session.commit()
            session.refresh(project)
            source_artifact = next(item for item in project.artifacts if item.type == "source_audio")
            if count == 1:
                stems.generate_stems(
                    session,
                    project=project,
                    source_artifact_id=source_artifact.id,
                    output_format="m4a",
                    force=True,
                    stem_model="htdemucs_ft",
                )
                session.commit()
            analysis.analyze_project(session, project, beat_backend="built-in")
            chords.detect_project_chords(session, project, backend="tuneforge-fast", force=True)
            lyrics.generate_project_lyrics(session, project=project, force=True)
            session.commit()
            projects.append(project)
        ids = [project.id for project in projects]
        started = time.perf_counter()
        export_sync_bundle(session, bundle_root=root / "baseline", project_ids=ids)
        metrics["baseline_export_ms"] = round((time.perf_counter() - started) * 1000, 2)
        session.commit()
        advanced = True
        for project in projects:
            session.refresh(project)
            source = next(item for item in project.artifacts if item.type == "source_audio")
            if variant in {"stems", "chords-stems", "combined"}:
                stems.generate_stems(
                    session,
                    project=project,
                    source_artifact_id=source.id,
                    output_format="m4a",
                    force=True,
                    stem_model="htdemucs_6s",
                )
                session.commit()
            if variant in {"analysis", "combined"}:
                analysis.analyze_project(session, project, beat_backend="beat-this")
            if variant in {"chords", "chords-stems", "combined"}:
                chords.detect_project_chords(session, project, backend="crema-advanced", force=True)
            if variant == "combined":
                lyrics.generate_project_lyrics(session, project=project, force=True)
            session.commit()
        started = time.perf_counter()
        export_sync_bundle(session, bundle_root=root / "changed", project_ids=ids)
        metrics["changed_export_ms"] = round((time.perf_counter() - started) * 1000, 2)
        session.commit()
        assert not session.scalar(select(Artifact.id).where(Artifact.type == "analysis_json"))
        started = time.perf_counter()
        assert len(list(session.scalars(select(AnalysisResult)))) == count
        assert len(list(session.scalars(select(ChordTimeline)))) == count
        assert len(list(session.scalars(select(LyricsTranscript)))) == count
        metrics["result_reads_ms"] = round((time.perf_counter() - started) * 1000, 2)
        metrics["bundle_bytes"] = sum(path.stat().st_size for path in (root / "changed").rglob("*") if path.is_file())
        (root / "expected.json").write_text(json.dumps({"project_ids": ids, "variant": variant, "metrics": metrics}))
        print(json.dumps({"projects": count, "variant": variant, "metrics": metrics}))


def verify_native(root: Path, manifest_path: Path) -> None:
    manifest = json.loads(manifest_path.read_text())
    with SessionLocal() as session:
        request = {
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": manifest["artifacts"],
                "entity_revisions": manifest["entity_revisions"],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "use_content_addressed_staging": True,
        }
        result = apply_sync_reconciliation(session, request)
        assert result.summary.failed_actions == 0
        session.commit()
        project_id = manifest["project"]["project_id"]
        assert session.get(AnalysisResult, project_id).estimated_reference_hz == 432.0, result
        assert session.get(ChordTimeline, project_id).segments_json[0]["label"] == "Dm"
        assert session.get(LyricsTranscript, project_id).segments_json[0]["text"] == "Native canção\x7f 🎵", result
        materialize_result_revisions(session)
        session.commit()
        replay = apply_sync_reconciliation(session, request)
        assert replay.summary.failed_actions == 0
        assert session.get(AnalysisResult, project_id).estimated_reference_hz == 432.0
        assert replay.plan.summary.total_conflicts == 0
        export_sync_bundle(session, bundle_root=root / "native-return", project_ids=[project_id])
        session.commit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument(
        "--variant", choices=["analysis", "chords", "stems", "chords-stems", "combined"], default="combined"
    )
    parser.add_argument("--verify-native", type=Path)
    args = parser.parse_args()
    if args.verify_native:
        verify_native(args.root, args.verify_native)
    else:
        build(args.root, count=args.count, variant=args.variant)
