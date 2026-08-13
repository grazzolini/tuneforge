# Changelog

This is a curated history of noteworthy product changes. GitHub Releases own
download, installation, verification, signature, and publication instructions.

## [Unreleased]

## [1.0.1] - Pending

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
- Added this curated product changelog.

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

[1.0.1]: https://github.com/grazzolini/tuneforge/compare/v1.0.0...main
[1.0.0]: https://github.com/grazzolini/tuneforge/releases/tag/v1.0.0
