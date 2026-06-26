# Packaging

Tuneforge packaging is currently intended for local unsigned desktop builds. Packaged builds launch the bundled backend locally, include the default desktop Advanced Chords and Advanced Beat Analysis dependency stacks, do not bundle external model weights by default, and still require host-installed `ffmpeg` and `ffprobe`; Tuneforge does not bundle FFmpeg.

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

- `macos/Tuneforge.app`
- `dmg/Tuneforge_<version>_<arch>.dmg`

Run packaging from a normal macOS shell so `hdiutil` can create the disk image. The generated app is unsigned and not notarized.

The packaged backend checks the inherited `PATH` plus common Homebrew and MacPorts install locations when looking for `ffmpeg` and `ffprobe`. System microphone volume control uses the built-in CoreAudio API on macOS.

By default, Demucs, Whisper, and beat-this weights are read from their normal caches and downloaded on first use if missing. `--model-bundle` stages required Demucs and Whisper weights into the package, and also stages the beat-this `small0` checkpoint when beat-this dependencies are included. On startup, bundled model files seed the normal caches; runtime loaders still use cache paths, not package resource paths. `--model-bundle` does not control dependency inclusion. The flag prints a warning because Demucs pretrained-weight redistribution is unclear/restricted upstream.

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

Linux Flatpak bundles are large because the default package includes Torch, NVIDIA CUDA Python wheels, TensorFlow and related Advanced Chords dependencies, and beat-this Advanced Beat Analysis dependencies. `--legacy-nvidia` swaps in CUDA 12.6 runtime wheels, and `--model-bundle` adds model weights.

Packaging prints a size report for the built `/app` tree and selected Python artifacts. Use that report to distinguish accidental copied build inputs from expected ML runtime payloads.
