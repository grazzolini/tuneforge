from __future__ import annotations

from pathlib import Path

from app.engines.lyrics import LyricsTranscription
from app.services.tabs import _match_tab_lyrics_to_segments

from .conftest import wait_for_job


def _install_lyrics_fixture(monkeypatch) -> None:
    def fake_transcription(*_args, **_kwargs):
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device="cpu",
            device="cpu",
            model="turbo",
            language="en",
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 8.0,
                    "text": "Hello from the first line",
                    "words": [
                        {"text": "Hello", "start_seconds": 0.0, "end_seconds": 1.0, "confidence": 0.9},
                        {"text": "from", "start_seconds": 1.0, "end_seconds": 2.0, "confidence": 0.9},
                        {"text": "the", "start_seconds": 2.0, "end_seconds": 3.0, "confidence": 0.9},
                        {"text": "first", "start_seconds": 3.0, "end_seconds": 4.5, "confidence": 0.9},
                        {"text": "line", "start_seconds": 4.5, "end_seconds": 6.0, "confidence": 0.9},
                    ],
                },
                {
                    "start_seconds": 8.0,
                    "end_seconds": 16.0,
                    "text": "Second lyric line stays steady",
                    "words": [
                        {"text": "Second", "start_seconds": 8.0, "end_seconds": 9.4, "confidence": 0.9},
                        {"text": "lyric", "start_seconds": 9.4, "end_seconds": 10.8, "confidence": 0.9},
                        {"text": "line", "start_seconds": 10.8, "end_seconds": 12.0, "confidence": 0.9},
                        {"text": "stays", "start_seconds": 12.0, "end_seconds": 13.4, "confidence": 0.9},
                        {"text": "steady", "start_seconds": 13.4, "end_seconds": 15.2, "confidence": 0.9},
                    ],
                },
            ],
        )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)


def _create_project_with_lyrics(client, monkeypatch, sample_audio_file: Path) -> dict:
    _install_lyrics_fixture(monkeypatch)
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]
    job = client.post(f"/api/v1/projects/{project['id']}/lyrics", json={"force": False}).json()["job"]
    assert wait_for_job(client, job["id"])["status"] == "completed"
    return project


def _suggestions_by_kind(tab_import: dict) -> dict[str, list[dict]]:
    return {group["kind"]: group["suggestions"] for group in tab_import["groups"]}


def test_tab_import_creates_suggestions_without_mutating_project(client, monkeypatch, sample_audio_file: Path):
    project = _create_project_with_lyrics(client, monkeypatch, sample_audio_file)
    raw_tab = """{key: D}
[Verse 1]
F#       G#
Hello from the fast line
[Chorus]
[A#m]Second lyric line stays steady
[Chorus 2]
Extra outro line
"""

    response = client.post(
        f"/api/v1/projects/{project['id']}/tabs/proposals",
        json={"raw_text": raw_tab},
    )

    assert response.status_code == 200
    tab_import = response.json()["tab_import"]
    assert tab_import["raw_text"] == raw_tab
    groups = _suggestions_by_kind(tab_import)
    assert groups["lyrics"][0]["suggested_text"] == "Hello from the fast line"
    assert groups["lyrics"][-1]["suggested_text"] == "Extra outro line"
    assert [suggestion["suggested_text"] for suggestion in groups["chords"]][:3] == ["F#", "G#", "A#m"]
    assert [suggestion["suggested_text"] for suggestion in groups["sections"]] == [
        "Verse 1",
        "Chorus",
        "Chorus 2",
    ]
    assert groups["key"][0]["payload"]["source_key_override"] == "2:major"

    lyrics = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert lyrics["segments"][0]["text"] == "Hello from the first line"
    assert client.get(f"/api/v1/projects/{project['id']}").json()["project"]["source_key_override"] is None


def test_tab_lyric_alignment_prefers_tab_order_over_greedy_best_match():
    tab_lyrics = [
        {"text": "verse one hello brave world"},
        {"text": "verse one hello brave world"},
    ]
    lyrics_segments = [
        {"text": "verse one hello world"},
        {"text": "verse one hello brave world"},
    ]

    assert _match_tab_lyrics_to_segments(tab_lyrics, lyrics_segments) == {0: 0, 1: 1}


