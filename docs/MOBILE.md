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

Lyrics generation accepts the same nullable `language_override` payload as desktop. `null`, omission, or blank text keeps Whisper language detection on auto. Mobile validates explicit overrides against `none`, `en`, `pt`, `es`, `fr`, `de`, `it`, `ja`, `ko`, `zh`, and `hi`. `none` records an empty lyrics transcript without running `whisper.cpp`; other explicit codes are passed to `whisper.cpp`.

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

## Desktop vs Mobile Persistence Parity

Mobile stores synced desktop outputs as library data, not as ad hoc downloads. Generation capability
is separate from data readability: unsupported mobile generation shows `Unavailable on this device`,
not a failed or pending job.

| Data | Persisted source or contract | Mobile behavior | Truthful user-facing state |
| --- | --- | --- | --- |
| Projects | Project response and sync manifest project entry with `project_id`, `source_sha256`, display name, and timestamps. | Persist as mobile project rows with the same identity; import through mobile services, not by copying desktop SQLite rows. | `Synced from desktop` when accepted. `Not on this device` when only metadata exists. `Missing` when required source or artifact bytes were expected but absent. |
| Source artifacts | `source_audio` artifact manifest with relative path, content SHA-256, size, format, and metadata; source SHA-256 remains project identity. | Store bytes in app-local project storage, verify hashes, and decode through WAV/PCM or Android media paths. | `Synced from desktop` when readable. `Not on this device` before bytes arrive. `Missing` if the local file is absent. `Unreadable` if hash or decode fails. |
| Generated artifacts | Artifact manifest rows for app-owned stems, practice mixes, previews, and cache artifacts, including type, format, metadata, and content SHA-256. | Preserve readable desktop-generated files as first-class artifacts. Regenerate only when a mobile capability exists. | `Synced from desktop` when readable. `Not on this device`, `Missing`, or `Unreadable` follows byte state. Unsupported generation is `Unavailable on this device`. |
| Export history | Local `export_mix` artifact rows record external deliverables, including path, format, and metadata. Export mixes are excluded from sync manifests and sync metadata. | Keep export history local. Do not transfer exported files or require an external destination to remain present. | Missing external exports never create sync warnings, failures, or transfer counts. |
| Analysis | Analysis project document with key, tuning, tempo, backend/version metadata, source artifact, created time, and timing data. | Persist imported results. Recompute only when `analysisAvailable` is true and source bytes are readable. | `Synced from desktop` when imported. `Missing` if no analysis document exists. `Unreadable` if the payload or source artifact is invalid. |
| Timing | Timing arrays embedded in the analysis document. | Keep complete arrays with analysis so playback and practice do not depend on lazy fragments. | `Synced from desktop` when present. `Missing` if analysis lacks timing. `Unreadable` if the timing schema is invalid. |
| Chords | Chord document or entity revision with source and current timelines, backend, source artifact, source kind, edit state, metadata, and timestamps. | Render and edit imported timelines. Basic mobile chords may generate only when available; advanced desktop output remains valid data. | `Synced from desktop` when imported. Empty timeline means no chords, not failure. Invalid schema is `Unreadable`. Unsupported generation is `Unavailable on this device`. |
| Lyrics | Lyrics document or entity revision with source and edited segments, backend, model/device metadata, language fields, edit state, and timestamps. | Render and edit imported transcripts. Generate only when local Whisper is available, or record empty lyrics for `language_override: "none"`. | `Synced from desktop` when imported. Empty lyrics can be valid. `Missing` means expected lyrics were absent. Without a local model, generation is `Unavailable on this device`. |
| Stems | Generated stem artifact rows with type, format, stem model, source artifact metadata, content hash, and size. | Play synced stem files from app-local storage when readable. Mobile stem separation remains disabled. | `Synced from desktop` when readable. `Not on this device`, `Missing`, or `Unreadable` follows byte state. Create action is `Unavailable on this device`, not failed or pending. |
| Edits | Project updates plus lyrics, chord, section, and tab-apply edits persisted as project documents or entity revisions. | Persist mobile edits locally and sync as revisions. Desktop-synced edits stay editable documents, not flattened files. | `Synced from desktop` for imported edit revisions. Local edits use normal unsynced or conflicted states, not generation failure states. |
| Sync revisions | `entity_revisions` with revision identity, entity type, source artifact, content hash, state, author device, payload, metadata, and timestamps. | Reconcile by identity and content hash. Apply tombstones before accepting older revisions. | `Synced from desktop` when accepted. `Missing` if referenced payload is absent. `Unreadable` if hash or schema validation fails. Conflicts use sync conflict state. |
| Tombstones | `delete_tombstones` for deleted projects, artifacts, and entity revisions, with author, target, group/project context, and prior metadata. | Persist delete markers and suppress resurrected records from offline peers. | Deleted records stay deleted or hidden, not `Missing`. Invalid tombstones are `Unreadable`; accepted tombstones can appear as `Synced from desktop` in sync history. |

## Android Setup

The Tauri Android target must be initialized from a machine with Android SDK/NDK installed:

```sh
pnpm --filter @tuneforge/desktop tauri android init
pnpm android:studio:shim
pnpm package:android
```

Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the Android SDK directory before running the
Android commands. Tauri cannot initialize or build the Android target without an SDK and NDK.

Android builds target API 26 or newer so native project playback can use CPAL's AAudio backend.
They are arm64-only by default for this experiment. Use `pnpm package:android` or
`pnpm package:android:debug`; both pass `--target aarch64` and avoid building `armv7`, `i686`, or
`x86_64`.
Android package scripts run `tauri icon --output src-tauri/target/android-icons src-tauri/icons/icon.png`
before building so ignored desktop icon outputs stay under `target/` while the generated Android
launcher resources under `apps/desktop/src-tauri/gen/android/app/src/main/res/` are refreshed from
the tracked TuneForge icon instead of Tauri's default icon.
The Android scripts run through `scripts/android-arm64-env.sh` so Cargo uses the rustup toolchain and
the Android NDK `aarch64-linux-android26-clang` compiler.

