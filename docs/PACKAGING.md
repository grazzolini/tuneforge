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

Run the pre-tag checks from the intended release commit:

```sh
node scripts/check-release-version.mjs
node scripts/release-license-inventory.mjs --check
pnpm package:mac
pnpm package:linux:flatpak
```

Run `pnpm package:mac` only on supported macOS release hosts, and run
`pnpm package:linux:flatpak` only on supported Linux hosts with Flatpak packaging
tooling. If a release includes only one platform artifact, run and record the package
command for that artifact.

For the manual launch smoke, install or open the built package artifact and confirm:

- the packaged app launches without a dev server;
- the bundled backend starts and remains bound to `127.0.0.1`;
- the UI loads and core navigation is usable;
- Settings/About release identity is visible when that surface exists for the build;
- observed behavior matches the package policy above: unsigned/not-notarized local
  builds, no bundled FFmpeg, and no external Demucs, Whisper, or beat-this model
  weights unless `--model-bundle` was explicitly reviewed and used.

Record release gate evidence with:

- OS and version;
- artifact type, such as macOS `.app`/DMG or Linux `.flatpak`;
- commit SHA;
- command run;
- repo-relative output path, artifact filename/hash, or sanitized artifact identity;
- launch-smoke checklist source, such as this manual checklist or a named release
  checklist;
- per-check proof for packaged launch without a dev server, backend startup,
  `127.0.0.1` bind, UI load, core navigation, and Settings/About release identity
  when that surface exists;
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
