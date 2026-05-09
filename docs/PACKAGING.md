# Packaging

Tuneforge packaging is currently intended for local unsigned desktop builds. Packaged builds launch the bundled backend locally, include both supported Demucs stem model weights, and still require host-installed `ffmpeg` and `ffprobe`; Tuneforge does not bundle FFmpeg.

## macOS

Build the app bundle and DMG with:

```sh
pnpm package:mac
```

The generated artifacts are written under `apps/desktop/src-tauri/target/release/bundle/`:

- `macos/Tuneforge.app`
- `dmg/Tuneforge_<version>_<arch>.dmg`

Run packaging from a normal macOS shell so `hdiutil` can create the disk image. The generated app is unsigned and not notarized.

The packaged backend checks the inherited `PATH` plus common Homebrew and MacPorts install locations when looking for `ffmpeg` and `ffprobe`. System microphone volume control uses the built-in CoreAudio API on macOS.

`pnpm package:mac` prepares `resources/backend/models/demucs` with pinned `htdemucs_6s` and `htdemucs_ft` weights. The app sets `TUNEFORGE_DEMUCS_MODEL_REPO` for the bundled backend so stem generation never downloads model weights at runtime. Use `pnpm models:demucs:prepare -- --cache-only` for offline packaging checks that must fail instead of downloading missing weights.

## Linux Flatpak

Build the standard local Flatpak profile with:

```sh
pnpm package:linux:flatpak
```

For faster local iteration, skip the single-file bundle step:

```sh
pnpm package:linux:flatpak -- --no-bundle
```

The standard profile generates local dependency source manifests, fetches pinned Demucs model sources, builds inside the SDK sandbox, installs the backend under `/app/lib/tuneforge/backend`, and stores private app data under `/var/data/tuneforge`. It bundles `pactl` for microphone volume control but does not bundle FFmpeg.

## Linux Full Flatpak Profile

Use the full profile for local/dev Linux builds that need Advanced Chords, the legacy NVIDIA Torch stack, broader GPU device access, and the same host library path used by `pnpm dev`:

```sh
pnpm package:linux:flatpak:full
# or
pnpm package:linux:flatpak -- --profile full
```

The full profile includes the `advanced-chords` backend extra and pins the legacy CUDA 12.6 PyTorch stack used by the local legacy NVIDIA setup. Advanced Chords remains opt-in through existing settings; the package profile only makes the backend available.

The full profile grants access to `xdg-data/tuneforge` and points `TUNEFORGE_DATA_DIR` at `~/.local/share/tuneforge`, so it reads the same SQLite database and project files as local development. Do not run the Flatpak app and `pnpm dev` against that shared library at the same time; SQLite is local and Tuneforge is not designed for concurrent backends writing the same library.

The full profile also uses broader Flatpak device access for CUDA validation. The standard profile keeps the narrower graphics device access.

## Flatpak Local Repo Installs

When `--no-bundle` is used, packaging exports a local Flatpak repository and prints the exact install commands. The standard profile uses `tuneforge-local` and `packaging/flatpak/repo`:

```sh
flatpak remote-add --user --if-not-exists --no-gpg-verify tuneforge-local packaging/flatpak/repo
flatpak install --user --reinstall tuneforge-local com.tuneforge.desktop
```

The full profile uses a separate local remote and repository so profile artifacts do not mix:

```sh
flatpak remote-add --user --if-not-exists --no-gpg-verify tuneforge-local-full packaging/flatpak/repo-full
flatpak install --user --reinstall tuneforge-local-full com.tuneforge.desktop
```

Without `--no-bundle`, the Flatpak bundle is written under `packaging/flatpak/` as `Tuneforge_<version>_x86_64.flatpak` for standard builds and `Tuneforge_<version>_x86_64-full.flatpak` for full builds.

## Size Expectations

Linux Flatpak bundles that include GPU ML stacks are large. The standard profile is already dominated by Torch and NVIDIA CUDA Python wheels, plus about 373 MiB of raw Demucs stem weights. The full profile adds TensorFlow and related Advanced Chords dependencies.

Packaging prints a size report for the built `/app` tree and selected Python artifacts. Use that report to distinguish accidental copied build inputs from expected ML runtime payloads.
