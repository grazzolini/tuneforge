from __future__ import annotations

import re
import unicodedata
from copy import deepcopy
from difflib import SequenceMatcher
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.chord_labels import chord_label_to_segment, parse_chord_label
from app.errors import AppError
from app.models import ChordTimeline, LyricsTranscript, Project, SongSection, TabImport, utcnow
from app.services.lyrics import persist_project_lyrics_segments, retime_lyrics_segment_text
from app.utils.ids import new_id

PARSER_VERSION = "v1"
SECTION_LABELS = {
    "final",
    "intro",
    "verse",
    "verso",
    "parte",
    "primeira parte",
    "segunda parte",
    "terceira parte",
    "quarta parte",
    "pre-chorus",
    "pre chorus",
    "pre-refrao",
    "pre refrao",
    "chorus",
    "refrao",
    "refrao final",
    "refrain",
    "bridge",
    "solo",
    "instrumental",
    "interludio",
    "outro",
    "coda",
}
CHORDPRO_SECTION_ALIASES = {
    "soc": "Chorus",
    "start_of_chorus": "Chorus",
    "sov": "Verse",
    "start_of_verse": "Verse",
    "sob": "Bridge",
    "start_of_bridge": "Bridge",
}
DIRECTIVE_RE = re.compile(r"^\{\s*([^}:]+)\s*:?\s*([^}]*)\}\s*$")
INLINE_CHORD_RE = re.compile(r"\[([^\]]+)\]")
KEY_RE = re.compile(
    r"\b(?:key|tom|tone|tonality)\s*[:=-]\s*([A-Ga-g](?:#|b)?\s*(?:m|min|minor|major)?)\b",
    re.IGNORECASE,
)
WORD_RE = re.compile(r"\S+")
TAB_STAFF_RE = re.compile(r"^\s*(?:[eEABGD]|[1-6])\|")
PRINT_MARKER_RE = re.compile(r"^(?:page|pagina)\s+\d+\s*/\s*\d+$")
PART_MARKER_RE = re.compile(r"^(?:part|parte)\s+\d+\s+(?:of|de)\s+\d+(?:\s*[-–]\s*\d+x)?$")
METADATA_PREFIXES = {
    "afinacao",
    "artist",
    "capo",
    "capotraste",
    "cifra",
    "composition",
    "composicao",
    "guitar",
    "song",
    "title",
    "tuning",
    "violao",
}
FOOTER_PREFIXES = {
    "composition by",
    "composicao de",
    "copyright",
    "written by",
}


def create_tab_import(session: Session, *, project: Project, raw_text: str) -> TabImport:
    parsed = parse_tab_text(raw_text)
    proposal = build_tab_proposal(project, parsed)
    tab_import = session.scalar(select(TabImport).where(TabImport.project_id == project.id))
    if tab_import is None:
        tab_import = TabImport(id=new_id("tab"), project_id=project.id)
        session.add(tab_import)
    tab_import.raw_text = raw_text
    tab_import.parser_version = PARSER_VERSION
    tab_import.status = "proposed"
    tab_import.parsed_json = parsed
    tab_import.proposal_json = proposal
    tab_import.updated_at = utcnow()
    session.flush()
    session.refresh(tab_import)
    return tab_import


def get_tab_import(session: Session, *, project_id: str, tab_import_id: str) -> TabImport:
    tab_import = session.get(TabImport, tab_import_id)
    if tab_import is None or tab_import.project_id != project_id:
        raise AppError("TAB_IMPORT_NOT_FOUND", "Tab import not found.", status_code=404)
    return tab_import


def list_project_sections(session: Session, *, project_id: str) -> list[SongSection]:
    return list(
        session.scalars(
            select(SongSection)
            .where(SongSection.project_id == project_id)
            .order_by(SongSection.start_seconds.is_(None), SongSection.start_seconds, SongSection.created_at)
        )
    )


