# Tuneforge

Tuneforge is a local-first, open-source desktop app for musicians who want to learn, rehearse, and play along with songs. Drop in any track and Tuneforge will split it into vocals, drums, bass, guitar, piano, and other stems, work out the key, tempo, chord progression, and lyrics, and let you shift the pitch, retune to a reference frequency, follow the transcript during playback, and export a custom version to practice with.

Think "AI-assisted song toolkit for the player at home" — but **fully local, single-user, and with no cloud component**. Every track stays on your machine, no account, no upload.

Local-first does not mean first use is always offline: setup or first use can download external ML model weights unless the required local caches already exist or a local/dev package was explicitly built with `--model-bundle`.

## Status

Pre-1.0. The desktop dev flow (`pnpm dev`) is the fastest way to iterate. Local macOS app/DMG and Linux Flatpak packaging are available, but generated builds are unsigned and not notarized. Development/source runs and macOS packages require `ffmpeg`/`ffprobe` on the host `PATH`; Flatpak uses `/app/bin/ffmpeg` and `/app/bin/ffprobe` wrappers backed by the Flatpak runtime sandbox.

Current 1.0 release limits:

- Desktop is the supported full workflow. Android/mobile remains a local-first companion path in progress.
- Packages are local build artifacts, not signed distribution releases.
- Default packages do not include external Demucs, Whisper, or beat-this model weights. Those weights are cached locally and may download on first setup/use unless the caches already exist or a local/dev package was explicitly built with `--model-bundle`. Crema's wheel-embedded chord model assets are the dependency-owned exception and ship with Advanced Chords unless that stack is excluded.
- Advanced Chords, Advanced Beat Analysis, GPU acceleration, loopback/browser playback smoke, and BlackHole or virtual-audio capture need manual or special coverage unless a specific CI job says otherwise.

## Features

- Import `mp3`, `wav`, `flac`, `m4a`, `aac`, `ogg`, `mp4`, and `webm`. `mp4` / `webm` are transcoded to a local WAV working file at import time.
- Key, tempo, and chord-timeline analysis.
- Local lyrics transcription with segment and word timestamps when available.
- In-app lyrics editing with transcript refresh and playback follow.
- Pitch transpose (semitones) and retune (target reference Hz).
- Stem separation via a local Demucs backend. The app defaults to `Default (6 stems model)` and also offers `2 stems model`.
- Preview rendering (cached) and export to `wav`, `mp3`, or `flac`.
- Per-project playback session with persistence, count-in, and playback-level tempo changes.

## Threat Model and Scope

Tuneforge is **local-only by design**:

- The backend binds to `127.0.0.1` only.
- There is **no authentication, no authorization, and no per-user model**.
- Treat the loopback bind as the only trust boundary. Do not expose the port to a network, do not put it behind a reverse proxy, and do not run it on a shared multi-user host without isolation.

Security reports follow the process in [SECURITY.md](./SECURITY.md). "There is no auth" is not a vulnerability — it is the design.

## Workspace

- `apps/backend` — FastAPI API, SQLite persistence, job runner, audio analysis/transforms, pytest suite. See [apps/backend/README.md](apps/backend/README.md).
- `apps/desktop` — Tauri desktop shell and React frontend.
- `packages/shared-types` — TypeScript contract generated from the backend OpenAPI schema.

## Documentation

- [Product specification](./docs/SPEC.md)
- [Third-party notices and release package policy](./THIRD_PARTY_NOTICES.md)
- [Stem separation](./docs/STEM_SEPARATION.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API](./docs/API.md)
- [Native audio and playback QA](./docs/NATIVE_AUDIO.md)
- [Packaging](./docs/PACKAGING.md)
- [Roadmap](./docs/ROADMAP.md)
- [Mobile architecture](./docs/MOBILE.md)
- [References](./docs/REFERENCES.md)

## Prerequisites

