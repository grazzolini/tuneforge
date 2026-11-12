# Third-Party Notices

Tuneforge is distributed under the [MIT License](./LICENSE). It depends on third-party software with its own licensing terms. Significant runtime and build dependencies are listed below. This is not exhaustive — refer to each project's own license file for the authoritative text.

This document is an engineering notice and distribution checklist, not legal advice.

## Release Package Policy

This file is the source of truth for dependency and model-weight distribution policy:

- Bare package commands select the isolated local Test profile; production requires `--release`.
- Default release package commands (`pnpm package:mac --release`, `pnpm package:linux:flatpak --release`) do not pass `--model-bundle`. They include Advanced Chords, Advanced Beat Analysis, and LV Chordia. LV Chordia's five dependency-owned checkpoints are included; external Demucs, Whisper, and beat-this weights are not.
- Packaged macOS arm64 and Android arm64 include the LGPL FFmpeg/LAME distribution pinned by [`packaging/ffmpeg/sources.lock.json`](./packaging/ffmpeg/sources.lock.json). Android arm64 also dynamically links the owned libsoxr runtime pinned by [`packaging/soxr/sources.lock.json`](./packaging/soxr/sources.lock.json). Development/source runs keep host lookup and explicit overrides. Flatpak includes neither owned payload and uses runtime/extension wrappers for FFmpeg.
- Demucs, Whisper, beat-this, and All-In-One weights are local cache assets by default. Setup/model-prewarm can prepare them ahead of time, and the app may download them on first use if they are missing. Fully offline use requires the relevant caches/assets to already exist.
- `--model-bundle` is an explicit local/dev packaging option, not part of default release packaging. It stages Demucs and Whisper weights and, when selected, the beat-this `small0` checkpoint; redistribution needs separate review before publishable artifacts use it.
- Android Advanced Chords uses ONNX Runtime and installs the exact pinned Crema model/runtime-state pair on first use. The explicit local/dev `--model-bundle` option embeds the same pair for first-launch offline use. The Crema Python package, TensorFlow, and Keras are not included.
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

### Gingo (owned music-core source)

- **License:** MIT
- **Source:** <https://github.com/sauloverissimo/gingopy/tree/eec410e6f5b09ad89a2b9d987b63e4048d9a738c>
- **Notes:** The standalone `packages/music-core` package explicitly acquires only locked upstream `cpp/` and `LICENSE` from its checksum-pinned archive. Generated sources are ignored; upstream source files are not tracked.
  `sources.lock.json` records the immutable source tree, archive checksum, and every imported file hash.
  The upstream MIT license remains at `packages/music-core/licenses/Gingo-LICENSE`.
  An owned build-time patch adds slash-tone enumeration, optional required pitch classes, a configurable
  non-root-bass penalty, and deterministic policy tie-breaking without modifying acquired source bytes
  or upstream playability pruning. Upstream calls retain their default coverage and scoring.
  Python, Rust, and locally bundled WASM consume this canonical core. Standalone wheels and source distributions retain its schema, instrument data,
  sources, and notices. No upstream Python
  runtime, CLI, assets, or audio are imported.

### pybind11 3.1.0 (music-core binding build dependency)

- **License:** BSD-3-Clause
- **Source:** <https://github.com/pybind/pybind11/tree/97bf890db679505a14dfe547a5e77bb2bd05dc90>
- **Notes:** Header-only binding dependency for the compiled `tuneforge_music_core._native`
  extension. Exact wheel/source hashes live in the core build-tool lock. It adds no Python
  runtime dependency. The standalone distribution retains the pybind11 notice; Flatpak
  acquires the pinned wheel before its offline build phase.

### Unicode 16.0.0 (music-core compatibility data)