Project playback prefers the native `android-aaudio` path. Web Audio is an automatic disclosed
fallback after native failure or a build-time development override; it is not a mobile setting.
Playback state, clocks, and Settings diagnostics change only after the active native session or Web
media confirms the transition.

Android power protection follows confirmed work automatically; no manual toggle exists. Confirmed
native playback uses a `mediaPlayback` foreground service and keeps the foreground activity screen
on. An active sync listener uses `connectedDevice`, and an active transfer also uses `dataSync`.
Listener and transfer work hold a bounded, renewable partial wake lock; playback relies on Android's
media path for CPU wakefulness. The ongoing notification states whether playback, sync, or both are
active. Pause, stop, natural end, fallback, listener stop, transfer completion/cancellation/failure,
and app shutdown release their corresponding reason without releasing other active work.
On Android 13 and newer, TuneForge requests notification permission only when a user action starts
protected playback or sync work. Denial does not cancel that work; diagnostics report the missing
notification visibility while Android's system active-app controls remain available.

Settings diagnostics distinguish acquiring, active, unsupported, failed, releasing, and
release-not-confirmed states. They report protection only after Android confirms it. Activity ->
Sync and playback status show concise reliability warnings for unsupported or failed protection.
Android 15 `dataSync` timeout is reported as a failure and releases protection; it is never shown as
a completed transfer.

`pnpm --filter @tuneforge/desktop android:prepare` updates the generated Android target before a
build. It keeps these manifest permissions present:

- `android.permission.INTERNET` for same-LAN TCP/QUIC/UDP sync sockets.
- `android.permission.RECORD_AUDIO` and `android.permission.MODIFY_AUDIO_SETTINGS` for mobile audio
  flows.
- `android.permission.CAMERA` for the Android-only QR pairing scanner.
- foreground-service permissions for `mediaPlayback`, `connectedDevice`, and `dataSync`, plus
  `android.permission.WAKE_LOCK`, for truthful playback and sync lifetime ownership.
- `android.permission.POST_NOTIFICATIONS` so supported Android versions can expose active work.
- `android.permission.CHANGE_NETWORK_STATE` for connected-device foreground sync work.

These are package-level permissions only. They do not change the local-only product rule, and they
must not be used to add cloud, telemetry, account, or remote-processing behavior. Do not add
Android nearby-device, Bluetooth, location, or Wi-Fi multicast permissions until a concrete local
discovery implementation requires them.
The barcode scanner capability is scoped to `android` in the mobile capability file. Keep scanner
permissions out of other platform capabilities unless a separate scanner flow is designed.

## Mobile Sync Validation

Real mobile sync validation must use an initialized Android target, a debug or release APK built
through the package scripts above, and a physical Android device when collecting CPU and battery
evidence. Use the privacy-safe evidence model and validation checklist in
[MULTI_DEVICE_LIBRARY_SYNC_SPIKE.md](./MULTI_DEVICE_LIBRARY_SYNC_SPIKE.md#sync-validation-evidence-model).
Record the selected transport path in the notes for each run:

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

For Android-to-desktop validation, import or change durable library data on Android, sync it to a
desktop peer, and record redacted project import cadence, TTFA, transfer counts, selected transport,
fallback reason/code, backend/mobile staging throughput, reconciliation apply time, and scratch or
staging peaks. Do not record audio content, file contents, filenames, absolute paths, display names,
raw device/project/artifact IDs, endpoint hints, or pairing payloads.

For listener lifecycle validation, start, stop, restart, pause, and resume the Android listener where
the build supports it. The UI records native-only lifecycle events through
`sync_transport_record_lifecycle_event`: desktop background events from `visibilitychange` hidden,
window blur, and `pagehide` stay passive; Android hidden/pagehide records `android_background`, and
Android window blur records `android_screen_lock`. Both Android events stay passive so the listener
and active transfers continue while the app is backgrounded or the screen is locked.
Foreground events from window focus, `visibilitychange` visible, and `pageshow` refresh listener
state; Android foreground uses `android_foreground`. Browser `online` and `offline` events record
network recovery/interruption. Offline interruptions may expose native retry guidance and a trusted
peer ID; when they do, the UI shows Retry Sync and reuses the normal preflight plus Sync Now path,
including nearby endpoint hints.

Also inspect Android service and power state with `adb`: confirmed playback must show the
`mediaPlayback` foreground-service type; listener and transfer must add `connectedDevice` and
`dataSync` as applicable. Notification copy must match active work. Verify every terminal path clears
its reason, and exercise a shortened Android 15 data-sync timeout in a synthetic debug run. A live
transfer still requires an isolated desktop peer; automated lifecycle tests do not prove that
end-to-end path.

Desktop sleep/wake has no native command bridge. The UI uses an elapsed-time check while visible: a
long timer gap records `sleep` followed by `wake`, while ordinary desktop hidden/blur/pagehide remains
passive. Current Android builds still do not expose a separate OS screen-lock callback to React, so
screen lock is inferred from Android focus/visibility changes.
Record whether desktop peers recover, whether fallback was used, and whether synced projects remain
deduped after reconnect. If Android still reports the transport stub, record that blocker and limit
the run to pairing, storage, and playback checks.

For QR pairing validation, grant the camera permission, scan a pairing QR code with the Android
build, and record whether the scan produced the expected pairing payload before trusting the peer.
If the camera permission is denied or the scanner is unavailable, record that blocker and do not
count QR pairing as validated.

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
