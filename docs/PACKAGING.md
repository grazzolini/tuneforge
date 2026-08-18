# Packaging

TuneForge packaging creates local unsigned desktop builds. Packaged builds launch the bundled backend locally, include the default desktop Advanced Chords and Advanced Beat Analysis dependency stacks, and do not bundle external model weights by default. Crema's wheel-embedded chord model assets are the dependency-owned exception and may be included with Advanced Chords. TuneForge does not bundle FFmpeg: macOS packages use host-installed `ffmpeg` and `ffprobe`, while Flatpak routes backend lookups through sandbox wrappers at `/app/bin/ffmpeg` and `/app/bin/ffprobe`.

See [Third-party notices](../THIRD_PARTY_NOTICES.md) for the dependency and model-weight distribution policy.

## Release Artifact Truth

- macOS packaging creates a local `.app` bundle and DMG. The app is unsigned and not notarized.
- Linux Flatpak packaging creates either a single-file `.flatpak` bundle or, with `--no-bundle`, a local Flatpak repository install flow.
- Source distribution is the repository checkout or source archive from version control. These package commands do not create a separate source tarball.
- Packaging, model-bundle review, crema/TensorFlow, beat-this, CUDA/MPS/legacy NVIDIA GPU behavior, and install smoke checks are manual or special coverage unless a CI workflow explicitly runs them.
- Release/default package commands must not use `--model-bundle`; publishable artifacts must not include Demucs, Whisper, or beat-this model weights unless redistribution has been explicitly reviewed.
- Default packages may still download Demucs, Whisper, or beat-this weights on first use when caches are missing. Fully offline operation requires host/sandbox FFmpeg access plus the relevant local caches or package assets to already exist.
- Crema chord model files come from the crema dependency and ship with Advanced Chords unless that dependency stack is excluded; Demucs, Whisper, and beat-this external weights remain cache/download assets unless `--model-bundle` is explicitly passed.

## Release Package Gate

A release package is not ready to publish until package build evidence and a
packaged launch smoke pass are both recorded for each intended artifact. Missing build
or smoke evidence fails the gate closed; do not substitute `pnpm dev`, a dev server, or
an unpackaged Tauri run for packaged-artifact proof.

Before tagging, verify the release changelog against changes since the previous tag. Promote completed
`[Unreleased]` entries into the dated release section, leave `[Unreleased]` empty, freeze the release
comparison at `previous-tag...new-tag`, and reset `[Unreleased]` to `new-tag...main`.

Run these checks from the clean final release commit:

```sh
node scripts/check-release-version.mjs
node scripts/release-license-inventory.mjs --check
```

After the tag checkpoint stop and fresh explicit tag-signing approval, automation may create the signed
annotated `v<version>` tag and must verify its signature, annotation, target, and release commit.
Require separate draft-release authority before creating a draft GitHub Release for that tag. Build
each intended artifact from a clean checkout of the tag without a `TUNEFORGE_GIT_REF` override.
TuneForge's current release contract requires exactly seven uploaded assets:

- Apple Silicon `TuneForge_<version>_aarch64.dmg` and its detached `.asc` signature;
- publishable ARM64 `TuneForge_<version>_android_aarch64_publishable.apk` and its detached `.asc`
  signature;
- `SHA256SUMS`, containing only the DMG and APK, and its detached `.asc` signature;
- armored public `release-key.asc` matching the signing fingerprint.

Both the DMG and publishable APK are mandatory. Manual steps run
`pnpm package:android:release` with the externally managed release key, create all detached
signatures, export `release-key.asc`, and publish the verified draft. Automation may build the
unsigned/not-notarized macOS DMG and verify public artifacts. It must never run the Android release
build or artifact-signing commands. Pushing the verified tag and draft-asset upload each need separate explicit
authority; final publication remains manual-only. Never move or delete a published tag; roll forward
with a new version. Operational artifact, installation, checksum, signature, and upload instructions
belong in the GitHub Release notes.

Run `pnpm package:mac` only on supported macOS release hosts. Flatpak packaging remains available
for local or future distribution work on supported Linux hosts, but v1.1.0 neither builds nor uploads
a Flatpak.

Use the artifact-specific checklist for the manual launch smoke.

For the macOS DMG, install or open the packaged app and confirm:

- the packaged app launches without a dev server;
- the bundled FastAPI backend starts and remains bound to `127.0.0.1`;
- the UI loads and core navigation is usable;
- Settings/About release identity is visible;
- observed behavior matches the package policy above: unsigned/not-notarized local builds, no
  bundled FFmpeg, and no external Demucs, Whisper, or beat-this model weights unless
  `--model-bundle` was explicitly reviewed and used.

