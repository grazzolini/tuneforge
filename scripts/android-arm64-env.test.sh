#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pinned_ndk_revision="$(node "${repo_root}/scripts/prepare-whisper-native-source.mjs" --ndk-revision)"
real_node="$(command -v node)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/tuneforge android arm64 env test.XXXXXX")"
fixture="$(cd "$fixture" && pwd -P)"
trap 'rm -rf "${fixture}"' EXIT

mkdir -p "${fixture}/bin" "${fixture}/cargo/bin" "${fixture}/tmp"
cat > "${fixture}/bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "${FIXTURE_HOST_OS:-Darwin}" ;;
  -m) echo "${FIXTURE_HOST_ARCH:-arm64}" ;;
  *) exit 1 ;;
esac
EOF
cat > "${fixture}/bin/rustup" <<EOF
#!/usr/bin/env bash
[[ -z "\${FIXTURE_RUSTUP_LOG:-}" ]] || echo queried >> "\$FIXTURE_RUSTUP_LOG"
echo "${fixture}/cargo/bin/cargo"
EOF
cat > "${fixture}/bin/llvm-ar" <<'EOF'
#!/usr/bin/env bash
last=""
for arg in "$@"; do last="$arg"; done
[[ -z "${FIXTURE_ARCHIVE_LOG:-}" ]] || echo archived >> "$FIXTURE_ARCHIVE_LOG"
: > "$last"
EOF
cat > "${fixture}/bin/node" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == */android-toolchain.mjs || "\$1" == "--input-type=module" ]]; then
  exec "${real_node}" "\$@"
fi
[[ "\$1" == */prepare-whisper-native-source.mjs ]] || exit 1
if [[ "\${2:-}" == "--ndk-revision" ]]; then
  echo "${pinned_ndk_revision}"
  exit 0
fi
echo prepared >> "\$FIXTURE_WHISPER_LOG"
echo "${fixture}/whisper-source"
EOF
chmod +x "${fixture}/bin/uname" "${fixture}/bin/rustup" "${fixture}/bin/llvm-ar" "${fixture}/bin/node"

make_ndk() {
  local sdk="$1" directory="$2" revision="$3" host tool
  local ndk="${sdk}/ndk/${directory}"
  mkdir -p "$ndk"
  printf 'Pkg.Revision = %s\n' "$revision" > "${ndk}/source.properties"
  for host in darwin-x86_64 linux-x86_64; do
    mkdir -p "${ndk}/toolchains/llvm/prebuilt/${host}/bin"
    for tool in aarch64-linux-android26-clang aarch64-linux-android26-clang++ llvm-ar llvm-readelf; do
      ln -s "${fixture}/bin/llvm-ar" "${ndk}/toolchains/llvm/prebuilt/${host}/bin/${tool}"
    done
    mkdir -p "${ndk}/shader-tools/${host}"
    ln -s "${fixture}/bin/llvm-ar" "${ndk}/shader-tools/${host}/glslc"
  done
}

make_platform() {
  local sdk="$1" version="$2" platform="$1/platforms/android-$2"
  mkdir -p "$platform"
  : > "$platform/android.jar"
  : > "$platform/build.prop"
  if [[ "$version" == *.* ]]; then
    printf '<r:repository xmlns:r="http://schemas.android.com/repository/android/common/02" xmlns:p="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><localPackage path="platforms;android-%s"><type-details xsi:type="p:platformDetailsType"><api-level>%s</api-level><base-extension>true</base-extension><layoutlib api="15"/></type-details><revision><major>1</major></revision><display-name>Android SDK Platform</display-name></localPackage></r:repository>\n' "$version" "$version" > "$platform/package.xml"
  else
    printf 'Pkg.Revision=1\nAndroidVersion.ApiLevel=%s\nAndroidVersion.CodeName=REL\n' "$version" > "$platform/source.properties"
  fi
}

