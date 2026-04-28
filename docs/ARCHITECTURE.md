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

Artifact rows include type, format, path, size, generation metadata, delete/regenerate flags, and creation time.

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
- Optional Advanced Chords dependencies are not installed by default.
- Demucs and lyrics models follow first-use local download/cache behavior.
- The Linux legacy NVIDIA profile is an opt-in local backend environment override; it does not change the default lockfile, CI setup, or packaged dependency baseline.
- Mobile avoids FFmpeg and uses platform media APIs where possible.

## Extensibility Rules

- Preserve the local-only trust boundary.
- Keep routes thin and do not call engines directly from routes.
- Keep mobile additions aligned with the existing project/job/artifact model.
- Treat practice views as consumers of project artifacts, not as separate sources of analysis truth.
- Keep display-only harmonic features such as capo-relative chords separate from audio transforms.
