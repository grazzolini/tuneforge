# Changelog

This is a curated history of noteworthy product changes. GitHub Releases own
download, installation, verification, signature, and publication instructions.

## [Unreleased]

### Added

- Moved project count-ins and playback-following metronome cues onto the native audio timeline,
  with timing-grid-aware spacing and the same short triangle click on native and Web Audio paths.
- Moved project count-ins and metronome timing onto one native output runtime, including standalone
  free-run and playback-following modes, while keeping tuner capture independently concurrent.

### Changed

- Made native audio required in normal Tauri sessions while preserving browser and explicitly
  forced Web Audio modes.

### Fixed

- Reduced Android sync reconciliation memory use for libraries with many pending projects.
- Preserved project playback position across native output changes, rejected stale transport
  completions, and made clearing a loop cancel queued wraps immediately.

## [1.4.0] - 2026-09-01

### Changed

- Upgraded the desktop backend to Python 3.14 and refreshed its dependency graph.
- Made the ONNX implementation the sole Advanced Chords runtime while preserving its engine ID,
  default selection, package aliases, and pinned model; removed Crema, TensorFlow, and Keras.
- Kept the Flatpak application CPU-only and split NVIDIA and legacy NVIDIA Torch stacks into
  matching, marker-validated Core/Runtime extensions with independent size and hash evidence;
  Flatpak builds can select CPU alone or either accelerator pair.
- Replaced legacy Demucs pickle checkpoints with pinned Hugging Face YAML+safetensors for first-use
  downloads, offline caches, local model repositories, and explicit model bundles.

## [1.3.0] - 2026-08-28

### Added

- Added an opt-in Crema ONNX implementation for Advanced Chords while retaining Crema/TensorFlow
  as the default setup and package profile.
- Added optional bundled LV Chordia submission chord detection for desktop; Advanced Chords remains
  the default while further default evaluation is deferred.

### Changed

- Made Advanced Beat Analysis the default beat-analysis request. Built-in Beat Analysis remains an
  explicit mobile, dependency-excluded-package, and opt-out choice; advanced beat runtime failures
  fail the job without silently switching engines.

### Fixed

- Restored Linux developer setup on unsupported default CUDA architectures and repaired legacy
  NVIDIA Flatpak packaging while retaining LV Chordia support.

## [1.2.0] - 2026-08-24

### Added

