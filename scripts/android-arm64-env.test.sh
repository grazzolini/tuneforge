#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/tuneforge-android-arm64-env-test.XXXXXX")"
trap 'rm -rf "${fixture}"' EXIT

mkdir -p "${fixture}/bin" "${fixture}/cargo/bin" "${fixture}/tmp"
cat > "${fixture}/bin/uname" <<'EOF'
#!/usr/bin/env bash
echo Darwin
EOF
cat > "${fixture}/bin/rustup" <<EOF
#!/usr/bin/env bash
echo "${fixture}/cargo/bin/cargo"
EOF
cat > "${fixture}/bin/llvm-ar" <<'EOF'
#!/usr/bin/env bash
last=""
for arg in "$@"; do last="$arg"; done
: > "$last"
EOF
chmod +x "${fixture}/bin/uname" "${fixture}/bin/rustup" "${fixture}/bin/llvm-ar"

make_ndk() {
  local sdk="$1" directory="$2" revision="$3"
  local ndk="${sdk}/ndk/${directory}"
  mkdir -p "${ndk}/toolchains/llvm/prebuilt/darwin-x86_64/bin"
  printf 'Pkg.Revision = %s\n' "$revision" > "${ndk}/source.properties"
  for tool in aarch64-linux-android26-clang aarch64-linux-android26-clang++; do
    ln -s "${fixture}/bin/llvm-ar" "${ndk}/toolchains/llvm/prebuilt/darwin-x86_64/bin/${tool}"
  done
  ln -s "${fixture}/bin/llvm-ar" "${ndk}/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-ar"
}

run_helper() {
  local label="$1" sdk="$2"
  shift 2
  env -i PATH="${fixture}/bin:/usr/bin:/bin" HOME="${fixture}/home" TMPDIR="${fixture}/tmp" ANDROID_HOME="$sdk" "$@" \
    /bin/bash "${repo_root}/scripts/android-arm64-env.sh" env > "${fixture}/${label}.out" 2>&1
}

assert_selected() {
  local label="$1" expected="$2"
  grep -Fx "ANDROID_NDK_HOME=${expected}" "${fixture}/${label}.out" >/dev/null
  grep -Fx "ANDROID_NDK_ROOT=${expected}" "${fixture}/${label}.out" >/dev/null
}

sdk_auto="${fixture}/sdk-auto"
make_ndk "$sdk_auto" 27.0.12077973 27.0.12077973
make_ndk "$sdk_auto" 29.0.14206865 29.0.14206865
run_helper auto "$sdk_auto"
assert_selected auto "${sdk_auto}/ndk/29.0.14206865"

make_ndk "$sdk_auto" 30.0.10000000 30.0.10000000
run_helper preferred "$sdk_auto"
assert_selected preferred "${sdk_auto}/ndk/29.0.14206865"

sdk_order="${fixture}/sdk-order"
make_ndk "$sdk_order" 29.0.9 29.0.9
make_ndk "$sdk_order" 29.0.10 29.0.10
run_helper same-major "$sdk_order"
assert_selected same-major "${sdk_order}/ndk/29.0.9"

make_ndk "$sdk_auto" malformed not-a-version
run_helper malformed-skip "$sdk_auto"
assert_selected malformed-skip "${sdk_auto}/ndk/29.0.14206865"

sdk_old="${fixture}/sdk-old"
make_ndk "$sdk_old" 28.0.13004108 28.0.13004108
if run_helper incompatible "$sdk_old"; then
  echo "expected incompatible installed NDKs to fail" >&2
  exit 1
fi
grep -F "android sdk install ndk/29.0.14206865" "${fixture}/incompatible.out" >/dev/null

if run_helper override-old "$sdk_auto" "ANDROID_NDK_HOME=${sdk_auto}/ndk/27.0.12077973"; then
  echo "expected lower explicit NDK override to fail" >&2
  exit 1
fi

if run_helper override-missing "$sdk_auto" "ANDROID_NDK_HOME=${fixture}/missing"; then
  echo "expected missing explicit NDK override to fail" >&2
  exit 1
fi

if run_helper override-malformed "$sdk_auto" "ANDROID_NDK_HOME=${sdk_auto}/ndk/malformed"; then
  echo "expected malformed explicit NDK override to fail" >&2
  exit 1
fi

run_helper override-new "$sdk_auto" "ANDROID_NDK_HOME=${sdk_auto}/ndk/30.0.10000000"
assert_selected override-new "${sdk_auto}/ndk/30.0.10000000"

echo "android-arm64-env NDK selection tests passed"
