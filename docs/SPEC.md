# TuneForge Product Specification

## Overview

TuneForge is a local-first music practice toolkit for musicians learning, rehearsing, and playing along with songs. It imports a local media file, creates a project, runs local analysis and generation jobs, and keeps the resulting audio, chords, lyrics, and metadata on the user's machine.

The product direction is desktop-first with an active Android/mobile path. Desktop remains the primary fully supported workflow for heavy audio processing. Mobile is being developed as a local companion workflow with device-capability gates and a desktop-backed processing option for work that is too heavy for phones.

TuneForge is not a SaaS product, web service, or multi-user system. It has no account model, cloud backend, telemetry, or remote processing requirement.

## Product Goals

- Import common audio and video containers into a local project workspace.
- Analyze key, tuning reference, tempo, chords, and duration locally.
- Generate and edit timestamped lyrics locally.
- Separate vocals and instrumental stems when the local desktop environment can support it.
- Provide musician-focused playback and practice tools: follow-along lyrics, chord timelines, pitch changes, retuning, stem mix practice, previews, and exports.
- Preserve user edits to generated lyrics and chord timelines unless the user explicitly chooses to replace them.
- Keep project data portable enough for future backup, sync, and mobile handoff improvements.

## Non-Goals

- Cloud processing, remote storage, user accounts, telemetry, or hosted collaboration.
- Network-exposed backend deployment, public API hosting, reverse-proxy usage, or multi-user authorization.
- Full DAW, production, mastering, or generic audio-editor workflows.
- Bundling FFmpeg. Desktop builds rely on host-installed `ffmpeg` and `ffprobe`.
- Guaranteeing generated chords, lyrics, tempo, or stems as ground truth. Outputs are editable practice aids.

## Users and Workflows

TuneForge is for musicians who want to prepare and rehearse songs locally:

- Import a song from local storage.
- Inspect analysis: key, tuning reference, tempo, chords, lyrics, and artifacts.
- Practice with source audio, stems, saved mixes, lyrics, and chords.
- Generate previews for pitch or tuning changes.
- Export practice-ready audio artifacts.
- Correct generated lyrics or chords as needed.

## Platforms

### Desktop

Desktop is the primary supported runtime. The current implementation uses:

- Tauri 2 shell.
- React, Vite, and TypeScript frontend.
- Local FastAPI backend bound to `127.0.0.1`.
- Python audio engines for analysis, Demucs stem separation, Whisper lyrics, and FFmpeg-backed transforms.
- SQLite and local filesystem project storage.
- Opt-in Linux legacy NVIDIA setup for older `x86_64` CUDA-capable GPUs that are not supported by the default PyTorch build.

### Mobile

Mobile is an active Android-first direction. The mobile path keeps the same local-first product rules, but does not run the desktop Python/FastAPI backend on Android. Instead, it uses a Tauri mobile command boundary and an embedded Rust/Kotlin backend shape where possible.

Mobile capabilities are expected to vary by device:

- Local processing for lightweight analysis, chords, and lyrics where supported.
- Desktop-backed processing for heavy ML work such as stem separation.
- Experimental mobile stems only after the capability and native media paths are reliable.

See [MOBILE.md](./MOBILE.md) for current mobile architecture notes.

## Core Capabilities

### Import and Project Model

- Accept local media paths on desktop.
- Accept Android file/content URIs on mobile where the mobile shell supports them.
- Copy or reference source media according to the import request.
- Store project records, source metadata, generated artifacts, and job history locally.
- Support project rename and source-key override updates.

### Analysis

Analysis is local and project-scoped:

- Estimate musical key and confidence.
- Estimate tuning reference and tuning offset.
- Store duration, sample rate, and channel count when available.
- Tempo detection exists as an API option and should evolve into a durable beat/tempo-map artifact.

### Chords and Harmony

- Generate chord timelines from source audio with the built-in chord backend.
- Allow optional desktop-only Advanced Chords when the optional crema/TensorFlow stack is installed.
- Store generated chord segments with timing, labels, confidence, pitch-class metadata, source kind, and user-edit state.
- Preserve user-edited chord timelines unless overwrite is explicitly requested.
- Future harmony work includes bar-based chord display, better beat/downbeat alignment, and tab-assisted correction.

Capo-relative display is a harmonic presentation feature. It should not alter audio pitch, tuning, or playback speed.

### Lyrics

- Generate lyrics locally with Whisper on desktop.
- Store source and edited transcript segments.
- Preserve user edits during transcript refresh unless replacement is explicitly requested.
- Support playback follow and combined lyrics/chords practice views in the desktop app.
- Android lyrics MVP is planned around local Whisper or an equivalent local runtime when the device capability model supports it.

### Stems

- Generate two-stem output on desktop with Demucs.
- Store vocal and instrumental artifacts.
- Allow practice playback against source audio or generated stems.
- Keep mobile stems experimental until local acceleration, storage, and native media handling are proven.

### Transforms, Preview, and Export

- Retune audio by reference frequency or cents offset.
- Transpose audio by semitones.
- Generate cached previews for practice before export.
- Export selected artifacts or transformed outputs to supported local formats.
- Desktop transform/export paths use host-installed FFmpeg.

### Playback and Practice UX

- Persist per-project playback session state.
- Support source playback, saved mixes, and stem playback.
- Support lyrics-only, chords-only, and combined practice displays.
- Future practice work should build from beat/bar artifacts: current bar/beat highlight, count-in, loop-by-bars, and section practice.

## Data and Storage

TuneForge stores project state locally:

- SQLite database for projects, jobs, analysis rows, lyrics transcripts, chord timelines, and artifact metadata.
- Filesystem artifacts for imported audio, transformed audio, previews, stems, exports, and future timing artifacts.
- Generated TypeScript contracts in `packages/shared-types` from the backend OpenAPI schema.

Project portability should improve over time without changing the local-first assumption.

## API and Contract Rules

- Backend HTTP APIs are versioned under `/api/v1`.
- Routes stay thin and delegate to services.
- Services orchestrate persistence, jobs, and engines.
- Engines perform audio/DSP/ML work.
- Shared frontend types come from generated OpenAPI contracts.
- Backend route or schema changes require contract regeneration.

See [API.md](./API.md) for the documented endpoint surface.

## Privacy and Security

- The desktop backend binds to `127.0.0.1`.
- There is no auth/session/user model by design.
- The app should not expose a network service or require internet after first-use model downloads.
- TuneForge must not log file contents, audio contents, or private user material.
- Security policy and disclosure process live in [../SECURITY.md](../SECURITY.md).

## Quality Expectations

- Use synthetic test fixtures for backend audio tests instead of committed copyrighted audio.
- Keep frontend tests focused on user-visible behavior.
- Keep generated contracts in sync with backend API changes.
- Preserve local-only behavior and dependency-license constraints.