- Added durable WAV, FLAC, MP3, and M4A storage, including byte-preserving Android receive and
  playback support ([#465](https://github.com/grazzolini/tuneforge/pull/465),
  [#467](https://github.com/grazzolini/tuneforge/pull/467)).
- Added opt-in, memory-only, bounded, sanitized diagnostics for native playback
  ([#464](https://github.com/grazzolini/tuneforge/pull/464)).
- Added Activity re-processing for durable audio with timestamp-based last-write-wins sync
  replacement ([#471](https://github.com/grazzolini/tuneforge/pull/471)).

### Fixed

- Applied repeat desktop-to-Android sync changes to existing project metadata and artifacts
  ([#469](https://github.com/grazzolini/tuneforge/pull/469)).
- Preserved project playback across native output-route changes and interruptions
  ([#466](https://github.com/grazzolini/tuneforge/pull/466)).

## [1.1.0] - 2026-08-18

### Added

- A dedicated project Export workspace for selecting one source track or practice mix and packaging
  its track and stems as a file, folder, or ZIP
  ([#428](https://github.com/grazzolini/tuneforge/pull/428),
  [#429](https://github.com/grazzolini/tuneforge/pull/429)).
- Saved per-project Export choices that safely reconcile with available audio and device capabilities
  ([#433](https://github.com/grazzolini/tuneforge/pull/433)).
- Desktop TXT export for saved lyrics and lyrics with chords, alone or packaged with selected audio
  ([#440](https://github.com/grazzolini/tuneforge/pull/440)).
- Android system-picker export for one existing WAV, Lyrics TXT, or mix-aware Lyrics + chords TXT,
  with verified local receipt history when provider readback is available
  ([#451](https://github.com/grazzolini/tuneforge/pull/451)).

### Changed

- Polished Export destination controls and defaulted new stemmed selections to track plus all stems
  ([#437](https://github.com/grazzolini/tuneforge/pull/437)).
- Matched Lyrics + chords TXT to the selected source or practice mix, including corrected key,
  transpose, enharmonic spelling, slash chords, and compact chronological instrumental rows
  ([#440](https://github.com/grazzolini/tuneforge/pull/440)).

## [1.0.1] - 2026-08-13

### Added

- Mobile storage parity, a practice workspace, synced lyrics and chords, and native tuner capture
  ([#339](https://github.com/grazzolini/tuneforge/pull/339),
  [#354](https://github.com/grazzolini/tuneforge/pull/354),
  [#364](https://github.com/grazzolini/tuneforge/pull/364),
  [#367](https://github.com/grazzolini/tuneforge/pull/367),
  [#369](https://github.com/grazzolini/tuneforge/pull/369)).
- Cross-platform wake inhibition for playback and sync
  ([#361](https://github.com/grazzolini/tuneforge/pull/361)).
- Dedicated Android release signing for publishable APKs
  ([#422](https://github.com/grazzolini/tuneforge/pull/422)).
- Added this curated product changelog ([#424](https://github.com/grazzolini/tuneforge/pull/424)).

### Changed

- Improved synced mobile lyrics, native and Web Audio playback, and responsive controls
  ([#352](https://github.com/grazzolini/tuneforge/pull/352),
  [#359](https://github.com/grazzolini/tuneforge/pull/359),
  [#368](https://github.com/grazzolini/tuneforge/pull/368),
  [#370](https://github.com/grazzolini/tuneforge/pull/370)).
- Strengthened sync and project-storage handling across mobile and desktop
  ([#328](https://github.com/grazzolini/tuneforge/pull/328),
  [#341](https://github.com/grazzolini/tuneforge/pull/341),
  [#343](https://github.com/grazzolini/tuneforge/pull/343),
  [#344](https://github.com/grazzolini/tuneforge/pull/344),
  [#348](https://github.com/grazzolini/tuneforge/pull/348),
  [#349](https://github.com/grazzolini/tuneforge/pull/349),
  [#350](https://github.com/grazzolini/tuneforge/pull/350),
  [#351](https://github.com/grazzolini/tuneforge/pull/351),
  [#365](https://github.com/grazzolini/tuneforge/pull/365)).
- Consolidated pre-v1 migration history into a v1 database baseline
  ([#372](https://github.com/grazzolini/tuneforge/pull/372)).
- Updated Android packaging prerequisites and made package commands self-contained
  ([#378](https://github.com/grazzolini/tuneforge/pull/378),
  [#382](https://github.com/grazzolini/tuneforge/pull/382)).

### Fixed

- Corrected playback layout and sync provenance/status display
  ([#330](https://github.com/grazzolini/tuneforge/pull/330),
  [#363](https://github.com/grazzolini/tuneforge/pull/363)).
- Preserved stem playback controls and improved project renaming
  ([#375](https://github.com/grazzolini/tuneforge/pull/375)).
- Improved sync-transfer wake handling and stale-screen protection
  ([#408](https://github.com/grazzolini/tuneforge/pull/408),
  [#413](https://github.com/grazzolini/tuneforge/pull/413)).
- Fixed Android sync-evidence copy and export
  ([#414](https://github.com/grazzolini/tuneforge/pull/414)).
- Allowed Flatpak logind inhibition during playback
  ([#416](https://github.com/grazzolini/tuneforge/pull/416)).
- Corrected generated Android app icons and JNI/release-build compatibility
  ([#327](https://github.com/grazzolini/tuneforge/pull/327),
  [#381](https://github.com/grazzolini/tuneforge/pull/381),
  [#412](https://github.com/grazzolini/tuneforge/pull/412)).

## [1.0.0] - 2026-07-03

### Added

- Imported local audio and video into projects stored in an on-device library.
- Analyzed key, tempo, chords, and lyrics; edited lyrics and followed the transcript during playback.
- Separated tracks into Demucs-generated stems for mix and practice control.
- Practiced with persistent desktop playback, tempo changes, loops, count-in, and OS media
  controls.
- Previewed pitch-shifted and retuned mixes, then exported custom practice versions.
- Included a chromatic tuner plus guitar, piano, and accordion chord dictionaries with live chord
  follow.
- Made import and processing work visible through Activity queues, runtime status, and progress.
- Kept the desktop experience local-only and single-user: no account, upload, or cloud service.

### Changed

- Development used `0.1.0` metadata; `v1.0.0` was the first tagged release.

[Unreleased]: https://github.com/grazzolini/tuneforge/compare/v1.4.0...main
[1.4.0]: https://github.com/grazzolini/tuneforge/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/grazzolini/tuneforge/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/grazzolini/tuneforge/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/grazzolini/tuneforge/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/grazzolini/tuneforge/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/grazzolini/tuneforge/releases/tag/v1.0.0
