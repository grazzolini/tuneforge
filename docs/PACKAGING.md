# Packaging

TuneForge packaging creates local unsigned desktop builds. Packaged builds launch the bundled backend locally and include Advanced Chords, Advanced Beat Analysis, and LV Chordia by default. LV Chordia includes five dependency-owned MIT checkpoints (28,730,939 bytes); other external model weights remain excluded by default. TuneForge does not bundle FFmpeg: macOS packages use host-installed `ffmpeg` and `ffprobe`, while Flatpak routes backend lookups through sandbox wrappers at `/app/bin/ffmpeg` and `/app/bin/ffprobe`.

See [Third-party notices](../THIRD_PARTY_NOTICES.md) for the dependency and model-weight distribution policy.

## Release Artifact Truth

- macOS packaging creates a local `.app` bundle and DMG. The app is unsigned and not notarized.
- Linux Flatpak packaging creates the CPU app plus the selected optional Core/Runtime extension
  pairs or, with `--no-bundle`, exports those same selected refs to a local Flatpak repository.
- Source distribution is the repository checkout or source archive from version control. These package commands do not create a separate source tarball.
- Packaging, model-bundle review, ONNX Advanced Chords, beat-this, CUDA/MPS/legacy NVIDIA GPU behavior, and install smoke checks are manual or special coverage unless a CI workflow explicitly runs them.
- Release/default package commands do not use `--model-bundle`. Publishable model-bundled artifacts require an explicit review of the selected weights and package distribution evidence.
- Default packages may still download Demucs, Whisper, or beat-this weights on first use when caches are missing. Fully offline operation requires host/sandbox FFmpeg access plus the relevant local caches or package assets to already exist.
- Advanced Chords uses ONNX Runtime. Every package that enables it includes the exact pinned 2.2 MB converted model, runtime state, and Brian McFee BSD-2-Clause notice; startup verifies and seeds the normal cache. This is independent of the broader `--model-bundle` option.
- LV Chordia checkpoints ship inside its pinned dependency for offline first use. `--no-lv-chordia` excludes both the runtime and checkpoints; damaged assets fail closed and are repaired by reinstalling.

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
From v1.4.0 onward, TuneForge's release contract requires exactly seven payloads:

- Apple Silicon `TuneForge_<version>_aarch64.dmg`;
- publishable ARM64 `TuneForge_<version>_android_aarch64_publishable.apk`;
- CPU `Tuneforge_<version>_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_Nvidia_Core_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_Nvidia_Runtime_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_LegacyNvidia_Core_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_LegacyNvidia_Runtime_x86_64.flatpak`.

Every payload has a detached `.asc` signature. A newly generated release `SHA256SUMS` covers
exactly those seven payloads sorted by basename; it also has a detached `SHA256SUMS.asc` signature.
Armored `release-key.asc` matching the signing fingerprint completes the exact 17 uploaded assets.
Never reuse the ignored `packaging/flatpak/generated/SHA256SUMS` as the release manifest.

Use this seven-payload verification matrix before upload and again after a fresh download:
every checksum entry must match the payload digest, and every detached `.asc` must verify against
the approved `release-key.asc` fingerprint.

