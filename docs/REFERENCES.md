# TuneForge References

## Purpose

This document records product and workflow references that can inform TuneForge design. These references are inspiration, not requirements, commitments, or parity targets.

TuneForge should remain focused on its own local-first scope, architecture, licensing constraints, and contributor capacity.

## How to Use This Document

- Use references to understand common musician workflows and user expectations.
- Prefer TuneForge-specific product principles over copying another tool's feature set.
- Treat all references as non-prescriptive.
- Avoid adding network, account, telemetry, or cloud assumptions just because a reference product has them.

## Workflow Category

TuneForge sits near tools for:

- music practice
- stem separation
- key, tempo, and chord detection
- pitch and tuning adjustment
- lyrics transcription and correction
- capo-oriented practice support
- local export of practice-ready audio

## Reference Tools

### Moises-style practice workflows

Relevant ideas:

- import a song and process it into practice aids
- separate vocals and backing instruments
- adjust key and tempo for practice
- show chords and lyrics during playback
- export or reuse prepared practice material

TuneForge differences:

- local-first architecture
- no account or cloud processing requirement
- desktop-first complete workflow
- Android/mobile as a local companion direction
- host-installed FFmpeg policy on desktop

### Transcription-oriented tools

Relevant ideas:

- timestamped lyric segments
- editable transcript output
- word-level timing where available
- follow-along playback

TuneForge should treat transcription as editable draft output and prioritize correction workflows over claiming perfect accuracy.

### Stem-focused tools

Relevant ideas:

- vocal/instrumental isolation
- practice against selected stems
- cached/generated artifacts
- clear progress and failure states for heavy jobs

TuneForge should keep stems local and avoid making stems a prerequisite for source-track analysis.

### Chord-focused tools

Relevant ideas:

- timed chord timelines
- bar-based chord grids
- current chord highlighting
- manual correction
- capo-relative display

TuneForge should keep chord data editable and should separate harmonic display changes from audio transforms.

### Lyrics-focused tools

Relevant ideas:

- large follow-along lyric display
- editable lines
- lyric/chord combined lead sheet
- tab or text import for correction

TuneForge should keep lyrics local and project-owned.

## Project-Specific Takeaways

- The most important workflow is preparing a song for practice, then staying in a focused playback/practice view.
- Chords, lyrics, stems, and transforms should support practice, not turn TuneForge into a general DAW.
- Local-first behavior is a product direction and architectural constraint.
- References should inform UX expectations, but TuneForge should not chase feature parity for its own sake.

## Future Research Areas

- Better local beat/downbeat detection for practice sync.
- Local mobile-friendly lyrics runtimes.
- Bar-based chord and lyric correction workflows.
- Project portability and optional device handoff.
- Lightweight local import of tab/chord text for correction.

