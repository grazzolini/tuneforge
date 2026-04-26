#!/usr/bin/env bash
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
NDK_ROOT="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$NDK_ROOT" ]]; then
  if [[ ! -d "$ANDROID_HOME/ndk" ]]; then
    echo "Android NDK not found under $ANDROID_HOME/ndk" >&2
    exit 1
  fi
  NDK_ROOT="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
fi

if [[ -z "$NDK_ROOT" || ! -d "$NDK_ROOT" ]]; then
  echo "Android NDK not found. Set ANDROID_NDK_HOME or install it with Android Studio." >&2
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
cc="$toolchain/aarch64-linux-android24-clang"
cxx="$toolchain/aarch64-linux-android24-clang++"
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
export ANDROID_PLATFORM="android-24"
export CMAKE_ANDROID_ARCH_ABI="arm64-v8a"
export CMAKE_SYSTEM_PROCESSOR="aarch64"
export CMAKE_SYSTEM_VERSION="24"

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
