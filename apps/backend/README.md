# Tuneforge Backend

FastAPI backend for Tuneforge. It owns persistence, artifact management, audio analysis, transform orchestration, and the in-process background job queue.

## Layout

- `app/api/routes/` — HTTP route handlers (projects, jobs, artifacts, health)
- `app/services/` — orchestration, persistence, caching
- `app/engines/` — pure computation: analysis, chord detection, stems (Demucs), transforms (FFmpeg / pitch)
- `app/models.py` / `app/schemas.py` — SQLAlchemy ORM models and Pydantic request/response schemas
- `app/errors.py` — central `AppError` exception and FastAPI error handlers
- `alembic/` — database migrations, run automatically on startup

## Prerequisites

- Python 3.11
- [`uv`](https://docs.astral.sh/uv/)
- `ffmpeg` and `ffprobe` available on `PATH`

## Setup

```sh
uv sync --python 3.11 --all-groups
```

### Linux legacy NVIDIA profile

If you are on Linux `x86_64` and the default PyTorch build does not support your NVIDIA GPU architecture (for example, Pascal cards like the GTX 1050 Ti), start from the standard sync above and then locally override `torch` / `torchaudio` with the older CUDA 12.6 wheels:

```sh
uv pip install \
  --python .venv/bin/python \
  --torch-backend cu126 \
  --reinstall-package torch \
  --reinstall-package torchaudio \
  "torch==2.6.0" \
  "torchaudio==2.6.0"
```

From the workspace root, the helper command is:

```sh
pnpm sync:backend:legacy-nvidia
```

This profile is an opt-in local override for Linux `x86_64`. The committed lockfile and the default macOS / Linux setup stay unchanged. When the override is active, use the repository commands (`pnpm dev:backend`, `pnpm test`, `pnpm lint`) so the backend keeps using the overridden `.venv` instead of asking `uv` to resync it.

Both backend sync helpers recreate `.venv` from scratch before installing packages. That avoids stale mixed CUDA stacks after switching between the default and legacy NVIDIA profiles, while still letting `uv` reuse its shared cache for faster reinstalls.

To switch back to the default backend dependency set, rerun:

```sh
pnpm sync:backend:default
```

## Run (development)

From the workspace root:

```sh
pnpm dev:backend
```

Or directly:

```sh
uv run --python 3.11 uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
```

The API is served at `http://127.0.0.1:8765/api/v1`. OpenAPI documentation is at `http://127.0.0.1:8765/docs`.

## Configuration

All configuration is environment-driven (see [`app/config.py`](./app/config.py)):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TUNEFORGE_HOST` | `127.0.0.1` | Bind address. **Do not change to a public address.** |
| `TUNEFORGE_PORT` | `8765` | Bind port. |
| `TUNEFORGE_DATA_DIR` | OS-specific | Override for the data directory (database, projects, cache). |
| `TUNEFORGE_FFMPEG_PATH` | `ffmpeg` | Override the `ffmpeg` binary location. |
| `TUNEFORGE_FFPROBE_PATH` | `ffprobe` | Override the `ffprobe` binary location. |
| `TUNEFORGE_STEM_MODEL` | `htdemucs_ft` | Demucs model used for stem separation. |
| `TUNEFORGE_STEM_DEVICE` | `auto` | One of `auto`, `cpu`, `mps`, `cuda`. `auto` prefers compatible CUDA, then MPS, then CPU. |

Default data directory:

- macOS: `~/Library/Application Support/Tuneforge`
- Linux: `~/.local/share/tuneforge`

## Migrations

Alembic migrations live in `alembic/versions/`. They run automatically on application startup. To create a new migration after changing models:

```sh
uv run --python 3.11 alembic revision --autogenerate -m "describe change"
```

Review the generated file before committing.

## Job system

The job runner is single-process, in-memory, and persists job state to SQLite ([`app/services/jobs.py`](./app/services/jobs.py)). On startup, jobs left in `running` state from a previous shutdown are marked `failed`, and any `pending` jobs are re-enqueued. The default worker count is `1` to avoid GPU/CPU contention with Demucs.

## Testing

```sh
uv run --python 3.11 pytest
```

Test fixtures generate synthetic audio (sine waves, chord progressions, multiple containers) so most tests run without external sample files.

## Lint / type-check

```sh
uv run --python 3.11 ruff check .
uv run --python 3.11 mypy app
```
