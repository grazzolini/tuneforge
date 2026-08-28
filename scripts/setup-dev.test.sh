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
cp "${repo_root}/scripts/sync-backend-legacy-nvidia.sh" "${fixture}/scripts/sync-backend-legacy-nvidia.sh"

cat > "${fixture}/scripts/configure-tauri-build-env.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF

cat > "${fixture}/bin/uv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${SETUP_DEV_TEST_UV_ARGS:-}" ]]; then
  printf '%s\n' '[call]' "$@" >> "${SETUP_DEV_TEST_UV_ARGS}"
fi
if [[ "$1" == "sync" ]]; then
  if [[ -n "${SYNC_BACKEND_TEST_UV_ARGS:-}" ]]; then
    printf '%s\n' "$@" > "${SYNC_BACKEND_TEST_UV_ARGS}"
  fi
  mkdir -p .venv/bin
  cat > .venv/bin/python <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
python_args_file="${SETUP_DEV_TEST_PYTHON_ARGS:-${SYNC_BACKEND_TEST_PYTHON_ARGS:-}}"
: "${python_args_file:?}"
printf '%s\n' "$@" > "${python_args_file}"
if [[ "${1:-}" == "-" ]]; then
  /bin/cat > "${SETUP_DEV_TEST_PYTHON_STDIN:-/dev/null}"
fi
PYTHON
  chmod +x .venv/bin/python
elif [[ "$1" != "pip" || "${2:-}" != "install" ]]; then
  echo "unexpected uv command: $*" >&2
  exit 1
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
python_stdin_file="${fixture}/python-stdin"
setup_uv_args_file="${fixture}/setup-uv-args"

