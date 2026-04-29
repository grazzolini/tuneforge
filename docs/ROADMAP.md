# TuneForge Roadmap

## Purpose

This roadmap describes current product direction. It does not repeat completed foundation work as future work. Completed capabilities include local desktop project import, analysis, chords, lyrics, stems, retune/transpose previews, exports, playback practice views, generated shared contracts, and CI gates.

Roadmap items are grouped by track so related work can move independently.

## Core / Desktop

- Keep the desktop app as the most complete supported workflow.
- Improve project portability so a project can be backed up, moved, or handed off more predictably.
- Keep generated audio, chord, lyrics, analysis, and job state tied to explicit project artifacts.
- Preserve user edits when regeneration jobs rerun, with explicit overwrite confirmation for destructive refreshes.
- Continue refining settings for default chord backend, playback display, follow behavior, and source-key overrides.

## Audio Analysis

- Add an offline beat-tracking and tempo-map artifact.
- Store beat timestamps, bar numbers, beat numbers, and confidence as JSON.
- Add first downbeat detection to improve chord, lyric, loop, and count-in synchronization.
- Use timing artifacts as shared project data rather than recalculating timing independently in each UI feature.
- Add a smart metronome that follows the tempo/bar map without rendering new audio.
- Consider an optional click-track audio artifact after the metronome and beat-map behavior are useful.

## Playback & Practice UX

- Add current bar and beat highlighting during playback.
- Add count-in support based on the beat/bar map.
- Add loop-by-bars so practice loops can snap to musical boundaries.
- Add section practice built on top of saved bar ranges or detected sections.
- Keep source-track analysis independent from practice mixes so stems or saved mixes do not accidentally change project-level analysis.
- Continue improving playback persistence and sync across source audio, stems, lyrics, and chords.

## Chords & Harmony

- Add a bar-based chord view similar to a lead sheet or Chordify-style practice grid.
- Align chord rendering with beat/bar data once the tempo-map artifact exists.
- Improve chord refresh UX around existing user edits and source-vs-stem analysis differences.
- Add tab import as a correction aid for lyrics and chords where users have a trusted local tab source.
- Keep capo-relative chord display as a presentation layer only. Audio pitch, tuning, and speed should remain unchanged.
- Evaluate graduating Advanced Chords from optional to the desktop default once dependency, runtime, and packaging checks are complete.

## Lyrics

- Keep desktop lyrics generation and editing as supported local functionality.
- Improve editable lyrics timeline behavior for segment timing, text correction, and playback follow.
- Add Android lyrics MVP using local Whisper or an equivalent local runtime behind the mobile capability model.
- Support tab import for lyrics correction and chord/lyric alignment where useful.
- Research local forced-alignment second passes, such as WhisperX- or Gentle-style alignment, after lyrics generation or accepted lyric/tab edits to refine word and phrase timing.
- Keep generated lyrics positioned as editable draft output, not guaranteed transcription truth.

## Mobile

- Move mobile from experimental toward a supported Android-first companion workflow.
- Keep mobile local-first: no account, no cloud backend, no telemetry, no remote processing requirement.
- Maintain a capability model with:
  - local processing for analysis, chords, and lyrics where device support exists
  - desktop-backed processing for stems and other heavy ML work
  - clear disabled states when local acceleration is unavailable
- Keep the embedded project/job/artifact model aligned with the desktop project model.
- Treat mobile stems as a later experimental milestone after native media, storage, and acceleration paths are reliable.
- Explore optional desktop/mobile pair for sending heavier jobs.
- Explore optional LAN (no cloud) desktop/mobile sync where imported tracks on either device show and play on both.

## Packaging & Distribution

- Keep macOS packaging available for local unsigned builds.
- Create a Flatpak package for Linux.
- Create package recipes for Arch Linux's pacman (`PKGBUILD`), rpm, and deb.
- Document host-installed FFmpeg and FFprobe requirements clearly.
- Avoid bundling FFmpeg for licensing and distribution reasons.
- Keep the Linux legacy NVIDIA profile documented for older `x86_64` CUDA-capable GPUs that need the opt-in PyTorch override.
- Keep Android packaging optional/manual while mobile remains in transition.
- Update packaged desktop dependency notices before bundling crema/TensorFlow by default.

## Testing & Quality

- Keep backend gates: Ruff, mypy, and pytest.
- Keep desktop gates: lint, typecheck, and Vitest.
- Keep OpenAPI contract drift checks in CI.
- Add focused tests when new timing artifacts, practice loops, mobile capability gates, or destructive-regeneration flows are introduced.
- Prefer deterministic timing tests over wall-clock-dependent assertions.
- Keep generated or ignored mobile build artifacts out of commits unless they are intentionally tracked.
