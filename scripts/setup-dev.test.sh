#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_root="${TMPDIR:-/tmp}"
fixture="$(mktemp -d "${tmp_root%/}/tuneforge-setup-dev-test.XXXXXX")"
trap 'rm -rf "${fixture}"' EXIT

mkdir -p \
  "${fixture}/apps/backend/.venv/bin" \
  "${fixture}/bin" \
  "${fixture}/scripts"

cp "${repo_root}/scripts/setup-dev.sh" "${fixture}/scripts/setup-dev.sh"
cp "${repo_root}/scripts/sync-backend-default.sh" "${fixture}/scripts/sync-backend-default.sh"

cat > "${fixture}/scripts/configure-tauri-build-env.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF

cat > "${fixture}/bin/uv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${SETUP_DEV_TEST_UV_CALLED:-}" ]]; then
  : > "${SETUP_DEV_TEST_UV_CALLED}"
fi
if [[ "$1" != "sync" ]]; then
  echo "unexpected uv command: $*" >&2
  exit 1
fi
if [[ -n "${SYNC_BACKEND_TEST_UV_ARGS:-}" ]]; then
  printf '%s\n' "$@" > "${SYNC_BACKEND_TEST_UV_ARGS}"
  mkdir -p .venv/bin
  cat > .venv/bin/python <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
: "${SYNC_BACKEND_TEST_PYTHON_ARGS:?}"
printf '%s\n' "$@" > "${SYNC_BACKEND_TEST_PYTHON_ARGS}"
PYTHON
  chmod +x .venv/bin/python
fi
EOF

cat > "${fixture}/bin/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  -s)
    printf '%s\n' Linux
    ;;
  -m)
    printf '%s\n' x86_64
    ;;
  *)
    echo "unexpected uname arguments: $*" >&2
    exit 1
    ;;
esac
EOF

cat > "${fixture}/apps/backend/.venv/bin/python" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${SETUP_DEV_TEST_PYTHON_ARGS:?}"
printf '%s\n' "$@" > "${SETUP_DEV_TEST_PYTHON_ARGS}"
EOF

chmod +x \
  "${fixture}/bin/uname" \
  "${fixture}/bin/uv" \
  "${fixture}/apps/backend/.venv/bin/python"

python_args_file="${fixture}/python-args"

run_setup_dev() {
  local label="$1"
  shift
  local output_file="${fixture}/setup-output-${label}"

  : > "${python_args_file}"
  if ! PATH="${fixture}/bin:${PATH}" \
    SETUP_DEV_TEST_PYTHON_ARGS="${python_args_file}" \
    /bin/bash "${fixture}/scripts/setup-dev.sh" \
      --skip-contracts \
      --skip-playwright-browsers \
      --skip-pnpm-install \
      "$@" > "${output_file}" 2>&1; then
    cat "${output_file}" >&2
    exit 1
  fi
}

assert_python_args() {
  local label="$1"
  shift
  local expected_args_file="${fixture}/expected-python-args-${label}"

  printf '%s\n' "$@" > "${expected_args_file}"

  if ! cmp -s "${expected_args_file}" "${python_args_file}"; then
    echo "unexpected prewarm_models args for ${label}" >&2
    diff -u "${expected_args_file}" "${python_args_file}" >&2 || true
    exit 1
  fi
}

run_setup_dev "default"
assert_python_args "default" \
  -m \
  app.cli.prewarm_models \
  --include-crema \
  --include-beat-this \
  --include-lv-chordia

run_setup_dev "opt-out" --no-crema --no-beat-this --no-lv-chordia
assert_python_args "opt-out" \
  -m \
  app.cli.prewarm_models

legacy_output_file="${fixture}/setup-output-legacy-lv"
legacy_uv_called_file="${fixture}/legacy-uv-called"
if PATH="${fixture}/bin:${PATH}" \
  SETUP_DEV_TEST_UV_CALLED="${legacy_uv_called_file}" \
  /bin/bash "${fixture}/scripts/setup-dev.sh" \
    --legacy-nvidia \
    --skip-contracts \
    --skip-playwright-browsers \
    --skip-pnpm-install > "${legacy_output_file}" 2>&1; then
  echo "expected legacy NVIDIA with default LV Chordia to fail" >&2
  exit 1
fi
grep -F -- \
  "--legacy-nvidia requires --no-lv-chordia because LV Chordia is audited only with Torch 2.11.0." \
  "${legacy_output_file}"
if [[ -e "${legacy_uv_called_file}" ]]; then
  echo "legacy NVIDIA compatibility rejection invoked uv" >&2
  exit 1
fi

sync_uv_args_file="${fixture}/sync-uv-args"
sync_python_args_file="${fixture}/sync-python-args"

run_sync_backend() {
  local label="$1"
  shift
  local output_file="${fixture}/sync-output-${label}"

  : > "${sync_uv_args_file}"
  : > "${sync_python_args_file}"
  if ! PATH="${fixture}/bin:${PATH}" \
    SYNC_BACKEND_TEST_UV_ARGS="${sync_uv_args_file}" \
    SYNC_BACKEND_TEST_PYTHON_ARGS="${sync_python_args_file}" \
    /bin/bash "${fixture}/scripts/sync-backend-default.sh" \
      --no-crema \
      --no-beat-this \
      "$@" > "${output_file}" 2>&1; then
    cat "${output_file}" >&2
    exit 1
  fi
}

run_sync_backend "default"
printf '%s\n' sync --python 3.11 --all-groups --extra lv-chordia > "${fixture}/expected-sync-uv-args"
cmp "${fixture}/expected-sync-uv-args" "${sync_uv_args_file}"
printf '%s\n' \
  -m \
  app.cli.prewarm_models \
  --skip-demucs \
  --skip-whisper \
  --include-lv-chordia > "${fixture}/expected-sync-python-args"
cmp "${fixture}/expected-sync-python-args" "${sync_python_args_file}"

run_sync_backend "opt-out" --no-lv-chordia
printf '%s\n' sync --python 3.11 --all-groups > "${fixture}/expected-sync-opt-out-uv-args"
cmp "${fixture}/expected-sync-opt-out-uv-args" "${sync_uv_args_file}"
if [[ -s "${sync_python_args_file}" ]]; then
  echo "unexpected LV Chordia prewarm for sync opt-out" >&2
  exit 1
fi

echo "setup-dev and sync-backend prewarm arg tests passed"
