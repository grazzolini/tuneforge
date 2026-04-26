# Third-Party Notices

Tuneforge is distributed under the [MIT License](./LICENSE). It depends on third-party software with its own licensing terms. Significant runtime and build dependencies are listed below. This is not exhaustive — refer to each project's own license file for the authoritative text.

## Runtime Dependencies (bundled or required)

### Demucs

- **License:** MIT
- **Source:** <https://github.com/facebookresearch/demucs>
- **Notes:** Used for source separation. Installed via `pip` as a normal Python dependency.

### htdemucs / htdemucs_ft model weights

- **License:** MIT
- **Source:** <https://github.com/facebookresearch/demucs>
- **Notes:** Pretrained weights are downloaded by Demucs at runtime into the local Torch cache on first use. Tuneforge does not redistribute them.

### PyTorch

- **License:** BSD-3-Clause
- **Source:** <https://github.com/pytorch/pytorch>

### librosa

- **License:** ISC
- **Source:** <https://github.com/librosa/librosa>

### crema (optional Advanced Chords backend)

- **License:** PyPI metadata lists ISC; upstream `LICENSE.md` currently contains BSD-2-Clause terms.
- **Source:** <https://github.com/bmcfee/crema>
- **Notes:** Optional desktop-only experimental chord-recognition backend. It is not installed by default, not required for normal app startup, and not part of the mobile build path. Primary transitive licenses checked for the optional stack include TensorFlow (Apache-2.0), Keras (Apache-2.0), and JAMS (ISC); review the full resolved dependency tree before bundling this optional backend into a packaged desktop app.

### FastAPI, Pydantic, SQLAlchemy, Alembic, Uvicorn, soundfile

- See each project's own license. All are permissively licensed (MIT / BSD / Apache-2.0 family).

### FFmpeg / ffprobe

- **License:** LGPL-2.1+ or GPL-2.0+ depending on the build
- **Source:** <https://ffmpeg.org/>
- **Notes:** **Tuneforge does not bundle FFmpeg.** It must be installed separately by the user (for example via Homebrew, apt, or winget) and discoverable on `PATH`. Users are responsible for the licensing terms of the FFmpeg build they install.

## Desktop Shell

### Tauri

- **License:** Apache-2.0 / MIT (dual)
- **Source:** <https://github.com/tauri-apps/tauri>

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
- **Notes:** Used by the embedded Android backend for debug side-loaded local lyrics transcription. Tuneforge does not redistribute Whisper model weights in this MVP.

### React, Vite, TanStack Query, openapi-fetch, openapi-typescript

- See each project's own license. All are permissively licensed.

## Generating a Full Inventory

The lists above cover the dependencies that materially shape the user experience. For a complete machine-readable inventory:

- JavaScript / TypeScript: `pnpm licenses list --recursive`
- Rust: `cargo license` (run inside `apps/desktop/src-tauri`)
- Python: `uv pip list` combined with each package's metadata

If you spot a missing or incorrect attribution, please open a pull request.
