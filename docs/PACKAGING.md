# Packaging

Tuneforge packaging is currently intended for local unsigned desktop builds. Packaged builds launch the bundled backend locally, do not bundle external model weights by default, and still require host-installed `ffmpeg` and `ffprobe`; Tuneforge does not bundle FFmpeg.

## macOS

Build the app bundle and DMG with:

```sh
pnpm package:mac
```

Optional backend/package flags can be passed through:

```sh
pnpm package:mac -- --crema --beat-this --model-bundle
```

The generated artifacts are written under `apps/desktop/src-tauri/target/release/bundle/`:

- `macos/Tuneforge.app`
- `dmg/Tuneforge_<version>_<arch>.dmg`

Run packaging from a normal macOS shell so `hdiutil` can create the disk image. The generated app is unsigned and not notarized.

The packaged backend checks the inherited `PATH` plus common Homebrew and MacPorts install locations when looking for `ffmpeg` and `ffprobe`. System microphone volume control uses the built-in CoreAudio API on macOS.

By default, Demucs, Whisper, and beat-this weights are read from their normal caches and downloaded on first use if missing. `--model-bundle` stages required Demucs and Whisper weights into the package, and also stages the beat-this `small0` checkpoint when `--beat-this` is present. On startup, bundled model files seed the normal caches; runtime loaders still use cache paths, not package resource paths. The flag prints a warning because Demucs pretrained-weight redistribution is unclear/restricted upstream.

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

Feature flags are independent:

```sh
pnpm package:linux -- --crema --beat-this --legacy-nvidia --model-bundle
```

- `--crema` includes the optional Advanced Chords dependency stack.
- `--beat-this` includes the optional Advanced Beat Analysis dependency stack.
- `--legacy-nvidia` swaps in the legacy CUDA 12.6 PyTorch/torchaudio wheels and broader GPU device access.
- `--model-bundle` includes required Demucs and Whisper weights, plus beat-this `small0` when `--beat-this` is present.
- `--sandbox-data` keeps app data under Flatpak-private `/var/data/tuneforge` instead of the host XDG data directory.

By default, the Flatpak grants access to `xdg-data/tuneforge`, `xdg-cache/torch`, and
`xdg-cache/whisper`. Packaged runs therefore use the same data root and model caches as
`pnpm dev`: `~/.local/share/tuneforge`, `~/.cache/torch`, and `~/.cache/whisper`. Do
not run the Flatpak app and `pnpm dev` against that shared library at the same time;
SQLite is local and Tuneforge is not designed for concurrent backends writing the same
library.

## Flatpak Local Repo Installs

When `--no-bundle` is used, packaging exports a local Flatpak repository and prints the exact install commands. The local remote is `tuneforge-local` and the repository is `packaging/flatpak/repo`:

```sh
flatpak remote-add --user --if-not-exists --no-gpg-verify tuneforge-local packaging/flatpak/repo
flatpak install --user --reinstall tuneforge-local com.tuneforge.desktop
```

Without `--no-bundle`, the Flatpak bundle is written under `packaging/flatpak/` as `Tuneforge_<version>_x86_64.flatpak`.

## Size Expectations

Linux Flatpak bundles that include GPU ML stacks are large. The default package is dominated by Torch and NVIDIA CUDA Python wheels. `--legacy-nvidia` adds CUDA 12.6 runtime wheels, `--crema` adds TensorFlow and related Advanced Chords dependencies, and `--model-bundle` adds model weights.

Packaging prints a size report for the built `/app` tree and selected Python artifacts. Use that report to distinguish accidental copied build inputs from expected ML runtime payloads.
