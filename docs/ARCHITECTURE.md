# TuneForge Architecture

## Overview

TuneForge is a local-first monorepo with a desktop app, local backend, generated shared contracts, and an Android-first mobile direction. The desktop app is the primary supported runtime. Mobile reuses the frontend and contract concepts where possible, but uses a Tauri command boundary and embedded backend shape instead of the desktop FastAPI process.

The main architectural rule is:

```text
routes -> services -> engines
```

Routes stay thin. Services own orchestration, persistence, and job behavior. Engines own audio, DSP, and ML work.

## Repository Layout

```text
apps/
  backend/
    app/
      api/routes/       FastAPI route handlers
      services/         orchestration, persistence, jobs, artifacts
      engines/          analysis, chords, stems, lyrics, transforms
      benchmarks/       local benchmark helpers
      utils/            shared backend helpers
      models.py         SQLAlchemy models
      schemas.py        Pydantic request/response schemas
      config.py         environment-driven settings
      db.py             database setup and migrations
      errors.py         AppError and error response handling
    alembic/            SQLite migrations
    tests/              pytest suite
  desktop/
    src/                React/Vite/TypeScript frontend
    src-tauri/          Tauri shell, desktop backend launcher, mobile commands
packages/
  shared-types/
    openapi.json        generated OpenAPI schema
    src/generated/      generated TypeScript contracts
scripts/                setup, packaging, Android, backend helpers
docs/                   product, architecture, API, roadmap, mobile docs
```

Root documents such as `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` stay at the repository root.

## Desktop Runtime

Desktop uses:

- Tauri 2 shell to host the WebView and launch the backend.
- React/Vite/TypeScript frontend.
- FastAPI backend bound to `127.0.0.1`.
- SQLite database and local filesystem artifacts.
- Python engines for audio analysis, lyrics, stems, and transforms.
- Host-installed `ffmpeg` and `ffprobe` for desktop transform/export work.

Development normally runs two local processes:

```text
React/Tauri frontend -> http://127.0.0.1:8765/api/v1 -> FastAPI backend
```

Packaged desktop builds launch the bundled backend process from the Tauri shell and still require host FFmpeg/FFprobe.

## Mobile Runtime

Mobile is Android-first and keeps the local-only product rules. It does not run the desktop Python/FastAPI backend on Android.

Current mobile shape:

```text
React frontend -> Tauri commands -> embedded Rust/Kotlin backend -> Android media APIs -> SQLite/filesystem
```

Mobile command handlers live in `apps/desktop/src-tauri/src/mobile_backend.rs`. They expose project, job, artifact, analysis, chords, lyrics, and capability-shaped responses where possible. Commands fail closed for unsupported generation paths.

See [MOBILE.md](./MOBILE.md) for current mobile details.

## Backend Layers

### Routes

Routes live under `apps/backend/app/api/routes/` and expose the `/api/v1` HTTP surface:

- health
- chord backends
- projects
- jobs
- artifacts

Routes validate request/response schemas and delegate work to services or the job runner.

### Services

Services live under `apps/backend/app/services/` and own:

- project import/update/delete
- analysis orchestration
- chord backend selection and chord generation workflow
- lyrics generation and edit persistence
- stem source resolution and stem orchestration
- transform, preview, export, and artifact management
- single-process job lifecycle and recovery

Services are the boundary between HTTP routes, database state, artifacts, and engines.

### Engines

Engines live under `apps/backend/app/engines/` and perform compute-heavy or audio-specific work:

- audio probing and feature extraction
- tuning/key/tempo-related analysis
- chord detection
- lyrics transcription
- Demucs stem separation
- FFmpeg-backed transforms and exports

Engines should not own route behavior or API concerns.

## Data Model

TuneForge uses SQLite plus filesystem artifacts.

SQLite stores:

- projects
- jobs
- analysis results
- chord timelines
- lyrics transcripts
- artifact metadata

Filesystem storage holds:

- imported source media or working copies
- preview and transformed audio
- stem artifacts
- export artifacts
- future JSON artifacts such as tempo/beat maps

App-owned source audio, stems, and saved practice mixes may use PCM16 WAV, FLAC level 5,
MP3 at 192 kbps, or AAC-LC M4A at 192 kbps. Each creation job captures one format; mixed-format
projects remain valid. Analysis, chord, lyric, and Demucs integrations receive scoped temporary
PCM WAV materializations when their durable input is compressed. Working WAVs are never artifacts,
never sync, and are removed when processing completes.

