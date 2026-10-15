#!/usr/bin/env bash
set -euo pipefail

studio_mode=false
if [[ "${1:-}" == "--studio" ]]; then
  studio_mode=true
  shift
fi
if [[ $# -eq 0 ]]; then
  echo "Usage: android-arm64-env.sh [--studio] command [args...]" >&2
  exit 1
fi

host_os="$(uname -s)"
host_arch="$(uname -m)"
case "$host_os/$host_arch" in
  Linux/x86_64) host_platform="linux"; host_arch="x64" ;;
  Darwin/x86_64) host_platform="darwin"; host_arch="x64" ;;
  Darwin/arm64) host_platform="darwin"; host_arch="arm64" ;;
  *)
    echo "Unsupported Android build host: $host_os/$host_arch. Use Linux x86_64 or macOS x86_64/arm64." >&2
    exit 1
    ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
selection_args=("$host_platform" "$host_arch")
if [[ "$studio_mode" == true ]]; then
  selection_args+=(--studio "$SCRIPT_DIR/../apps/desktop/src-tauri/gen/android/app/build.gradle.kts")
fi
selection="$(node "$SCRIPT_DIR/android-toolchain.mjs" "${selection_args[@]}")"
selected=()
while IFS= read -r value; do selected+=("$value"); done <<< "$selection"
ANDROID_HOME="${selected[0]}"
NDK_ROOT="${selected[1]}"
NDK_REVISION="${selected[2]}"
prebuilt="${selected[3]}"
toolchain="$NDK_ROOT/toolchains/llvm/prebuilt/$prebuilt/bin"
android_api=26
cc="$toolchain/aarch64-linux-android${android_api}-clang"
cxx="$toolchain/aarch64-linux-android${android_api}-clang++"
ar="$toolchain/llvm-ar"

configure_bindgen_args() {
  node --input-type=module - "aarch64-linux-android${android_api}" "${toolchain%/bin}/sysroot" <<'NODE'
const names = ["BINDGEN_EXTRA_CLANG_ARGS_aarch64-linux-android", "BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android", "BINDGEN_EXTRA_CLANG_ARGS"];
const name = names.find((candidate) => Object.hasOwn(process.env, candidate));
const extra = name === undefined ? "" : process.env[name];
// Inspect shlex words without evaluating or rewriting the caller's arguments.
const words = [];
let word = "", quote = "", active = false;
for (let index = 0; index < extra.length; index += 1) {
  const ch = extra[index];
  if (!quote && !active && ch === "#") {
    while (index < extra.length && extra[index] !== "\n") index += 1;
    continue;
  }
  if (quote === "'") {
    if (ch === "'") quote = ""; else word += ch;
  } else if (ch === "\\") {
    const next = extra[++index];
    if (next === undefined) { quote = "invalid"; break; }
    if (quote === '"' && !'$`"\\\n'.includes(next)) word += "\\";
    if (next !== "\n") word += next;
    active = true;
  } else if (quote === '"') {
    if (ch === '"') quote = ""; else word += ch;
  } else if (ch === "'" || ch === '"') {
    quote = ch; active = true;
  } else if (/[ \t\n]/.test(ch)) {
    if (active) words.push(word);
    word = ""; active = false;
  } else { word += ch; active = true; }
}
if (quote) { console.error(`Invalid shell quoting in ${name}; Android bindgen arguments were not configured.`); process.exit(1); }
if (active) words.push(word);
const defaults = [];
if (!words.some((word) => /^(?:--target=|-target$|--target$)/.test(word))) defaults.push(`--target=${process.argv[2]}`);
if (!words.some((word) => /^(?:--sysroot(?:=|$)|-isysroot)/.test(word))) {
  defaults.push("'--sysroot=" + process.argv[3].replaceAll("'", "'\\''") + "'");
}
// A sentinel preserves trailing newlines through Bash command substitution.
process.stdout.write(defaults.join(" ") + (defaults.length && extra ? "\n" : "") + extra + "x");
NODE
}
bindgen_args="$(configure_bindgen_args)"
bindgen_args="${bindgen_args%x}"

cargo_bin="$(dirname "$(rustup which cargo)")"

export PATH="$cargo_bin:$toolchain:$PATH"
export ANDROID_HOME="$ANDROID_HOME"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$NDK_ROOT"
export ANDROID_NDK_ROOT="$NDK_ROOT"
export NDK_HOME="$NDK_ROOT"
export CC_aarch64_linux_android="$cc"
export CXX_aarch64_linux_android="$cxx"
export AR_aarch64_linux_android="$ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$cc"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_AR="$ar"
export CMAKE_TOOLCHAIN_FILE="$SCRIPT_DIR/android-arm64.toolchain.cmake"
export ANDROID_ABI="arm64-v8a"
export ANDROID_PLATFORM="android-${android_api}"
export CMAKE_ANDROID_ARCH_ABI="arm64-v8a"
export CMAKE_SYSTEM_PROCESSOR="aarch64"
export CMAKE_SYSTEM_VERSION="$android_api"

export TUNEFORGE_WHISPER_RS_SYS_SOURCE="$(
  node "$SCRIPT_DIR/prepare-whisper-native-source.mjs"
)"

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

exec env "BINDGEN_EXTRA_CLANG_ARGS_aarch64-linux-android=$bindgen_args" "$@"