def apply_tab_suggestions(
    session: Session,
    *,
    project: Project,
    tab_import: TabImport,
    accepted_suggestion_ids: list[str],
) -> dict[str, Any]:
    accepted = set(accepted_suggestion_ids)
    suggestions = _flatten_suggestions(tab_import.proposal_json)
    accepted_suggestions = [suggestion for suggestion in suggestions if suggestion["id"] in accepted]
    accepted_ids = [suggestion["id"] for suggestion in accepted_suggestions]
    ignored_ids = sorted(accepted - set(accepted_ids))

    lyrics = _apply_lyric_suggestions(session, project, accepted_suggestions)
    chords = _apply_chord_suggestions(session, project, accepted_suggestions)
    sections = _apply_section_suggestions(session, project, tab_import, accepted_suggestions)
    _apply_key_suggestions(project, accepted_suggestions)

    now = utcnow()
    tab_import.status = "applied" if accepted_ids else "reviewed"
    tab_import.updated_at = now
    tab_import.proposal_json = _mark_suggestions(tab_import.proposal_json, set(accepted_ids))
    session.flush()
    session.refresh(tab_import)
    if lyrics is not None:
        session.refresh(lyrics)
    if chords is not None:
        session.refresh(chords)
    for section in sections:
        session.refresh(section)

    return {
        "tab_import": tab_import,
        "accepted_suggestion_ids": accepted_ids,
        "ignored_suggestion_ids": ignored_ids,
        "lyrics": lyrics,
        "chords": chords,
        "sections": sections,
        "project": project,
    }


def parse_tab_text(raw_text: str) -> dict[str, Any]:
    parsed_lines: list[dict[str, Any]] = []
    lines = raw_text.splitlines()
    index = 0
    while index < len(lines):
        raw_line = lines[index].rstrip()
        stripped = raw_line.strip()
        if not stripped:
            index += 1
            continue

        key = _parse_key(stripped)
        if key is not None:
            parsed_lines.append({"type": "key", "key": key, "line_number": index + 1, "raw": raw_line})
            index += 1
            continue

        if _is_tab_marker(stripped):
            parsed_lines.append(
                {"type": "ignored", "reason": "tablature_marker", "line_number": index + 1, "raw": raw_line}
            )
            index += 1
            continue

        directive = _parse_directive(stripped)
        if directive is not None:
            parsed_lines.append({**directive, "line_number": index + 1, "raw": raw_line})
            index += 1
            continue

        section = _parse_section(stripped)
        if section is not None:
            parsed_lines.append({"type": "section", "label": section, "line_number": index + 1, "raw": raw_line})
            index += 1
            continue

        ignored_reason = _ignored_line_reason(stripped, line_index=index, lines=lines)
        if ignored_reason is not None:
            parsed_lines.append(
                {"type": "ignored", "reason": ignored_reason, "line_number": index + 1, "raw": raw_line}
            )
            index += 1
            continue

        parenthetical_chords = _parse_parenthetical_chords(stripped)
        if parenthetical_chords:
            parsed_lines.append(
                {
                    "type": "chords",
                    "chords": parenthetical_chords,
                    "line_number": index + 1,
                    "raw": raw_line,
                }
            )
            index += 1
            continue

        inline = _parse_inline_chords(raw_line)
        if inline is not None:
            parsed_lines.append({**inline, "line_number": index + 1, "raw": raw_line})
            index += 1
            continue

        chord_positions = _parse_chord_line(raw_line)
        if chord_positions:
            lyric_index = _next_line_index_for_chord_pair(lines, index + 1)
            if lyric_index is not None:
                lyric_line = lines[lyric_index].rstrip()
                parsed_lines.append(
                    {
                        "type": "lyrics",
                        "text": lyric_line.strip(),
                        "line_number": lyric_index + 1,
                        "raw": lyric_line,
                        "chords": _anchor_chords_to_lyrics(chord_positions, lyric_line),
                    }
                )
                index = lyric_index + 1
                continue
            parsed_lines.append(
                {
                    "type": "chords",
                    "chords": chord_positions,
                    "line_number": index + 1,
                    "raw": raw_line,
                }
            )
            index += 1
            continue

        if _looks_like_lyric_line(stripped):
            parsed_lines.append(
                {"type": "lyrics", "text": stripped, "line_number": index + 1, "raw": raw_line, "chords": []}
            )
        else:
            parsed_lines.append({"type": "ignored", "reason": "noise", "line_number": index + 1, "raw": raw_line})
        index += 1

    return {
        "version": PARSER_VERSION,
        "lines": parsed_lines,
        "lyrics": [line for line in parsed_lines if line["type"] == "lyrics"],
        "sections": [line for line in parsed_lines if line["type"] == "section"],
        "keys": [line for line in parsed_lines if line["type"] == "key"],
    }


