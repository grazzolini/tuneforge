# TuneForge CI image

`ghcr.io/grazzolini/tuneforge-ci` contains the stable Linux system layer used by
TuneForge's AMD64 GitHub Actions jobs. It is CI infrastructure only. TuneForge
release artifacts continue to require host-installed FFmpeg and do not copy
anything from this image.

## Contents and provenance

- Base: Ubuntu 24.04, pinned in `Dockerfile` to a Linux AMD64 manifest digest.
- FFmpeg: Ubuntu Noble `ffmpeg=7:6.1.1-3ubuntu5` from the official Ubuntu
  archive. The downloaded package SHA-256 is
  `1a23baace5f2688a47e28119aedae6993cd638e6279a7227dfc52d9a337a1c17`.
- FFmpeg binaries: the build fails unless `/usr/bin/ffmpeg` and
  `/usr/bin/ffprobe` match the SHA-256 values pinned in `Dockerfile`.
- Playwright: Ubuntu 24.04 Chromium system dependencies reviewed against
  Playwright `1.62.1`. Chromium itself remains a job-time download.
- Tauri: the GTK, WebKitGTK, ALSA, AppIndicator, SVG, XDo, and OpenSSL
  development packages previously installed by the CI workflow.
- CI utilities: only tools needed by setup actions and native builds. No source
  tree, dependency directory, build output, model, user data, or credential is
  included.

Each image records evidence under `/usr/share/tuneforge-ci/`:

- `base-image.txt`
- `packages.txt`
- `ffmpeg-source.txt`
- `ffmpeg.sha256`
- `ffmpeg-version.txt`
- `ffmpeg-buildconf.txt`
- `playwright-version.txt`
- `codec-validation.jsonl`

The build generates a synthetic one-second sine wave and proves PCM/WAV, FLAC,
`libmp3lame` MP3 at 192 kbps, and AAC-LC/M4A at 192 kbps. No user or copyrighted
audio enters the image.

## Licensing

Ubuntu packages retain their upstream and distribution licenses. The Noble
FFmpeg build enables GPL components and is GPL-2.0-or-later; its installed
copyright file is `/usr/share/doc/ffmpeg/copyright`. The OCI license label uses
`LicenseRef-TuneForge-CI-Image` because the aggregate image has multiple package
licenses. The package inventory and installed copyright files are the detailed
license record.

This GPL-bearing CI tool is not linked into, copied into, or distributed with
TuneForge application artifacts. `THIRD_PARTY_NOTICES.md` continues to describe
the application's host-installed FFmpeg boundary.

## Refresh and promotion

1. Let Docker Dependabot update the Ubuntu digest, or update it from the
   official `ubuntu:24.04` Linux AMD64 manifest.
2. When Playwright changes in `apps/desktop/package.json` and `pnpm-lock.yaml`,
   review its Ubuntu 24.04 Chromium dependency list. Update both the packages in
   `Dockerfile` and `PLAYWRIGHT_VERSION`; the policy check rejects version drift.
3. For an FFmpeg update, verify the official package checksum, extract the AMD64
   package, update both binary hashes, then perform two clean builds:

   ```sh
   docker buildx build --no-cache --platform linux/amd64 --load \
     --tag tuneforge-ci:check-1 .github/ci
   docker buildx build --no-cache --platform linux/amd64 --load \
     --tag tuneforge-ci:check-2 .github/ci
   docker run --rm tuneforge-ci:check-1 sha256sum /usr/bin/ffmpeg /usr/bin/ffprobe
   docker run --rm tuneforge-ci:check-2 sha256sum /usr/bin/ffmpeg /usr/bin/ffprobe
   ```

4. Merge the bootstrap change only with separate approval. Trusted `main`
   publication creates only
   `sha-<commit>-run-<run-id>-attempt-<attempt>` and prints its manifest digest,
   package evidence paths, SBOM, and provenance status in the job summary.
5. Review the build logs, inventory, licenses, codec evidence, SBOM, provenance,
   tag, and digest. The first GHCR package is private; changing it to public is a
   separate authorized GitHub operation.
6. Verify repository linkage and an anonymous Linux AMD64 pull by digest.
7. Promote that exact digest through a second normal PR. Never consume a moving
   tag, delete a referenced image version, or migrate CI before publication and
   public-pull proof succeed.