- **License:** Unicode License V3 (`Unicode-3.0`)
- **Source:** <https://www.unicode.org/Public/16.0.0/ucd/>
- **Notice:** `packages/music-core/licenses/Unicode-LICENSE`
- **Notes:** The generated `resources/unicode-v16.hpp` remains versioned compatibility source data;
  musical parsing uses shared canonical helpers rather than per-language emulation. Its header records
  the exact UnicodeData, DerivedCoreProperties, and SpecialCasing source hashes plus
  the generator and license hashes. `tools/generate_unicode.py` is a maintenance tool;
  builds use the committed table without downloading Unicode data. Standalone wheels,
  source distributions, packaged applications, and CI image payloads retain the complete Unicode notice.


### demucs-infer 4.2.2

- **License:** MIT
- **Source:** <https://github.com/openmirlab/demucs-infer/tree/4b79d5c756ce298503d90b0cca2abbc76c565416>
- **Notes:** Used for source separation from the immutable source archive pinned in
  `apps/backend/pyproject.toml`. TuneForge loads its pinned YAML+safetensors models through a
  native strict loader and does not use the package's legacy pickle checkpoint loader.

### All-In-One section detection

- **Source license:** MIT, Copyright (c) 2023 Taejun Kim. The immutable
  [all-in-one-infer v3.1.0 source](https://github.com/openmirlab/all-in-one-infer/tree/da84f9606c10f1b8b605cce637426afeeafef227)
  supplies pure-PyTorch attention; NATTEN is not required. It reuses TuneForge's verified
  six-source stems rather than invoking the upstream separator or downloader.
- **Adapted code:** DiNAT layers derive from Hugging Face Transformers, Copyright 2022
  SHI Labs and The HuggingFace Inc. team, under Apache-2.0. Preserve the attribution,
  modification notice, and complete license in
  [`LICENSES/all-in-one-Transformers-Apache-2.0.txt`](./LICENSES/all-in-one-Transformers-Apache-2.0.txt).
- **Weights:** the original publisher's [immutable model card](https://huggingface.co/taejunkim/allinone/blob/379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19/README.md)
  explicitly declares `license: mit`. The card contains this declaration rather than a full
  copyright/license text. Eight original-author `harmonix-fold*.pth` files are fetched directly
  from that revision and each verified at 1,400,571 bytes with its pinned SHA-256 before
  `torch.load(weights_only=True)`, primitive configuration validation, and strict tensor loading.
- **Discrepancy:** the downstream fork's
  [checkpoint catalog](https://github.com/openmirlab/all-in-one-infer/blob/566f96c3f007c783ab5eb6db0123bf3335af8f31/src/allin1_infer/config/checkpoints.toml)
  labels the same hashes CC BY-NC-SA-4.0, conflicting with the author's MIT declaration.
  TuneForge uses direct original-author files and records this conflict; no third-party
  rehosted weights or original madmom neural checkpoints are used. Checkpoints remain local
  first-use/prewarm cache assets and are not added to release packages or `--model-bundle`.
- **DSP/decoding:** pinned
  [madmom-infer source](https://github.com/openmirlab/madmom-infer/tree/a9ed04ec942dd6ec5309df7ce7f3783d1bb42575)
  is BSD-2-Clause. TuneForge uses its spectrogram frontend and All-In-One's functional
  decoder. The package contains a checkpoint catalog but no model payloads; optional neural
  downloads are unused.

### All-In-One configuration and plotting dependencies

- **Configuration:** Hydra Core 1.3.8 is MIT; OmegaConf 2.3.1 is BSD-3-Clause; ANTLR Python
  runtime 4.9.3 is BSD-3-Clause. The ANTLR wheel omits the complete license text, so retain
  [`LICENSES/antlr4-BSD-3-Clause.txt`](./LICENSES/antlr4-BSD-3-Clause.txt) alongside its source headers.
- **Plotting import closure:** Matplotlib 3.11.2 retains the Matplotlib license;
  contourpy 1.4.0, cycler 0.12.1, kiwisolver 1.5.1, and python-dateutil 4.0.0 are BSD-3-Clause;
  fonttools 4.68.0 and pyparsing 3.3.3 are MIT. The upstream package imports plotting modules
  even for headless analysis; TuneForge does not expose plotting or sonification here.
- **Actual wheel assets:** the CPython 3.14 macOS arm64 and Linux x86_64 wheels retain
  per-distribution license files. Matplotlib's bundled FreeType uses the permissive FreeType
  License (FTL) alternative, not GPL; its HarfBuzz portions are MIT-style and Qhull is permissive.
  This product uses the FreeType Project (<https://www.freetype.org/>). Retain wheel notices
  for BaKoMa/Bitstream/DejaVu/STIX fonts, OFL font material, Apache-2.0 ColorBrewer data, and
  CC0 style data. These are separate from model-checkpoint licensing. Fonttools' external
  Apache/MIT/OFL notices also remain intact.
- **Distribution:** macOS resource staging preserves dependency `.dist-info` notices plus the
  two explicit licenses above under `backend/licenses/`. Flatpak preserves installed wheel
  notices and installs those explicit licenses under `/app/share/doc/tuneforge/LICENSES/`.
  Verify the resolved wheel payloads/notices again when their locked versions or platforms change.

### Pillow

- **License:** MIT-CMU
- **Source:** <https://github.com/python-pillow/Pillow/tree/12.3.0>
- **Notes:** The pinned 12.3.0 macOS arm64 and Linux x86_64 wheels declare MIT-CMU.
  Required by the plotting import closure and also used by the development renderer.
  The audited macOS arm64 and Linux x86_64 wheels retain codec/font notices for
  FreeType FTL, HarfBuzz MIT-style, JPEG, OpenJPEG, WebP, AVIF, PNG/zlib, TIFF, LittleCMS,
  XZ, and X11 components. The optional system FriBidi integration is not a bundled LGPL
  payload. Preserve the complete wheel `licenses/LICENSE`, including its full FTL text.

### tzdata

- **License:** Apache-2.0
- **Source:** <https://github.com/python/tzdata>
- **Notes:** The resolved desktop Python shipping closure includes the `tzdata==2026.6` wheel
  pinned in `apps/backend/uv.lock`. Retain its bundled license and copyright notices in macOS
  arm64 and Linux x86_64 desktop packages.

### htdemucs_6s / htdemucs_ft model weights

- **License:** not covered by the Demucs MIT license; upstream contributors describe the pretrained weights as provided for scientific/research purposes.
- **Source:** <https://github.com/facebookresearch/demucs>
- **Notes:** Default desktop and Android packages omit these weights. `pnpm setup:dev` preloads the pinned, verified Hugging Face YAML+safetensors cache, and packaged apps reuse that cache or download on first use. The explicit local/dev `--model-bundle` option stores the same immutable files and loads them directly; it still prints a redistribution warning.

### huggingface-hub

- **License:** Apache-2.0
- **Source:** <https://github.com/huggingface/huggingface_hub>
- **Notes:** Demucs uses public Hugging Face cache/download APIs with pinned repository commits and the standard Hub cache precedence: `HF_HUB_CACHE`, legacy `HUGGINGFACE_HUB_CACHE`, `HF_HOME/hub`, `XDG_CACHE_HOME/huggingface/hub`, then `~/.cache/huggingface/hub`. `TUNEFORGE_DATA_DIR` does not control upstream Demucs, Whisper, or beat-this caches. Public Demucs downloads work without `HF_TOKEN`; it is optional for authenticated Hub access. Explicit local repos and packaged model bundles retain their separate verified layouts.

### PyTorch

- **License:** BSD-3-Clause
- **Source:** <https://github.com/pytorch/pytorch>
- **Notes:** The Linux Flatpak application resolves the official CPU Torch base. Optional NVIDIA and legacy NVIDIA Core/Runtime extension pairs redistribute separate locked acceleration and compatibility closures. Marker and dependency checks do not prove inference on every driver/hardware combination.

### NVIDIA CUDA runtime wheels

- **License:** NVIDIA Software License Agreement and related NVIDIA component terms; see each wheel's bundled license metadata.
- **Source:** <https://download.pytorch.org/whl/> and NVIDIA CUDA component packages on PyPI.
- **Notes:** The `com.tuneforge.desktop.Torch.Stack.Nvidia` and `com.tuneforge.desktop.Torch.Stack.LegacyNvidia` profiles each use a Core extension for their Torch-family binaries and a matching Runtime extension for the locked CUDA/NVIDIA closure, including cuBLAS, cuDNN, cuFFT, cuSOLVER, cuSPARSE, NCCL, NVRTC, NVTX, and related runtime libraries. The CPU application rejects CUDA, NVIDIA, and Triton packages.

### librosa

- **License:** ISC
- **Source:** <https://github.com/librosa/librosa>

### Crema 0.2.0 converted model / Advanced Chords backend

- **License:** PyPI metadata lists ISC; upstream `LICENSE.md` currently contains BSD-2-Clause terms.
- **Source:** <https://github.com/bmcfee/crema>
- **Notes:** Advanced Chords uses an ONNX format conversion of the Crema 0.2.0 model, not a TuneForge-trained model. The model and runtime state are pinned to immutable Hugging Face catalog revision `895b249c4ccabaedc0770b12935c2b7b2f60e145`. Desktop packages retain their existing bundled-cache behavior. Android downloads and verifies the pair on first use unless `--model-bundle` embeds it for first-launch offline use. Source/training provenance remains incomplete. The complete Brian McFee BSD-2-Clause notice is packaged at [`LICENSES/crema-0.2.0-BSD-2-Clause.txt`](./LICENSES/crema-0.2.0-BSD-2-Clause.txt).

### ONNX Runtime / Advanced Chords backend

- **License:** MIT
- **Source:** <https://github.com/microsoft/onnxruntime>
- **Notes:** Included by the canonical desktop `advanced-chords` dependency profile and equivalent `advanced-chords-onnx` compatibility profile. Android pins `com.microsoft.onnxruntime:onnxruntime-android:1.29.0` (AAR SHA-256 `e97540ca78fe36f6fe2013f82843414fb843b6c7681fb04644cba5e1406662dd`) and uses the FP32 CPU provider. This removes Crema/TensorFlow's HDF5 model-loading closure; preserved LV Chordia support still brings its separately declared `h5py` dependency.

### beat-this / Advanced Beat Analysis backend

- **License:** MIT
- **Source:** <https://github.com/CPJKU/beat_this>
- **Notes:** Advanced Beat Analysis is part of the default desktop/dev/package dependency set and can be excluded with `--no-beat-this` / `--no-advanced-beats`. Desktop uses the upstream Python runtime. Android uses the pinned, digest-verified FP32 ExecuTorch `small0` program from immutable Hugging Face catalog revision `895b249c4ccabaedc0770b12935c2b7b2f60e145` (`beat-this/beat-this-small0.pte`, 9,820,680 bytes, SHA-256 `03b512e135edeb4f4644a7f05fa13ae20ba676484997548f81118fec13d42293`). Default packages do not bundle beat-this checkpoints: Android downloads and verifies this program on first use, while desktop uses its existing local cache/download path. The explicit local/dev `--model-bundle` option embeds the same Android program or desktop checkpoint. Its verified availability does not grant redistribution approval for publishable artifacts.

### ExecuTorch Android 1.4.0

- **License:** BSD-3-Clause
- **Source:** <https://github.com/pytorch/executorch/tree/v1.4.0>
- **Notes:** Android Advanced Beat Analysis executes the FP32 `small0` program through the XNNPACK backend. Gradle resolves `org.pytorch:executorch-android:1.4.0`; packaging rejects the build unless the AAR digest is SHA-256 `a4a836b9fadd5b9afdf07b8533b2c3326695d04a58dd37e2cdfe709e804854fb`.

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

- **Version:** See [`packaging/ffmpeg/sources.lock.json`](./packaging/ffmpeg/sources.lock.json).
- **License:** LGPL-2.1-or-later for TuneForge's owned configuration
- **Source:** <https://ffmpeg.org/>
- **Notes:** Packaged macOS arm64 and Android arm64 use the repository recipe and source lock in `packaging/ffmpeg/`. The build disables GPL, nonfree, version3, network, device, and unused libraries/features. macOS also includes `ffmpeg` and `ffprobe`; Android links the five selected libav libraries through a narrow C bridge. The detached source signature is verified against the signing key pinned by the source lock. Each build emits a hash-bound corresponding-source companion containing the full upstream archives, signature/key, patch, recipe, lock, validator, and notices. Development/source runs keep host lookup. Flatpak uses only sandbox runtime/extension wrappers.

### libsoxr

- **Version:** Revision `a66f3eeeeb62a32403ff143b756eed92b1ec6b62`
- **License:** LGPL-2.1-or-later; embedded PFFFT component under the UCAR/NCAR BSD-3-Clause terms
- **Source:** <https://github.com/dofuuz/soxr/tree/a66f3eeeeb62a32403ff143b756eed92b1ec6b62>
- **Notes:** Android arm64 dynamically links the audited libsoxr build used only for desktop-compatible analysis and Crema resampling. The build enables PFFFT, Copyright (c) 2013 Julien Pommier, based on UCAR/NCAR FFTPACK, under BSD-3-Clause terms. [`packaging/soxr/sources.lock.json`](./packaging/soxr/sources.lock.json) pins the exact upstream source archive, PFFFT revision and source path, hashes, license texts, and Android patch. `pnpm soxr:build -- --target android-arm64-v8a` emits the replaceable shared library, license texts, hash-bound provenance, and corresponding-source companion. Rebuilding that companion with a replacement LGPL-compatible libsoxr preserves the narrow C ABI consumed by TuneForge; the APK does not statically incorporate libsoxr.

### LAME

- **Version:** See [`packaging/ffmpeg/sources.lock.json`](./packaging/ffmpeg/sources.lock.json).
- **License:** LGPL-2.0-or-later
- **Source:** <https://sourceforge.net/projects/lame/>
- **Notes:** Dynamically linked only for the owned MP3 encoder. Upstream publishes the release archive over HTTPS but no detached signature or checksum sidecar; TuneForge pins and verifies the reviewed archive SHA-256 in `packaging/ffmpeg/sources.lock.json`. The package includes LAME's COPYING and LICENSE texts.

### WirePlumber wpctl

- **Version:** 0.5.17
- **License:** MIT
- **Source:** <https://gitlab.freedesktop.org/pipewire/wireplumber/-/archive/0.5.17/wireplumber-0.5.17.tar.bz2>
- **Notes:** The Flatpak bundles `wpctl` and required libraries/modules, not the session manager daemon. Source hashes are pinned in the manifest; upstream license files ship under `/app/share/licenses/wireplumber-wpctl`.

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

- **License:** Apache-2.0
- **Source:** <https://github.com/RustAudio/cpal>
- **Notes:** Used by the desktop shell for local microphone device enumeration and tuner input capture, and by macOS, Linux, Android, and iOS simulator project playback. Linux selects CPAL's native PipeWire host; its `pipewire-rs` binding stack is MIT-licensed and links the host/Flatpak PipeWire library. Android playback uses CPAL's AAudio backend and requires API 26 or newer. iOS simulator playback uses CPAL's CoreAudio output backend.

### signalsmith-stretch

- **License:** MIT
- **Source:** <https://github.com/colinmarc/signalsmith-stretch-rs>
- **Notes:** Used by the shared native macOS, Linux, Android, and iOS simulator playback engine. iOS playback is limited to 1.0x speed. Its resolved Rust transitive stack is permissively licensed.

### Symphonia

- **License:** MPL-2.0
- **Source:** <https://github.com/pdeljanov/Symphonia>
- **Notes:** Used by the native macOS, Linux, and Android playback engine and by Android durable-artifact validation. The iOS simulator startup smoke decodes a generated WAV, while product playback uses the strict WAV decoder without a Symphonia fallback. FFmpeg conversion remains separate from realtime playback and is not included on iOS.

### ndk-context

- **License:** Apache-2.0 / MIT (dual)
- **Source:** <https://github.com/rust-windowing/android-ndk-rs>
- **Notes:** Version 0.1.1 is used by the Android shell to initialize the process Android VM and activity context expected by CPAL before opening its AAudio output stream.

### rusqlite / SQLite

- **License:** MIT for rusqlite; SQLite is public domain
- **Source:** <https://github.com/rusqlite/rusqlite> and <https://sqlite.org/>
- **Notes:** Used by the embedded Android and iOS simulator backends for durable app-private persistence. The iOS simulator startup smoke also exercises an in-memory database. Desktop persistence remains in the Python backend.

### rustls

- **License:** Apache-2.0 OR ISC OR MIT
- **Source:** <https://github.com/rustls/rustls>
- **Notes:** The iOS target explicitly installs the already-resolved ring crypto provider before Tauri initializes its existing Rustls-based networking stack. This keeps startup deterministic and does not add an iOS transport feature.

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
- **Notes:** Android builds prepare checksum-pinned `whisper-rs-sys` 0.15.0 source in isolated build storage and apply the maintained DTW/Vulkan patch. Local lyrics use the full upstream `large-v3-turbo` GGML artifact at immutable revision `98aa99a0a9db05ae2342309f5096248665f7cba3`, expected size 1,624,555,275 bytes and SHA-256 `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`. Default packages do not redistribute these weights; the app downloads and verifies them on first use.

### Khronos Vulkan-Headers 1.4.357.0

- **License:** Apache-2.0
- **Source:** <https://github.com/KhronosGroup/Vulkan-Headers/tree/vulkan-sdk-1.4.357.0>
- **Notes:** Checksum-pinned build input for Android whisper.cpp Vulkan compilation. The source archive SHA-256 is `e87dce08116151f6b6d7de6b6faf41498e87e6cf848ff16fa3bd5402190ad4a3`; shader compilation requires the `glslc` shipped by Android NDK `29.0.14206865`, and runtime loading uses Android's system Vulkan loader.

### zlib

- **License:** zlib License
- **Source:** <https://zlib.net/>
- **Notes:** Android whisper.cpp links the platform `libz` supplied by Android. It computes the same UTF-8 repetition ratio used by the pinned desktop Whisper decode fallback. APK validation verifies the emitted system-library dependency; TuneForge does not redistribute zlib.

### qrcode.react

- **License:** ISC
- **Source:** <https://github.com/zpao/qrcode.react>
- **Notes:** Used to render pairing QR codes. The package license also notes bundled QR Code Generator code under MIT terms.

### React, Vite, TanStack Query, openapi-fetch, openapi-typescript, lucide-react

- See each project's own license. The installed JavaScript tree is primarily permissive, with some non-copyleft notice/data licenses such as MPL-2.0 (`lightningcss`), BlueOak-1.0.0 (`lru-cache` / `minimatch`), CC-BY-4.0 (`caniuse-lite` browser data), and CC0-1.0 (`mdn-data`).

### Android CPU Demucs runtime

- **Scope:** The Android arm64-v8a runtime ships in default optimized Test, debug Test, and signed release APKs.
- **Sources:** [demucs-infer](https://github.com/openmirlab/demucs-infer/tree/4b79d5c756ce298503d90b0cca2abbc76c565416), [Termux package recipes](https://github.com/termux/termux-packages). The runtime lock records each exact archive, recipe, source revision, and SHA-256, including the byte-identical mirror for zlib 1.3.2 and its matching historical recipe.
- **Components:** CPython 3.14.10 (PSF/CNRI/CWI notices), PyTorch 2.15.0 and NumPy 2.5.4 (BSD and bundled third-party notices), owned rebuilt OpenBLAS 0.3.34 (BSD-3-Clause, Android ARM64 LP64 pthread capacity 4/effective 1), protobuf (BSD/MIT), Abseil (Apache-2.0), Android compatibility libraries (MIT/BSD/Apache), libffi (MIT), libc++ (LLVM/NCSA), zlib, and the locked permissive Python modules. Preserve all upstream combined-license notices; metadata alone is not a complete grant audit.
- **Curation:** Omit GPL readline/history/gdbm code and dependent Python extensions; omit optional lzma/zstd consumers, package managers, CLI tools, development headers and test code. Torch's GPL Valgrind headers are omitted with the development headers. The import-required internal `torch_shm_manager` is retained with Torch's BSD notices; this single-process eager worker does not launch it. `tqdm` has MPL-2.0/MIT contributions and is omitted; the guarded Demucs adaptation rejects progress bars while keeping numerical inference unchanged. Legacy Demucs pickle/network/audio loaders are omitted; a fixed-hash strict safetensors loader constructs the only supported model.
- **Grant review:** Retain PSF/CNRI history that mentions GPL compatibility; it does not make Python GPL. Elect the explicit PSF option for `urllib.robotparser`. Torch's retained OpenMP/NVTX notices are Apache-2.0 with LLVM exceptions; their GPLv2 compatibility exception is not a GPL license grant. Exact reviewed notice-content hashes and explanations remain in the lock. Preserve notices for optional upstream components even when CUDA/other features were disabled in the pinned recipe.
- **Evidence:** Packaging verifies the signed APK's nested runtime against an independently captured source-build receipt. It checks AArch64 ELF closure and alignment, checked-out worker and lock identity, and retained notices. Review the pinned recipes and preserved `licenses/runtime-audit.json` for statically embedded upstream components. The owned FFmpeg/LAME and libsoxr components have separate evidence.
- **OpenBLAS:** The producer verifies the official source SHA-256 `cd7e129868320cc2d033afa920e31202dfe0b8066a5b66661900ccc0f197dfed`, rebuilds with the selected NDK/CMake toolchain, and verifies the BSD notice. The APK retains the producer recipe and actual toolchain, configure flags and emitted library SHA-256 in `licenses/openblas/`. The worker checks that identity and uses CPU Torch 4/inter-op 1 with effective pthread OpenBLAS 1.
- **Weights:** Ordinary APKs download the exact `htdemucs_6s` checkpoint on first use from the pinned author's revision in `packaging/demucs/models.json`. The explicit `--model-bundle` option embeds the same verified checkpoint under the existing model-weight distribution policy.

## Generating a Full Inventory

The lists above cover the dependencies and model assets that materially shape the user experience. Before release, refresh a machine-readable inventory from the locked dependency set and reconcile policy changes back into this file. The default desktop package inventory includes the Advanced Chords and Advanced Beat Analysis dependency stacks and excludes `--model-bundle` sources; opt-out, legacy NVIDIA, and model-bundled builds need separate inventory notes.

- Repeatable release checklist: `pnpm release:license-inventory` (add `-- --check` to verify required CLIs, or `-- --json` for structured output)
- JavaScript / TypeScript: `pnpm licenses list --recursive`
- Rust: `cargo about generate --format json --locked` (run inside `apps/desktop/src-tauri`)
- Python: `uv tree --python 3.14 --locked --all-groups` plus each package's metadata

If you spot a missing or incorrect attribution, please open a pull request.
