#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: run-backend-module.sh <module> [args...]" >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="${repo_root}/apps/backend"
marker_file="${backend_dir}/.venv/.tuneforge-legacy-nvidia"
module="$1"
shift

cd "${backend_dir}"

if [[ -f "${marker_file}" ]]; then
  if [[ ! -x .venv/bin/python ]]; then
    echo "Backend virtualenv not found. Run 'uv sync --python 3.11 --all-groups' first." >&2
    exit 1
  fi
  exec .venv/bin/python -m "${module}" "$@"
fi

exec uv run --python 3.11 python -m "${module}" "$@"
