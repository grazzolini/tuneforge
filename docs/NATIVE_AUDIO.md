# Native Audio

TuneForge keeps Web Audio as the fallback implementation for desktop audio paths. Native audio is
added feature by feature behind the Tauri native audio boundary.

## Current Scope

- Tuner microphone capture uses native `cpal` on supported desktop builds.
- Tuner device listing uses native input enumeration first, then cached/browser labels as fallback.
- Source, stem, and project playback still use Web Audio.
- Native playback is intentionally not implemented yet.

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

This is a global native audio override, not a per-feature setting. It currently affects tuner
capture. Future native playback work should use the same override so Web Audio can remain the
comparison path for both capture and playback.

## Diagnostics

Settings -> Local Data -> Show diagnostics reports:

- input capture availability
- last tuner capture backend
- last native capture error
- playback backend

When `VITE_TUNEFORGE_FORCE_WEB_AUDIO=1` is active, diagnostics report `Web Audio (forced)`.

## Device And Volume Behavior

Native tuner capture can use a selected input device without changing the system default microphone.
Native selected-device volume uses host controls where available. Web Audio capture remains limited
to the browser/system default input path, so non-default microphone choices are disabled while Web
Audio is active.
