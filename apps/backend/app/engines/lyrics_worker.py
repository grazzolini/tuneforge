from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from app.engines.lyrics import (
    lyrics_transcription_to_payload,
    transcribe_project_lyrics_in_process,
)
from app.errors import AppError


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe lyrics with Whisper.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--requested-device", required=True)
    parser.add_argument("--download-root", required=True)
    return parser.parse_args()


def _print_payload(payload: dict[str, Any]) -> None:
    print(json.dumps(payload), flush=True)


def main() -> None:
    args = parse_args()
    try:
        transcription = transcribe_project_lyrics_in_process(
            Path(args.source),
            model_name=args.model,
            requested_device=args.requested_device,
            download_root=Path(args.download_root),
        )
        _print_payload(
            {
                "ok": True,
                "transcription": lyrics_transcription_to_payload(transcription),
            }
        )
    except AppError as exc:
        _print_payload(
            {
                "ok": False,
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "status_code": exc.status_code,
                    "details": exc.details,
                },
            }
        )
        raise SystemExit(1) from exc
    except Exception as exc:
        _print_payload(
            {
                "ok": False,
                "error": {
                    "code": "PROCESSING_FAILED",
                    "message": "Lyrics generation failed.",
                    "status_code": 500,
                    "details": {"message": str(exc)},
                },
            }
        )
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
