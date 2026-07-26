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

printf '\n[tests] Starting sync validation harness tests\n\n'
sync_validation_start=${SECONDS}
(
  cd "${repo_root}"
  node --test scripts/sync-validation.test.mjs
)
sync_validation_elapsed=$((SECONDS - sync_validation_start))
printf '\n[tests] Sync validation harness tests finished in %ss\n' "${sync_validation_elapsed}"

printf '\n[tests] Starting Android release JNI validation tests\n\n'
android_jni_validation_start=${SECONDS}
(
  cd "${repo_root}"
  node --test scripts/validate-android-release-jni.test.mjs
)
android_jni_validation_elapsed=$((SECONDS - android_jni_validation_start))
printf '\n[tests] Android release JNI validation tests finished in %ss\n' "${android_jni_validation_elapsed}"

printf '\n[tests] Starting release license inventory tests\n\n'
release_license_start=${SECONDS}
(
  cd "${repo_root}"
  node --test scripts/release-license-inventory.test.mjs
)
release_license_elapsed=$((SECONDS - release_license_start))
printf '\n[tests] Release license inventory tests finished in %ss\n' "${release_license_elapsed}"

printf '\n[tests] Starting setup-dev script tests\n\n'
setup_dev_start=${SECONDS}
(
  cd "${repo_root}"
  bash scripts/setup-dev.test.sh
)
setup_dev_elapsed=$((SECONDS - setup_dev_start))
printf '\n[tests] setup-dev script tests finished in %ss\n' "${setup_dev_elapsed}"

printf '\n[tests] Starting Android toolchain helper tests\n\n'
android_env_start=${SECONDS}
(
  cd "${repo_root}"
  bash scripts/android-arm64-env.test.sh
)
android_env_elapsed=$((SECONDS - android_env_start))
printf '\n[tests] Android toolchain helper tests finished in %ss\n' "${android_env_elapsed}"

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
