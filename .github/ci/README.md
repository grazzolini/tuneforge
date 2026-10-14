# TuneForge CI image

`ghcr.io/grazzolini/tuneforge-ci` contains the stable Linux system layer used by
TuneForge's AMD64 GitHub Actions jobs. It is CI infrastructure only. TuneForge
release artifacts continue to require host-installed FFmpeg and do not copy
anything from this image.

## Mandatory image-impact preflight

Before assigning implementation, assess all planned paths:

```sh
pnpm ci:image:impact --paths scripts/build-soxr-runtime.mjs apps/backend/app/config.py
pnpm ci:image:impact --diff origin/main HEAD
pnpm ci:image:impact --working-tree origin/main
node scripts/ci-image-impact.mjs --check
```

Recheck scope additions before editing and actual changes before publication,
including uncommitted paths. The canonical machine-readable inventory is
[`image-inputs.json`](image-inputs.json): components declare inputs, upstream
source/pins, license, probes, and consumer jobs. Docker COPY/context, static local
imports, lock references and patch checksums are checked against it. Dynamic
filesystem reads and snapshot lists require a reviewed source checksum in
`readAuditSha256`; changed producer code fails with an actionable registration
request. This is an explicit code review boundary, not static proof of arbitrary
JavaScript behavior. New components must register transitive dependencies and
consider host-installed tools shadowing image binaries/libraries.

Reports distinguish producer, publishing-process, consumer-compatibility, and
no known image impact. Flatpak source/cache policy and the application-owned
LGPL FFmpeg builder have no current producer edge. CI FFmpeg is the separate
Ubuntu GPL package in Dockerfile. Package locks and job-time Node, Python, Rust,
pnpm, uv, and Chromium are compatibility inputs unless copied into the recipe.
If they expose missing image libraries, add the concrete Dockerfile producer edge.

Producer delivery order: producer PR and full final candidate validation,
merge, trusted main image publication, inventory/license/provenance review and
anonymous pull by digest, then separate consumer promotion. Publication-process
or compatibility changes need their corresponding review; they do not inherently
rebuild the image. A promoted record is consumer configuration, never a producer
input or publication trigger.

Image impact is one dependency view. Inspect every shared-helper caller separately
for non-image behavior and compatibility before assigning implementation.

The complete sorted producer manifest defines a recipe fingerprint. It is not
byte identity: unversioned APT dependencies can resolve differently between
builds. Every build records the actual transitive package inventory; registry
manifest digest and Docker config image ID retain their distinct meanings.

## Contents and provenance

- Base: Ubuntu 24.04, pinned in `Dockerfile` to a Linux AMD64 manifest digest.
- FFmpeg: Ubuntu Noble `ffmpeg=7:6.1.1-3ubuntu5` from the official Ubuntu
  archive. The downloaded package SHA-256 is pinned in `Dockerfile`.
- FFmpeg binaries: the build fails unless `/usr/bin/ffmpeg` and
  `/usr/bin/ffprobe` match the SHA-256 values pinned in `Dockerfile`.
- Playwright: Ubuntu 24.04 Chromium system dependencies reviewed against
  Playwright `1.62.1`. Chromium itself remains a job-time download.
- Tauri: the GTK, WebKitGTK, ALSA, PipeWire/SPA, AppIndicator, SVG, XDo, and OpenSSL
  development packages needed by native Rust checks, plus
  `libclang-dev` for Rust bindgen.
- SoXR: the repository-pinned Linux AMD64 `host-test` runtime under
  `/opt/tuneforge-ci/soxr/host-test`, built with PFFFT in a disposable stage.
  Node, CMake, and the SoXR compiler toolchain stay outside the final image.
- CI utilities: only tools needed by setup actions and native builds. No
  repository checkout, dependency directory, model, user data, or credential is
  included; SoXR corresponding sources are the documented exception.

Each image records evidence under `/usr/share/tuneforge-ci/`:

- `base-image.txt`
- `packages.txt`
- `ffmpeg-source.txt`
- `ffmpeg.sha256`
- `ffmpeg-version.txt`
- `ffmpeg-buildconf.txt`
- `playwright-version.txt`
- `codec-validation.jsonl`

SoXR records separate evidence under `/opt/tuneforge-ci/soxr/`:

- `build-tools.txt`
- `build-inputs.sha256`
- `payload.sha256`
- `host-test/provenance.json`
- Corresponding-source archive named in `host-test/provenance.json`.

