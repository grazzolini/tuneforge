#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm sync:backend:default [options]

Recreates the backend environment with the default locked dependency set.

Options:
  --advanced-chords, --crema  Include the default crema/TensorFlow chord backend.
  --no-advanced-chords, --no-crema
                              Skip the crema/TensorFlow chord backend.
  --advanced-beats, --beat-this
                              Include the default beat-this backend.
  --no-advanced-beats, --no-beat-this
                              Skip the beat-this backend.
  --lv-chordia               Include LV Chordia and verify bundled checkpoints (default).
  --no-lv-chordia            Skip LV Chordia and its bundled checkpoints.
  -h, --help                  Show this help.
EOF
}

advanced_chords=1
advanced_beats=1
lv_chordia=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --advanced-chords | --crema)
      advanced_chords=1
      ;;
    --no-advanced-chords | --no-crema)
      advanced_chords=0
      ;;
    --advanced-beats | --beat-this)
      advanced_beats=1
      ;;
    --no-advanced-beats | --no-beat-this)
      advanced_beats=0
      ;;
    --lv-chordia)
      lv_chordia=1
      ;;
    --no-lv-chordia)
      lv_chordia=0
      ;;
    --)
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="${repo_root}/apps/backend"
marker_file="${backend_dir}/.venv/.tuneforge-legacy-nvidia"

cd "${backend_dir}"
backend_sync_args=(sync --python 3.11 --all-groups)
if [[ "${advanced_chords}" -eq 1 ]]; then
  backend_sync_args+=(--extra advanced-chords)
fi
if [[ "${advanced_beats}" -eq 1 ]]; then
  backend_sync_args+=(--extra advanced-beats)
fi
if [[ "${lv_chordia}" -eq 1 ]]; then
  backend_sync_args+=(--extra lv-chordia)
fi

rm -rf .venv
uv "${backend_sync_args[@]}"
if [[ "${lv_chordia}" -eq 1 ]]; then
  .venv/bin/python -m app.cli.prewarm_models \
    --skip-demucs \
    --skip-whisper \
    --include-lv-chordia
fi
rm -f "${marker_file}"
