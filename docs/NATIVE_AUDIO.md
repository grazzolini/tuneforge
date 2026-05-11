# Native Audio

TuneForge keeps Web Audio as the fallback implementation for desktop audio paths. Native audio is
added feature by feature behind the Tauri native audio boundary.

## Current Scope

- Tuner microphone capture uses native `cpal` on supported desktop builds.
- Tuner device listing uses native input enumeration first, then cached/browser labels as fallback.
- Source, practice-mix, and stem playback prefer native `cpal` on macOS/Linux when every active
  artifact has a local path. WAV uses a fast streaming reader; other common formats decode through
  Symphonia for playback only.
- Native playback supports shared transport play/pause/seek, position events, mute/solo lane gains,
  and generated metronome click lanes for follow-playback mode.
- Native tempo changes use `signalsmith-stretch` for pitch-preserving playback.
- If native setup, decode, seek, or output startup fails, playback falls back to Web Audio at the
  same transport position.
- Linux native capture and playback currently use `cpal`'s ALSA host. On PipeWire/PulseAudio
  desktops this usually routes through the host ALSA compatibility layer, but device labels may
  still look like ALSA PCM names.

## Backend Selection

The frontend prefers native audio when a feature is supported and falls back to Web Audio when
native support is unavailable or startup fails.

## Linux Build Prerequisites

Native tempo playback uses `signalsmith-stretch`, which runs Rust `bindgen` during the Tauri build.
Linux developers need Clang/libclang development files available to Cargo:

```sh
# Arch
sudo pacman -S clang

# Debian/Ubuntu
sudo apt-get install clang libclang-dev
```

`pnpm setup:dev` checks these prerequisites. `pnpm --filter @tuneforge/desktop tauri ...` runs
through a wrapper that sets `LIBCLANG_PATH` from a system install or from the backend `.venv` when
the optional TensorFlow stack already installed the Python `libclang` wheel. Direct `cargo check` /
`cargo test` commands still require the same system toolchain or equivalent `LIBCLANG_PATH`.

For development comparisons, force Web Audio for native-audio-backed features:

```sh
VITE_TUNEFORGE_FORCE_WEB_AUDIO=1 pnpm dev
```

If the backend is already running separately:

```sh
VITE_TUNEFORGE_FORCE_WEB_AUDIO=1 pnpm dev:desktop
```

This is a global native audio override, not a per-feature setting. It affects tuner capture and
project playback so Web Audio remains the comparison path for both.

## Diagnostics

Settings -> Local Data -> Show diagnostics reports:

- backend package version and git ref
- frontend package version and git ref
- input capture availability
- last tuner capture backend
- last native capture error
- playback backend
- last playback backend
- last native playback error
- latest native fallback cause
- native playback buffer health per lane, including fill level, underrun count, worker errors, and
  the last worker error when present

When `VITE_TUNEFORGE_FORCE_WEB_AUDIO=1` is active, diagnostics report `Web Audio (forced)`.

## Device And Volume Behavior

Native tuner capture can use a selected input device without changing the system default microphone.
Native selected-device volume uses host controls where available. Web Audio capture remains limited
to the browser/system default input path, so non-default microphone choices are disabled while Web
Audio is active.

## Playback QA Matrix

Use this matrix for local regressions against source, practice-mix, and stems.
Run once with native playback selected per platform, then rerun with forced Web Audio.

| Check | Native macOS | Native Linux | Forced Web Audio (`VITE_TUNEFORGE_FORCE_WEB_AUDIO=1`) |
| --- | --- | --- | --- |
| Source playback | start/seek/pause/resume/stop works | start/seek/pause/resume/stop works | start/seek/pause/resume/stop works |
| Practice mix playback | start/seek/pause/resume/stop works | start/seek/pause/resume/stop works | start/seek/pause/resume/stop works |
| Stem playback | start/seek/pause/resume/stop works | start/seek/pause/resume/stop works | start/seek/pause/resume/stop works |
| Mute/Solo behavior | lane mute and solo are independent and audible | lane mute and solo are independent and audible | lane mute and solo are independent and audible |
| Seek accuracy | scrub reflects transport position and lane audio resumes at target | same | same |
| Stop semantics | returns transport to expected idle state | same | same |
| Pause/Resume | no drift on resume at least for short cycle | no drift on resume at least for short cycle | no drift on resume at least for short cycle |
| Loop | loop boundaries and loop duration stable | stable | stable |
| Song count-in | only runs from absolute song start | same | same |
| Loop count-in | runs at loop start and on loop wrap, never on pause/resume | same | same |
| Tempo control | tempo change applies and stays stable | tempo change applies and stays stable | tempo change applies and stays stable |
| Metronome follow | follows active track tempo while BPM changes | follows active track tempo while BPM changes | follows active track tempo while BPM changes |
| Fallback + no output device | falls back (or errors and recovers) without crash when no native output exists | same | same |

## Local-only Playwright Smoke Harness

Scaffold file: `scripts/playback-smoke.mjs` (local only, not wired to CI). This is a
browser-based smoke check for the frontend/Web Audio transport path; native output still needs the
manual matrix above. `pnpm setup:dev` installs the Playwright Chromium browser needed by this
smoke check; use `pnpm setup:dev -- --skip-playwright-browsers` to skip that download.

Check that the local smoke scaffold is available:

```sh
pnpm --filter @tuneforge/desktop test:e2e
```

Start the dev app first with `pnpm dev`, or `pnpm dev:desktop` when the backend is already
running. Then execute the smoke pass with the visible project name from the library:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --project-name="Demo Song"
```

For full coverage, use a fixture project with timed lyrics or chords. The smoke pass always checks
stopped scrubber start, and it also checks stopped lyrics/chords start when a timed practice target
is available.

If you already know the project ID, `--project-id=<id>` opens the project route directly.
Set `TUNEFORGE_SMOKE_APP_URL` if the desktop frontend is not on `http://127.0.0.1:1420`.
