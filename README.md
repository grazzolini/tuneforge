# Tuneforge

Tuneforge is a local-first, open-source desktop app for musicians who want to learn, rehearse, and play along with songs. Drop in any track and Tuneforge will split it into vocals, drums, bass, guitar, piano, and other stems, work out the key, tempo, chord progression, and lyrics, and let you shift the pitch, retune to a reference frequency, follow the transcript during playback, and export a custom version to practice with.

Think "AI-assisted song toolkit for the player at home" — but **fully local, single-user, and with no cloud component**. Every track stays on your machine, no account, no upload.

## Status

Pre-1.0. The desktop dev flow (`pnpm dev`) is the fastest way to iterate. Local macOS app/DMG packaging is available with `pnpm package:mac`; generated builds are unsigned, not notarized, and require `ffmpeg`/`ffprobe` on the host `PATH`.

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
- [Stem separation](./docs/STEM_SEPARATION.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API](./docs/API.md)
- [Packaging](./docs/PACKAGING.md)
- [Roadmap](./docs/ROADMAP.md)
- [Mobile architecture](./docs/MOBILE.md)
- [References](./docs/REFERENCES.md)

## Prerequisites

- `pnpm` (version pinned in [package.json](./package.json))
- [`uv`](https://docs.astral.sh/uv/)
- Python 3.11
- `ffmpeg` and `ffprobe` available on `PATH` (install via `brew install ffmpeg`, `apt install ffmpeg`, etc.)
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
Python environment, regenerates shared API contracts, and prepares the pinned local Demucs model repo.
The first setup is heavy because it installs Demucs/Torch and downloads stem weights into
`packaging/demucs/cache/`. Later backend launches use the prepared repo automatically, so stem
generation does not download weights at runtime.

Skip model preparation when you only need non-stem development:

```sh
pnpm setup:dev -- --skip-demucs-models
```

Prepare models manually with `pnpm models:demucs:prepare`. Add `-- --cache-only` or set
`TUNEFORGE_DEMUCS_CACHE_ONLY=1` to require already cached weights.

To install the optional experimental crema/TensorFlow Advanced Chords backend for local desktop development:

```sh
pnpm setup:dev -- --advanced-chords
```

`--crema` is accepted as an alias. Advanced Chords remains optional; default setup and mobile paths do not install crema or TensorFlow.

### Linux legacy NVIDIA profile

If you are on Linux `x86_64` with an older NVIDIA GPU that the default PyTorch build rejects at runtime, use the backend's opt-in legacy NVIDIA sync:

```sh
pnpm setup:dev -- --legacy-nvidia
```

That command first performs the normal backend sync, then locally overrides `torch` / `torchaudio` inside `apps/backend/.venv` with the official CUDA 12.6 wheels. The local backend commands (`pnpm dev:backend`, backend test/lint steps inside `pnpm test` / `pnpm lint`) will keep using that override until you reset the backend env:

```sh
pnpm sync:backend:default
```

To combine the legacy NVIDIA profile with Advanced Chords:

```sh
pnpm setup:dev -- --legacy-nvidia --advanced-chords
```

The standalone backend sync helpers also accept `--advanced-chords` / `--crema` when switching profiles:

```sh
pnpm sync:backend:legacy-nvidia -- --advanced-chords
pnpm sync:backend:default -- --advanced-chords
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
| `TUNEFORGE_HOST` | `127.0.0.1` | Bind address. Do not change to a public address. |
| `TUNEFORGE_PORT` | `8765` | Bind port. |
| `TUNEFORGE_DATA_DIR` | OS-specific | Override the data directory. |
| `TUNEFORGE_FFMPEG_PATH` / `TUNEFORGE_FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Override binary lookup. |
| `TUNEFORGE_STEM_MODEL` | `htdemucs_6s` | Default Demucs stem model. |
| `TUNEFORGE_STEM_DEVICE` | `auto` | `auto` / `cpu` / `mps` / `cuda`. |
| `TUNEFORGE_DEMUCS_MODEL_REPO` | unset | Local Demucs model repo containing bundled weights/YAML. See `docs/STEM_SEPARATION.md`. |
| `TUNEFORGE_LYRICS_MODEL` | `turbo` | Whisper model for lyrics transcription. |
| `TUNEFORGE_LYRICS_DEVICE` | `auto` | `auto` / `cpu` / `mps` / `cuda`. |

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

For Linux local/dev packaging with Advanced Chords, Advanced Beat Analysis, legacy NVIDIA Torch, and shared host XDG data, use the full Flatpak profile:

```sh
pnpm package:linux:flatpak:full
```

For faster Flatpak testing, skip the single-file bundle step:

```sh
pnpm package:linux:flatpak -- --no-bundle
pnpm package:linux:flatpak:full -- --no-bundle
```

Packaged builds require host `ffmpeg` / `ffprobe`; Tuneforge does not bundle FFmpeg. See [Packaging](./docs/PACKAGING.md) for output paths, Flatpak profiles, local repo install commands, data-directory behavior, and size expectations.

## CI

GitHub Actions runs path-aware checks on pull requests and full checks on `main`:

- `backend`: `uv sync`, `ruff`, `mypy`, and FFmpeg-backed `pytest` only when backend/runtime paths require it
- `desktop`: `pnpm install`, `pnpm contracts:generate`, generated-contract drift check, desktop `lint`, `typecheck`, `test`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Feature scope is opinionated; please open a feature-request issue before writing significant new code.

## License

[MIT](./LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
