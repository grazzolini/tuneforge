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
  verify model caches and preload/download only missing or invalid assets

Options:
  --advanced-chords, --crema  Include the default crema/TensorFlow chord backend.
  --no-advanced-chords, --no-crema
                              Skip the crema/TensorFlow chord backend.
  --advanced-beats, --beat-this
                              Include the default beat-this backend and verify/preload small0.
  --no-advanced-beats, --no-beat-this
                              Skip the beat-this backend and checkpoint verification/preload.
  --lv-chordia               Include LV Chordia and verify its bundled checkpoints (default).
  --no-lv-chordia            Skip LV Chordia and its bundled checkpoints.
  --legacy-nvidia             Use the Linux x86_64 legacy NVIDIA Torch profile.
  --skip-demucs-models        Skip Demucs model cache verification/preload.
  --skip-model-prewarm        Skip all model cache verification/preload work.
  --skip-playwright-browsers  Skip installing Playwright's Chromium browser.
  --skip-pnpm-install         Skip workspace dependency installation.
  --skip-contracts            Skip OpenAPI contract generation.
  -h, --help                  Show this help.
EOF
}

advanced_chords=1
advanced_beats=1
lv_chordia=1
legacy_nvidia=0
skip_demucs_models=0
skip_model_prewarm=0
skip_playwright_browsers=0
skip_pnpm_install=0
skip_contracts=0

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
    --legacy-nvidia)
      legacy_nvidia=1
      ;;
    --skip-demucs-models)
      skip_demucs_models=1
      ;;
    --skip-model-prewarm)
      skip_model_prewarm=1
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
if [[ "${lv_chordia}" -eq 1 ]]; then
  backend_sync_args+=(--extra lv-chordia)
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
    "torch==2.11.0" \
    "torchaudio==2.11.0"

  .venv/bin/python - <<'PY'
import sys

import torch
import torchaudio

expected_version = "2.11.0+cu126"
if torch.__version__ != expected_version:
    raise SystemExit(f"Expected torch {expected_version} for the legacy NVIDIA profile, found {torch.__version__}.")

if torchaudio.__version__ != expected_version:
    raise SystemExit(
        f"Expected torchaudio {expected_version} for the legacy NVIDIA profile, found {torchaudio.__version__}."
    )

if torch.version.cuda != "12.6":
    raise SystemExit(f"Expected CUDA 12.6 for the legacy NVIDIA profile, found {torch.version.cuda}.")

sys.stdout.write(
    f"Verified legacy NVIDIA Torch profile: torch {torch.__version__}, "
    f"torchaudio {torchaudio.__version__}, CUDA {torch.version.cuda}\n"
)
PY

  touch "${marker_file}"
else
  rm -f "${marker_file}"
fi

if [[ "${skip_contracts}" -eq 0 ]]; then
  cd "${repo_root}"
  echo "Generating shared API contracts..."
  pnpm contracts:generate
fi

if [[ "${skip_model_prewarm}" -eq 0 ]]; then
  cd "${backend_dir}"
  prewarm_args=()
  if [[ "${skip_demucs_models}" -eq 1 ]]; then
    prewarm_args+=(--skip-demucs)
  fi
  if [[ "${advanced_chords}" -eq 1 ]]; then
    prewarm_args+=(--include-crema)
  fi
  if [[ "${advanced_beats}" -eq 1 ]]; then
    prewarm_args+=(--include-beat-this)
  fi
  if [[ "${lv_chordia}" -eq 1 ]]; then
    prewarm_args+=(--include-lv-chordia)
  fi
  echo "Verifying model caches; preloading missing or invalid assets only..."
  if [[ "${#prewarm_args[@]}" -gt 0 ]]; then
    .venv/bin/python -m app.cli.prewarm_models "${prewarm_args[@]}"
  else
    .venv/bin/python -m app.cli.prewarm_models
  fi
fi

echo "Setup complete."
