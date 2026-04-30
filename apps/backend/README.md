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

From the workspace root, `pnpm setup:dev` also runs the full developer setup: `pnpm install`, backend sync, and shared contract generation.

### Advanced Chords backend

Built-in Chords is the default TuneForge chord backend. It uses TuneForge's built-in librosa/chroma/template pipeline and stays available on every supported backend path.

Advanced Chords is an experimental backend backed by [`crema`](https://github.com/bmcfee/crema). It can preserve richer chord labels from crema, including sevenths and inversion/slash-chord bass notes, but it pulls in TensorFlow/Keras and may start and run more slowly. It is still optional in the current setup, but it is being evaluated as a future desktop default. The optional extra pins the crema stack to TensorFlow/Keras 2.15, scikit-learn `<1.6`, and setuptools `<81` because crema 0.2.0 uses legacy model-loading, encoder, and `pkg_resources` APIs that are not compatible with newer releases.

The current mobile backend does not run the desktop Python/FastAPI stack and disables Advanced Chords through `TUNEFORGE_RUNTIME_PLATFORM`.

Built-in Chords and Advanced Chords both analyze the source track first. When a matching source instrumental stem exists, chord refresh also analyzes that stem and augments the source timeline, so chord jobs can report `source+stem`.

For local desktop development:

```sh
uv sync --python 3.11 --all-groups --extra advanced-chords
```

From the workspace root:

```sh
pnpm setup:dev -- --advanced-chords
```

If `crema`, TensorFlow, Keras, or JAMS are missing, `/api/v1/chord-backends` reports `crema-advanced` as unavailable and normal Built-in Chords detection keeps working.

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
pnpm setup:dev -- --legacy-nvidia
```

Use `pnpm setup:dev -- --legacy-nvidia --advanced-chords` to combine this profile with Advanced Chords.
If you later switch profiles with the standalone helpers, pass the same optional extra there too:

```sh
pnpm sync:backend:legacy-nvidia -- --advanced-chords
pnpm sync:backend:default -- --advanced-chords
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
| `TUNEFORGE_LYRICS_MODEL` | `turbo` | Whisper model used for lyrics generation. |
| `TUNEFORGE_LYRICS_DEVICE` | `auto` | One of `auto`, `cpu`, `mps`, `cuda`. `auto` prefers compatible CUDA, then MPS, then CPU. |
| `TUNEFORGE_LYRICS_CACHE_DIR` | `<data>/cache/lyrics` | Override where Whisper model weights are cached. |
| `TUNEFORGE_DEFAULT_CHORD_BACKEND` | `tuneforge-fast` | Default chord backend for `backend: "default"`. Use `crema-advanced` only in desktop environments with optional dependencies installed. |
| `TUNEFORGE_RUNTIME_PLATFORM` | `desktop` | Runtime platform marker. `android`, `ios`, or `mobile` disables the advanced chord backend. |

Default data directory:

- macOS: `~/Library/Application Support/Tuneforge`
- Linux: `~/.local/share/tuneforge`

Lyrics models follow the same first-use download pattern as Demucs. The selected Whisper weights are downloaded on demand into the lyrics cache directory, then reused offline on later runs.

## Chord backends

List available backends:

```sh
curl http://127.0.0.1:8765/api/v1/chord-backends
```

Generate chords with an explicit backend:

```json
{
  "backend": "tuneforge-fast",
  "force": false,
  "overwrite_user_edits": false
}
```

Accepted backend aliases are `fast` / `tuneforge-fast` and `advanced` / `crema-advanced`. User-edited chord timelines are preserved unless `overwrite_user_edits` is explicitly true.

Benchmark Built-in Chords against Advanced Chords:

```sh
uv run --python 3.11 python -m app.benchmarks.chords --audio /path/to/song.mp3
```

The command writes machine-readable JSON to stdout and a short summary to stderr. Use `--json-only` for JSON-only output.

### Licensing note

The crema package metadata on PyPI lists ISC, while the upstream repository and wheel license file show BSD-2-Clause terms. Both are permissive, but the mismatch should stay documented. The `crema-0.2.0` wheel includes its pretrained chord model files under `crema/models/chord/`, including `model.h5`, so packaged desktop builds that include Advanced Chords redistribute those model artifacts. Primary transitive licenses in the pinned stack include TensorFlow (Apache-2.0), Keras (Apache-2.0), TensorBoard (Apache-2.0), gRPC (Apache-2.0), Protobuf (BSD-3-Clause), h5py/HDF5 (BSD-style), and JAMS (ISC). Complete a fresh full inventory before making Advanced Chords part of the default packaged desktop environment.

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
