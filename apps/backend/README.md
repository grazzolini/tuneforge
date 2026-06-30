# Tuneforge Backend

FastAPI backend for Tuneforge. It owns persistence, artifact management, audio analysis, transform orchestration, and the in-process background job queue.

## Layout

- `app/api/routes/` — HTTP route handlers (projects, jobs, artifacts, health, sync, backend capability lists)
- `app/services/` — orchestration, persistence, caching
- `app/engines/` — pure computation: analysis, beat/chord detection, lyrics, stems (Demucs), transforms (FFmpeg / pitch)
- `app/models.py` / `app/schemas.py` — SQLAlchemy ORM models and Pydantic request/response schemas
- `app/errors.py` — central `AppError` exception and FastAPI error handlers
- `alembic/` — database migrations, run automatically on startup

## Prerequisites

- Python 3.11
- [`uv`](https://docs.astral.sh/uv/)
- `ffmpeg` and `ffprobe` available on `PATH`

## Setup

```sh
uv sync --python 3.11 --all-groups --extra advanced-chords --extra advanced-beats
```

From the workspace root, `pnpm setup:dev` also runs the full developer setup: `pnpm install`,
backend sync with default desktop advanced engine dependencies, model cache/asset verification with
preload/download only for missing or invalid assets, and shared contract generation.

### Advanced Chords backend

Advanced Chords is the default desktop TuneForge chord backend when the desktop dependency stack is
available. Built-in Chords uses TuneForge's built-in librosa/chroma/template pipeline and stays
available as the fallback on every supported backend path.

Advanced Chords is backed by [`crema`](https://github.com/bmcfee/crema). It can preserve richer
chord labels from crema, including sevenths and inversion/slash-chord bass notes, but it pulls in
TensorFlow/Keras and may start and run more slowly. The advanced dependency extra pins the crema
stack because crema 0.2.0 uses legacy model-loading, encoder, and `pkg_resources` APIs that are not
compatible with newer releases.

The current mobile backend does not run the desktop Python/FastAPI stack and disables Advanced Chords through `TUNEFORGE_RUNTIME_PLATFORM`.

Built-in Chords and Advanced Chords both analyze the source track first. When matching source stems exist, chord refresh also analyzes a non-vocal stem input and augments the source timeline, so chord jobs can report `source+stem`. For the 6 stems model, the non-vocal input is a temporary float mix of drums, bass, guitar, piano, and other that is deleted after analysis.

For local desktop development, plain setup includes Advanced Chords by default:

```sh
pnpm setup:dev
```

Opt out when testing built-in fallback behavior or unsupported profiles:

```sh
pnpm setup:dev -- --no-crema
pnpm setup:dev -- --no-advanced-chords
```

If `crema`, TensorFlow, Keras, or JAMS are missing, `/api/v1/chord-backends` reports `crema-advanced` as unavailable and normal Built-in Chords detection keeps working.

Release coverage label: full crema/TensorFlow runtime, package inclusion, and model-artifact review
are manual or special checks unless a CI workflow explicitly installs and exercises the advanced
dependency stack. Built-in Chords fallback should stay available when that stack is missing.

### Advanced Beat Analysis backend

Advanced Beat Analysis is the default desktop timing-grid backend when the desktop dependency stack
and `small0` checkpoint are available. Built-in Beat Analysis uses TuneForge's built-in
librosa-derived beat tracker, sparse-gap stabilization, and downbeat heuristics, and stays available
as the fallback.

Advanced Beat Analysis is backed by [`beat-this`](https://github.com/CPJKU/beat_this). It runs when
an analyze request uses `"beat_backend": "beat-this"`; desktop preferences and desktop import flows
select it by default when available. For the default desktop setup:

```sh
pnpm setup:dev
```

The backend loads `beat-this` lazily and uses its `small0` checkpoint on CPU. `pnpm setup:dev`
verifies the checkpoint with size and SHA-256 before importing beat-this; if it is missing or
invalid, setup preloads it. If the dependency or checkpoint is unavailable, the advanced settings
option is disabled and Built-in Beat Analysis keeps working.

Release coverage label: full beat-this runtime and checkpoint behavior are manual or special checks
unless a CI workflow explicitly installs the advanced beat dependency stack and exercises it.

`pnpm setup:dev` may download the checkpoint into the local PyTorch cache during setup. Opt out when
testing built-in fallback behavior or unsupported profiles:

```sh
pnpm setup:dev -- --no-beat-this
pnpm setup:dev -- --no-advanced-beats
```

To verify or preload manually:

```sh
uv sync --python 3.11 --all-groups --extra advanced-beats
uv run --python 3.11 python -m app.cli.prewarm_models --skip-demucs --skip-whisper --include-beat-this
```

The preload is stored at `$TORCH_HOME/hub/checkpoints/beat_this-small0.ckpt` when `TORCH_HOME` is set, `$XDG_CACHE_HOME/torch/hub/checkpoints/beat_this-small0.ckpt` when `XDG_CACHE_HOME` is set, or `~/.cache/torch/hub/checkpoints/beat_this-small0.ckpt` by default. When that file already matches the expected size and SHA-256, setup only verifies it and skips beat-this import/download.

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

The legacy NVIDIA profile includes the default advanced desktop engines unless you pass opt-outs.
If you later switch profiles with the standalone helpers, pass opt-outs only when you need the
built-in fallback stack:

```sh
pnpm sync:backend:legacy-nvidia -- --no-crema
pnpm sync:backend:default -- --no-crema
```

This profile is an opt-in local override for Linux `x86_64`. The committed lockfile and the default macOS / Linux
setup stay unchanged. When the override is active, use the repository commands (`pnpm dev:backend`, `pnpm test`,
`pnpm lint`, `pnpm contracts:generate`) so the backend keeps using the overridden `.venv` instead of asking `uv` to
resync it.

Release coverage label: CUDA, MPS, and legacy NVIDIA GPU behavior are manual or special checks
unless a CI workflow explicitly runs on matching hardware/profile.

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
| `TUNEFORGE_HOST` | `127.0.0.1` | Dev/test-only loopback override. Allowed values: `127.0.0.1` or `localhost`. |
| `TUNEFORGE_PORT` | `8765` | Bind port. |
| `TUNEFORGE_ADDITIONAL_CORS_ORIGINS` | unset | Comma-separated local HTTP origins to allow in addition to the desktop defaults. Only `http://127.0.0.1:<port>` and `http://localhost:<port>` are accepted. |
| `TUNEFORGE_DATA_DIR` | OS-specific | Override for the data directory (database, projects, cache). |
| `TUNEFORGE_FFMPEG_PATH` | `ffmpeg` | Override the `ffmpeg` binary location. |
| `TUNEFORGE_FFPROBE_PATH` | `ffprobe` | Override the `ffprobe` binary location. |
| `TUNEFORGE_STEM_MODEL` | `htdemucs_6s` | Default Demucs model used for stem separation. |
| `TUNEFORGE_STEM_DEVICE` | `auto` | One of `auto`, `cpu`, `mps`, `cuda`. `auto` prefers compatible CUDA, then MPS, then CPU. |
| `TUNEFORGE_DEMUCS_MODEL_REPO` | unset | Optional local Demucs model repo containing packaged `.yaml` and `.th` files. When unset, Demucs uses the Torch checkpoint cache. |
| `TUNEFORGE_MODEL_BUNDLE_DIR` | unset | Optional packaged model bundle directory. When set, backend startup seeds normal model caches from this directory before model loaders run. |
| `TUNEFORGE_LYRICS_MODEL` | `turbo` | Whisper model used for lyrics generation. |
| `TUNEFORGE_LYRICS_DEVICE` | `auto` | One of `auto`, `cpu`, `mps`, `cuda`. `auto` prefers compatible CUDA, then MPS, then CPU. |
| `TUNEFORGE_LYRICS_CACHE_DIR` | upstream Whisper cache | Override where Whisper model weights are cached. By default this is `$XDG_CACHE_HOME/whisper` or `~/.cache/whisper`. |
| `TUNEFORGE_DEFAULT_CHORD_BACKEND` | `crema-advanced` | Default chord backend for `backend: "default"` on desktop. Built-in fallback remains available when crema is unavailable, unsupported, or explicitly excluded. |
| `TUNEFORGE_RUNTIME_PLATFORM` | `desktop` | Runtime platform marker. `android`, `ios`, or `mobile` disables the advanced chord backend. |

Default data directory:

- macOS: `~/Library/Application Support/Tuneforge`
- Linux: `~/.local/share/tuneforge`

Lyrics models are downloaded on demand into the lyrics cache directory, then reused offline on later runs. In development, `pnpm setup:dev` verifies Demucs, Whisper, crema, and beat-this `small0` caches/assets, then preloads or downloads only missing, corrupt, or partial assets through the existing model loader paths. A successful setup verification means the local cache/assets are usable; runtime models may still load lazily on first use. The Torch cache path is `$TORCH_HOME/hub/checkpoints` when `TORCH_HOME` is set, `$XDG_CACHE_HOME/torch/hub/checkpoints` when `XDG_CACHE_HOME` is set, or `~/.cache/torch/hub/checkpoints` by default. Packaged desktop builds use these same caches by default. Packages built with `--model-bundle` seed Demucs and Whisper caches from package resources on startup, and also seed the beat-this `small0` checkpoint when beat-this dependencies are included.

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
bash scripts/run-backend-module.sh app.benchmarks.chords --audio /path/to/song.mp3
```

Run from the repository root. The command writes machine-readable JSON to stdout and a short summary to stderr. Use `--json-only` for JSON-only output.

Benchmark timing-grid heuristic analysis against a local, non-committed track set:

```sh
bash scripts/run-backend-module.sh app.benchmarks.timing --audio-dir /path/to/local/tracks --json-only
```

You can also run the wrapper from the backend environment:

```sh
cd apps/backend
uv run --python 3.11 python ../../scripts/benchmark-timing.py --track-dir /path/to/local/tracks --json-only
```

The timing benchmark reports anonymized `track_###` rows by default. Add `--include-relative-paths` only when relative
paths are safe to include in local research notes.

### Licensing note

The crema package metadata on PyPI lists ISC, while the upstream repository and wheel license file show BSD-2-Clause terms. Both are permissive, but the mismatch should stay documented. The `crema-0.2.0` wheel includes its pretrained chord model files under `crema/models/chord/`, including `model.h5`, so standard packaged desktop builds redistribute those model artifacts unless Advanced Chords is explicitly excluded. Primary transitive licenses in the pinned stack include TensorFlow (Apache-2.0), Keras (Apache-2.0), TensorBoard (Apache-2.0), gRPC (Apache-2.0), Protobuf (BSD-3-Clause), h5py/HDF5 (BSD-style), and JAMS (ISC). Keep a fresh full inventory before release packaging.

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
