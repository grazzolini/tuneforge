#!/usr/bin/env bash
set -euo pipefail

: "${CI_IMAGE_REFERENCE:?CI_IMAGE_REFERENCE is required}"
: "${GITHUB_JOB:?GITHUB_JOB is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"

soxr_root="${TUNEFORGE_CI_SOXR_ROOT:-/opt/tuneforge-ci/soxr}"
soxr_runtime_root="${soxr_root}/host-test"

if [[ ! -f "${soxr_root}/payload.sha256" ]] ||
  [[ ! -f "${soxr_root}/build-inputs.sha256" ]] ||
  [[ ! -f "${soxr_runtime_root}/include/soxr.h" ]] ||
  [[ ! -e "${soxr_runtime_root}/lib/libsoxr.so" ]] ||
  [[ ! -f "${soxr_runtime_root}/provenance.json" ]]; then
  echo "CI image is missing the prebuilt SoXR payload. Publish and promote a current tuneforge-ci image." >&2
  exit 1
fi

if ! (cd "${soxr_root}" && sha256sum --check --strict --status payload.sha256); then
  echo "CI image SoXR payload failed integrity verification. Rebuild and promote tuneforge-ci." >&2
  exit 1
fi

if ! grep -Fq '"-DWITH_PFFFT=ON"' "${soxr_runtime_root}/provenance.json"; then
  echo "CI image SoXR payload does not use the required PFFFT profile." >&2
  exit 1
fi

if ! (cd "${GITHUB_WORKSPACE}" &&
  sha256sum --check --strict --status "${soxr_root}/build-inputs.sha256"); then
  echo "CI image SoXR build inputs do not match this checkout. Publish and promote a current tuneforge-ci image." >&2
  exit 1
fi

ffmpeg_path="$(command -v ffmpeg)"
ffprobe_path="$(command -v ffprobe)"
test "${ffmpeg_path}" = "${TUNEFORGE_CI_EXPECTED_FFMPEG_PATH:-/usr/bin/ffmpeg}"
test "${ffprobe_path}" = "${TUNEFORGE_CI_EXPECTED_FFPROBE_PATH:-/usr/bin/ffprobe}"

{
  printf '## %s CI image\n\n' "${GITHUB_JOB}"
  printf -- '- Image: `%s`\n' "${CI_IMAGE_REFERENCE}"
  printf -- '- FFmpeg: `%s` — `%s`\n' "${ffmpeg_path}" "$("${ffmpeg_path}" -version | sed -n '1p')"
  printf -- '- FFprobe: `%s` — `%s`\n' "${ffprobe_path}" "$("${ffprobe_path}" -version | sed -n '1p')"
  printf -- '- SoXR: `%s` — verified payload and build inputs\n' "${soxr_runtime_root}"
} >> "${GITHUB_STEP_SUMMARY}"