def build_tab_proposal(project: Project, parsed: dict[str, Any]) -> dict[str, Any]:
    lyrics_segments = _current_lyrics_segments(project)
    lyric_matches = _match_tab_lyrics_to_segments(parsed.get("lyrics", []), lyrics_segments)
    lyric_suggestions = _build_lyric_suggestions(parsed.get("lyrics", []), lyrics_segments, lyric_matches)
    chord_suggestions = _build_chord_suggestions(
        parsed.get("lyrics", []),
        lyrics_segments,
        lyric_matches,
        project.chords,
    )
    section_suggestions = _build_section_suggestions(
        parsed.get("sections", []),
        parsed.get("lyrics", []),
        lyrics_segments,
        lyric_matches,
    )
    key_suggestions = _build_key_suggestions(parsed.get("keys", []), project)

    groups = [
        {"kind": "lyrics", "label": "Lyrics", "suggestions": lyric_suggestions},
        {"kind": "chords", "label": "Chords", "suggestions": chord_suggestions},
        {"kind": "sections", "label": "Sections", "suggestions": section_suggestions},
        {"kind": "key", "label": "Key", "suggestions": key_suggestions},
    ]
    return {"groups": groups}


def _ignored_line_reason(line: str, *, line_index: int, lines: list[str]) -> str | None:
    folded = _fold_text(line).lower().strip()
    if TAB_STAFF_RE.match(line):
        return "tablature_staff"
    if _is_tab_marker(line):
        return "tablature_marker"
    if PART_MARKER_RE.match(folded):
        return "tablature_part_marker"
    if PRINT_MARKER_RE.match(folded):
        return "print_marker"
    if _is_footer_line(folded):
        return "footer"
    if _is_metadata_line(folded):
        return "metadata"
    if _is_likely_preamble_line(line, line_index=line_index, lines=lines):
        return "preamble"
    return None


def _is_tab_marker(line: str) -> bool:
    folded = _fold_text(line).lower().strip()
    return bool(
        re.match(r"^\[\s*tab\b", folded)
        or re.match(r"^tab\s*[-:]", folded)
        or folded in {"tablature", "tablatura"}
    )


def _is_metadata_line(folded_line: str) -> bool:
    prefix = re.split(r"\s*[:=-]\s*", folded_line, maxsplit=1)[0].strip()
    if prefix in METADATA_PREFIXES:
        return True
    return any(folded_line.startswith(f"{metadata_prefix} ") for metadata_prefix in METADATA_PREFIXES)


def _is_footer_line(folded_line: str) -> bool:
    return any(folded_line.startswith(prefix) for prefix in FOOTER_PREFIXES) or "information is wrong" in folded_line


def _is_likely_preamble_line(line: str, *, line_index: int, lines: list[str]) -> bool:
    if line_index > 2 or not _looks_like_lyric_line(line):
        return False
    if _parse_key(line) is not None or _parse_section(line) is not None:
        return False
    if _parse_parenthetical_chords(line) or _parse_chord_line(line):
        return False
    upcoming = [candidate.strip() for candidate in lines[line_index + 1 : line_index + 8] if candidate.strip()]
    return any(
        _parse_key(candidate) is not None
        or _parse_section(candidate) is not None
        or _is_tab_marker(candidate)
        or _parse_chord_line(candidate)
        or _ignored_line_reason_without_preamble(candidate) is not None
        for candidate in upcoming
    )


