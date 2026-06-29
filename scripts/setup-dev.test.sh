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

cat > "${fixture}/scripts/configure-tauri-build-env.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF

cat > "${fixture}/bin/uv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "sync" ]]; then
  echo "unexpected uv command: $*" >&2
  exit 1
fi
EOF

cat > "${fixture}/apps/backend/.venv/bin/python" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${SETUP_DEV_TEST_PYTHON_ARGS:?}"
printf '%s\n' "$@" > "${SETUP_DEV_TEST_PYTHON_ARGS}"
EOF

chmod +x \
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
  --include-beat-this

run_setup_dev "opt-out" --no-crema --no-beat-this
assert_python_args "opt-out" \
  -m \
  app.cli.prewarm_models

echo "setup-dev prewarm arg tests passed"