run_helper() {
  local label="$1" sdk="$2"
  shift 2
  env -i PATH="${fixture}/bin:/usr/bin:/bin" HOME="${fixture}/home" TMPDIR="${fixture}/tmp" ANDROID_HOME="$sdk" \
    FIXTURE_WHISPER_LOG="${fixture}/${label}.source-prep" FIXTURE_BINDGEN_ARGS="${fixture}/${label}.bindgen" "$@" \
    /bin/bash "${repo_root}/scripts/android-arm64-env.sh" /bin/bash -c \
    'env; printenv BINDGEN_EXTRA_CLANG_ARGS_aarch64-linux-android > "$FIXTURE_BINDGEN_ARGS"' > "${fixture}/${label}.out" 2>&1
}

assert_selected() {
  local label="$1" expected="$2"
  grep -Fx "ANDROID_NDK_HOME=${expected}" "${fixture}/${label}.out" >/dev/null
  grep -Fx "ANDROID_NDK_ROOT=${expected}" "${fixture}/${label}.out" >/dev/null
  grep -Fx "NDK_HOME=${expected}" "${fixture}/${label}.out" >/dev/null
}

assert_bindgen() {
  local label="$1" expected="$2" actual
  actual="$(cat "${fixture}/${label}.bindgen"; printf x)"
  actual="${actual%x}"
  actual="${actual%$'\n'}"
  if [[ "$actual" != "$expected" ]]; then
    echo "unexpected bindgen arguments for $label" >&2
    cat "${fixture}/${label}.bindgen" >&2
    exit 1
  fi
}

sdk_auto="${fixture}/sdk-auto"
make_ndk "$sdk_auto" 27.0.12077973 27.0.12077973
make_ndk "$sdk_auto" "$pinned_ndk_revision" "$pinned_ndk_revision"
run_helper auto "$sdk_auto"
assert_selected auto "${sdk_auto}/ndk/${pinned_ndk_revision}"
assert_bindgen auto "--target=aarch64-linux-android26 '--sysroot=${sdk_auto}/ndk/${pinned_ndk_revision}/toolchains/llvm/prebuilt/darwin-x86_64/sysroot'"

make_ndk "$sdk_auto" 30.0.10000000 30.0.10000000
run_helper preferred "$sdk_auto"
assert_selected preferred "${sdk_auto}/ndk/30.0.10000000"

sdk_order="${fixture}/sdk-order"
make_ndk "$sdk_order" 29.0.9 29.0.9
make_ndk "$sdk_order" 29.0.10 29.0.10
run_helper same-major "$sdk_order"
assert_selected same-major "${sdk_order}/ndk/29.0.10"

make_ndk "$sdk_auto" malformed not-a-version
run_helper malformed-skip "$sdk_auto"
assert_selected malformed-skip "${sdk_auto}/ndk/30.0.10000000"

sdk_old="${fixture}/sdk-old"
make_ndk "$sdk_old" 28.0.13004108 28.0.13004108
if run_helper incompatible "$sdk_old"; then
  echo "expected incompatible installed NDKs to fail" >&2
  exit 1
fi
grep -F "Install a current stable NDK (major 29 or newer) using sdkmanager" "${fixture}/incompatible.out" >/dev/null

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

if run_helper aliases-conflict "$sdk_auto" "ANDROID_NDK_HOME=${sdk_auto}/ndk/30.0.10000000" "ANDROID_NDK_ROOT=${sdk_auto}/ndk/${pinned_ndk_revision}"; then
  echo "expected conflicting NDK aliases to fail" >&2
  exit 1
fi
grep -F "same NDK" "${fixture}/aliases-conflict.out" >/dev/null
make_ndk "$sdk_auto" prerelease "31.0.1 beta1"
run_helper stable-preferred "$sdk_auto"
assert_selected stable-preferred "${sdk_auto}/ndk/30.0.10000000"

