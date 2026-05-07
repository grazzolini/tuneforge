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

## Backend Selection

The frontend prefers native audio when a feature is supported and falls back to Web Audio when
native support is unavailable or startup fails.

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

- input capture availability
- last tuner capture backend
- last native capture error
- playback backend
- last playback backend
- last native playback error

When `VITE_TUNEFORGE_FORCE_WEB_AUDIO=1` is active, diagnostics report `Web Audio (forced)`.

## Device And Volume Behavior

Native tuner capture can use a selected input device without changing the system default microphone.
Native selected-device volume uses host controls where available. Web Audio capture remains limited
to the browser/system default input path, so non-default microphone choices are disabled while Web
Audio is active.
