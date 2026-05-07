#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

total_start=${SECONDS}

printf '\n[tests] Starting desktop tests\n\n'
desktop_start=${SECONDS}
(
  cd "${repo_root}"
  pnpm --filter @tuneforge/desktop test --run
)
desktop_elapsed=$((SECONDS - desktop_start))
printf '\n[tests] Desktop tests finished in %ss\n' "${desktop_elapsed}"

printf '\n[tests] Starting Tauri shell tests\n\n'
tauri_start=${SECONDS}
(
  cd "${repo_root}/apps/desktop/src-tauri"
  source "${repo_root}/scripts/configure-tauri-build-env.sh"
  cargo test
)
tauri_elapsed=$((SECONDS - tauri_start))
printf '\n[tests] Tauri shell tests finished in %ss\n' "${tauri_elapsed}"

printf '\n[tests] Starting backend tests\n\n'
backend_start=${SECONDS}
(
  cd "${repo_root}"
  bash scripts/run-backend-module.sh pytest "$@"
)
backend_elapsed=$((SECONDS - backend_start))
printf '\n[tests] Backend tests finished in %ss\n' "${backend_elapsed}"

total_elapsed=$((SECONDS - total_start))
printf '[tests] Total test time %ss\n' "${total_elapsed}"
