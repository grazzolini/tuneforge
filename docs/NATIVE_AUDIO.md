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

Playback also owns media-key controls and wake prevention through the active backend only:

- TuneForge registers one desktop system-media adapter with the OS for media keys and headset
  controls. That adapter does not choose the audio engine; it routes play/pause/stop/seek events to
  the current playback owner.
- Native playback owns the transport only after native playback has successfully started, and uses
  native idle/display inhibition while playing.
- Web Audio/HTML media playback owns the transport when playback starts through browser media,
  including `VITE_TUNEFORGE_FORCE_WEB_AUDIO=1` and native fallback. It uses the browser Screen Wake
  Lock while playing.
- Native fallback is an explicit ownership transfer. TuneForge clears system media state and native
  idle inhibition, starts the Web Audio path at the fallback position, then re-registers system
  media state for the Web Audio owner and acquires the browser wake lock. Diagnostics keep the
  native fallback reason.
- Failed native prepare/play attempts before audio starts never activate native transport ownership.

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
| Media keys / headset controls | system media controls play/pause/stop/seek native transport only | MPRIS controls play/pause/stop/seek native transport only | system media controls play/pause/stop/seek browser transport only |
| Wake prevention | native display idle inhibition while playing; released on pause/stop/end/fallback | desktop idle inhibition while playing; released on pause/stop/end/fallback | Screen Wake Lock while playing; released on pause/stop/end |
| Native runtime fallback ownership | system state/inhibition clear before Web Audio starts at fallback position, then system controls route to Web Audio | same | not applicable; web owns controls from start |
| Fallback + no output device | falls back (or errors and recovers) without crash when no native output exists | same | same |

## Local-only Playwright Smoke Harness

Scaffold file: `scripts/playback-smoke.mjs` (local only, not wired to CI or default gates). This is
a browser-based smoke check for the frontend transport path; native output still needs the manual
matrix above. The automated path uses generated fixture audio only; do not use copyrighted audio.
The isolated smoke pass requires `window.__TUNEFORGE_PLAYBACK_E2E__.read()` and asserts song-start
count-in scheduling/firing before loop setup, loop pre-count scheduling/firing during loop playback,
and transport telemetry. Native transport/buffer health is checked only when telemetry reports native
playback is the active path. Manual app mode remains backward-compatible and skips telemetry-only
assertions when that bridge is unavailable.

`pnpm setup:dev` installs the Playwright Chromium browser needed by this smoke check; use
`pnpm setup:dev -- --skip-playwright-browsers` to skip that download.

Check that the local smoke scaffold is available:

```sh
pnpm --filter @tuneforge/desktop test:e2e
```

Run the isolated smoke pass:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run
```

Run the optional Linux virtual-audio capture smoke:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output
```

Run the optional macOS AVFoundation capture smoke with an explicit capture device:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --capture-provider=avfoundation --capture-device="BlackHole 2ch"
```

Use the same local debugging flags when needed. On macOS, replace `--route-output` with the explicit
`--capture-provider=avfoundation --capture-device=<name-or-id>` pair:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output --headed
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output --keep-artifacts
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output --backend-port=<port> --app-port=<port>
```

The isolated run prepares temporary app data and a temporary database, creates a deterministic
generated fixture project, starts the backend and frontend, runs the smoke flow, then cleans the
temporary data by default. Use `--keep-artifacts` to retain temporary paths and logs for debugging.
If a local port is already in use, pass `--backend-port=<port>` or `--app-port=<port>`. The isolated
backend allows only the selected loopback frontend origin so browser CORS stays enabled.

`--route-output` is Linux-only and should be used only for isolated generated-fixture runs. It must
not be combined with `--manual-app`, because virtual output capture is intended to avoid personal
libraries and user audio. Without `--route-output`, the smoke does not change system audio routing.
With `--route-output` on Linux, the smoke records the fixture playback through a temporary virtual
output path and restores the previous output route during cleanup. If routing, recording, or platform
support is missing, the virtual-capture portion fails or skips with a clear message; the standard
browser smoke still reports its own pass/fail result separately.

On Linux, use a PipeWire desktop with the PulseAudio compatibility service (`pipewire-pulse`) or a
PulseAudio session, and make sure `pactl` plus either `pw-record` or `parecord` are available on
`PATH`. Example setup:

```sh
# Arch
sudo pacman -S pipewire-pulse pipewire-audio libpulse

# Debian/Ubuntu
sudo apt-get install pipewire-pulse pulseaudio-utils pipewire-bin
```

The smoke creates a temporary null sink only when `--route-output` is present, routes playback to
that sink, records the sink through the selected local provider, then restores the previous default
sink and unloads the temporary sink. With PipeWire, the smoke resolves the temp sink's
`object.serial` and passes that serial to `pw-record --target`; the sidecar still records the
Pulse/PipeWire monitor source as the logical device. If `pactl` cannot create the sink, no default
sink can be restored, or capture is unavailable, keep artifacts and inspect the smoke logs before
rerunning.

On macOS, install a local BlackHole device and `ffmpeg` first, then verify AVFoundation can see it:

```sh
# Homebrew-managed setup
brew install blackhole-2ch ffmpeg

# Device discovery
ffmpeg -f avfoundation -list_devices true -i ""
```

Select the BlackHole device with `--capture-device=<name-or-id>` if more than one virtual audio
device is installed. macOS capture does not support `--route-output` and the smoke does not switch or
restore the default output device. Configure any Multi-Output Device or output routing manually
before running the smoke if you want to listen while capturing. Tauri WebDriver cannot automate the
WKWebView on macOS, so this capture path validates the local browser smoke and explicit AVFoundation
capture rather than automating the packaged Tauri WebView.

With `--keep-artifacts`, virtual-capture runs retain the temporary root printed by the smoke. Expect
the fixture data directory, backend/frontend child-process logs, the captured audio file, and any
platform routing logs or metadata that describe the selected virtual sink/device. Custom
`--capture-output` paths must end in `.wav`, because the capture analyzer reads WAV output. Without
`--keep-artifacts`, these outputs are temporary diagnostics and are removed during cleanup.

To run against an existing personal library or a pre-running app, opt into manual app mode and pass
the project selector explicitly:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --manual-app --project-name="Demo Song"
pnpm --filter @tuneforge/desktop test:e2e -- --run --manual-app --project-id=<id>
```

Manual app mode requires the app to already be running. Use it only when you need an existing
personal project instead of the generated fixture.

For full coverage, use a fixture project with timed lyrics or chords. The smoke pass always checks
stopped scrubber start, and it also checks stopped lyrics/chords start when a timed practice target
is available. It remains a local/manual diagnostic, not a CI gate and not part of `pnpm test`.
