#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm sync:backend:legacy-nvidia [options]

Recreates the backend environment with the Linux x86_64 legacy NVIDIA Torch profile.

Options:
  --advanced-chords, --crema, --advanced-chords-onnx, --crema-onnx
                              Include the Crema ONNX Runtime chord backend (default).
  --no-advanced-chords, --no-crema, --no-advanced-chords-onnx, --no-crema-onnx
                              Skip the Crema ONNX Runtime chord backend.
  --advanced-beats, --beat-this
                              Include the default beat-this backend.
  --no-advanced-beats, --no-beat-this
                              Skip the beat-this backend.
  --lv-chordia               Include LV Chordia and verify bundled checkpoints (default).
  --no-lv-chordia            Skip LV Chordia and its bundled checkpoints.
  -h, --help                  Show this help.
EOF
}

advanced_chords="onnx"
advanced_chords_selected=""
advanced_beats=1
lv_chordia=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --advanced-chords | --crema | --advanced-chords-onnx | --crema-onnx)
      selection="onnx"
      ;;
    --no-advanced-chords | --no-crema | --no-advanced-chords-onnx | --no-crema-onnx)
      selection="none"
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
  if [[ -n "${selection:-}" ]]; then
    if [[ -n "${advanced_chords_selected}" && "${advanced_chords_selected}" != "${selection}" ]]; then
      echo "Conflicting Advanced Chords selectors were provided." >&2
      exit 2
    fi
    advanced_chords="${selection}"
    advanced_chords_selected="${selection}"
    unset selection
  fi
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

backend_sync_args=(sync --python 3.14 --all-groups)
if [[ "${advanced_chords}" == "onnx" ]]; then
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
uv pip install \
  --python .venv/bin/python \
  --torch-backend cu126 \
  --reinstall-package torch \
  --reinstall-package torchaudio \
  "torch==2.13.0" \
  "torchaudio==2.11.0"

.venv/bin/python - <<'PY'
import sys

import torch
import torchaudio

expected_torch = "2.13.0+cu126"
expected_torchaudio = "2.11.0+cu126"
if torch.__version__ != expected_torch:
    raise SystemExit(f"Expected torch {expected_torch} for the legacy NVIDIA profile, found {torch.__version__}.")
if torchaudio.__version__ != expected_torchaudio:
    raise SystemExit(
        f"Expected torchaudio {expected_torchaudio} for the legacy NVIDIA profile, found {torchaudio.__version__}."
    )
if torch.version.cuda != "12.6":
    raise SystemExit(f"Expected CUDA 12.6 for the legacy NVIDIA profile, found {torch.version.cuda}.")
sys.stdout.write(
    f"Verified legacy NVIDIA Torch profile: torch {torch.__version__}, "
    f"torchaudio {torchaudio.__version__}, CUDA {torch.version.cuda}\n"
)
PY

touch "${marker_file}"

if [[ "${lv_chordia}" -eq 1 ]]; then
  .venv/bin/python -m app.cli.prewarm_models \
    --skip-demucs \
    --skip-whisper \
    --include-lv-chordia
fi