- `pnpm` (version pinned in [package.json](./package.json))
- [`uv`](https://docs.astral.sh/uv/)
- Python 3.11
- `ffmpeg` and `ffprobe` available on `PATH` for development/source runs and macOS packages (install via `brew install ffmpeg`, `apt install ffmpeg`, etc.)
- macOS system mic volume control uses the built-in CoreAudio API.
- Linux system mic volume control uses `wpctl` or `pactl` for the active PipeWire/PulseAudio session.
- Linux native tempo playback builds require Clang/libclang for `bindgen` (`sudo pacman -S clang`
  on Arch, `sudo apt-get install clang libclang-dev` on Debian/Ubuntu).
- Rust toolchain for Tauri

## Setup

```sh
pnpm setup:dev
```

That command installs workspace dependencies, checks Tauri build prerequisites, syncs the backend
Python environment with the default desktop advanced engine dependencies, regenerates shared API
contracts, and verifies/preloads the default local model caches. The first setup is heavy because it
installs Demucs/Torch, crema/TensorFlow Advanced Chords, and beat-this Advanced Beat Analysis, then
downloads Demucs stem weights into the shared Torch checkpoint cache, the default Whisper lyrics
model into the TuneForge lyrics cache, and the beat-this `small0` checkpoint into the shared Torch
checkpoint cache. Later worktrees verify file size and SHA-256 first, then skip model
loaders/downloads when the cache is already valid.

Skip all model prewarm work when you only need non-ML development:

```sh
pnpm setup:dev -- --skip-model-prewarm
```

Skip only Demucs model prewarm when you only need non-stem development:

```sh
pnpm setup:dev -- --skip-demucs-models
```

Prepare an explicit Demucs model repo for `TUNEFORGE_DEMUCS_MODEL_REPO` with
`pnpm models:demucs:prepare`. Add `-- --cache-only` or set
`TUNEFORGE_DEMUCS_CACHE_ONLY=1` to require already cached weights.

Advanced Chords and Advanced Beat Analysis are default desktop development engines. Opt out of one
or both advanced dependency stacks when testing fallback behavior or mobile/unsupported profiles:

```sh
pnpm setup:dev -- --no-crema
pnpm setup:dev -- --no-advanced-chords
pnpm setup:dev -- --no-beat-this
pnpm setup:dev -- --no-advanced-beats
```

The built-in chord and beat backends remain available as fallbacks when advanced dependencies are
missing, unsupported, or disabled. Mobile paths do not run the desktop Python/FastAPI stack and must
keep clear disabled/fallback states instead of requiring crema, TensorFlow, or beat-this.

Release diagnostics distinguish host tools from local model/cache dependencies. If an import or
metadata error names `ffmpeg` or `ffprobe`, install FFmpeg on the host or set
`TUNEFORGE_FFMPEG_PATH` / `TUNEFORGE_FFPROBE_PATH`; TuneForge does not bundle those binaries.
Diagnostics that name Demucs, Whisper, crema, or beat-this refer to local runtime dependencies or
model/checkpoint caches, which are prepared by setup/model prewarm or by packages built with
`--model-bundle`.

### Linux legacy NVIDIA profile

If you are on Linux `x86_64` with an older NVIDIA GPU that the default PyTorch build rejects at runtime, use the backend's opt-in legacy NVIDIA sync:

```sh
pnpm setup:dev -- --legacy-nvidia
```

That command first performs the normal backend sync, then locally overrides `torch` / `torchaudio` inside `apps/backend/.venv` with the official CUDA 12.6 wheels. The local backend commands (`pnpm dev:backend`, backend test/lint steps inside `pnpm test` / `pnpm lint`) will keep using that override until you reset the backend env:

```sh
pnpm sync:backend:default
```

To combine the legacy NVIDIA profile with the default Advanced Chords and Advanced Beat Analysis
desktop stack:

```sh
pnpm setup:dev -- --legacy-nvidia
```

Use the same opt-outs when switching profiles directly if you need a built-in-only backend
environment:

```sh
pnpm sync:backend:legacy-nvidia -- --no-crema
pnpm sync:backend:default -- --no-crema
```

Both backend sync helpers recreate `apps/backend/.venv` from scratch to avoid stale mixed CUDA stacks when switching profiles. `uv` still reuses its shared cache, so after the first install, switching is usually much faster than a cold download. It is intended for cards like the GTX 1050 Ti. macOS, CI, and the default Linux setup remain unchanged.

When the legacy marker is active, use the root `pnpm` scripts for backend work. They preserve the local Torch
override; running raw `uv run` inside `apps/backend` can resync the default Torch stack and leave CUDA libraries mixed.

## Development

Two terminals:

```sh
pnpm dev:backend
pnpm dev:desktop
```

Or both at once:

```sh
pnpm dev
```

The backend serves the local API on `http://127.0.0.1:8765/api/v1`.

Native audio notes and the Web Audio fallback override are in [docs/NATIVE_AUDIO.md](docs/NATIVE_AUDIO.md).

## Configuration

Backend behavior is environment-driven. Full table is in [apps/backend/README.md](apps/backend/README.md#configuration). The most relevant variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TUNEFORGE_HOST` | `127.0.0.1` | Dev/test-only loopback override. Allowed values: `127.0.0.1` or `localhost`. |
| `TUNEFORGE_PORT` | `8765` | Bind port. |
| `TUNEFORGE_DATA_DIR` | OS-specific | Override the data directory. |
| `TUNEFORGE_FFMPEG_PATH` / `TUNEFORGE_FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Override binary lookup. |
| `TUNEFORGE_STEM_MODEL` | `htdemucs_6s` | Default Demucs stem model. |
| `TUNEFORGE_STEM_DEVICE` | `auto` | `auto` / `cpu` / `mps` / `cuda`. |
| `TUNEFORGE_DEMUCS_MODEL_REPO` | unset | Local Demucs model repo containing bundled weights/YAML. See `docs/STEM_SEPARATION.md`. |
| `TUNEFORGE_MODEL_BUNDLE_DIR` | unset | Optional packaged model bundle used to seed normal model caches on startup. |
| `TUNEFORGE_LYRICS_MODEL` | `turbo` | Whisper model for lyrics transcription. |
| `TUNEFORGE_LYRICS_DEVICE` | `auto` | `auto` / `cpu` / `mps` / `cuda`. |
| `TUNEFORGE_LYRICS_CACHE_DIR` | upstream Whisper cache | Override where Whisper model weights are cached. |

Default data directory:

- macOS: `~/Library/Application Support/Tuneforge`
- Linux: `~/.local/share/tuneforge`

## Quality Gates

```sh
pnpm lint
pnpm typecheck
pnpm test
```

If you change backend routes or schemas, regenerate the shared contracts and commit the result:

```sh
pnpm contracts:generate
```

CI fails if `packages/shared-types/src/generated/openapi.ts` drifts from the backend OpenAPI output.

## Packaging

Build local unsigned desktop packages with:

```sh
pnpm package:mac
pnpm package:linux:flatpak
```

Plain package commands include crema Advanced Chords and beat-this Advanced Beat Analysis
dependencies by default for desktop builds, but release/default package commands do not pass
`--model-bundle`. Use opt-outs to build fallback packages, and keep `--model-bundle` separate
for local/dev artifacts that explicitly copy model weights into the package:

```sh
pnpm package:mac -- --no-crema --no-beat-this
pnpm package:linux -- --no-advanced-chords --no-advanced-beats --legacy-nvidia
pnpm package:mac -- --model-bundle
```

`--model-bundle` stages Demucs and Whisper weights, and stages the beat-this `small0` checkpoint
only when beat-this dependencies are included. It does not control whether advanced dependencies are
installed. Crema is the dependency-owned exception to the external model-weight rule: its
wheel-embedded chord model files ship when Advanced Chords is included unless `--no-crema` /
`--no-advanced-chords` is used. See
[Third-party notices and release package policy](./THIRD_PARTY_NOTICES.md) for the dependency and
model-weight policy.

Linux Flatpak packages use host XDG data and model cache directories by default, so
packaged runs share `~/.local/share/tuneforge`, `~/.cache/torch`, and `~/.cache/whisper`
with development runs. Pass `--sandbox-data` to keep Flatpak app data private under
`/var/data/tuneforge`.

For faster Flatpak testing, skip the single-file bundle step:

```sh
pnpm package:linux:flatpak -- --no-bundle
```

macOS packaging writes a `.app` bundle and DMG. Flatpak packaging writes either a local `.flatpak`
bundle or, with `--no-bundle`, a local repository install flow. Source distribution is the source
checkout/archive; the package commands do not create a separate source tarball.

macOS packages require host `ffmpeg` / `ffprobe`; Flatpak routes backend lookups to sandbox wrappers at `/app/bin/ffmpeg` and `/app/bin/ffprobe`. Tuneforge does not bundle FFmpeg. See [Packaging](./docs/PACKAGING.md) for output paths, package flags, local repo install commands, data-directory behavior, and size expectations.

## CI

GitHub Actions runs path-aware checks on pull requests and full checks on `main`:

- `backend`: `uv sync`, `ruff`, `mypy`, and FFmpeg-backed `pytest` only when backend/runtime paths require it
- `desktop`: `pnpm install`, `pnpm contracts:generate`, generated-contract drift check, desktop `lint`, `typecheck`, `test`

Manual or special coverage unless a workflow explicitly runs it:

- local macOS packaging, Linux Flatpak packaging, and source/archive release checks
- crema/TensorFlow Advanced Chords and beat-this Advanced Beat Analysis runtime/package checks
- CUDA, MPS, and legacy NVIDIA GPU profiles
- loopback browser playback E2E, Linux virtual-output capture, and macOS BlackHole capture

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Feature scope is opinionated; please open a feature-request issue before writing significant new code.

## License

[MIT](./LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
