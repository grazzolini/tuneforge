# Native Audio

TuneForge prefers native audio for project playback and keeps Web Audio as a disclosed fallback or
development override. Native audio is added feature by feature behind the Tauri native audio
boundary.

## Current Scope

- Tuner microphone capture uses native `cpal` on supported desktop builds and CPAL/AAudio on
  Android.
- Tuner device listing uses native input enumeration first, then cached/browser labels as fallback.
- Source, practice-mix, and stem playback prefer native `cpal` on macOS/Linux and CPAL/AAudio on
  Android when every active
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
- Android native playback and tuner capture report the `android-aaudio` backend and require Android
  API 26 or newer. Tuner monitoring remains unsupported.
- Android Web Audio fallback and forced-Web-Audio playback use a private seekable loopback
  transport so Chromium can request complete byte ranges without exposing arbitrary file paths.

## Backend Selection

The frontend prefers native audio when a feature is supported and falls back to Web Audio when
native support is unavailable or startup fails.

Packaged Android tuner capture is an exception: it requires the native AAudio path and never silently
falls back to `getUserMedia` after a capability, permission, startup, or stream failure. The global
`VITE_TUNEFORGE_FORCE_WEB_AUDIO=1` development override remains an explicit all-Web mode for both
tuner capture and playback.

Playback owns media-key controls, while playback and tuner capture participate in TuneForge's
shared power-protection model. See [POWER_PROTECTION.md](./POWER_PROTECTION.md) for the
cross-platform owner, backend, diagnostic, and validation rules.

- TuneForge registers one desktop system-media adapter with the OS for media keys and headset
  controls. That adapter does not choose the audio engine; it routes play/pause/stop/seek events to
  the current playback owner.
- Native playback owns the transport only after a matching native session confirms playback, and
  requests OS power protection while playing. User intent or an in-flight start does not count as
  confirmed protection.
- Web Audio/HTML media playback owns the transport only after a `playing` event or confirmed media
  progress,
  including `VITE_TUNEFORGE_FORCE_WEB_AUDIO=1` and native fallback. It uses the browser Screen Wake
  Lock while playing. Browser Screen Wake Lock protects the visible screen only; it does not claim
  native background protection.
- Native tuner capture acquires the same OS power-protection manager only after the CPAL/AAudio
  stream starts. Worker exit releases its scoped owner on stop, interruption, replacement, Android
  suspension, or teardown even when WebView effects cannot run.
- Confirmed Web Audio tuner capture owns the same shared browser Screen Wake Lock and a native
  `tuner-capture` reason in packaged Tauri builds. Track termination, stop, error, replacement, and
  unmount clear both. Pending permission and startup never acquire protection. Playback and tuner
  browser owners share one sentinel, so either owner can stop without releasing the other.
- Native fallback is an explicit ownership transfer. TuneForge clears system media state and native
  power protection, starts the Web Audio path at the fallback position, then re-registers system
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
project playback so Web Audio remains the comparison path for both. It does not disable native
capability detection, and it is not a persisted current-playback state.

## Diagnostics

Settings -> Local Data -> Show diagnostics reports:

- backend package version and git ref
- frontend package version and git ref
- input capture availability
- capture selection policy, current Android permission, current state, and current confirmed path
- last confirmed tuner capture path and latest safe historical failure
- audio override and playback selection policy
- native playback capability, even while Web Audio is forced
- current playback state and current confirmed path
- last confirmed playback path
- latest native playback failure
- latest native fallback cause
- latest Web media failure
- active native session lane count
- native playback buffer health per lane, including fill level, underrun count, worker errors, and
  the last worker error when present
- current power-protection phase, confirmed backend, active reasons, and separately confirmed screen
  and background coverage
- current native backend, browser Screen Wake Lock phase/backend, and separately confirmed browser
  screen coverage, plus latest safe power-protection error and last confirmed native backend

Current state is live and starts as `Not playing` / `None` after reload. Only last-confirmed path and
redacted failures are restored from local storage. A native failure does not claim Web fallback
until Web playback is confirmed, and `android-null` is always reported as unavailable. Diagnostic
reasons omit local paths, URLs, artifact IDs, and session IDs. Active power state is never restored
from local storage; only a safe historical backend and error may survive reload.

When `VITE_TUNEFORGE_FORCE_WEB_AUDIO=1` is active, diagnostics report the build-time override and
`Web Audio forced` policy while continuing to report native capability independently.

Android microphone permission is requested only from a tuner start or retry. TuneForge distinguishes
the initial prompt, an in-progress prompt, denial, permanent blocking, the Android microphone privacy
toggle, and unavailable hardware. Blocked states give an Android Settings path and Retry; TuneForge
does not open Settings. Permission and privacy state are rechecked before every start and while the
stream is active. Revocation, privacy blocking, stream interruption, or app suspension stops the
stream, clears live pitch/input state, and requires an explicit retry after resume.

Protection failure stays separate from capture truth. Listening continues with a compact warning
when neither native screen protection nor browser Screen Wake Lock is confirmed. No active owner is
restored from diagnostics history.

On Web media `error`, playback stops with an error. After `waiting` or `stalled`, five seconds with
no progress while the element is not paused, seeking, or ended is also treated as a failed path.

## Device And Volume Behavior

Native tuner capture can use a selected input device without changing the system default microphone.
Native selected-device volume uses host controls where available. Web Audio capture remains limited
to the browser/system default input path, so non-default microphone choices are disabled while Web
Audio is active.

Android exposes only `System Default` because CPAL/AAudio does not provide a confirmed stable native
device identity for this flow. Cached browser labels and browser device choices are not shown as
Android native routes.

## Playback QA Matrix

