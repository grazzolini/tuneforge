# TuneForge Backend

FastAPI backend for TuneForge. It owns persistence, artifact management, audio analysis, transform orchestration, and the in-process background job queue.

## Layout

- `app/api/routes/` — HTTP route handlers (projects, jobs, artifacts, health, sync, backend capability lists)
- `app/services/` — orchestration, persistence, caching
- `app/engines/` — pure computation: analysis, beat/chord detection, lyrics, stems (Demucs), transforms (FFmpeg / pitch)
- `app/models.py` / `app/schemas.py` — SQLAlchemy ORM models and Pydantic request/response schemas
- `app/errors.py` — central `AppError` exception and FastAPI error handlers
- `alembic/` — database migrations, run automatically on startup

## Prerequisites

- Python 3.14.7
- [`uv`](https://docs.astral.sh/uv/)
- `ffmpeg` and `ffprobe` available on `PATH`

## Setup

```sh
uv sync --python 3.14 --all-groups --extra advanced-chords --extra advanced-beats --extra lv-chordia
```

From the workspace root, `pnpm setup:dev` also runs the full developer setup: `pnpm install`,
backend sync with default desktop advanced engine dependencies, model cache/asset verification with
preload/download only for missing or invalid assets, and shared contract generation.

### Advanced Chords backend

Advanced Chords is the default desktop TuneForge chord backend when the desktop dependency stack is
available. Built-in Chords uses TuneForge's built-in librosa/chroma/template pipeline and stays
available as the fallback on every supported backend path.

Advanced Chords uses an ONNX Runtime conversion of the
[`crema`](https://github.com/bmcfee/crema) 0.2.0 model. It preserves the `crema-advanced` backend ID,
default selection, richer chord vocabulary, and slash-chord bass notes without installing the
Crema Python package, TensorFlow, or Keras. The `advanced-chords` extra is canonical;
`advanced-chords-onnx` is an equivalent compatibility extra. Preserved LV Chordia support still
installs its separately declared `h5py` dependency.

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

The historical selectors are compatibility aliases for the same ONNX profile:

```sh
pnpm setup:dev -- --crema-onnx
```

Setup verifies or prewarms the immutable model and runtime state in the normal TuneForge data cache.
TuneForge downloads missing files anonymously from the pinned Hugging Face revision.

`/api/v1/chord-backends` reports Advanced Chords availability and the installed implementation.
ONNX download, integrity, decoder, and inference failures are reported on the requested job.

Release coverage label: ONNX runtime, package inclusion, offline first-use, and model-integrity
checks are manual or special checks unless a CI workflow explicitly exercises the advanced
dependency stack. Built-in Chords fallback should stay available when that stack is missing.

### LV Chordia backend

`lv-chordia-submission` (alias `lv-chordia`) is an optional desktop chord backend using the
submission vocabulary from audited upstream revision
`9d7de7bbf45efa6731ec8dc62d35280f141c0702`. Normal desktop setup and packages include its five
MIT checkpoints (28,730,939 bytes); `--no-lv-chordia` excludes the dependency and checkpoints.
The backend validates every checkpoint name, size, and SHA-256 before model loading. Missing or
corrupt assets fail closed and are repaired by reinstalling or rebuilding the package; there is no
download or user-cache lifecycle. Advanced Chords remains the default pending manual product evaluation.

The pinned LV Chordia 1.1.0 metadata requests NumPy 2.2.6+ and Torch 2.13+, which the refreshed
default graph now satisfies without global NumPy or Torch overrides. The dependency refresh reruns
LV Chordia's pinned upstream CPU golden with its prepared checkpoints; TuneForge does not copy that
upstream audio fixture into this repository. Its own tests cover checkpoint integrity and mocked
offline/session paths, not a repository-owned real-session golden. This is not a claim that every
LV Chordia or CUDA hardware combination is qualified.

LV Chordia accepts local audio paths only. It uses CUDA only when the installed PyTorch build
supports a visible GPU architecture, otherwise it selects MPS or CPU. Model prewarm and inference
retry once on CPU for accelerator availability or allocation failures. Explicit generation,
refresh, stem, and bulk requests never switch chord backends; import routes may record a Built-in
fallback.

### Advanced Beat Analysis backend

Advanced Beat Analysis is the default desktop timing-grid request. It uses the optional `beat-this`
dependency and downloads or loads its `small0` checkpoint on first use. Built-in Beat Analysis uses
TuneForge's local librosa-derived beat tracker, sparse-gap stabilization, and downbeat heuristics,
and remains available as an explicit alternative.

Advanced Beat Analysis is backed by [`beat-this`](https://github.com/CPJKU/beat_this). Analyze,
import, and bulk analyze requests default to `"beat_backend": "beat-this"`; desktop actions send the
saved choice to the backend. For the default desktop setup:

```sh
pnpm setup:dev
```

The backend loads `beat-this` lazily and uses its `small0` checkpoint on CPU. An Advanced Beat
Analysis request fails if its optional dependency is missing or if checkpoint download, load,
runtime, or timing analysis ultimately fails. It never silently switches analysis engines. An
explicit Built-in Beat Analysis request never probes `beat-this`. `pnpm setup:dev`
verifies the checkpoint with size and SHA-256 before importing beat-this; if it is missing or
invalid, setup preloads it. Normal desktop builds submit the saved Advanced Beat Analysis choice even
if dependency diagnostics fail, so the job reports the failure instead of silently switching engines.
Packages built with `--no-beat-this` embed that intentional opt-out and desktop actions explicitly
select Built-in Beat Analysis.

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
uv sync --python 3.14 --all-groups --extra advanced-beats
uv run --python 3.14 python -m app.cli.prewarm_models --skip-demucs --skip-whisper --include-beat-this
```

The preload is stored at `$TORCH_HOME/hub/checkpoints/beat_this-small0.ckpt` when `TORCH_HOME` is set, `$XDG_CACHE_HOME/torch/hub/checkpoints/beat_this-small0.ckpt` when `XDG_CACHE_HOME` is set, or `~/.cache/torch/hub/checkpoints/beat_this-small0.ckpt` by default. When that file already matches the expected size and SHA-256, setup only verifies it and skips beat-this import/download.

### Linux legacy NVIDIA profile

If you are on Linux `x86_64` and the default PyTorch build does not support your NVIDIA GPU architecture, start from the standard sync above and then locally override `torch` / `torchaudio` with the older CUDA 12.6 wheels:

```sh
uv pip install \
  --python .venv/bin/python \
  --torch-backend cu126 \
  --reinstall-package torch \
  --reinstall-package torchaudio \
  "torch==2.13.0" \
  "torchaudio==2.11.0"
```

From the workspace root, the helper command is:

```sh
pnpm setup:dev -- --legacy-nvidia
```

The legacy NVIDIA profile installs Torch 2.13.0 and torchaudio 2.11.0 CUDA 12.6 wheels and includes
the default advanced desktop engines, including LV Chordia, unless you pass opt-outs. The profile
script verifies the selected wheel versions and CUDA runtime only; GPU inference still requires a
Linux x86_64 machine with the intended NVIDIA driver and hardware.
If you later switch profiles with the standalone helpers, pass opt-outs only when you need the
built-in fallback stack:

```sh
pnpm sync:backend:legacy-nvidia -- --no-crema
pnpm sync:backend:legacy-nvidia -- --no-lv-chordia
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
uv run --python 3.14 uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
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
| `TUNEFORGE_RUNTIME_PLATFORM` | `desktop` | Runtime platform marker. `android`, `ios`, or `mobile` disables desktop chord backends. |

Default data directory:

- macOS: `~/Library/Application Support/Tuneforge`
- Linux: `~/.local/share/tuneforge`

Lyrics models are downloaded on demand into the lyrics cache directory, then reused offline on later runs. In development, `pnpm setup:dev` verifies Demucs, Whisper, Advanced Chords ONNX, and beat-this `small0` caches/assets, then preloads or downloads only missing, corrupt, or partial assets through the existing model loader paths. A successful setup verification means the local cache/assets are usable; runtime models may still load lazily on first use. The Torch cache path is `$TORCH_HOME/hub/checkpoints` when `TORCH_HOME` is set, `$XDG_CACHE_HOME/torch/hub/checkpoints` when `XDG_CACHE_HOME` is set, or `~/.cache/torch/hub/checkpoints` by default. Packaged desktop builds use these same caches by default. Advanced Chords packages always seed the exact pinned ONNX files. Packages built with `--model-bundle` additionally seed Demucs and Whisper caches, plus the beat-this `small0` checkpoint when beat-this dependencies are included.

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

Accepted backend aliases are `fast` / `tuneforge-fast`, `advanced` / `crema-advanced`, and
`lv-chordia` / `lv-chordia-submission`. User-edited chord timelines are preserved unless
`overwrite_user_edits` is explicitly true.

Benchmark Built-in Chords against Advanced Chords:

```sh
pnpm chords:benchmark -- --audio /path/to/song.mp3
```

### Chord quality benchmarks

The quality benchmark is a manual-only evaluator; it is intentionally excluded from CI and never
downloads datasets. It emits anonymous aggregate metrics only, without source paths, filenames,
labels, timelines, or audio hashes. The deterministic synthetic suite contains generated tones only:

```sh
pnpm chords:benchmark -- --quality-synthetic --json-only
```

For an external normalized manifest, keep the manifest and its audio outside the repository. The
manifest requires SHA-256-verified relative audio paths and only the fixed public musical strata.
Pass an explicit root for those paths. Vendored public manifests resolve their declared safe
`data_subdir` below that root, so GuitarSet and Tiny AAM can run together:

```sh
pnpm chords:benchmark -- \
  --quality-manifest /secure/local/chords.json --data-root /secure/local/data --json-only
```

Vendored GuitarSet 1.1.0 and Tiny AAM 1.1.0 manifests pin official archive and selected-asset
checksums plus deterministic six-track selection rules. The benchmark does not fetch data; corpus
execution and archive/layout validation remain separate manual checks.

Run from the repository root. The command writes machine-readable JSON to stdout and a short summary to stderr. Use `--json-only` for JSON-only output.

Benchmark timing-grid heuristic analysis against a local, non-committed track set:

```sh
bash scripts/run-backend-module.sh app.benchmarks.timing --audio-dir /path/to/local/tracks --json-only
```

You can also run the wrapper from the backend environment:

```sh
cd apps/backend
uv run --python 3.14 python ../../scripts/benchmark-timing.py --track-dir /path/to/local/tracks --json-only
```

The timing benchmark reports anonymized `track_###` rows by default. Add `--include-relative-paths` only when relative
paths are safe to include in local research notes.

### Licensing note

Advanced Chords uses ONNX Runtime under the MIT license and a converted Crema 0.2.0 model. The
model provenance, original BSD-2-Clause notice, immutable revision, size, and SHA-256 hashes remain
part of the release inventory. The Crema Python wheel, TensorFlow, and Keras are not distributed.
Keep a fresh full inventory before release packaging.

## Migrations

Alembic migrations live in `alembic/versions/`. They run automatically on application startup. To create a new migration after changing models:

```sh
uv run --python 3.14 alembic revision --autogenerate -m "describe change"
```

Review the generated file before committing.

## Job system

The job runner is single-process, in-memory, and persists job state to SQLite ([`app/services/jobs.py`](./app/services/jobs.py)). On startup, jobs left in `running` state from a previous shutdown are marked `failed`, and any `pending` jobs are re-enqueued. The default worker count is `1` to avoid GPU/CPU contention with Demucs.

## Testing

```sh
uv run --python 3.14 pytest
```

Test fixtures generate synthetic audio (sine waves, chord progressions, multiple containers) so most tests run without external sample files.

## Lint / type-check

```sh
uv run --python 3.14 ruff check .
uv run --python 3.14 mypy app
```
