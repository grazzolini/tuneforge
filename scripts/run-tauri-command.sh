#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
desktop_dir="${repo_root}/apps/desktop"

source "${repo_root}/scripts/configure-tauri-build-env.sh"

cd "${desktop_dir}"
exec pnpm exec tauri "$@"