For the Android APK, install it on an isolated emulator or device and confirm:

- the packaged APK launches without a dev server;
- the embedded mobile backend initializes and serves the packaged app's on-device workflow; do not
  require or claim a desktop FastAPI listener or `127.0.0.1` bind;
- the UI loads and core navigation is usable;
- Settings/About release identity is visible.

Record release gate evidence with:

- OS and version;
- artifact type, such as macOS `.app`/DMG, publishable ARM64 Android APK, or Linux `.flatpak`;
- commit SHA;
- command run;
- repo-relative output path, artifact filename/hash, or sanitized artifact identity;
- launch-smoke checklist source, such as this manual checklist or a named release
  checklist;
- per-check proof for the applicable platform checklist: macOS packaged launch, bundled FastAPI
  startup and loopback bind, UI/navigation, and release identity; or Android packaged launch on the
  isolated emulator/device, embedded mobile backend initialization, UI/navigation, and release
  identity;
- pass/fail result for each package build and launch-smoke check;
- sanitized notes or log excerpt.

Do not collapse launch-smoke evidence to a generic pass. Evidence must avoid user
paths, audio contents, secrets, and raw private logs. This gate documents package-build
and launch-smoke readiness only. It does not automate tag-to-release, release notes,
signing, notarization, checksums, or GitHub Release upload.

## macOS

Build the app bundle and DMG with:

```sh
pnpm package:mac
```

Plain macOS packages include crema Advanced Chords and beat-this Advanced Beat Analysis
dependencies by default. Package flags can opt out of advanced dependencies or opt into explicit
model bundling:

```sh
pnpm package:mac -- --no-crema --no-beat-this
pnpm package:mac -- --no-advanced-chords --no-advanced-beats
pnpm package:mac -- --model-bundle
```

The generated artifacts are written under `apps/desktop/src-tauri/target/release/bundle/`:

- `macos/TuneForge.app`
- `dmg/TuneForge_<version>_<arch>.dmg`

Run packaging from a normal macOS shell so `hdiutil` can create the disk image. The generated app is unsigned and not notarized.

The packaged backend checks the inherited `PATH` plus common Homebrew and MacPorts install locations when looking for `ffmpeg` and `ffprobe`. System microphone volume control uses the built-in CoreAudio API on macOS.

By default, Demucs, Whisper, and beat-this weights are read from their normal caches and downloaded on first use if missing. Crema is the dependency-owned exception: its wheel-embedded chord model files are part of the crema package and ship when Advanced Chords is included. `--model-bundle` stages required Demucs and Whisper weights into the package, and also stages the beat-this `small0` checkpoint when beat-this dependencies are included. On startup, bundled model files seed the normal caches; runtime loaders still use cache paths, not package resource paths. `--model-bundle` does not control dependency inclusion. The flag prints a warning because Demucs pretrained-weight redistribution is unclear/restricted upstream.

## Android

Prepare the generated project, then choose a debug, optimized local release-profile, or stable-key
GitHub Release APK build:

```sh
pnpm package:android:prepare
pnpm package:android:debug
pnpm package:android
pnpm package:android:release
```

Preparation owns toolchain validation, conditional Tauri Android initialization, icon generation,
and generated-project preparation. All three build commands require this state and never prepare it.

The release command creates a direct GitHub Release APK. Its dedicated long-lived key provides a
stable signing/update identity for sideloaded APKs. PKCS12 is the only supported release-key
container format. Inputs are environment-only:

- `TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH`: absolute path to a readable regular PKCS12 file.
- `TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS`: alias containing the private signing key.
- `TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD`: PKCS12 password.
- `TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD`: private-key password.
- `TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256`: expected certificate SHA-256 fingerprint (64
  hexadecimal characters or 32 colon-separated bytes).

Supply an externally managed PKCS12 file at a private absolute path outside the repository. TuneForge does
not manage or need to know its storage/export workflow. The operator owns any temporary-file
lifecycle and cleanup. Enter passwords silently, export the configuration, then clear it afterward:

```sh
read -rs "TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD?Keystore password: "; export TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD; echo
read -rs "TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD?Key password: "; export TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD; echo
export TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH="/absolute/private/path/tuneforge-release.p12"
export TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS="tuneforge-release"
export TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
pnpm package:android:release
unset TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS
unset TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD
unset TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256
```

