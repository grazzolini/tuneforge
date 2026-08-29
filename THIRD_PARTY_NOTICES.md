# Third-Party Notices

Tuneforge is distributed under the [MIT License](./LICENSE). It depends on third-party software with its own licensing terms. Significant runtime and build dependencies are listed below. This is not exhaustive — refer to each project's own license file for the authoritative text.

This document is an engineering notice and distribution checklist, not legal advice.

## Release Package Policy

This file is the source of truth for dependency and model-weight distribution policy:

- Default release package commands (`pnpm package:mac`, `pnpm package:linux:flatpak`) do not pass `--model-bundle`. They include Advanced Chords, Advanced Beat Analysis, and LV Chordia. LV Chordia's five dependency-owned checkpoints are included; external Demucs, Whisper, and beat-this weights are not.
- FFmpeg and ffprobe are not bundled by Tuneforge. macOS and source runs use host-installed binaries on `PATH` or explicit `TUNEFORGE_FFMPEG_PATH` / `TUNEFORGE_FFPROBE_PATH` overrides. Flatpak builds use `/app/bin/ffmpeg` and `/app/bin/ffprobe` wrappers backed by the Flatpak runtime or extensions.
- Demucs, Whisper, and beat-this weights are local cache assets by default. Setup/model-prewarm can prepare them ahead of time, and the app may download them on first use if they are missing. Fully offline use requires the relevant caches/assets to already exist.
- `--model-bundle` is an explicit local/dev packaging option, not part of default release packaging. It stages Demucs and Whisper weights and, when selected, the beat-this `small0` checkpoint; redistribution needs separate review before publishable artifacts use it.
- Default Advanced Chords packages use ONNX Runtime and always include the exact pinned 2.2 MB converted model and runtime state so startup can seed the verified TuneForge data cache. The Crema Python package, TensorFlow, and Keras are not included.
- LV Chordia's five MIT checkpoints are bundled inside its pinned source dependency, total exactly 28,730,939 bytes, and are removed with `--no-lv-chordia`. They never use a downloader or user cache.
- Tuneforge does not add cloud processing, accounts, telemetry, or track uploads for these features. Local-first does not mean first use is always offline.

## Build and Development Dependencies

### TypeScript / @typescript/typescript6

- **License:** Apache-2.0
- **Source:** <https://github.com/microsoft/TypeScript>
- **Notes:** Microsoft's TypeScript 7 CLI and official `@typescript/typescript6` compatibility package are build/development-only toolchain dependencies. They are not bundled into Tuneforge runtime artifacts.

### sccache 0.17.0

- **License:** Apache-2.0
- **Source:** <https://github.com/mozilla/sccache/tree/v0.17.0>
- **Notes:** The pinned x86_64 musl release binary accelerates Rust compilation during Linux Flatpak builds. It is build-only and is removed from the final Tuneforge package.

## Runtime Dependencies (bundled or required)

### Demucs

- **License:** MIT
- **Source:** <https://github.com/facebookresearch/demucs>
- **Notes:** Used for source separation. Installed via `pip` as a normal Python dependency.

### htdemucs_6s / htdemucs_ft model weights

- **License:** not covered by the Demucs MIT license; upstream contributors describe the pretrained weights as provided for scientific/research purposes.
- **Source:** <https://github.com/facebookresearch/demucs>
- **Notes:** Default release packaged desktop builds do not redistribute these weights. `pnpm setup:dev` preloads the pinned weights into the local Torch cache, and packaged apps reuse that cache when available or download on first use. The explicit local/dev `--model-bundle` package option can include these weights and prints a redistribution warning.

### PyTorch

- **License:** BSD-3-Clause
- **Source:** <https://github.com/pytorch/pytorch>
- **Notes:** The default Linux Flatpak uses the locked PyTorch runtime. The `--legacy-nvidia` Linux package option swaps in the legacy NVIDIA CUDA 12.6 PyTorch and torchaudio wheels for older supported NVIDIA GPUs. Its local verifier confirms wheel and CUDA-runtime versions, not GPU inference on every driver/hardware combination.

### NVIDIA CUDA runtime wheels

