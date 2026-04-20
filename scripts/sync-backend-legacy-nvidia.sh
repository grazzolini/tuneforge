#!/usr/bin/env bash
set -euo pipefail

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
rm -rf .venv
uv sync --python 3.11 --all-groups
uv pip install \
  --python .venv/bin/python \
  --torch-backend cu126 \
  --reinstall-package torch \
  --reinstall-package torchaudio \
  "torch==2.6.0" \
  "torchaudio==2.6.0"

touch "${marker_file}"