def test_tab_import_filters_rich_chord_sheet_noise_before_alignment(client, monkeypatch, sample_audio_file: Path):
    project = _create_project_with_lyrics(client, monkeypatch, sample_audio_file)
    raw_tab = """Synthetic Song
Example Artist
Chord sheet print view
Tom: D (shape chords in C)
Capo on 2nd fret
Tuning: E A D G B E
[Intro] Em

[Tab - Intro]
Part 1 of 2
   Em          A
E|----------------|
B|----------------|
G|----------------|
D|--2-2-2---------|
A|----------------|
E|----------------|

( A  G  D/F# )

[Verse 1]
F#       G#
Hello from the fast line
Page 1 / 2
[Chorus]
[A#m]Second lyric line stays steady

Composition by Example Writer. Report wrong info.
"""

    response = client.post(
        f"/api/v1/projects/{project['id']}/tabs/proposals",
        json={"raw_text": raw_tab},
    )

    assert response.status_code == 200
    tab_import = response.json()["tab_import"]
    assert tab_import["raw_text"] == raw_tab
    groups = _suggestions_by_kind(tab_import)
    assert [suggestion["suggested_text"] for suggestion in groups["lyrics"]] == ["Hello from the fast line"]
    assert {suggestion["suggested_text"] for suggestion in groups["chords"]} >= {"F#", "G#", "A#m"}
    assert [suggestion["suggested_text"] for suggestion in groups["sections"]] == [
        "Intro",
        "Verse 1",
        "Chorus",
    ]
    assert groups["key"][0]["payload"]["source_key_override"] == "2:major"
    ignored_reasons = {line["reason"] for line in tab_import["parsed"]["lines"] if line["type"] == "ignored"}
    assert ignored_reasons >= {"preamble", "metadata", "tablature_marker", "tablature_staff", "print_marker", "footer"}


def test_tab_import_is_single_project_scoped_record(client, monkeypatch, sample_audio_file: Path):
    project = _create_project_with_lyrics(client, monkeypatch, sample_audio_file)
    first = client.post(
        f"/api/v1/projects/{project['id']}/tabs/proposals",
        json={"raw_text": "Key: D\n[Verse]\nHello from the fast line\n"},
    ).json()["tab_import"]
    second_raw = "Key: E\n[Chorus]\nSecond lyric line stays steady\n"
    second = client.post(
        f"/api/v1/projects/{project['id']}/tabs/proposals",
        json={"raw_text": second_raw},
    ).json()["tab_import"]

    assert second["id"] == first["id"]
    assert second["raw_text"] == second_raw
    detail = client.get(f"/api/v1/projects/{project['id']}/tabs/{first['id']}").json()["tab_import"]
    assert detail["raw_text"] == second_raw


def test_tab_import_acceptance_applies_only_selected_suggestions(client, monkeypatch, sample_audio_file: Path):
    project = _create_project_with_lyrics(client, monkeypatch, sample_audio_file)
    raw_tab = """Key: D
[Verse]
F#      G#
Hello from the fast line
"""
    tab_import = client.post(
        f"/api/v1/projects/{project['id']}/tabs/proposals",
        json={"raw_text": raw_tab},
    ).json()["tab_import"]
    groups = _suggestions_by_kind(tab_import)
    accepted_ids = [
        groups["lyrics"][0]["id"],
        groups["chords"][0]["id"],
        groups["sections"][0]["id"],
    ]
    accepted_chord_label = groups["chords"][0]["suggested_text"]

    applied = client.post(
        f"/api/v1/projects/{project['id']}/tabs/{tab_import['id']}/accept",
        json={"accepted_suggestion_ids": accepted_ids},
    ).json()

    assert applied["accepted_suggestion_ids"] == accepted_ids
    assert applied["project"]["source_key_override"] is None
    lyrics = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert lyrics["segments"][0]["text"] == "Hello from the fast line"
    assert [word["text"] for word in lyrics["segments"][0]["words"]] == ["Hello", "from", "the", "fast", "line"]
    assert lyrics["segments"][0]["words"][3]["start_seconds"] == 3.0

    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert chords["has_user_edits"] is True
    assert chords["source_kind"] == "user-edited"
    assert accepted_chord_label in {segment["label"] for segment in chords["timeline"]}

    sections = client.get(f"/api/v1/projects/{project['id']}/sections").json()["sections"]
    assert sections[0]["label"] == "Verse"
    assert sections[0]["start_seconds"] == 0.0


def test_lyrics_refresh_clears_current_tab_state(client, monkeypatch, sample_audio_file: Path):
    project = _create_project_with_lyrics(client, monkeypatch, sample_audio_file)
    tab_import = client.post(
        f"/api/v1/projects/{project['id']}/tabs/proposals",
        json={"raw_text": "Key: D\n[Verse]\nF#\nHello from the fast line\n"},
    ).json()["tab_import"]
    groups = _suggestions_by_kind(tab_import)
    client.post(
        f"/api/v1/projects/{project['id']}/tabs/{tab_import['id']}/accept",
        json={"accepted_suggestion_ids": [groups["sections"][0]["id"]]},
    )
    assert client.get(f"/api/v1/projects/{project['id']}/sections").json()["sections"]

    job = client.post(f"/api/v1/projects/{project['id']}/lyrics", json={"force": True}).json()["job"]
    assert wait_for_job(client, job["id"])["status"] == "completed"

    assert client.get(f"/api/v1/projects/{project['id']}/tabs/{tab_import['id']}").status_code == 404
    assert client.get(f"/api/v1/projects/{project['id']}/sections").json()["sections"] == []
