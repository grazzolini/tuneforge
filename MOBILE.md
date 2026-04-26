# TuneForge Mobile Architecture

TuneForge mobile is Android-first and keeps the local-only product rule: no account, no cloud backend, no telemetry, and no remote processing.

## Backend Shape

The mobile app includes its backend inside the Tauri app. It does not run the desktop Python/FastAPI backend on Android.

- Desktop: React -> Tauri -> FastAPI -> Python engines -> host FFmpeg -> SQLite/filesystem.
- Mobile: React -> Tauri commands -> embedded Rust/Kotlin backend -> Android media APIs -> SQLite/filesystem.

The frontend talks through a `TuneForgeClient` boundary. Desktop uses the existing generated OpenAPI HTTP client. Mobile uses Tauri commands that return the same project, job, artifact, lyrics, chord, and analysis response shapes where possible.

## Android Embedded Backend

Rust owns mobile project persistence, artifact records, job records, and app data paths. Kotlin/Android or Rust NDK bindings are the intended bridge for platform-only work:

- `content://` import resolution and permissions
- Android media decode/encode through `MediaExtractor`, `MediaCodec`, `MediaMuxer`, and Media3 Transformer
- GPU/NPU capability probes
- native ML runtime integration

The current Rust command surface is present even when generation is unavailable. Generation commands must fail closed if required local inference assets are unavailable.

## Mobile Processing Gates

Analyze and basic chord detection may run on CPU. Lyrics transcription may also run locally on CPU when a debug side-loaded `whisper.cpp` ggml model is present in app-private storage. Stem separation and other heavier generation paths stay unavailable until a native local runtime is wired. Capability detection returns:

- `gpuBackend`: `vulkan`, `nnapi`, `qnn`, `coreml`, or `null`
- `isEmulator`
- `analysisAvailable`
- `basicChordsAvailable`
- `whisperAvailable`
- `stemSeparationAvailable`
- `generationTestingAvailable`
- `maxRecommendedModel`
- `cpuFallbackAllowed: false`

If the local Whisper model is missing, the UI disables lyrics generation and shows:

```text
Side-load a Whisper model to enable local lyrics. Stem generation is unavailable on this device.
```

Debug Android emulator builds may set `generationTestingAvailable` so unavailable generation buttons can submit jobs during UI flow testing. This does not report Whisper or stem separation as available. Once a Whisper model is side-loaded, lyrics use the real local transcription path; stems still fail closed with an explicit unavailable message.

For debug lyrics testing, side-load one of these files before launching the app:

```sh
adb push ggml-base.bin /data/local/tmp/ggml-base.bin
adb shell run-as com.tuneforge.desktop mkdir -p models/whisper
adb shell run-as com.tuneforge.desktop cp /data/local/tmp/ggml-base.bin models/whisper/ggml-base.bin
```

The supported lookup priority is `ggml-base.bin`, `ggml-base.en.bin`, `ggml-tiny.bin`, then
`ggml-tiny.en.bin`.

## FFmpeg Policy

Mobile does not bundle FFmpeg. Android uses platform media APIs instead.

- Import keeps the original file inside app storage.
- WAV/PCM can be read directly for CPU analysis and basic chord detection.
- Compressed audio should decode through Android media APIs before waveform or ML processing.
- Mobile internal generated audio should prefer `m4a`/AAC first.
- Desktop currently keeps WAV intermediates and `wav`/`mp3`/`flac` exports through host-installed FFmpeg.
- Unsupported mobile export formats stay unavailable until a native encoder path exists.

Future desktop refinement: consider matching the mobile storage model by keeping the original import as the canonical source and creating normalized PCM/WAV files only as disposable derived cache. Analysis, chords, and feature data should stay cached separately so repeated desktop workflows do not require persistent full-size WAV copies.

## Android Setup

The Tauri Android target must be initialized from a machine with Android SDK/NDK installed:

```sh
pnpm --filter @tuneforge/desktop tauri android init
pnpm android:studio:shim
pnpm package:android
```

Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the Android SDK directory before running the
Android commands. Tauri cannot initialize or build the Android target without an SDK and NDK.

Android builds are arm64-only by default for this experiment. Use `pnpm package:android` or
`pnpm package:android:debug`; both pass `--target aarch64` and avoid building `armv7`, `i686`, or
`x86_64`.
The Android scripts run through `scripts/android-arm64-env.sh` so Cargo uses the rustup toolchain and
the Android NDK `aarch64-linux-android24-clang` compiler.

For Android Studio repo-root import, run `pnpm android:studio:shim` after Android init. The script
writes ignored root Gradle files that point Studio at `apps/desktop/src-tauri/gen/android`, set the
experiment to arm64-only, and keep machine-local SDK paths out of git. Use `pnpm dev:android:studio`
when you want Studio-driven dev runs; a plain Studio Run can hit Tauri's `android-studio-script`
websocket guard if the Tauri CLI dev command is not running. For smoke testing an APK, build with
`pnpm package:android:debug` and install the generated APK onto an emulator or device.

## Fallback Rule

Stay with Tauri mobile while these primitives remain clean:

- file import
- audio playback
- app-local storage
- native ML bridge
- large artifacts
- permissions
- resumable local jobs

Switch the mobile shell to React Native only if Tauri fights those primitives. The embedded project/job/artifact backend model should remain the same either way.
