#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm sync:backend:legacy-nvidia [options]

Recreates the backend environment with the Linux x86_64 legacy NVIDIA Torch profile.

Options:
  --advanced-chords, --crema  Include the default crema/TensorFlow chord backend.
  --no-advanced-chords, --no-crema
                              Skip the crema/TensorFlow chord backend.
  --advanced-beats, --beat-this
                              Include the default beat-this backend.
  --no-advanced-beats, --no-beat-this
                              Skip the beat-this backend.
  -h, --help                  Show this help.
EOF
}

advanced_chords=1
advanced_beats=1

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

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Legacy NVIDIA backend profile is only supported on Linux." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Legacy NVIDIA backend profile is only supported on Linux x86_64." >&2
  exit 1
fi

cd "${backend_dir}"

# Start from the standard locked backend environment, then locally override
# torch/torchaudio with the older CUDA 12.6 wheels for legacy NVIDIA cards.
backend_sync_args=(sync --python 3.11 --all-groups)
if [[ "${advanced_chords}" -eq 1 ]]; then
  backend_sync_args+=(--extra advanced-chords)
fi
if [[ "${advanced_beats}" -eq 1 ]]; then
  backend_sync_args+=(--extra advanced-beats)
fi

rm -rf .venv
uv "${backend_sync_args[@]}"
uv pip install \
  --python .venv/bin/python \
  --torch-backend cu126 \
  --reinstall-package torch \
  --reinstall-package torchaudio \
  "torch==2.6.0" \
  "torchaudio==2.6.0"

.venv/bin/python - <<'PY'
import sys

import torch

if not torch.__version__.startswith("2.6.0"):
    raise SystemExit(f"Expected torch 2.6.0 for the legacy NVIDIA profile, found {torch.__version__}.")

if torch.version.cuda != "12.6":
    raise SystemExit(f"Expected CUDA 12.6 for the legacy NVIDIA profile, found {torch.version.cuda}.")

sys.stdout.write(f"Verified legacy NVIDIA Torch profile: torch {torch.__version__}, CUDA {torch.version.cuda}\n")
PY

touch "${marker_file}"
