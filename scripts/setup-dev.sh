#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm setup:dev [options]

Runs the standard developer setup:
  pnpm install
  pnpm --filter @tuneforge/desktop exec playwright install chromium
  uv sync --python 3.11 --all-groups
  pnpm contracts:generate
  pnpm models:demucs:prepare

Options:
  --advanced-chords, --crema  Install the optional crema/TensorFlow chord backend.
  --advanced-beats, --beat-this
                              Install the optional beat-this backend and preload small0.
  --legacy-nvidia             Use the Linux x86_64 legacy NVIDIA Torch profile.
  --skip-demucs-models        Skip preparing the local pinned Demucs model repo.
  --skip-playwright-browsers  Skip installing Playwright's Chromium browser.
  --skip-pnpm-install         Skip workspace dependency installation.
  --skip-contracts            Skip OpenAPI contract generation.
  -h, --help                  Show this help.
EOF
}

advanced_chords=0
advanced_beats=0
legacy_nvidia=0
skip_demucs_models=0
skip_playwright_browsers=0
skip_pnpm_install=0
skip_contracts=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --advanced-chords | --crema)
      advanced_chords=1
      ;;
    --advanced-beats | --beat-this)
      advanced_beats=1
      ;;
    --legacy-nvidia)
      legacy_nvidia=1
      ;;
    --skip-demucs-models)
      skip_demucs_models=1
      ;;
    --skip-playwright-browsers)
      skip_playwright_browsers=1
      ;;
    --skip-pnpm-install)
      skip_pnpm_install=1
      ;;
    --skip-contracts)
      skip_contracts=1
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

if [[ "${legacy_nvidia}" -eq 1 ]]; then
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Legacy NVIDIA backend profile is only supported on Linux." >&2
    exit 1
  fi

  if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "Legacy NVIDIA backend profile is only supported on Linux x86_64." >&2
    exit 1
  fi
fi

backend_sync_args=(sync --python 3.11 --all-groups)
if [[ "${advanced_chords}" -eq 1 ]]; then
  backend_sync_args+=(--extra advanced-chords)
fi
if [[ "${advanced_beats}" -eq 1 ]]; then
  backend_sync_args+=(--extra advanced-beats)
fi

cd "${repo_root}"

if [[ "${skip_pnpm_install}" -eq 0 ]]; then
  echo "Installing workspace dependencies..."
  pnpm install
fi

if [[ "${skip_playwright_browsers}" -eq 0 ]]; then
  echo "Installing Playwright Chromium browser..."
  pnpm --filter @tuneforge/desktop exec playwright install chromium
fi

echo "Checking Tauri build dependencies..."
source "${repo_root}/scripts/configure-tauri-build-env.sh"

cd "${backend_dir}"

if [[ "${legacy_nvidia}" -eq 1 ]]; then
  echo "Recreating backend environment with legacy NVIDIA profile..."
  rm -rf .venv
elif [[ -f "${marker_file}" ]]; then
  echo "Resetting backend environment from legacy NVIDIA profile..."
  rm -rf .venv
fi

echo "Syncing backend dependencies..."
uv "${backend_sync_args[@]}"

if [[ "${legacy_nvidia}" -eq 1 ]]; then
  echo "Installing legacy NVIDIA Torch wheels..."
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
else
  rm -f "${marker_file}"
fi

if [[ "${advanced_beats}" -eq 1 ]]; then
  echo "Preloading beat-this small0 checkpoint..."
  .venv/bin/python - <<'PY'
from beat_this.inference import File2Beats

File2Beats(checkpoint_path="small0", device="cpu", dbn=False)
print("Preloaded beat-this small0 checkpoint.")
PY
fi

if [[ "${skip_contracts}" -eq 0 ]]; then
  cd "${repo_root}"
  echo "Generating shared API contracts..."
  pnpm contracts:generate
fi

if [[ "${skip_demucs_models}" -eq 0 ]]; then
  cd "${repo_root}"
  echo "Preparing local Demucs model repo..."
  pnpm models:demucs:prepare
fi

echo "Setup complete."
