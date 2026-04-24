#!/usr/bin/env bash
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
NDK_ROOT="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"

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
ar="$toolchain/llvm-ar"

if [[ ! -x "$cc" ]]; then
  echo "Android arm64 compiler not found: $cc" >&2
  exit 1
fi

cargo_bin="$(dirname "$(rustup which cargo)")"

export PATH="$cargo_bin:$toolchain:$PATH"
export CC_aarch64_linux_android="$cc"
export AR_aarch64_linux_android="$ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$cc"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_AR="$ar"

exec "$@"