run_setup_dev() {
  local label="$1"
  shift
  local output_file="${fixture}/setup-output-${label}"

  : > "${python_args_file}"
  : > "${python_stdin_file}"
  : > "${setup_uv_args_file}"
  if ! PATH="${fixture}/bin:${PATH}" \
    SETUP_DEV_TEST_PYTHON_ARGS="${python_args_file}" \
    SETUP_DEV_TEST_PYTHON_STDIN="${python_stdin_file}" \
    SETUP_DEV_TEST_UV_ARGS="${setup_uv_args_file}" \
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

assert_legacy_version_verifier() {
  local label="$1"
  local fake_module_dir="${fixture}/fake-python-modules-${label}"
  local output_file="${fixture}/version-verifier-output-${label}"

  mkdir -p "${fake_module_dir}"
  cat > "${fake_module_dir}/torch.py" <<'PYTHON'
import os

__version__ = os.environ["FAKE_TORCH_VERSION"]


class _Version:
    cuda = os.environ["FAKE_TORCH_CUDA"]


version = _Version()
PYTHON
  cat > "${fake_module_dir}/torchaudio.py" <<'PYTHON'
import os

__version__ = os.environ["FAKE_TORCHAUDIO_VERSION"]
PYTHON

  if ! PYTHONPATH="${fake_module_dir}" \
    FAKE_TORCH_VERSION="2.13.0+cu126" \
    FAKE_TORCH_CUDA="12.6" \
    FAKE_TORCHAUDIO_VERSION="2.11.0+cu126" \
    python3 - < "${python_stdin_file}" > "${output_file}" 2>&1; then
    cat "${output_file}" >&2
    echo "${label} verifier rejected the matched legacy NVIDIA profile" >&2
    exit 1
  fi

  if PYTHONPATH="${fake_module_dir}" \
    FAKE_TORCH_VERSION="2.13.0+cu126" \
    FAKE_TORCH_CUDA="12.6" \
    FAKE_TORCHAUDIO_VERSION="2.6.0+cu126" \
    python3 - < "${python_stdin_file}" > "${output_file}" 2>&1; then
    echo "${label} verifier accepted mismatched torch and torchaudio versions" >&2
    exit 1
  fi
  grep -F \
    'Expected torchaudio 2.11.0+cu126 for the legacy NVIDIA profile, found 2.6.0+cu126.' \
    "${output_file}" > /dev/null
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

run_setup_dev "onnx" --crema-onnx
grep -Fx -- "advanced-chords" "${setup_uv_args_file}"
assert_python_args "onnx" \
  -m \
  app.cli.prewarm_models \
  --include-crema \
  --include-beat-this \
  --include-lv-chordia

conflict_output_file="${fixture}/setup-output-conflict"
if PATH="${fixture}/bin:${PATH}" \
  /bin/bash "${fixture}/scripts/setup-dev.sh" \
    --crema --no-crema-onnx \
    --skip-contracts --skip-playwright-browsers --skip-pnpm-install > "${conflict_output_file}" 2>&1; then
  echo "expected conflicting Advanced Chords selectors to fail" >&2
  exit 1
fi
grep -F -- "Conflicting Advanced Chords selectors" "${conflict_output_file}"

run_setup_dev "legacy-lv" --legacy-nvidia
assert_python_args "legacy-lv" \
  -m \
  app.cli.prewarm_models \
  --include-crema \
  --include-beat-this \
  --include-lv-chordia
printf '%s\n' \
  '[call]' sync --python 3.14 --all-groups --extra advanced-chords --extra advanced-beats --extra lv-chordia \
  '[call]' pip install --python .venv/bin/python --torch-backend cu126 \
  --reinstall-package torch --reinstall-package torchaudio \
  'torch==2.13.0' 'torchaudio==2.11.0' > "${fixture}/expected-setup-legacy-uv-args"
cmp "${fixture}/expected-setup-legacy-uv-args" "${setup_uv_args_file}"
grep -F 'expected_torch = "2.13.0+cu126"' "${python_stdin_file}" > /dev/null
grep -F 'expected_torchaudio = "2.11.0+cu126"' "${python_stdin_file}" > /dev/null
grep -F 'torch.__version__ != expected_torch' "${python_stdin_file}" > /dev/null
grep -F 'torchaudio.__version__ != expected_torchaudio' "${python_stdin_file}" > /dev/null
grep -F 'torch.version.cuda != "12.6"' "${python_stdin_file}" > /dev/null
assert_legacy_version_verifier "setup-dev"

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
printf '%s\n' sync --python 3.14 --all-groups --extra lv-chordia > "${fixture}/expected-sync-uv-args"
cmp "${fixture}/expected-sync-uv-args" "${sync_uv_args_file}"
printf '%s\n' \
  -m \
  app.cli.prewarm_models \
  --skip-demucs \
  --skip-whisper \
  --include-lv-chordia > "${fixture}/expected-sync-python-args"
cmp "${fixture}/expected-sync-python-args" "${sync_python_args_file}"

run_sync_backend "opt-out" --no-lv-chordia
printf '%s\n' sync --python 3.14 --all-groups > "${fixture}/expected-sync-opt-out-uv-args"
cmp "${fixture}/expected-sync-opt-out-uv-args" "${sync_uv_args_file}"
if [[ -s "${sync_python_args_file}" ]]; then
  echo "unexpected LV Chordia prewarm for sync opt-out" >&2
  exit 1
fi

run_sync_legacy_backend() {
  local label="$1"
  shift
  local output_file="${fixture}/sync-legacy-output-${label}"

  : > "${setup_uv_args_file}"
  : > "${sync_uv_args_file}"
  : > "${sync_python_args_file}"
  : > "${python_stdin_file}"
  if ! PATH="${fixture}/bin:${PATH}" \
    SETUP_DEV_TEST_UV_ARGS="${setup_uv_args_file}" \
    SETUP_DEV_TEST_PYTHON_STDIN="${python_stdin_file}" \
    SYNC_BACKEND_TEST_UV_ARGS="${sync_uv_args_file}" \
    SYNC_BACKEND_TEST_PYTHON_ARGS="${sync_python_args_file}" \
    /bin/bash "${fixture}/scripts/sync-backend-legacy-nvidia.sh" \
      --no-crema \
      --no-beat-this \
      "$@" > "${output_file}" 2>&1; then
    cat "${output_file}" >&2
    exit 1
  fi
}

run_sync_legacy_backend "default"
printf '%s\n' sync --python 3.14 --all-groups --extra lv-chordia > "${fixture}/expected-legacy-sync-uv-args"
cmp "${fixture}/expected-legacy-sync-uv-args" "${sync_uv_args_file}"
printf '%s\n' \
  -m \
  app.cli.prewarm_models \
  --skip-demucs \
  --skip-whisper \
  --include-lv-chordia > "${fixture}/expected-legacy-sync-python-args"
cmp "${fixture}/expected-legacy-sync-python-args" "${sync_python_args_file}"
printf '%s\n' \
  '[call]' sync --python 3.14 --all-groups --extra lv-chordia \
  '[call]' pip install --python .venv/bin/python --torch-backend cu126 \
  --reinstall-package torch --reinstall-package torchaudio \
  'torch==2.13.0' 'torchaudio==2.11.0' > "${fixture}/expected-legacy-sync-all-uv-args"
cmp "${fixture}/expected-legacy-sync-all-uv-args" "${setup_uv_args_file}"
grep -F 'expected_torch = "2.13.0+cu126"' "${python_stdin_file}" > /dev/null
grep -F 'expected_torchaudio = "2.11.0+cu126"' "${python_stdin_file}" > /dev/null
grep -F 'torch.__version__ != expected_torch' "${python_stdin_file}" > /dev/null
grep -F 'torchaudio.__version__ != expected_torchaudio' "${python_stdin_file}" > /dev/null
grep -F 'torch.version.cuda != "12.6"' "${python_stdin_file}" > /dev/null
assert_legacy_version_verifier "sync-backend-legacy-nvidia"

run_sync_legacy_backend "opt-out" --no-lv-chordia
printf '%s\n' sync --python 3.14 --all-groups > "${fixture}/expected-legacy-sync-opt-out-uv-args"
cmp "${fixture}/expected-legacy-sync-opt-out-uv-args" "${sync_uv_args_file}"
printf '%s\n' - > "${fixture}/expected-legacy-sync-opt-out-python-args"
cmp "${fixture}/expected-legacy-sync-opt-out-python-args" "${sync_python_args_file}"

echo "setup-dev and backend sync profile tests passed"