def _ignored_line_reason_without_preamble(line: str) -> str | None:
    folded = _fold_text(line).lower().strip()
    if TAB_STAFF_RE.match(line):
        return "tablature_staff"
    if _is_tab_marker(line):
        return "tablature_marker"
    if PART_MARKER_RE.match(folded):
        return "tablature_part_marker"
    if PRINT_MARKER_RE.match(folded):
        return "print_marker"
    if _is_footer_line(folded):
        return "footer"
    if _is_metadata_line(folded):
        return "metadata"
    return None


def _next_line_index_for_chord_pair(lines: list[str], start_index: int) -> int | None:
    index = start_index
    while index < len(lines):
        candidate = lines[index].rstrip()
        stripped = candidate.strip()
        if not stripped or PRINT_MARKER_RE.match(_fold_text(stripped).lower()):
            index += 1
            continue
        if _ignored_line_reason_without_preamble(stripped) is not None:
            return None
        if _parse_key(stripped) is not None or _parse_section(stripped) is not None:
            return None
        if _parse_chord_line(candidate):
            return None
        return index if _looks_like_lyric_line(stripped) else None
    return None


def _looks_like_lyric_line(line: str) -> bool:
    folded = _fold_text(line)
    if not re.search(r"[A-Za-z]", folded):
        return False
    symbol_count = len(re.findall(r"[-|_/\\]", line))
    return symbol_count <= max(3, len(line) // 3)


def _parse_directive(line: str) -> dict[str, Any] | None:
    match = DIRECTIVE_RE.match(line)
    if not match:
        return None
    name = match.group(1).strip().lower()
    value = match.group(2).strip()
    if name in {"key", "meta-key"}:
        key = _parse_key(value)
        return {"type": "key", "key": key} if key is not None else None
    if name in CHORDPRO_SECTION_ALIASES:
        return {"type": "section", "label": CHORDPRO_SECTION_ALIASES[name]}
    if name in {"start_of_tab", "end_of_tab", "eot", "end_of_chorus", "eoc", "end_of_verse", "eov"}:
        return {"type": "directive", "name": name, "value": value}
    return None


def _parse_section(line: str) -> str | None:
    section_match = re.match(r"^\[\s*([^\]]+?)\s*\](?:\s+.*)?$", line)
    bracketed = section_match.group(1).strip() if section_match else line
    normalized = _normalize_section_label(bracketed)
    if normalized in SECTION_LABELS:
        return bracketed.strip()
    return None


def _parse_inline_chords(line: str) -> dict[str, Any] | None:
    chords: list[dict[str, Any]] = []
    lyric_parts: list[str] = []
    cursor = 0
    lyric_cursor = 0
    for match in INLINE_CHORD_RE.finditer(line):
        raw_chord = match.group(1).strip()
        if not _is_chord_token(raw_chord):
            continue
        before = line[cursor:match.start()]
        lyric_parts.append(before)
        lyric_cursor += len(before)
        chords.append({"label": raw_chord, "column": lyric_cursor, "word_index": None})
        cursor = match.end()

    if not chords:
        return None
    lyric_parts.append(line[cursor:])
    lyric_text = "".join(lyric_parts).strip()
    if not lyric_text:
        return None
    return {
        "type": "lyrics",
        "text": lyric_text,
        "chords": _anchor_chords_to_lyrics(chords, lyric_text),
    }


def _parse_chord_line(line: str) -> list[dict[str, Any]]:
    tokens = list(re.finditer(r"\S+", line))
    if not tokens:
        return []
    chord_tokens = [
        {"label": token.group(0), "column": token.start(), "word_index": None}
        for token in tokens
        if _is_chord_token(token.group(0))
    ]
    if len(chord_tokens) != len(tokens):
        return []
    return chord_tokens if len(chord_tokens) >= 1 else []


def _parse_parenthetical_chords(line: str) -> list[dict[str, Any]]:
    if not line.startswith("(") or not line.endswith(")"):
        return []
    inner = line[1:-1].strip()
    if not inner:
        return []
    chord_line = _parse_chord_line(inner)
    if not chord_line:
        return []
    return [{**chord, "column": chord["column"] + 1} for chord in chord_line]


def _anchor_chords_to_lyrics(chords: list[dict[str, Any]], lyric_line: str) -> list[dict[str, Any]]:
    word_matches = list(WORD_RE.finditer(lyric_line))
    anchored: list[dict[str, Any]] = []
    for chord in chords:
        column = int(chord.get("column", 0))
        word_index = 0
        for index, match in enumerate(word_matches):
            if match.start() <= column:
                word_index = index
        anchored.append({**chord, "word_index": word_index})
    return anchored


def _is_chord_token(token: str) -> bool:
    parsed = parse_chord_label(token)
    return not parsed.is_unknown


def _parse_key(value: str) -> dict[str, Any] | None:
    key_value = value.strip()
    key_match = KEY_RE.search(key_value)
    if key_match:
        key_value = key_match.group(1)
    match = re.match(r"^([A-Ga-g](?:#|b)?)(?:\s*(m|min|minor|major))?$", key_value.strip())
    if not match:
        return None
    root, mode_raw = match.groups()
    parsed_root = parse_chord_label(root)
    if parsed_root.root_pitch_class is None:
        return None
    mode = "minor" if mode_raw and mode_raw.lower() in {"m", "min", "minor"} else "major"
    return {
        "label": f"{root.strip()}{'m' if mode == 'minor' else ''}",
        "source_key_override": f"{parsed_root.root_pitch_class}:{mode}",
    }


def _current_lyrics_segments(project: Project) -> list[dict[str, Any]]:
    return deepcopy(project.lyrics.segments_json) if project.lyrics is not None else []


def _match_tab_lyrics_to_segments(
    tab_lyrics: list[dict[str, Any]],
    lyrics_segments: list[dict[str, Any]],
) -> dict[int, int]:
    if not tab_lyrics or not lyrics_segments:
        return {}

    threshold = 0.55
    scores = [
        [
            _text_similarity(str(tab_lyric.get("text", "")), str(lyrics_segment.get("text", "")))
            for lyrics_segment in lyrics_segments
        ]
        for tab_lyric in tab_lyrics
    ]
    tab_count = len(tab_lyrics)
    lyric_count = len(lyrics_segments)
    dp = [[0.0 for _ in range(lyric_count + 1)] for _ in range(tab_count + 1)]
    choice = [["" for _ in range(lyric_count + 1)] for _ in range(tab_count + 1)]

    for tab_index in range(1, tab_count + 1):
        for lyric_index in range(1, lyric_count + 1):
            best = dp[tab_index - 1][lyric_index]
            best_choice = "up"
            if dp[tab_index][lyric_index - 1] > best:
                best = dp[tab_index][lyric_index - 1]
                best_choice = "left"

            score = scores[tab_index - 1][lyric_index - 1]
            diagonal = dp[tab_index - 1][lyric_index - 1] + score if score >= threshold else -1.0
            if diagonal > best:
                best = diagonal
                best_choice = "diag"

            dp[tab_index][lyric_index] = best
            choice[tab_index][lyric_index] = best_choice

    matches: dict[int, int] = {}
    tab_index = tab_count
    lyric_index = lyric_count
    while tab_index > 0 and lyric_index > 0:
        current_choice = choice[tab_index][lyric_index]
        if current_choice == "diag":
            matches[tab_index - 1] = lyric_index - 1
            tab_index -= 1
            lyric_index -= 1
        elif current_choice == "left":
            lyric_index -= 1
        else:
            tab_index -= 1
    return dict(sorted(matches.items()))


def _build_lyric_suggestions(
    tab_lyrics: list[dict[str, Any]],
    lyrics_segments: list[dict[str, Any]],
    lyric_matches: dict[int, int],
) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    for tab_index, lyric in enumerate(tab_lyrics):
        suggested_text = str(lyric.get("text", "")).strip()
        segment_index = lyric_matches.get(tab_index)
        if segment_index is None:
            suggestions.append(
                _suggestion(
                    suggestion_id=f"lyrics-extra-{tab_index}",
                    kind="lyrics",
                    title="Additional tab lyric line",
                    current_text=None,
                    suggested_text=suggested_text,
                    payload={"action": "append_untimed_lyric", "text": suggested_text, "tab_line_index": tab_index},
                )
            )
            continue
        current = lyrics_segments[segment_index]
        current_text = str(current.get("text", ""))
        if _normalize_text(current_text) == _normalize_text(suggested_text):
            continue
        suggestions.append(
            _suggestion(
                suggestion_id=f"lyrics-{segment_index}-{tab_index}",
                kind="lyrics",
                title="Update lyric text",
                current_text=current_text,
                suggested_text=suggested_text,
                start_seconds=_float_or_none(current.get("start_seconds")),
                end_seconds=_float_or_none(current.get("end_seconds")),
                segment_index=segment_index,
                payload={"action": "replace_lyric_segment", "segment_index": segment_index, "text": suggested_text},
            )
        )
    return suggestions


def _build_chord_suggestions(
    tab_lyrics: list[dict[str, Any]],
    lyrics_segments: list[dict[str, Any]],
    lyric_matches: dict[int, int],
    chords: ChordTimeline | None,
) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    current_timeline = chords.segments_json if chords is not None else []
    for tab_index, lyric in enumerate(tab_lyrics):
        segment_index = lyric_matches.get(tab_index)
        if segment_index is None:
            continue
        segment = lyrics_segments[segment_index]
        for chord_index, chord in enumerate(lyric.get("chords", [])):
            chord_segment = _tab_chord_to_segment(chord, segment)
            if chord_segment is None:
                continue
            current_label = _current_chord_label_at(current_timeline, chord_segment["start_seconds"])
            if current_label == chord_segment["label"]:
                continue
            suggestions.append(
                _suggestion(
                    suggestion_id=f"chord-{segment_index}-{tab_index}-{chord_index}",
                    kind="chords",
                    title="Update chord marker",
                    current_text=current_label,
                    suggested_text=chord_segment["label"],
                    start_seconds=chord_segment["start_seconds"],
                    end_seconds=chord_segment["end_seconds"],
                    segment_index=segment_index,
                    chord_index=chord_index,
                    payload={"action": "overlay_chord", "segment": chord_segment},
                )
            )
    return suggestions


def _build_section_suggestions(
    sections: list[dict[str, Any]],
    tab_lyrics: list[dict[str, Any]],
    lyrics_segments: list[dict[str, Any]],
    lyric_matches: dict[int, int],
) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    matched_tab_indexes = sorted(lyric_matches)
    for section_index, section in enumerate(sections):
        label = str(section.get("label", "")).strip()
        line_number = int(section.get("line_number", 0))
        next_tab_index = next(
            (
                tab_index
                for tab_index in matched_tab_indexes
                if int(tab_lyrics[tab_index].get("line_number", 0)) > line_number
            ),
            None,
        )
        start_seconds = None
        if next_tab_index is not None:
            segment = lyrics_segments[lyric_matches[next_tab_index]]
            start_seconds = _float_or_none(segment.get("start_seconds"))
        suggestions.append(
            _suggestion(
                suggestion_id=f"section-{section_index}",
                kind="sections",
                title="Add song section",
                current_text=None,
                suggested_text=label,
                start_seconds=start_seconds,
                payload={"action": "add_section", "label": label, "start_seconds": start_seconds},
            )
        )
    return suggestions


def _build_key_suggestions(keys: list[dict[str, Any]], project: Project) -> list[dict[str, Any]]:
    for key in keys:
        parsed_key = key.get("key")
        if not isinstance(parsed_key, dict):
            continue
        source_key_override = parsed_key.get("source_key_override")
        if not isinstance(source_key_override, str) or source_key_override == project.source_key_override:
            continue
        return [
            _suggestion(
                suggestion_id="key-source",
                kind="key",
                title="Update source key",
                current_text=project.source_key_override,
                suggested_text=str(parsed_key.get("label", source_key_override)),
                payload={"action": "update_source_key", "source_key_override": source_key_override},
            )
        ]
    return []


def _tab_chord_to_segment(chord: dict[str, Any], segment: dict[str, Any]) -> dict[str, Any] | None:
    start_seconds = _time_for_word(segment, int(chord.get("word_index", 0)))
    segment_end = _float_or_none(segment.get("end_seconds"))
    if start_seconds is None or segment_end is None:
        return None
    end_seconds = min(segment_end, start_seconds + 2.0)
    if end_seconds <= start_seconds:
        end_seconds = start_seconds + 0.25
    return chord_label_to_segment(
        str(chord.get("label", "")),
        start_seconds=start_seconds,
        end_seconds=end_seconds,
        confidence=None,
    )


def _time_for_word(segment: dict[str, Any], word_index: int) -> float | None:
    words = [word for word in segment.get("words", []) if isinstance(word, dict)]
    if words and 0 <= word_index < len(words):
        start_seconds = _float_or_none(words[word_index].get("start_seconds"))
        if start_seconds is not None:
            return start_seconds
    segment_start = _float_or_none(segment.get("start_seconds"))
    segment_end = _float_or_none(segment.get("end_seconds"))
    if segment_start is None or segment_end is None:
        return None
    return round(segment_start + max(0, word_index) * 0.5, 3)


def _current_chord_label_at(timeline: list[dict[str, Any]], time_seconds: float) -> str | None:
    for segment in timeline:
        start = _float_or_none(segment.get("start_seconds"))
        end = _float_or_none(segment.get("end_seconds"))
        if start is not None and end is not None and start <= time_seconds < end:
            label = segment.get("label")
            return str(label) if label is not None else None
    return None


def _apply_lyric_suggestions(
    session: Session,
    project: Project,
    suggestions: list[dict[str, Any]],
) -> LyricsTranscript | None:
    lyric_suggestions = [suggestion for suggestion in suggestions if suggestion["kind"] == "lyrics"]
    if not lyric_suggestions:
        return None
    lyrics = session.get(LyricsTranscript, project.id)
    if lyrics is None:
        return None
    segments = deepcopy(lyrics.segments_json)
    for suggestion in lyric_suggestions:
        payload = suggestion.get("payload", {})
        if payload.get("action") == "replace_lyric_segment":
            index = payload.get("segment_index")
            text = payload.get("text")
            if isinstance(index, int) and 0 <= index < len(segments) and isinstance(text, str):
                segments[index] = retime_lyrics_segment_text(segments[index], text)
        elif payload.get("action") == "append_untimed_lyric" and isinstance(payload.get("text"), str):
            segments.append({"text": payload["text"], "start_seconds": None, "end_seconds": None, "words": []})
    return persist_project_lyrics_segments(session, project_id=project.id, segments=segments)


def _apply_chord_suggestions(
    session: Session,
    project: Project,
    suggestions: list[dict[str, Any]],
) -> ChordTimeline | None:
    chord_segments = [
        suggestion.get("payload", {}).get("segment")
        for suggestion in suggestions
        if suggestion["kind"] == "chords" and isinstance(suggestion.get("payload", {}).get("segment"), dict)
    ]
    if not chord_segments:
        return None
    chords = session.get(ChordTimeline, project.id)
    if chords is None:
        chords = ChordTimeline(project_id=project.id, backend="tab", source_kind="user-edited")
        session.add(chords)
    timeline = _overlay_chord_segments(chords.segments_json or [], cast(list[dict[str, Any]], chord_segments))
    chords.segments_json = timeline
    chords.timeline_json = deepcopy(timeline)
    if not chords.source_segments_json:
        chords.source_segments_json = deepcopy(timeline)
    chords.has_user_edits = True
    chords.source_kind = "user-edited"
    session.flush()
    return chords


def _apply_section_suggestions(
    session: Session,
    project: Project,
    tab_import: TabImport,
    suggestions: list[dict[str, Any]],
) -> list[SongSection]:
    created: list[SongSection] = []
    for suggestion in suggestions:
        if suggestion["kind"] != "sections":
            continue
        payload = suggestion.get("payload", {})
        if payload.get("action") != "add_section" or not isinstance(payload.get("label"), str):
            continue
        section = SongSection(
            id=new_id("sec"),
            project_id=project.id,
            tab_import_id=tab_import.id,
            label=payload["label"],
            start_seconds=_float_or_none(payload.get("start_seconds")),
            end_seconds=None,
            source="tab",
            metadata_json={"suggestion_id": suggestion["id"]},
        )
        session.add(section)
        created.append(section)
    session.flush()
    return created


def _apply_key_suggestions(project: Project, suggestions: list[dict[str, Any]]) -> None:
    for suggestion in suggestions:
        payload = suggestion.get("payload", {})
        source_key_override = payload.get("source_key_override")
        if suggestion["kind"] == "key" and isinstance(source_key_override, str):
            project.source_key_override = source_key_override


def _overlay_chord_segments(
    current_timeline: list[dict[str, Any]],
    accepted_segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    timeline = [dict(segment) for segment in current_timeline]
    for accepted in sorted(accepted_segments, key=lambda segment: float(segment["start_seconds"])):
        start = float(accepted["start_seconds"])
        end = float(accepted["end_seconds"])
        next_timeline: list[dict[str, Any]] = []
        for segment in timeline:
            segment_start = float(segment["start_seconds"])
            segment_end = float(segment["end_seconds"])
            if segment_end <= start or segment_start >= end:
                next_timeline.append(segment)
                continue
            if segment_start < start:
                next_timeline.append({**segment, "end_seconds": start})
            if segment_end > end:
                next_timeline.append({**segment, "start_seconds": end})
        next_timeline.append(dict(accepted))
        timeline = _merge_chord_segments(sorted(next_timeline, key=lambda segment: float(segment["start_seconds"])))
    return timeline


def _merge_chord_segments(timeline: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for segment in timeline:
        if not merged or merged[-1].get("label") != segment.get("label"):
            merged.append(dict(segment))
            continue
        merged[-1]["end_seconds"] = segment["end_seconds"]
    return merged


def _flatten_suggestions(proposal_json: dict[str, Any]) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    for group in proposal_json.get("groups", []):
        if isinstance(group, dict):
            suggestions.extend(
                [suggestion for suggestion in group.get("suggestions", []) if isinstance(suggestion, dict)]
            )
    return suggestions


def _mark_suggestions(proposal_json: dict[str, Any], accepted_ids: set[str]) -> dict[str, Any]:
    proposal = deepcopy(proposal_json)
    for group in proposal.get("groups", []):
        if not isinstance(group, dict):
            continue
        for suggestion in group.get("suggestions", []):
            if isinstance(suggestion, dict):
                suggestion["status"] = "accepted" if suggestion.get("id") in accepted_ids else "rejected"
    return proposal


def _suggestion(
    *,
    suggestion_id: str,
    kind: str,
    title: str,
    current_text: str | None = None,
    suggested_text: str | None = None,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
    segment_index: int | None = None,
    chord_index: int | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": suggestion_id,
        "kind": kind,
        "status": "pending",
        "title": title,
        "current_text": current_text,
        "suggested_text": suggested_text,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "segment_index": segment_index,
        "chord_index": chord_index,
        "payload": payload or {},
    }


def _text_similarity(first: str, second: str) -> float:
    return SequenceMatcher(a=_normalize_text(first), b=_normalize_text(second), autojunk=False).ratio()


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w'\s]+", "", value.lower())).strip()


def _normalize_section_label(value: str) -> str:
    folded = _fold_text(value).lower().strip()
    folded = re.sub(r"\s+\d+$", "", folded)
    folded = re.sub(r"\s*\(\d+x\)$", "", folded)
    folded = folded.replace("_", " ")
    folded = re.sub(r"\s*-\s*", "-", folded)
    folded = re.sub(r"\s+", " ", folded)
    return folded


def _fold_text(value: str) -> str:
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")


def _float_or_none(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) else None