The script never modifies the keystore. Before building, it verifies the PKCS12/store password, alias
certificate and DER SHA-256 fingerprint, then proves the key password/private key by signing a
temporary empty JAR. Credential subprocess output is suppressed; secrets stay out of arguments,
generated Gradle configuration, metadata, logs, and errors.

The verified result is atomically promoted to
`apps/desktop/src-tauri/target/release/bundle/apk/TuneForge_<version>_android_aarch64_publishable.apk`.
Android package commands serialize access to the generated project and never auto-remove a stale
lock. If packaging reports one, first verify no package command is active, then remove
`apps/desktop/src-tauri/target/.tuneforge-android-package.lock` manually. A failed attempt removes
its disposable outputs and preserves an existing versioned APK. The command does not install,
launch, upload, tag, create a release, or publish that file.

## Linux Flatpak

Build the local Flatpak package with:

```sh
pnpm package:linux:flatpak
```

For faster local iteration, skip the single-file bundle step:

```sh
pnpm package:linux:flatpak -- --no-bundle
```

The Flatpak build generates local dependency source manifests, builds inside the SDK sandbox, and installs the backend under `/app/lib/tuneforge/backend`. It bundles `pactl` for microphone volume control but does not bundle FFmpeg.

Flatpak runtime lookups are not host `PATH` lookups. The manifest sets `TUNEFORGE_FFMPEG_PATH=/app/bin/ffmpeg` and `TUNEFORGE_FFPROBE_PATH=/app/bin/ffprobe`; those files are wrappers that search for `ffmpeg` and `ffprobe` inside the sandbox runtime/extension paths. If the runtime does not provide them, the Flatpak build or app reports the missing sandbox binary rather than falling back to the host shell.

Plain Linux packages include crema Advanced Chords and beat-this Advanced Beat Analysis dependency
stacks by default. Feature flags are independent:

```sh
pnpm package:linux -- --no-crema --no-beat-this
pnpm package:linux -- --no-advanced-chords --no-advanced-beats
pnpm package:linux -- --legacy-nvidia --model-bundle
```

- `--no-crema` / `--no-advanced-chords` exclude the Advanced Chords dependency stack.
- `--no-beat-this` / `--no-advanced-beats` exclude the Advanced Beat Analysis dependency stack.
- `--legacy-nvidia` swaps in the legacy CUDA 12.6 PyTorch/torchaudio wheels and broader GPU device access.
- `--model-bundle` includes required Demucs and Whisper weights, plus beat-this `small0` when beat-this dependencies are included.
- `--sandbox-data` keeps app data under Flatpak-private `/var/data/tuneforge` instead of the host XDG data directory.

Like macOS packages, plain Flatpak packages rely on normal Demucs, Whisper, and beat-this caches unless `--model-bundle` is explicitly passed. Advanced Chords uses crema package assets instead of a separate first-use model download; this is the dependency-owned Crema exception, not an external model-bundle source.

By default, the Flatpak grants access to `xdg-data/tuneforge`, `xdg-cache/torch`, and
`xdg-cache/whisper`. Packaged runs therefore use the same data root and model caches as
`pnpm dev`: `~/.local/share/tuneforge`, `~/.cache/torch`, and `~/.cache/whisper`. Do
not run the Flatpak app and `pnpm dev` against that shared library at the same time;
SQLite is local and TuneForge is not designed for concurrent backends writing the same
library.

## Flatpak Local Repo Installs

When `--no-bundle` is used, packaging exports a local Flatpak repository and prints the exact install commands. The local remote is `tuneforge-local` and the repository is `packaging/flatpak/repo`:

```sh
flatpak remote-add --user --if-not-exists --no-gpg-verify tuneforge-local packaging/flatpak/repo
flatpak install --user --reinstall tuneforge-local com.tuneforge.desktop
```

Without `--no-bundle`, the Flatpak bundle is written under `packaging/flatpak/` as `Tuneforge_<version>_x86_64.flatpak`.

## Size Expectations

Linux Flatpak bundles are large because the default package includes Torch, NVIDIA CUDA Python wheels, TensorFlow and related Advanced Chords dependencies, and beat-this Advanced Beat Analysis dependencies. `--legacy-nvidia` swaps in CUDA 12.6 runtime wheels, and `--model-bundle` adds model weights.

Packaging prints a size report for the built `/app` tree and selected Python artifacts. Use that report to distinguish accidental copied build inputs from expected ML runtime payloads.
