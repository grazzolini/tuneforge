# Tuneforge

Tuneforge is a local-first desktop music practice tool built with Tauri, React, FastAPI, SQLite, and FFmpeg.

Supported import formats currently include `mp3`, `wav`, `flac`, `m4a`, `aac`, `ogg`, `mp4`, and `webm`.
For `mp4` and `webm`, Tuneforge extracts a local WAV working file during import so analysis and transforms run against audio directly.

## Workspace

- `apps/backend`: FastAPI API, SQLite persistence, job runner, audio analysis/transforms, pytest suite
- `apps/desktop`: Tauri desktop shell and React frontend
- `packages/shared-types`: generated TypeScript contract from the backend OpenAPI schema

## Development

Prerequisites:

- `pnpm`
- `uv`
- `Python 3.11`
- `FFmpeg` and `ffprobe`
- Rust toolchain for Tauri

Commands:

- `pnpm install`
- `cd apps/backend && uv sync --python 3.11 --all-groups`
- `pnpm contracts:generate`
- `pnpm dev:backend`
- `pnpm dev:desktop`
- `pnpm dev`
- `pnpm lint`
- `pnpm test`

The backend serves the local API on `http://127.0.0.1:8765/api/v1`.

Notes:

- `pnpm dev:desktop` runs the Tauri shell and starts the Vite frontend dev server. Run `pnpm dev:backend` separately if you are not using `pnpm dev`.
- `pnpm dev` starts the backend and desktop flow together.