The producer uses `scripts/build-soxr-runtime.mjs` and the neutral TAR serializer
in `scripts/deterministic-source-snapshot.mjs`. Corresponding sources include
the build inputs, pinned upstream archive, and rebuild instructions. Flatpak
source lists, epoch selection, and cache configuration are outside the image
inputs and publication paths.

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

## Candidate producer validation

The central [promoted record](./promoted-image.json) holds the immutable registry
manifest digest, producer fingerprint, source revision and platform. CI compares
the whole checkout fingerprint to that record on both PRs and main. Matching
recipes use the promoted image. A mismatch, including an unrelated PR during a
promotion gap, builds the full final candidate and forces all three image consumer
gates. The initial null fingerprint/revision explicitly requires candidates until
the first verified promotion; it does not invent evidence for the existing digest.

The hosted Ubuntu 24.04 candidate job builds the same final recipe and platform
without cache, registry login, package writes or publication. It exports a Docker
archive and metadata containing checkout SHA, producer fingerprint, archive SHA,
Docker config image ID and platform. Consumers download the exact artifact ID from
the same run, verify metadata and bytes, and bind Docker's loaded config ID to that
metadata. A config image ID is distinct from the registry manifest digest. Missing
or expired rerun artifacts, selector failures and identity failures fail closed.

All three consumers run on the host with the same
[Docker helper](../../scripts/ci-image-run.sh) as their absolute custom shell.
Actions, caches and artifact uploads remain on the host; installs, strict image
verification and native tests run in the selected container. The helper preserves
working directories, UID/GID, workspace, temporary outputs and GitHub command
files at identical absolute paths. It mounts only the selected action tool prefixes
and cache subtrees, with an isolated home and explicit environment. It never mounts
the runner's entire home, Docker socket or host system libraries. Node, Python,
Rust, pnpm and uv intentionally come from pinned setup actions; image probes must
detect accidental shadowing of native image tools such as FFmpeg. pnpm, uv and
Cargo cache keys include selected image and recipe identity. Cleanup and host
post-actions remain available after native failures.

The whole-recipe manifest verifier supplements the existing strict SoXR payload,
PFFFT and build-input checks and exact FFmpeg paths. Candidate validation does not
authorize registry publication, digest promotion or anonymous-pull approval.

## Refresh and promotion

1. Let Docker Dependabot update the Ubuntu digest, or update it from the
   official `ubuntu:24.04` Linux AMD64 manifest.
2. When Playwright changes in `apps/desktop/package.json` and `pnpm-lock.yaml`,
   review its Ubuntu 24.04 Chromium dependency list. Update both the packages in
   `Dockerfile` and `PLAYWRIGHT_VERSION`; the policy check rejects version drift.
3. Changes to the permanent SoXR runtime recipe, source lock, patch, and neutral
   helper rebuild the same shared image. Review `build-tools.txt`, both SHA-256
   manifests, provenance, licenses, corresponding sources, and the synthetic
   resampling check.
4. For an FFmpeg update, verify the official package checksum, extract the AMD64
   package, update both binary hashes, then perform two clean builds:

   ```sh
   docker buildx build --no-cache --platform linux/amd64 --load \
     --file .github/ci/Dockerfile --tag tuneforge-ci:check-1 .
   docker buildx build --no-cache --platform linux/amd64 --load \
     --file .github/ci/Dockerfile --tag tuneforge-ci:check-2 .
   docker run --rm tuneforge-ci:check-1 sha256sum /usr/bin/ffmpeg /usr/bin/ffprobe
   docker run --rm tuneforge-ci:check-2 sha256sum /usr/bin/ffmpeg /usr/bin/ffprobe
   ```

5. Merge producer changes in a dedicated PR. The trusted `main` publication
   workflow builds the image; do not dispatch a branch image. Keep the consumer
   digest unchanged until verification completes. Publication creates only
   `sha-<commit>-run-<run-id>-attempt-<attempt>` and prints its manifest digest,
   package evidence paths, SBOM, and provenance status in the job summary.
6. Verify the immutable digest and review build logs, inventory, licenses, codec
   evidence, SoXR payload and build-input manifests, corresponding sources,
   synthetic resampling, SBOM, and `mode=max` provenance. GHCR visibility changes
   remain a separate authorized GitHub operation.
7. Verify repository linkage and an anonymous Linux AMD64 pull by digest.
8. After those checks pass, promote the exact verified digest in a separate
   consumer PR by updating `promoted-image.json` with its digest, publication
   fingerprint, source revision and platform. Preserve the strict input verifier
   and Tauri SoXR configuration. Never consume a moving tag, delete a referenced
   image version, or promote before publication and anonymous-pull proof succeed.
