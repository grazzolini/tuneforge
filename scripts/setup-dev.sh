#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm setup:dev [options]

Runs the standard developer setup:
  pnpm install
  uv sync --python 3.11 --all-groups
  pnpm contracts:generate

Options:
  --advanced-chords, --crema  Install the optional crema/TensorFlow chord backend.
  --legacy-nvidia             Use the Linux x86_64 legacy NVIDIA Torch profile.
  --skip-pnpm-install         Skip workspace dependency installation.
  --skip-contracts            Skip OpenAPI contract generation.
  -h, --help                  Show this help.
EOF
}

advanced_chords=0
legacy_nvidia=0
skip_pnpm_install=0
skip_contracts=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --advanced-chords | --crema)
      advanced_chords=1
      ;;
    --legacy-nvidia)
      legacy_nvidia=1
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

cd "${repo_root}"

if [[ "${skip_pnpm_install}" -eq 0 ]]; then
  echo "Installing workspace dependencies..."
  pnpm install
fi

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

  touch "${marker_file}"
else
  rm -f "${marker_file}"
fi

if [[ "${skip_contracts}" -eq 0 ]]; then
  cd "${repo_root}"
  echo "Generating shared API contracts..."
  pnpm contracts:generate
fi

echo "Setup complete."