run_helper standalone-without-sdk "" "ANDROID_NDK_HOME=${sdk_auto}/ndk/30.0.10000000"
assert_selected standalone-without-sdk "${sdk_auto}/ndk/30.0.10000000"
run_helper tauri-alias "" "NDK_HOME=${sdk_auto}/ndk/30.0.10000000"
assert_selected tauri-alias "${sdk_auto}/ndk/30.0.10000000"
if run_helper tauri-alias-conflict "$sdk_auto" "NDK_HOME=${sdk_auto}/ndk/${pinned_ndk_revision}" "ANDROID_NDK_HOME=${sdk_auto}/ndk/30.0.10000000"; then
  echo "expected conflicting Tauri NDK alias to fail" >&2
  exit 1
fi
grep -F "same NDK" "${fixture}/tauri-alias-conflict.out" >/dev/null

run_helper root-alias "$sdk_auto" "ANDROID_NDK_ROOT=${sdk_auto}/ndk/${pinned_ndk_revision}"
assert_selected root-alias "${sdk_auto}/ndk/${pinned_ndk_revision}"

for host in Darwin/arm64 Darwin/x86_64 Linux/x86_64; do
  label="host-${host//\//-}"
  prebuilt="darwin-x86_64"
  [[ "$host" != Linux/* ]] || prebuilt="linux-x86_64"
  run_helper "$label" "$sdk_auto" "FIXTURE_HOST_OS=${host%/*}" "FIXTURE_HOST_ARCH=${host#*/}"
  toolchain="${sdk_auto}/ndk/30.0.10000000/toolchains/llvm/prebuilt/${prebuilt}/bin"
  grep -Fx "CC_aarch64_linux_android=${toolchain}/aarch64-linux-android26-clang" "${fixture}/${label}.out" >/dev/null
  grep -Fx "CXX_aarch64_linux_android=${toolchain}/aarch64-linux-android26-clang++" "${fixture}/${label}.out" >/dev/null
  grep -Fx "AR_aarch64_linux_android=${toolchain}/llvm-ar" "${fixture}/${label}.out" >/dev/null
  grep -Fx "ANDROID_ABI=arm64-v8a" "${fixture}/${label}.out" >/dev/null
  grep -Fx "ANDROID_PLATFORM=android-26" "${fixture}/${label}.out" >/dev/null
  grep -Fx "CMAKE_SYSTEM_VERSION=26" "${fixture}/${label}.out" >/dev/null
  assert_bindgen "$label" "--target=aarch64-linux-android26 '--sysroot=${toolchain%/bin}/sysroot'"
  grep -Fx "TUNEFORGE_WHISPER_RS_SYS_SOURCE=${fixture}/whisper-source" "${fixture}/${label}.out" >/dev/null
  [[ -f "${fixture}/${label}.source-prep" ]]
done

defaults="--target=aarch64-linux-android26 '--sysroot=${sdk_auto}/ndk/30.0.10000000/toolchains/llvm/prebuilt/darwin-x86_64/sysroot'"
generic='-I"existing include path" -D_KEEP=1'
run_helper bindgen-generic "$sdk_auto" "BINDGEN_EXTRA_CLANG_ARGS=$generic"
assert_bindgen bindgen-generic "$defaults
$generic"
run_helper bindgen-underscore "$sdk_auto" "BINDGEN_EXTRA_CLANG_ARGS=$generic" 'BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android=-D_SPECIFIC=1'
assert_bindgen bindgen-underscore "$defaults
-D_SPECIFIC=1"
run_helper bindgen-hyphen "$sdk_auto" 'BINDGEN_EXTRA_CLANG_ARGS=-D_GLOBAL=1' \
  'BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android=-D_UNDERSCORE=1' "BINDGEN_EXTRA_CLANG_ARGS_aarch64-linux-android=$generic"
assert_bindgen bindgen-hyphen "$defaults
$generic"
for variable in BINDGEN_EXTRA_CLANG_ARGS BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android BINDGEN_EXTRA_CLANG_ARGS_aarch64-linux-android; do
  run_helper "empty-$variable" "$sdk_auto" 'BINDGEN_EXTRA_CLANG_ARGS=-D_IGNORED=1' "$variable="
  assert_bindgen "empty-$variable" "$defaults"
done
for explicit in '--target=aarch64-linux-android26 --sysroot="custom sysroot" -D_KEEP=1' \
  '-target aarch64-linux-android26 -isysroot "custom sysroot"' \
  '--target=aarch64-linux-android26 -isysroot/custom' \
  '"--target=aarch64-linux-android26" "-isysroot" "custom sysroot"' \
  '--target=aarch64-linux-android26 --sysroot "custom sysroot"'; do
  run_helper bindgen-explicit "$sdk_auto" "BINDGEN_EXTRA_CLANG_ARGS=$explicit"
  assert_bindgen bindgen-explicit "$explicit"
done
continuation=$'--target=aarch64-linux-android26 --sysroot="custom sysroot" -D_KEEP=1 \\\n'
run_helper bindgen-continuation "$sdk_auto" "BINDGEN_EXTRA_CLANG_ARGS=$continuation"
assert_bindgen bindgen-continuation "$continuation"
run_helper bindgen-target-only "$sdk_auto" 'BINDGEN_EXTRA_CLANG_ARGS=-target aarch64-linux-android26'
assert_bindgen bindgen-target-only "'--sysroot=${sdk_auto}/ndk/30.0.10000000/toolchains/llvm/prebuilt/darwin-x86_64/sysroot'
-target aarch64-linux-android26"
run_helper bindgen-sysroot-only "$sdk_auto" 'BINDGEN_EXTRA_CLANG_ARGS=--sysroot="custom sysroot"'
assert_bindgen bindgen-sysroot-only '--target=aarch64-linux-android26
--sysroot="custom sysroot"'
literal='-D_LITERAL="$(touch '"${fixture}"'/executed)" -D_TICK="`touch '"${fixture}"'/executed`"'
run_helper bindgen-literal "$sdk_auto" "BINDGEN_EXTRA_CLANG_ARGS=$literal"
assert_bindgen bindgen-literal "$defaults
$literal"
[[ ! -e "${fixture}/executed" ]]
comment='-D_TEXT="--target=not-an-option" # --sysroot=comment'
run_helper bindgen-comment "$sdk_auto" "BINDGEN_EXTRA_CLANG_ARGS=$comment"
assert_bindgen bindgen-comment "$defaults
$comment"
if run_helper bindgen-malformed "$sdk_auto" 'BINDGEN_EXTRA_CLANG_ARGS=-I"unterminated'; then
  echo "expected malformed bindgen quoting to fail" >&2
  exit 1
fi
grep -F 'Invalid shell quoting in BINDGEN_EXTRA_CLANG_ARGS;' "${fixture}/bindgen-malformed.out" >/dev/null
[[ ! -f "${fixture}/bindgen-malformed.source-prep" ]]

for host in Linux/aarch64 Darwin/i386 Windows/x86_64; do
  label="unsupported-${host//\//-}"
  if run_helper "$label" "$sdk_auto" "FIXTURE_HOST_OS=${host%/*}" "FIXTURE_HOST_ARCH=${host#*/}"; then
    echo "expected unsupported host $host to fail" >&2
    exit 1
  fi
  grep -F "Unsupported Android build host: $host" "${fixture}/${label}.out" >/dev/null
  [[ ! -f "${fixture}/${label}.source-prep" ]]
done

for tool in aarch64-linux-android26-clang aarch64-linux-android26-clang++ llvm-ar; do
  sdk="${fixture}/missing-${tool}"
  make_ndk "$sdk" "$pinned_ndk_revision" "$pinned_ndk_revision"
  rm "${sdk}/ndk/${pinned_ndk_revision}/toolchains/llvm/prebuilt/linux-x86_64/bin/${tool}"
  if run_helper "missing-${tool}" "$sdk" FIXTURE_HOST_OS=Linux FIXTURE_HOST_ARCH=x86_64; then
    echo "expected missing tool $tool to fail" >&2
    exit 1
  fi
  grep -F "missing or not executable:" "${fixture}/missing-${tool}.out" >/dev/null
  [[ ! -f "${fixture}/missing-${tool}.source-prep" ]]
done

for host in Linux Darwin; do
  default_sdk="${fixture}/home/Android/Sdk"
  [[ "$host" != Darwin ]] || default_sdk="${fixture}/home/Library/Android/sdk"
  mkdir -p "${default_sdk}/ndk"
  ln -s "${sdk_auto}/ndk/${pinned_ndk_revision}" "${default_sdk}/ndk/${pinned_ndk_revision}"
  run_helper "default-${host}" "" "FIXTURE_HOST_OS=${host}" FIXTURE_HOST_ARCH=x86_64
  assert_selected "default-${host}" "${default_sdk}/ndk/${pinned_ndk_revision}"
  run_helper "sdk-root-${host}" "" "ANDROID_SDK_ROOT=${default_sdk}" "FIXTURE_HOST_OS=${host}" FIXTURE_HOST_ARCH=x86_64
  assert_selected "sdk-root-${host}" "${default_sdk}/ndk/${pinned_ndk_revision}"
done

studio_root="${fixture}/studio"
mkdir -p "${studio_root}/scripts"
cp "${repo_root}/scripts/android-arm64-env.sh" "${studio_root}/scripts/android-arm64-env.sh"
# Exercise the actual CLI with only its filesystem probe restricted to this fixture.
"$real_node" --input-type=module - "${repo_root}/scripts/android-toolchain.mjs" "${studio_root}/scripts/android-toolchain.mjs" "$fixture" <<'NODE'
import fs from "node:fs";
const [sourceFile, destination, fixtureRoot] = process.argv.slice(2);
const source = fs.readFileSync(sourceFile, "utf8");
const marker = "\nif (process.argv[1] &&";
if (!source.includes(marker)) throw new Error("Android toolchain CLI entry marker is missing");
const isolation = `
const fixtureResolveSdk = resolveSdk;
resolveSdk = (options = {}) => fixtureResolveSdk({ ...options,
  isDirectory: (candidate) => candidate.startsWith(${JSON.stringify(fixtureRoot + "/")}) &&
    fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() });
const fixtureResolveNdk = resolveNdk;
resolveNdk = (sdk, options = {}) => fixtureResolveNdk(sdk, { ...options, standaloneRoots: [] });
`;
fs.writeFileSync(destination, source.replace(marker, isolation + marker));
NODE

env -i PATH="${fixture}/bin:/usr/bin:/bin" HOME="${fixture}/standalone-home" TMPDIR="${fixture}/standalone-tmp" \
  ANDROID_NDK_HOME="${sdk_auto}/ndk/30.0.10000000" FIXTURE_WHISPER_LOG="${fixture}/standalone-fixture.source-prep" \
  /bin/bash "${studio_root}/scripts/android-arm64-env.sh" env > "${fixture}/standalone-fixture.out" 2>&1
assert_selected standalone-fixture "${sdk_auto}/ndk/30.0.10000000"
[[ ! -e "${studio_root}/apps" ]]

run_studio() {
  local label="$1"
  shift
  env -i PATH="${fixture}/bin:/usr/bin:/bin" HOME="${fixture}/home" TMPDIR="${fixture}/studio-tmp/${label}" \
    FIXTURE_WHISPER_LOG="${fixture}/${label}.source-prep" FIXTURE_RUSTUP_LOG="${fixture}/${label}.rustup" \
    FIXTURE_ARCHIVE_LOG="${fixture}/${label}.archive" FIXTURE_CHILD_LOG="${fixture}/${label}.child" "$@" \
    /bin/bash "${studio_root}/scripts/android-arm64-env.sh" --studio /bin/bash -c \
    'env; echo launched > "$FIXTURE_CHILD_LOG"' > "${fixture}/${label}.out" 2>&1
}

assert_studio_stopped() {
  local label="$1"
  for effect in source-prep rustup archive child; do [[ ! -e "${fixture}/${label}.${effect}" ]]; done
  [[ ! -e "${fixture}/studio-tmp/${label}" ]]
}

if run_studio studio-missing "ANDROID_NDK_HOME=${sdk_auto}/ndk/30.0.10000000"; then
  echo "expected missing Studio scaffold to fail" >&2; exit 1
fi
grep -F 'Generated Android app/build.gradle.kts is missing or unreadable' "${fixture}/studio-missing.out" >/dev/null
assert_studio_stopped studio-missing

studio_app="${studio_root}/apps/desktop/src-tauri/gen/android/app/build.gradle.kts"
mkdir -p "$(dirname "$studio_app")"
manager_sdk="${fixture}/studio-newer-sdk"
mkdir -p "${manager_sdk}/cmdline-tools/latest/bin" "${manager_sdk}/platforms/android-38"
printf '#!/bin/sh\n' > "${manager_sdk}/cmdline-tools/latest/bin/sdkmanager"
chmod +x "${manager_sdk}/cmdline-tools/latest/bin/sdkmanager"
ln -s "${manager_sdk}/cmdline-tools/latest/bin/sdkmanager" "${fixture}/bin/sdkmanager"
make_platform "$manager_sdk" 38
for host in Linux Darwin; do
  studio_sdk="${fixture}/home/Android/Sdk"
  [[ "$host" != Darwin ]] || studio_sdk="${fixture}/home/Library/Android/sdk"
  make_ndk "$studio_sdk" 30.0.10000000 30.0.10000000
  for required in 37 37.0 37.2 36; do
    printf 'android {\n    compileSdk = %s\n' "${required%%.*}" > "$studio_app"
    [[ "$required" != *.* ]] || printf '    compileSdkMinor = %s\n' "${required#*.}" >> "$studio_app"
    printf '    ndkVersion = "%s"\n}\n' "$pinned_ndk_revision" >> "$studio_app"
    make_platform "$studio_sdk" "$required"
    make_platform "$studio_sdk" 37.10
    label="studio-${host}-${required}"
    run_studio "$label" "FIXTURE_HOST_OS=$host" FIXTURE_HOST_ARCH=x86_64
    grep -Fx "ANDROID_HOME=${studio_sdk}" "${fixture}/${label}.out" >/dev/null
    grep -Fx "ANDROID_SDK_ROOT=${studio_sdk}" "${fixture}/${label}.out" >/dev/null
    assert_selected "$label" "${studio_sdk}/ndk/${pinned_ndk_revision}"
    [[ -f "${fixture}/${label}.source-prep" && -f "${fixture}/${label}.child" ]]
  done
done
printf 'android {\n    compileSdk = 37\n    compileSdkMinor = 2\n    ndkVersion = "30.0.10000000"\n}\n' > "$studio_app"
run_studio studio-standalone-ndk FIXTURE_HOST_OS=Linux FIXTURE_HOST_ARCH=x86_64 "ANDROID_NDK_HOME=${sdk_auto}/ndk/30.0.10000000"
assert_selected studio-standalone-ndk "${sdk_auto}/ndk/30.0.10000000"
for override in "ANDROID_HOME=$manager_sdk" "ANDROID_SDK_ROOT=$manager_sdk" "ANDROID_HOME=${fixture}/missing-sdk"; do
  label="studio-override-${override%%=*}"
  if run_studio "$label" "$override"; then
    echo "expected incompatible Studio SDK override to fail" >&2; exit 1
  fi
  grep -F 'Required Android SDK platform android-37.2' "${fixture}/${label}.out" >/dev/null
  assert_studio_stopped "$label"
done
printf 'android {\n    compileSdk = 37\n    compileSdkMinor = 5\n}\n' > "$studio_app"
if run_studio studio-no-platform; then
  echo "expected unavailable exact Studio platform to fail" >&2; exit 1
fi
grep -F 'Required Android SDK platform android-37.5' "${fixture}/studio-no-platform.out" >/dev/null
assert_studio_stopped studio-no-platform
printf 'android {\n    compileSdk = sdkVersion\n}\n' > "$studio_app"
if run_studio studio-malformed; then
  echo "expected malformed Studio scaffold to fail" >&2; exit 1
fi
grep -F 'Generated Android compileSdk must have one unambiguous numeric literal declaration.' "${fixture}/studio-malformed.out" >/dev/null
assert_studio_stopped studio-malformed

external_sdk="${fixture}"'/external "NDK" ${literal} \tools'
make_ndk "$external_sdk" "$pinned_ndk_revision" "$pinned_ndk_revision"
external_ndk="${external_sdk}/ndk/${pinned_ndk_revision}"
write_recorded_ndk() {
  "$real_node" --input-type=module - "$studio_app" "$1" "${2:-}" "${3:-path}" <<'NODE'
import fs from "node:fs";
import path from "node:path";
const [app, version, ndk, mode] = process.argv.slice(2);
const quoted = (value) => JSON.stringify(value).replaceAll("$", "\\$");
fs.writeFileSync(app, `android {\n    compileSdk = 37\n    compileSdkMinor = 2\n    ndkVersion = ${quoted(version)}\n` +
  (mode === "path" ? `    ndkPath = ${quoted(ndk)}\n` : "") + "}\n");
const properties = path.join(path.dirname(app), "..", "local.properties");
if (mode === "properties") {
  const escaped = ndk.replace(/[\\ :]/g, (character) => `\\${character}`).replace("external", "\\u0065xternal");
  fs.writeFileSync(properties, `ndk.dir : ${escaped}\n`);
} else fs.rmSync(properties, { force: true });
NODE
}
write_recorded_ndk "$pinned_ndk_revision" "$external_ndk"
run_studio studio-recorded-external
assert_selected studio-recorded-external "$external_ndk"
grep -Fx "CC_aarch64_linux_android=${external_ndk}/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android26-clang" "${fixture}/studio-recorded-external.out" >/dev/null
ndk_alias="${fixture}/external-ndk-alias"
ln -s "$external_ndk" "$ndk_alias"
run_studio studio-recorded-alias "ANDROID_NDK_ROOT=$ndk_alias" "NDK_HOME=$external_ndk"
assert_selected studio-recorded-alias "$ndk_alias"
if run_studio studio-recorded-conflict "ANDROID_NDK_HOME=${sdk_auto}/ndk/30.0.10000000"; then
  echo "expected override disagreement with recorded NDK path to fail" >&2; exit 1
fi
grep -F 'override disagrees with the generated NDK path' "${fixture}/studio-recorded-conflict.out" >/dev/null
assert_studio_stopped studio-recorded-conflict
write_recorded_ndk 30.0.10000000 "$external_ndk"
if run_studio studio-recorded-revision; then
  echo "expected recorded NDK revision mismatch to fail" >&2; exit 1
fi
grep -F 'does not match generated ndkVersion' "${fixture}/studio-recorded-revision.out" >/dev/null
assert_studio_stopped studio-recorded-revision
write_recorded_ndk "$pinned_ndk_revision" "$external_ndk" properties
run_studio studio-recorded-properties
assert_selected studio-recorded-properties "$external_ndk"
rm "${external_ndk}/shader-tools/darwin-x86_64/glslc"
if run_studio studio-recorded-missing-tool; then
  echo "expected incomplete recorded external NDK to fail" >&2; exit 1
fi
grep -F 'glslc' "${fixture}/studio-recorded-missing-tool.out" >/dev/null
assert_studio_stopped studio-recorded-missing-tool
write_recorded_ndk "$pinned_ndk_revision" "$external_ndk"
printf 'ndk.dir=%s\n' "${sdk_auto}/ndk/30.0.10000000" > "$(dirname "$studio_app")/../local.properties"
if run_studio studio-recorded-stale-properties; then
  echo "expected stale ndk.dir conflict with recorded ndkPath to fail" >&2; exit 1
fi
grep -F 'ndkPath conflicts with local.properties ndk.dir' "${fixture}/studio-recorded-stale-properties.out" >/dev/null
assert_studio_stopped studio-recorded-stale-properties

recorded_sdk="${fixture}/recorded external SDK"
make_platform "$recorded_sdk" 37.2
make_ndk "$recorded_sdk" "$pinned_ndk_revision" "$pinned_ndk_revision"
write_recorded_ndk "$pinned_ndk_revision" "${recorded_sdk}/ndk/${pinned_ndk_revision}"
"$real_node" --input-type=module - "$studio_app" "$recorded_sdk" <<'NODE'
import fs from "node:fs";
import path from "node:path";
const [app, sdk] = process.argv.slice(2), root = path.join(path.dirname(app), "..");
const escaped = path.relative(root, sdk).replace(/[\\ :]/g, (character) => `\\${character}`).replace("SDK", "\\u0053DK");
fs.writeFileSync(path.join(root, "local.properties"), `# preserve recorded SDK\nsdk.dir : ${escaped}\ncustom.setting=preserved\n`);
NODE
studio_properties="$(dirname "$studio_app")/../local.properties"
cp "$studio_properties" "${fixture}/recorded-sdk.properties"
run_studio studio-recorded-sdk
grep -Fx "ANDROID_HOME=${recorded_sdk}" "${fixture}/studio-recorded-sdk.out" >/dev/null
grep -Fx "ANDROID_SDK_ROOT=${recorded_sdk}" "${fixture}/studio-recorded-sdk.out" >/dev/null
assert_selected studio-recorded-sdk "${recorded_sdk}/ndk/${pinned_ndk_revision}"
cmp "$studio_properties" "${fixture}/recorded-sdk.properties"
if run_studio studio-recorded-sdk-conflict "ANDROID_HOME=${fixture}/home/Library/Android/sdk"; then
  echo "expected override disagreement with recorded SDK to fail" >&2; exit 1
fi
grep -F 'sdk.dir conflicts with the selected SDK' "${fixture}/studio-recorded-sdk-conflict.out" >/dev/null
assert_studio_stopped studio-recorded-sdk-conflict
cmp "$studio_properties" "${fixture}/recorded-sdk.properties"
sdk_alias="${fixture}/recorded-sdk-alias"
ln -s "$recorded_sdk" "$sdk_alias"
run_studio studio-recorded-sdk-alias "ANDROID_HOME=$sdk_alias" "ANDROID_SDK_ROOT=$recorded_sdk"
grep -Fx "ANDROID_HOME=${sdk_alias}" "${fixture}/studio-recorded-sdk-alias.out" >/dev/null
grep -Fx "ANDROID_SDK_ROOT=${sdk_alias}" "${fixture}/studio-recorded-sdk-alias.out" >/dev/null
assert_selected studio-recorded-sdk-alias "${recorded_sdk}/ndk/${pinned_ndk_revision}"
cmp "$studio_properties" "${fixture}/recorded-sdk.properties"

if env -i PATH="${fixture}/bin:/usr/bin:/bin" TUNEFORGE_SENTINEL=must-not-print \
  /bin/bash "${repo_root}/scripts/android-arm64-env.sh" > "${fixture}/no-command.out" 2>&1; then
  echo "expected no-command invocation to fail with usage" >&2
  exit 1
fi
grep -Fx 'Usage: android-arm64-env.sh [--studio] command [args...]' "${fixture}/no-command.out" >/dev/null
[[ "$(wc -l < "${fixture}/no-command.out")" -eq 1 ]]

echo "android-arm64-env NDK selection and host/toolchain fixture tests passed"