| Exact payload filename | Provenance | Size | Checksum and signature | License evidence | Architecture / branch | Package or ref identity |
| --- | --- | --- | --- | --- | --- | --- |
| `TuneForge_<version>_aarch64.dmg` | Frozen tagged SHA | Recorded, nonzero | Sorted manifest entry + matching `.asc` | Release inventory + notices | `aarch64` / n/a | `TuneForge`, embedded version and git ref |
| `TuneForge_<version>_android_aarch64_publishable.apk` | Frozen tagged SHA | Recorded, nonzero | Sorted manifest entry + matching `.asc` | Release inventory + notices | `arm64-v8a` / n/a | `com.tuneforge.desktop`, version, release signer |
| `Tuneforge_<version>_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | CPU profile inventory + notices | `x86_64` / `stable` | `app/com.tuneforge.desktop/x86_64/stable` |
| `Tuneforge_<version>_Torch_Nvidia_Core_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | NVIDIA Core inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Core/x86_64/stable` |
| `Tuneforge_<version>_Torch_Nvidia_Runtime_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | NVIDIA Runtime inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime/x86_64/stable` |
| `Tuneforge_<version>_Torch_LegacyNvidia_Core_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | LegacyNvidia Core inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Core/x86_64/stable` |
| `Tuneforge_<version>_Torch_LegacyNvidia_Runtime_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | LegacyNvidia Runtime inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Runtime/x86_64/stable` |

Public release notes must say that Flatpak support is x86_64 only, the CPU app installs first, and
an accelerator installs only as a complete matching Core/Runtime pair. FFmpeg remains host-provided
and must be available through the Flatpak runtime/extension paths; Flatpak never searches host
`PATH` directly.

All seven payloads are mandatory. Manual steps build the five Flatpaks on Linux, run
`pnpm package:android:release` with the externally managed release key, create the eight detached
signatures, export `release-key.asc`, and publish the verified draft. Automation may build the
unsigned/not-notarized macOS DMG and verify supplied public artifacts. It must never run the Android
release build, Linux package build, packaged-app launch, or artifact-signing commands. The user owns
launches and app data. Pushing the verified tag and uploading the 17 draft assets each need separate
explicit authority; final publication remains manual-only. Never move or delete a published tag;
roll forward with a new version. Operational artifact, installation, checksum, signature, and
upload instructions belong in the GitHub Release notes.

Run `pnpm package:mac` only on supported macOS release hosts. Build the five Flatpaks from a clean
x86_64 tagged checkout with no `TUNEFORGE_GIT_REF`, `--model-bundle`, or profile selectors by using
`pnpm package:linux:flatpak`. The Linux handoff must include sanitized OS and tool versions, command,
tag, commit SHA, refs, sizes, hashes, state, checksum, and CPU smoke evidence.

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

For the Flatpak runtime gate, create an isolated environment, install only
`Tuneforge_<version>_x86_64.flatpak`, and confirm no accelerator refs are installed. Then confirm:

- the packaged CPU app launches without a dev server;
- the bundled FastAPI backend starts and remains bound to `127.0.0.1`;
- the UI loads, core navigation is usable, and `v<version>` release identity is visible;
- CPU fallback remains available.

Accelerator-device detection and inference are optional, non-blocking evidence and remain
unverified unless explicitly tested. All five Flatpak payloads still fail closed on malformed
identity/ref, hash, signature, size, license, or provenance evidence.

Record release gate evidence with:

- OS and version;
- artifact type, such as macOS `.app`/DMG, publishable ARM64 Android APK, or Linux `.flatpak`;
- commit SHA;
- command run;
- repo-relative output path, artifact filename/hash, or sanitized artifact identity;
- launch-smoke checklist source, such as this manual checklist or a named release
  checklist;
- per-check proof for the applicable platform checklist: macOS packaged launch, bundled FastAPI
  startup and loopback bind, UI/navigation, and release identity; Android packaged launch on the
  isolated emulator/device, embedded mobile backend initialization, UI/navigation, and release
  identity; or isolated CPU-only Flatpak install, absence of accelerator refs, packaged launch,
  bundled backend loopback bind, UI/navigation, release identity, and CPU fallback;
- pass/fail result for each package build and launch-smoke check;
- sanitized notes or log excerpt.

Before upload, stage exactly the seven payloads and a newly generated sorted `SHA256SUMS`, then stop
for manual creation of eight detached signatures and `release-key.asc`. In an isolated temporary
GPG home, verify the key fingerprint, exact 17-file set, and every applicable matrix field. After
separately authorized upload, download all 17 assets into a fresh directory and repeat the complete
matrix and asset-set verification against the frozen release commit before publication.

Do not collapse launch-smoke evidence to a generic pass. Evidence must avoid user
paths, audio contents, secrets, and raw private logs. This gate documents package-build
and launch-smoke readiness only. It does not automate tag-to-release, release notes,
signing, notarization, checksums, or GitHub Release upload.

## macOS

Build the app bundle and DMG with:

```sh
pnpm package:mac
```

Plain macOS packages include ONNX Advanced Chords, beat-this Advanced Beat Analysis, and LV
Chordia dependencies by default. Package flags independently opt out or opt into explicit model
bundling:

```sh
pnpm package:mac -- --no-crema --no-beat-this --no-lv-chordia
pnpm package:mac -- --no-advanced-chords --no-advanced-beats
pnpm package:mac -- --lv-chordia
pnpm package:mac -- --model-bundle
pnpm package:mac -- --crema-onnx
pnpm package:mac -- --crema-onnx --model-bundle
```

Advanced Beat Analysis remains the default analysis request without bundled model weights. Its
`small0` checkpoint follows the normal first-use cache lifecycle. With `--no-beat-this`, the desktop
backend registry marks Advanced Beat Analysis unavailable and the compile-time package option makes
desktop actions send an explicit Built-in Beat Analysis selection. A broken normal installation still
submits Advanced Beat Analysis and surfaces the dependency failure instead of silently changing engines.

The generated artifacts are written under `apps/desktop/src-tauri/target/release/bundle/`:

- `macos/TuneForge.app`
- `dmg/TuneForge_<version>_<arch>.dmg`

Run packaging from a normal macOS shell so `hdiutil` can create the disk image. The generated app is unsigned and not notarized.

The packaged backend checks the inherited `PATH` plus common Homebrew and MacPorts install locations when looking for `ffmpeg` and `ffprobe`. System microphone volume control uses the built-in CoreAudio API on macOS.

By default, Demucs, Whisper, and beat-this weights are read from their normal caches and downloaded on first use if missing. Demucs uses immutable Hugging Face YAML+safetensors in the standard Hub cache: `HF_HUB_CACHE`, legacy `HUGGINGFACE_HUB_CACHE`, `HF_HOME/hub`, `XDG_CACHE_HOME/huggingface/hub`, then `~/.cache/huggingface/hub`. `TUNEFORGE_DATA_DIR` does not control the upstream Demucs, Whisper, or beat-this caches. Advanced Chords always stages the exact verified ONNX model and runtime state so packaged startup can seed `TUNEFORGE_DATA_DIR/cache/models/crema/` offline. It excludes the Crema Python package, TensorFlow, Keras, and their HDF5 model-loading closure; preserved LV Chordia support still brings its declared `h5py` dependency. LV Chordia ships exactly five validated checkpoints. `--model-bundle` independently stages required Demucs and Whisper weights, plus beat-this `small0` when included; Demucs is validated and loaded directly from its pinned bundle path without copying into the Hugging Face cache.

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

The Flatpak build generates local dependency source manifests, builds inside the SDK sandbox, and
installs the CPU-only backend under `/app/lib/tuneforge/backend`. The same manifest exports optional
NVIDIA and legacy NVIDIA Torch extensions from one repository. It bundles `pactl` for microphone
volume control but does not bundle FFmpeg.

### Flatpak Build Caches and Evidence

Flatpak packaging runs `flatpak-builder --force-clean`, so `packaging/flatpak/build-dir` is always a
clean output. Durable state and dependency/compiler caches default to
`.flatpak-builder/tuneforge-state` and `.flatpak-builder/tuneforge-cache`. Set absolute
`FLATPAK_STATE_DIR` and `FLATPAK_CACHE_DIR` paths to move them. Packaging rejects unsafe or
overlapping roots; valid caches persist until deleted.

Caches are namespaced by the `flatpak-cache-v1` contract: application, architecture, runtime,
toolchain, and non-profile package options. CPU, NVIDIA, legacy NVIDIA, and the default/all
selection reuse one Builder, pnpm, and sccache namespace; Flatpak Builder's per-module input keys
decide which extension module must execute. Reports use the same `flatpak-cache-v1` contract.
Outputs remain selection-specific. Packaging holds one checkout-wide Linux
lock while it generates sources, runs Builder, reconciles refs, and writes reports, so concurrent
commands wait without a timeout rather than corrupting shared state. Dependency installation remains frozen and offline.
Integrity, lock, or cache failures stop the build without network fallback or automatic repair.
Deterministic timestamps keep repeated build payloads comparable.

After a successful export, the selected state directory stores ignored atomic
`flatpak-output-state-v1.json` evidence: namespace, normalized profiles, payload digest, ordered
OSTree ref commits, and checkout size evidence. On an ordinary same-profile warm run, exact state
and repository refs are preserved and Builder receives `--require-changes`; unchanged refs report
`preserved-unchanged` and reuse that bound payload/size evidence. Missing, corrupt, stale, or
profile-mismatched state is discarded, selected refs are reconciled, and one normal export restores
state. A Builder no-op may remove its checkout; the valid saved state remains sufficient for the
next same-profile no-op. Changing profiles likewise exports once.

Before Flatpak Builder runs, packaging writes deterministic USTAR snapshots for the frontend,
desktop Rust shell, and backend static inputs. Snapshots include dirty and untracked inputs,
dotfiles, empty directories, file and directory modes, and symlink targets with normalized `0777`
modes; they use `SOURCE_DATE_EPOCH` (or the HEAD
timestamp) and are ignored build outputs. A source change invalidates modules whose snapshots include
it, then any downstream modules Builder must rebuild.
Generated version metadata and Cargo, pnpm, and Python dependency sources remain separate.

The backend version in installed `version.json` describes the whole checkout. The frontend version
uses the last commit affecting the exact Vite module inputs plus scoped dirty detection, so the
displayed refs can intentionally differ. `TUNEFORGE_FRONTEND_GIT_REF` overrides only the frontend
ref; `TUNEFORGE_GIT_REF` overrides the checkout/backend ref.

Every successful build writes the ignored, sanitized
`packaging/flatpak/generated/cache-report.json`. Override it with
`FLATPAK_CACHE_REPORT_PATH`. `flatpak-cache-v1` records ordered module observations from Builder
output (`cached`, `executed`, or `unknown`), observation completeness, first invalidated module,
cache mode, dependency/compiler evidence, timings, deterministic payload digest, and selected
repository commits. Its `output` observation records whether refs were exported or preserved and
where payload evidence came from. Its independent `bundleCache` observation records per-ref bundle
reuse or rebuild status, bytes, SHA-256, and the first rebuilt artifact; `--no-bundle` reports
`not-requested`, while evidence mode reports `disabled-for-evidence`. Module/output comparisons do
not infer bundle reuse. Unknown or incomplete observations do not fail a normal build; they fail a
cold/warm comparison. Reports contain no host cache paths.

Use the normal Linux x86_64 checkout paths for a cold/warm comparison. Save the first report, then
use it as the same-selection baseline:

```sh
export FLATPAK_CACHE_REPORT_PATH="$PWD/packaging/flatpak/generated/cache-cold.json"
pnpm package:linux:flatpak -- --no-bundle