- **License:** NVIDIA Software License Agreement and related NVIDIA component terms; see each wheel's bundled license metadata.
- **Source:** <https://download.pytorch.org/whl/cu126/> and NVIDIA CUDA component packages on PyPI.
- **Notes:** The `--legacy-nvidia` Linux package option redistributes the CUDA 12.6 runtime wheel set pulled by PyTorch 2.13.0+cu126 and torchaudio 2.11.0+cu126, including cuBLAS, cuDNN, cuFFT, cuSOLVER, cuSPARSE, NCCL, NVRTC, NVTX, and related runtime libraries.

### librosa

- **License:** ISC
- **Source:** <https://github.com/librosa/librosa>

### Crema 0.2.0 converted model / Advanced Chords backend

- **License:** PyPI metadata lists ISC; upstream `LICENSE.md` currently contains BSD-2-Clause terms.
- **Source:** <https://github.com/bmcfee/crema>
- **Notes:** Advanced Chords uses an ONNX format conversion of the Crema 0.2.0 model, not a TuneForge-trained model. The model and runtime state are pinned to immutable Hugging Face revision `65af18f49af5101267fd28f15ac8c452d98b8e3d` and included in every package that enables Advanced Chords. Package startup verifies and seeds the normal cache. Source/training provenance remains incomplete. The complete Brian McFee BSD-2-Clause notice is packaged at [`LICENSES/crema-0.2.0-BSD-2-Clause.txt`](./LICENSES/crema-0.2.0-BSD-2-Clause.txt).

### ONNX Runtime / Advanced Chords backend

- **License:** MIT
- **Source:** <https://github.com/microsoft/onnxruntime>
- **Notes:** Included by the canonical `advanced-chords` dependency profile and equivalent `advanced-chords-onnx` compatibility profile. TuneForge uses CPU execution and an immutable converted-model revision. Advanced Chords packages include the exact model and runtime-state files and seed the same verified cache on startup. This removes Crema/TensorFlow's HDF5 model-loading closure; preserved LV Chordia support still brings its separately declared `h5py` dependency.

### beat-this / Advanced Beat Analysis backend

- **License:** MIT
- **Source:** <https://github.com/CPJKU/beat_this>
- **Notes:** Advanced Beat Analysis is part of the default desktop/dev/package dependency set and can be excluded with `--no-beat-this` / `--no-advanced-beats`. Tuneforge does not bundle beat-this checkpoints by default. `pnpm setup:dev` preloads the selected `small0` checkpoint into the local PyTorch cache; if it is not preloaded, the first Advanced Beat Analysis run may download it through `beat-this`. Packages built with `--model-bundle` include the `small0` checkpoint when beat-this dependencies are included.

### lv-chordia / LV Chordia (Submission) backend and checkpoints

- **License:** MIT for source and the five distributed checkpoints.
- **Source:** <https://github.com/openmirlab/lv-chordia/tree/9d7de7bbf45efa6731ec8dc62d35280f141c0702>
- **Notes:** The optional dependency is pinned to audited revision `9d7de7bbf45efa6731ec8dc62d35280f141c0702`, whose package metadata identifies LV Chordia 1.1.0. Normal desktop packages include one checkpoint set under `share/lv-chordia/cache_data`: five files totaling exactly 28,730,939 bytes. TuneForge validates exact names, sizes, and SHA-256 digests before deserialization. Missing or corrupt files fail closed and are repaired by reinstalling; no outbound fetch or user-cache lifecycle exists. `--no-lv-chordia` excludes both source/runtime bytes and checkpoint bytes. The refreshed default graph satisfies LV 1.1.0's NumPy 2.2.6+ and Torch 2.13+ requirements without global resolver overrides. Runtime dependency size must be reported separately from the 28,730,939 checkpoint bytes.

### openai-whisper / Whisper model weights

- **License:** MIT for the upstream package/repository; review model-weight redistribution separately before publishing bundled weights.
- **Source:** <https://github.com/openai/whisper>
- **Notes:** Used for local lyrics transcription. Default release packaged desktop builds do not redistribute Whisper model weights. `pnpm setup:dev` preloads the default `turbo` model into the local TuneForge lyrics cache, and packaged apps reuse that cache when available or download on first use. Packages built with `--model-bundle` stage the required Whisper weights into the package so startup can seed the normal cache.