Artifact rows include type, format, path, size, generation metadata, delete/regenerate flags, and creation time.

### Database Migrations

Alembic migrations run automatically on backend startup. The frozen v1 baseline is
`0021_job_runtime_status`; databases already stamped at that revision remain compatible without
rerunning schema changes.

Revisions `0001` through `0020` are unsupported pre-v1 history. To recover one, first close every
TuneForge instance, then back up the entire TuneForge data directory, including `app.sqlite`, any
SQLite sidecars, and all project and artifact files. Copying `app.sqlite` alone is insufficient.
After the backup completes, open that data directory once with TuneForge v1.0.0 so it upgrades to
`0021_job_runtime_status`, close v1.0.0, and then open it with the newer build.

## Job Model

The backend uses a single-process in-memory job runner with SQLite-persisted job state. Jobs can be pending, running, completed, failed, or cancelled.

Current job types include:

- analyze
- chords
- lyrics
- retune
- transpose
- preview
- stems
- export

On startup, previously running jobs are marked failed and pending jobs are re-enqueued. The default worker count is conservative to avoid local CPU/GPU contention.

## Contracts

The backend OpenAPI schema is generated into `packages/shared-types/openapi.json` and `packages/shared-types/src/generated/openapi.ts`.

Rules:

- Use generated frontend types from `@tuneforge/shared-types`.
- Regenerate contracts after backend route or schema changes.
- CI checks generated contract drift.
- Do not hand-edit generated OpenAPI artifacts.

## Frontend Shape

The desktop frontend lives under `apps/desktop/src/`:

- `features/projects/` owns project workspace, processing controls, inspector, playback, lyrics, chords, stems, and practice views.
- `features/settings/` owns app settings and theme/preferences UI.
- `features/tools/` owns standalone tools such as tuner workflows.
- `lib/` owns shared clients, preferences, playback persistence, theme tokens, and utilities.
- `test/` owns shared Vitest/Testing Library harness code.

The frontend talks through a TuneForge client boundary. Desktop uses HTTP/OpenAPI types. Mobile uses Tauri commands that return compatible shapes where possible.

## Error Handling

Backend user-facing failures use `AppError` and return a structured error response:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Readable message.",
    "details": {}
  }
}
```

Validation failures return `INVALID_REQUEST` with serialized validation details.

## Packaging Constraints

- FFmpeg is a host dependency and is not bundled.
- Normal Tauri project playback, metronome output, and tuner microphone capture use the native
  audio control plane. Native failure remains terminal until a later explicit action; it does not
  fall back to Web Audio. Browser, non-Tauri, and forced-Web Tauri builds use Web Audio.
- Native desktop tempo playback uses `signalsmith-stretch` for pitch preservation.
- Native desktop playback decodes local files through a WAV fast path or Symphonia. FFmpeg remains a host dependency for transform/export work.
- Native audio development notes live in [NATIVE_AUDIO.md](NATIVE_AUDIO.md).
- Cross-platform wake, sleep, and power-inhibition behavior lives in [POWER_PROTECTION.md](POWER_PROTECTION.md).
- Desktop system microphone volume control uses CoreAudio on macOS, or host `wpctl`/`pactl` tools on Linux with an active PipeWire/PulseAudio session.
- Advanced Chords and Advanced Beat Analysis are default desktop/dev/package engines. Advanced Chords uses ONNX Runtime and packages the exact pinned converted Crema model/state; the Crema Python package, TensorFlow, and Keras are absent. Packaged builds must treat ONNX Runtime, model provenance, beat-this, and their runtime dependencies as default-runtime notice scope. Built-in chord and beat engines remain fallback paths when advanced dependencies are unavailable, unsupported, or explicitly excluded.
- Demucs and lyrics models follow first-use local download/cache behavior.
- The Linux legacy NVIDIA profile is an opt-in local backend environment override; it does not change the default lockfile, CI setup, or packaged dependency baseline.
- Mobile avoids FFmpeg and uses platform media APIs where possible.
- Mobile does not run the desktop Python/FastAPI backend today.

## Extensibility Rules

- Preserve the local-only trust boundary.
- Keep routes thin and do not call engines directly from routes.
- Keep mobile additions aligned with the existing project/job/artifact model.
- Treat practice views as consumers of project artifacts, not as separate sources of analysis truth.
- Keep display-only harmonic features such as capo-relative chords separate from audio transforms.
