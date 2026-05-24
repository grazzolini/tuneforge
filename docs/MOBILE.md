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

Analyze and basic chord detection may run on CPU. Lyrics transcription may also run locally on CPU when a side-loaded `whisper.cpp` ggml model is present in app-private storage. Stem separation and other heavier generation paths stay unavailable until a native local runtime is wired. Capability detection returns:

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

Debug Android emulator builds may set `generationTestingAvailable` so the lyrics action can submit jobs during UI flow testing. This does not report Whisper or stem separation as available. Once a Whisper model is side-loaded, lyrics use the real local transcription path; stems stay disabled and still fail closed if invoked directly.

For local lyrics testing, side-load one of these files before launching the app:

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
Android package scripts run `tauri icon --output src-tauri/target/android-icons src-tauri/icons/icon.png`
before building so ignored desktop icon outputs stay under `target/` while the generated Android
launcher resources under `apps/desktop/src-tauri/gen/android/app/src/main/res/` are refreshed from
the tracked TuneForge icon instead of Tauri's default icon.
The Android scripts run through `scripts/android-arm64-env.sh` so Cargo uses the rustup toolchain and
the Android NDK `aarch64-linux-android24-clang` compiler.

`pnpm --filter @tuneforge/desktop android:prepare` updates the generated Android target before a
build. It keeps these manifest permissions present:

- `android.permission.INTERNET` for same-LAN TCP/QUIC/UDP sync sockets.
- `android.permission.RECORD_AUDIO` and `android.permission.MODIFY_AUDIO_SETTINGS` for mobile audio
  flows.

These are package-level permissions only. They do not change the local-only product rule, and they
must not be used to add cloud, telemetry, account, or remote-processing behavior. Do not add
Android nearby-device, Bluetooth, location, or Wi-Fi multicast permissions until a concrete local
discovery implementation requires them.

## Mobile Sync Validation

Real mobile sync validation must use an initialized Android target, a debug or release APK built
through the package scripts above, and a physical Android device when collecting CPU and battery
evidence. Record the selected transport path in the notes for each run:

- `tuneforge-sync+tcp`
- `tuneforge-sync+iroh`
- fallback path and fallback reason, if any

The default Android/desktop listener uses TCP port `47619` and a stable adjacent Iroh UDP
port `47620`; custom listener ports use `tcp_port + 1` for Iroh.

Also record whether Android reports sync transport support. If `sync_transport_status.supported` is
`false`, the APK is still using the Android stub and cannot satisfy real transport validation; only
pairing/storage/playback checks can proceed.

For accepted mobile sync evidence, sync at least one desktop project to Android, play the synced WAV
source and synced WAV stem artifacts from app-local storage, and compare battery, CPU, storage, and
transfer costs against AAC/M4A or another compressed baseline. Mobile sync remains library sync
only; remote processing stays out of scope.

## Stem Separation Spike

Stem separation remains unavailable on mobile in this experiment. The lowest-risk next spike is an
ONNX/Open-Unmix path because it has existing Android-oriented ONNX exports and a smaller integration
surface than a full Demucs port, but it still needs native STFT/iSTFT, chunking, memory budgeting,
and model-file policy work. ExecuTorch/Demucs is the more future-proof PyTorch-native direction, but
it is higher risk for this branch because it requires model export validation, Android runtime
integration, and careful device/backend selection. Full runtime integration should wait until the
basic mobile project, analysis, chords, lyrics, playback, and packaging path is stable.

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