export FLATPAK_CACHE_BASELINE_REPORT="$FLATPAK_CACHE_REPORT_PATH"
export FLATPAK_CACHE_REPORT_PATH="$PWD/packaging/flatpak/generated/cache-warm.json"
export FLATPAK_CACHE_COMPARISON_REPORT_PATH="$PWD/packaging/flatpak/generated/cache-comparison.json"
pnpm package:linux:flatpak -- --no-bundle
```

The warm comparison requires `flatpak-cache-v1` reports, complete matching module observations, every warm module
cached, no warm invalidation, matching namespaces, payloads, repository commits, and a
`preserved-unchanged` warm output observation. It fails closed otherwise. `FLATPAK_CACHE_EVIDENCE=1`
always performs a normal export and deliberately disables Builder's module-result cache to inspect
pnpm and sccache behavior; its report says `disabled-for-evidence`, so it is not a normal module-cache
warm comparison. To prove profile reuse, set `FLATPAK_CACHE_CROSS_PROFILE_BASELINE_REPORT` to a
previous selection report before building a different selection; its target must be an exported
report with a cached shared prefix.
`FLATPAK_BUILD_DIR`, `FLATPAK_REPO_DIR`, and `FLATPAK_BUNDLE_PATH` configure output paths.

CPU and legacy NVIDIA Torch wheels come from reviewed committed pylocks under
`packaging/flatpak/locks/`; normal packaging never resolves them. Refresh a reviewed lock explicitly
with `node scripts/refresh-flatpak-torch-locks.mjs --cpu` or `--legacy-nvidia`, then review its wheel
closure, license inventory, and synchronized Node/Rust profile pair ID. NVIDIA derives from the
committed backend `uv.lock` and is verified against its reviewed profile pair during source generation.

Flatpak runtime lookups are not host `PATH` lookups. The manifest sets `TUNEFORGE_FFMPEG_PATH=/app/bin/ffmpeg` and `TUNEFORGE_FFPROBE_PATH=/app/bin/ffprobe`; those files are wrappers that search for `ffmpeg` and `ffprobe` inside the sandbox runtime/extension paths. If the runtime does not provide them, the Flatpak build or app reports the missing sandbox binary rather than falling back to the host shell.

Plain Linux packages include ONNX Advanced Chords, beat-this Advanced Beat Analysis, and LV
Chordia dependency stacks by default. Feature flags are independent:

```sh
pnpm package:linux -- --no-crema --no-beat-this --no-lv-chordia
pnpm package:linux -- --no-advanced-chords --no-advanced-beats
pnpm package:linux -- --model-bundle
pnpm package:linux -- --crema-onnx
pnpm package:linux -- --crema-onnx --model-bundle
```

- `--crema`, `--advanced-chords`, `--crema-onnx`, and `--advanced-chords-onnx` enable the same ONNX Advanced Chords profile.
- `--no-crema`, `--no-advanced-chords`, `--no-crema-onnx`, and `--no-advanced-chords-onnx` exclude it. Mixing enable and disable selectors is an error.
- `--no-beat-this` / `--no-advanced-beats` exclude the Advanced Beat Analysis dependency stack.
- `--lv-chordia` / `--no-lv-chordia` include or exclude LV Chordia and its five checkpoints.
- `--model-bundle` includes pinned Demucs YAML+safetensors and required Whisper weights, plus beat-this `small0` when beat-this dependencies are included. Advanced Chords model/state files are always included when that engine is enabled.
- `--sandbox-data` keeps app data under Flatpak-private `/var/data/tuneforge` instead of the host XDG data directory.
- With no profile flags, Flatpak packaging builds CPU, NVIDIA, and legacy NVIDIA. `--cpu` builds
  only the CPU app; `--nvidia` or `--legacy-nvidia` builds the CPU app and that accelerator pair.
  The profile flags may be combined in any order, and repeated flags have no effect.

Like macOS packages, plain Flatpak packages rely on normal Demucs, Whisper, and beat-this caches
unless `--model-bundle` is explicitly passed. The application contains the official CPU Torch base;
its generated closure rejects CUDA, NVIDIA, and Triton. Each NVIDIA profile is split across
matching `Core` and `Runtime` refs beneath
`com.tuneforge.desktop.Torch.Stack`. Core contains the profile-specific Torch binaries; Runtime
contains its CUDA/NVIDIA closure. This generic profile-pair layout can also represent other GPU
families without making Core binaries portable across backends. The launcher validates both immutable
markers before starting Python, prefers NVIDIA over legacy NVIDIA, and prepends only the selected
profile's merged `site-packages`; an incomplete, mismatched, or stale pair falls back to the CPU base.
Advanced Chords always includes and seeds the exact pinned ONNX model and runtime-state files.
When beat-this is excluded, desktop actions explicitly select Built-in Beat Analysis. An Advanced
Beat Analysis request that ultimately fails during first-use download, load, runtime, or timing
analysis fails the job rather than switching engines; explicit Built-in Beat Analysis requests do
not probe beat-this.

By default, the Flatpak grants access to `xdg-data/tuneforge`, `xdg-cache/torch`, and
`xdg-cache/whisper`. Packaged runs therefore use the same data root and model caches as
`pnpm dev`: `~/.local/share/tuneforge`, `~/.cache/torch`, and `~/.cache/whisper`. Do
not run the Flatpak app and `pnpm dev` against that shared library at the same time;
SQLite is local and TuneForge is not designed for concurrent backends writing the same
library.

## Flatpak Local Repo Installs

When `--no-bundle` is used, packaging exports a local Flatpak repository and prints the exact
commands for the selected profiles. The local remote is `tuneforge-local` and the repository is
`packaging/flatpak/repo`:

```sh
flatpak remote-add --user --if-not-exists --no-gpg-verify tuneforge-local packaging/flatpak/repo
flatpak install --user --reinstall tuneforge-local com.tuneforge.desktop
flatpak install --user --reinstall tuneforge-local com.tuneforge.desktop.Torch.Stack.Nvidia.Core com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime
```

Install the legacy NVIDIA pair by replacing `Nvidia` with `LegacyNvidia`. Install the CPU application
first, then one or both complete accelerator pairs. When both pairs are installed, NVIDIA takes
precedence over legacy NVIDIA.

Without profile flags or `--no-bundle`, packaging writes five independent bundles under
`packaging/flatpak/`:

- `Tuneforge_<version>_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_Nvidia_Core_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_Nvidia_Runtime_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_LegacyNvidia_Core_x86_64.flatpak`;
- `Tuneforge_<version>_Torch_LegacyNvidia_Runtime_x86_64.flatpak`.

Selective builds write only the CPU bundle and the two bundles for each selected accelerator. The
ignored `packaging/flatpak/generated/SHA256SUMS` contains exactly the artifacts from that run.
The shared namespace stores atomic ignored `flatpak-bundle-state-v1.json` state whose header binds
the namespace, exact Flatpak version, x86_64, stable, and canonical `build-bundle`. Each entry binds
one output path and basename to its full ref, verified
OSTree commit, app/runtime role, byte size, and SHA-256. There is no whole-profile bundle cache key.
An ordinary run reuses each selected bundle only when that entry, the exact `SHA256SUMS` entry, and
the full file hash all match. Ref changes rebuild only their artifacts; adding a profile builds only
the additions, and removing one preserves the retained bundles then prunes managed unselected
outputs. Missing or globally malformed state, or a malformed/duplicate checksum manifest, rebuilds
all selected bundles. A fully valid warm selection launches no bundle builders and leaves bundles,
state, and checksums untouched. `FLATPAK_CACHE_EVIDENCE=1` deliberately rebuilds every requested
bundle and may seed verified state. `--no-bundle` never reads, hashes, creates, deletes, or rewrites
bundle outputs, bundle state, or `SHA256SUMS`.
Misses build to same-directory temporary paths, are size- and hash-verified, and move into place
only after all pending builders succeed. Packaging removes both trust markers before mutation.
Failure removes temporary and replaced outputs plus both trust markers. Profile transitions publish
selected-only state and sorted checksums, and prune only caller-known managed paths.
Each bundle must remain strictly below 2 GiB. Pending bundle work uses
`max(1, available CPU workers - 1)`, capped by the pending count; the Flatpak ref build remains
sequential.

## Size Expectations

Linux Flatpak bundles are large because they include Torch, beat-this, and the LV Chordia runtime.
Each NVIDIA profile's Torch Core and CUDA/NVIDIA Runtime live in separate optional extension bundles,
so all four components are gated independently from the CPU application. `--model-bundle` adds other
reviewed model weights.

Every Flatpak build writes an ignored structured size report at
`packaging/flatpak/generated/size-report.json` (override with `FLATPAK_SIZE_REPORT_PATH`). It uses
bytes, includes the compressed bundle when produced, installed `/app`, Python runtime,
site-packages, separate wheel-input and source-archive entries, and descending `/app` top-level
directories. Each Python input group reports `knownBytes`, `unknownCount`, and `complete`; a partial
known-byte sum is never a total. A normal bundle
fails at 2 GiB or more and meets the issue target only at 1.9 GiB or less; a 1.9–2 GiB bundle is
buildable but leaves that target incomplete. `--no-bundle` records installed-size evidence with the
compressed bundle unavailable and makes no bundle-compliance claim.