Use this matrix for local regressions against source, practice-mix, and stems.
Run once with native playback selected per platform, then rerun with forced Web Audio.

Coverage label: manual/special unless a CI workflow explicitly runs the same command and capture
mode. The matrix, loopback browser E2E suite, Linux `--route-output`, macOS AVFoundation capture, and
BlackHole capture are release checks, not default `pnpm test` coverage.

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
| Wake prevention | native display idle inhibition while playing; released on pause/stop/end/fallback | portal or logind inhibition while playing; released on pause/stop/end/fallback | Screen Wake Lock while playing; released on pause/stop/end |
| Native runtime fallback ownership | system state/inhibition clear before Web Audio starts at fallback position, then system controls route to Web Audio | same | not applicable; web owns controls from start |
| Fallback + no output device | falls back (or errors and recovers) without crash when no native output exists | same | same |

For manual Linux, macOS, Android, and browser power validation, use the owner-specific evidence and
release checks in [POWER_PROTECTION.md](./POWER_PROTECTION.md#validation).

## Local-only Playwright Desktop E2E Suite

Suite file: `scripts/desktop-e2e.mjs`. `--run` executes all headless-capable groups in catalog order:
generated-fixture playback, diagnostics, and the Export workspace. `--ci` separately expresses the
CI-approved policy; it currently runs the same three groups, but can diverge without changing `--run`.
Neither selector includes audio capture, and the suite is not part of the default `pnpm test` suite.
This is a browser-based desktop E2E suite; its playback group checks the frontend transport path, while
native output still needs the manual matrix above. The automated path uses generated fixture audio only;
do not use copyrighted audio. The isolated playback group requires `window.__TUNEFORGE_PLAYBACK_E2E__.read()` and asserts song-start
count-in scheduling/firing before loop setup, loop pre-count scheduling/firing during loop playback,
and transport telemetry. Native transport/buffer health is checked only when telemetry reports native
playback is the active path. Manual app mode remains backward-compatible and skips telemetry-only
assertions when that bridge is unavailable.

`pnpm setup:dev` installs the Playwright Chromium browser needed by this suite; use
`pnpm setup:dev -- --skip-playwright-browsers` to skip that download.

Check that the local desktop E2E suite is available:

```sh
pnpm --filter @tuneforge/desktop test:e2e
```

Run all headless-capable groups:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run
```

Run the CI-approved selector policy:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --ci
```

Run every group, including audio capture. A headed browser is currently recommended for working capture:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --all --headed
```

Run only the CI-safe Export workspace journey without submitting an export or opening a native picker:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --group export
```

Run the optional Linux virtual-audio capture group:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output --headed
```

Run the optional macOS AVFoundation capture group with an explicit capture device:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --capture-provider=avfoundation --capture-device="BlackHole 2ch" --headed
```

Use the same local debugging flags when needed. On macOS, replace `--route-output` with the explicit
`--capture-provider=avfoundation --capture-device=<name-or-id>` pair:

```sh
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output --headed
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output --keep-artifacts --headed
pnpm --filter @tuneforge/desktop test:e2e -- --run --route-output --backend-port=<port> --app-port=<port> --headed
```

The isolated run prepares temporary app data and a temporary database, creates a deterministic
generated fixture project, starts the backend and frontend, runs the E2E flow, then cleans the
temporary data by default. Use `--keep-artifacts` to retain temporary paths and logs for debugging.
If a local port is already in use, pass `--backend-port=<port>` or `--app-port=<port>`. The isolated
backend allows only the selected loopback frontend origin so browser CORS stays enabled.

`--route-output` is Linux-only and should be used only for isolated generated-fixture runs. It must
not be combined with `--manual-app`, because virtual output capture is intended to avoid personal
libraries and user audio. `--headed` is a launch-mode option, not a capture policy: it is currently
recommended (and typically needed) for working capture, but headless attempts are allowed so future
browser and platform support can succeed without changing the selector contract. Without `--route-output`,
the E2E suite does not change system audio routing.
With `--route-output` on Linux, the capture group records fixture playback through a temporary virtual
output path and restores the previous output route during cleanup. If routing, recording, or platform
support is missing, the virtual-capture portion fails or skips with a clear message; the standard
browser E2E suite still reports its own pass/fail result separately.

On Linux, use a PipeWire desktop with the PulseAudio compatibility service (`pipewire-pulse`) or a
PulseAudio session, and make sure `pactl` plus either `pw-record` or `parecord` are available on
`PATH`. Example setup:

```sh
# Arch
sudo pacman -S pipewire-pulse pipewire-audio libpulse

# Debian/Ubuntu
sudo apt-get install pipewire-pulse pulseaudio-utils pipewire-bin
```

The capture group creates a temporary null sink only when `--route-output` is present, routes playback to
that sink, records the sink through the selected local provider, then restores the previous default
sink and unloads the temporary sink. With PipeWire, the smoke resolves the temp sink's
`object.serial` and passes that serial to `pw-record --target`; the sidecar still records the
Pulse/PipeWire monitor source as the logical device. If `pactl` cannot create the sink, no default
sink can be restored, or capture is unavailable, keep artifacts and inspect the E2E logs before
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
WKWebView on macOS, so this capture path validates the local browser E2E suite and explicit AVFoundation
capture rather than automating the packaged Tauri WebView.

With `--keep-artifacts`, virtual-capture runs retain the temporary root printed by the E2E suite. Expect
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

For full coverage, use a fixture project with timed lyrics or chords. The playback group always checks
stopped scrubber start, and it also checks stopped lyrics/chords start when a timed practice target
is available. Native output and virtual-audio capture remain local/manual diagnostics, not CI gates.
