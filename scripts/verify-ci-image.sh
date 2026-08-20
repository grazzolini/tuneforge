#!/usr/bin/env bash
set -euo pipefail

: "${CI_IMAGE_REFERENCE:?CI_IMAGE_REFERENCE is required}"
: "${GITHUB_JOB:?GITHUB_JOB is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"

ffmpeg_path="$(command -v ffmpeg)"
ffprobe_path="$(command -v ffprobe)"
test "${ffmpeg_path}" = /usr/bin/ffmpeg
test "${ffprobe_path}" = /usr/bin/ffprobe

{
  printf '## %s CI image\n\n' "${GITHUB_JOB}"
  printf -- '- Image: `%s`\n' "${CI_IMAGE_REFERENCE}"
  printf -- '- FFmpeg: `%s` — `%s`\n' "${ffmpeg_path}" "$(ffmpeg -version | sed -n '1p')"
  printf -- '- FFprobe: `%s` — `%s`\n' "${ffprobe_path}" "$(ffprobe -version | sed -n '1p')"
} >> "${GITHUB_STEP_SUMMARY}"
