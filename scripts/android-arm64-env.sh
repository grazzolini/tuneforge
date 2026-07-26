#!/usr/bin/env bash
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
NDK_ROOT="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NDK_MAJOR=29
NDK_INSTALL_HINT="Install NDK ${MIN_NDK_MAJOR} or newer: android sdk install ndk/29.0.14206865"

ndk_revision() {
  local revision
  revision="$(awk -F= '$1 ~ /^[[:space:]]*Pkg.Revision[[:space:]]*$/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit }' "$1/source.properties" 2>/dev/null)"
  [[ "$revision" =~ ^[0-9]+(\.[0-9]+)*$ ]] && printf '%s\n' "$revision"
}

version_less() {
  local IFS=. i
  local -a left_parts=($1) right_parts=($2)
  for ((i = 0; i < ${#left_parts[@]} || i < ${#right_parts[@]}; i++)); do
    ((10#${left_parts[i]:-0} < 10#${right_parts[i]:-0})) && return 0; ((10#${left_parts[i]:-0} > 10#${right_parts[i]:-0})) && return 1
  done
  return 1
}

if [[ -n "$NDK_ROOT" ]]; then
  NDK_REVISION="$(ndk_revision "$NDK_ROOT" || true)"
else
  NDK_REVISION=""
  for candidate in "$ANDROID_HOME/ndk"/*; do
    candidate_revision="$(ndk_revision "$candidate" || true)"
    [[ -n "$candidate_revision" && $((10#${candidate_revision%%.*})) -ge $MIN_NDK_MAJOR ]] || continue
    if [[ -z "$NDK_REVISION" ]] || version_less "$candidate_revision" "$NDK_REVISION"; then
      NDK_ROOT="$candidate"
      NDK_REVISION="$candidate_revision"
    fi
  done
fi
if [[ -z "$NDK_ROOT" || -z "$NDK_REVISION" || $((10#${NDK_REVISION%%.*})) -lt $MIN_NDK_MAJOR ]]; then
  echo "Android NDK must have numeric Pkg.Revision >= ${MIN_NDK_MAJOR}: ${NDK_ROOT:-$ANDROID_HOME/ndk}. $NDK_INSTALL_HINT" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) prebuilt="darwin-x86_64" ;;
  *)
    echo "Unsupported host for this Android helper: $(uname -s)" >&2
    exit 1
    ;;
esac

toolchain="$NDK_ROOT/toolchains/llvm/prebuilt/$prebuilt/bin"
cc="$toolchain/aarch64-linux-android26-clang"
cxx="$toolchain/aarch64-linux-android26-clang++"
ar="$toolchain/llvm-ar"

if [[ ! -x "$cc" ]]; then
  echo "Android arm64 compiler not found: $cc" >&2
  exit 1
fi
if [[ ! -x "$cxx" ]]; then
  echo "Android arm64 C++ compiler not found: $cxx" >&2
  exit 1
fi

cargo_bin="$(dirname "$(rustup which cargo)")"

export PATH="$cargo_bin:$toolchain:$PATH"
export ANDROID_HOME="$ANDROID_HOME"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$NDK_ROOT"
export ANDROID_NDK_ROOT="$NDK_ROOT"
export CC_aarch64_linux_android="$cc"
export CXX_aarch64_linux_android="$cxx"
export AR_aarch64_linux_android="$ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$cc"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_AR="$ar"
export CMAKE_TOOLCHAIN_FILE="$SCRIPT_DIR/android-arm64.toolchain.cmake"
export ANDROID_ABI="arm64-v8a"
export ANDROID_PLATFORM="android-26"
export CMAKE_ANDROID_ARCH_ABI="arm64-v8a"
export CMAKE_SYSTEM_PROCESSOR="aarch64"
export CMAKE_SYSTEM_VERSION="26"

if command -v make >/dev/null 2>&1; then
  export CMAKE_MAKE_PROGRAM="$(command -v make)"
fi

# whisper-rs-sys checks the macOS build-script host instead of the Android target
# and asks rustc to link ggml-blas even when the Android CMake build disables it.
# Provide an empty archive so the unused static-lib request does not break
# Android packaging on macOS.
shim_dir="${TMPDIR:-/tmp}/tuneforge-android-link-shims"
mkdir -p "$shim_dir"
if [[ ! -f "$shim_dir/libggml-blas.a" ]]; then
  "$ar" crs "$shim_dir/libggml-blas.a"
fi
export RUSTFLAGS="${RUSTFLAGS:-} -L native=$shim_dir"

exec "$@"