### cryptography

- **License:** Apache-2.0 OR BSD-3-Clause
- **Source:** <https://github.com/pyca/cryptography>
- **Notes:** Used for local Ed25519 sync identity keys.

### audioop-lts

- **License:** PSF-2.0
- **Source:** <https://github.com/AbstractUmbra/audioop>
- **Notes:** Restores the removed standard-library `audioop` module for Python 3.13+ compatibility in pydub/LV paths.

### Advanced Beat Analysis transitive runtime stack

- **Primary new packages:** beat-this (MIT) and rotary-embedding-torch (MIT).
- **Notes:** These packages are in the default desktop/dev/package dependency set unless `--no-beat-this` / `--no-advanced-beats` is passed, and reuse the existing PyTorch, torchaudio, einops, and soxr stack already present in `apps/backend/uv.lock`. Built-in Beat Analysis remains the fallback when beat-this is unavailable, unsupported, or explicitly excluded.

### FastAPI, Pydantic, SQLAlchemy, Alembic, Uvicorn, soundfile

- See each project's own license. All are permissively licensed (MIT / BSD / Apache-2.0 family).

### FFmpeg / ffprobe

- **License:** LGPL-2.1+ or GPL-2.0+ depending on the build
- **Source:** <https://ffmpeg.org/>
- **Notes:** **Tuneforge does not bundle FFmpeg.** macOS and source runs use a user-installed build (for example via Homebrew, apt, or winget) discoverable on `PATH` or through explicit binary path settings. Flatpak packages use sandbox wrapper paths backed by the Flatpak runtime or extensions. Users are responsible for the licensing terms of the FFmpeg build they install or provide.

### PulseAudio pactl

- **License:** LGPL-2.1+
- **Source:** <https://www.freedesktop.org/software/pulseaudio/>
- **Notes:** Bundled in the Flatpak build as client-only PulseAudio utilities/libraries so Linux system microphone volume control can use `pactl` inside the sandbox. The PulseAudio daemon is not bundled.

## Desktop Shell

### Tauri

- **License:** Apache-2.0 / MIT (dual)
- **Source:** <https://github.com/tauri-apps/tauri>
- **Notes:** The Rust crate inventory is primarily MIT / Apache-2.0 / BSD / ISC / Zlib family. It also includes MPL-2.0 and Unicode-3.0 notice obligations. Crates with LGPL-2.1-or-later as one license option, such as `r-efi`, also provide MIT or Apache-2.0 alternatives in the resolved metadata.

### Tauri barcode scanner plugin

- **License:** MIT OR Apache-2.0
- **Source:** <https://github.com/tauri-apps/plugins-workspace>
- **Notes:** Used by the Android-only QR pairing scanner. The desktop shell does not enable the barcode scanner plugin.

### Tauri clipboard manager plugin

- **License:** MIT OR Apache-2.0
- **Source:** <https://github.com/tauri-apps/plugins-workspace>
- **Notes:** Used to write explicit user-requested pairing material and privacy-safe sync evidence as plain text to the system clipboard.

### TuneForge LAN sync transport Rust crates

- **License:** Apache-2.0 / MIT for `snow`, `base64`, `rand`, `sha2`, and the RustCrypto AEAD/hash stack; BSD-3-Clause for `ed25519-dalek` and `curve25519-dalek`; MIT / BSD-3-Clause for `if-addrs`.
- **Source:** <https://github.com/mcginty/snow>, <https://github.com/dalek-cryptography/curve25519-dalek>, <https://github.com/RustCrypto>, <https://github.com/rust-random/rand>, <https://github.com/marshallpierce/rust-base64>, and <https://github.com/messense/if-addrs>.
- **Notes:** Used by the desktop-only same-LAN sync transport for Noise encrypted sessions, trusted Ed25519 peer identity verification, SHA-256 artifact verification, random session nonces, and local interface endpoint hints. The FastAPI backend remains loopback-only.

### Iroh / iroh-blobs prototype sync transport Rust crates

