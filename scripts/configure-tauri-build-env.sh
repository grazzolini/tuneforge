#!/usr/bin/env bash

configure_tauri_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" == "Linux" ]]; then
  if [[ -z "${LIBCLANG_PATH:-}" ]]; then
    shopt -s nullglob
    configure_tauri_libclang_candidates=(
      "${configure_tauri_repo_root}"/apps/backend/.venv/lib/python*/site-packages/clang/native/libclang.so
      /usr/lib/libclang.so
      /usr/lib/libclang-*.so
      /usr/lib/libclang.so.*
      /usr/lib/llvm*/lib/libclang.so
      /usr/lib/llvm*/lib/libclang-*.so
      /usr/lib*/llvm*/lib/libclang.so
      /usr/lib*/llvm*/lib/libclang-*.so
      /usr/lib64/libclang.so
      /usr/lib64/libclang-*.so
      /usr/local/lib/libclang.so
      /usr/local/lib/libclang-*.so
    )
    shopt -u nullglob

    for configure_tauri_libclang_path in "${configure_tauri_libclang_candidates[@]}"; do
      if [[ -f "${configure_tauri_libclang_path}" ]]; then
        export LIBCLANG_PATH
        LIBCLANG_PATH="$(dirname -- "${configure_tauri_libclang_path}")"
        break
      fi
    done
  fi

  if [[ -z "${LIBCLANG_PATH:-}" ]]; then
    cat >&2 <<'EOF'
Tuneforge native tempo playback uses signalsmith-stretch, which runs bindgen during the Tauri build.
bindgen requires libclang. Install Clang/libclang development files, then rerun this command.

Arch:
  sudo pacman -S clang

Debian/Ubuntu:
  sudo apt-get install -y clang libclang-dev
EOF
    return 1 2>/dev/null || exit 1
  fi

  if command -v cc >/dev/null 2>&1; then
    configure_tauri_cc_include_dir="$(cc -print-file-name=include 2>/dev/null || true)"
    if [[ -d "${configure_tauri_cc_include_dir}" ]]; then
      case " ${BINDGEN_EXTRA_CLANG_ARGS:-} " in
        *" -I${configure_tauri_cc_include_dir} "*) ;;
        *)
          export BINDGEN_EXTRA_CLANG_ARGS
          BINDGEN_EXTRA_CLANG_ARGS="${BINDGEN_EXTRA_CLANG_ARGS:+${BINDGEN_EXTRA_CLANG_ARGS} }-I${configure_tauri_cc_include_dir}"
          ;;
      esac
    fi
  fi
fi