- **License:** MIT OR Apache-2.0
- **Source:** <https://github.com/n0-computer/iroh> and <https://docs.rs/iroh-blobs/latest/iroh_blobs/>
- **Notes:** Evaluated for desktop-native prototype transport code. The prototype uses Iroh QUIC endpoints for peer connections and records transport-local BLAKE3/blob identity after TuneForge semantic manifests and SHA-256 artifact verification succeed. It does not yet use full `iroh-blobs` verified streaming or range-oriented blob transfer before staged import.

### cpal

- **License:** Apache-2.0 / MIT (dual)
- **Source:** <https://github.com/RustAudio/cpal>
- **Notes:** Used by the desktop shell for local microphone device enumeration and tuner input capture, and by macOS, Linux, and Android project playback. Android playback uses CPAL's AAudio backend and requires API 26 or newer.

### signalsmith-stretch

- **License:** MIT
- **Source:** <https://github.com/colinmarc/signalsmith-stretch-rs>
- **Notes:** Used by the native macOS, Linux, and Android playback engine for tempo changes with pitch preservation. Its resolved Rust transitive stack is permissively licensed.

### Symphonia

- **License:** MPL-2.0
- **Source:** <https://github.com/pdeljanov/Symphonia>
- **Notes:** Used only by the native macOS, Linux, and Android playback engine for streaming demux/decode of local playback files. FFmpeg remains the desktop host dependency for transform/export work and is not bundled on Android.

### ndk-context

- **License:** Apache-2.0 / MIT (dual)
- **Source:** <https://github.com/rust-windowing/android-ndk-rs>
- **Notes:** Version 0.1.1 is used by the Android shell to initialize the process Android VM and activity context expected by CPAL before opening its AAudio output stream.

### rusqlite / SQLite

- **License:** MIT for rusqlite; SQLite is public domain
- **Source:** <https://github.com/rusqlite/rusqlite> and <https://sqlite.org/>
- **Notes:** Used by the embedded Android backend. Desktop persistence remains in the Python backend.

### android_system_properties

- **License:** Apache-2.0 / MIT (dual)
- **Source:** <https://github.com/nical/android_system_properties>
- **Notes:** Used by the embedded Android backend to detect emulator runtimes for debug-only flow testing.

### ndk-sys

- **License:** Apache-2.0 / MIT (dual)
- **Source:** <https://github.com/rust-mobile/ndk>
- **Notes:** Used by the embedded Android backend to call Android NDK media decode APIs.

### whisper-rs / whisper.cpp

- **License:** Unlicense for whisper-rs; MIT for whisper.cpp
- **Source:** <https://codeberg.org/tazz4843/whisper-rs> and <https://github.com/ggml-org/whisper.cpp>
- **Notes:** Used by the embedded Android backend for side-loaded local lyrics transcription. Tuneforge does not redistribute Whisper model weights.

### qrcode.react

- **License:** ISC
- **Source:** <https://github.com/zpao/qrcode.react>
- **Notes:** Used to render pairing QR codes. The package license also notes bundled QR Code Generator code under MIT terms.

### React, Vite, TanStack Query, openapi-fetch, openapi-typescript, lucide-react

- See each project's own license. The installed JavaScript tree is primarily permissive, with some non-copyleft notice/data licenses such as MPL-2.0 (`lightningcss`), BlueOak-1.0.0 (`lru-cache` / `minimatch`), CC-BY-4.0 (`caniuse-lite` browser data), and CC0-1.0 (`mdn-data`).

## Generating a Full Inventory

The lists above cover the dependencies and model assets that materially shape the user experience. Before release, refresh a machine-readable inventory from the locked dependency set and reconcile policy changes back into this file. The default desktop package inventory includes the Advanced Chords and Advanced Beat Analysis dependency stacks and excludes `--model-bundle` sources; opt-out, legacy NVIDIA, and model-bundled builds need separate inventory notes.

- Repeatable release checklist: `pnpm release:license-inventory` (add `-- --check` to verify required CLIs, or `-- --json` for structured output)
- JavaScript / TypeScript: `pnpm licenses list --recursive`
- Rust: `cargo about generate --format json --locked` (run inside `apps/desktop/src-tauri`)
- Python: `uv tree --python 3.14 --locked --all-groups` plus each package's metadata

If you spot a missing or incorrect attribution, please open a pull request.
