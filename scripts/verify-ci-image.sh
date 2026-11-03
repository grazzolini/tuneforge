#!/usr/bin/env bash
set -euo pipefail

: "${CI_IMAGE_REFERENCE:?CI_IMAGE_REFERENCE is required}"
: "${GITHUB_JOB:?GITHUB_JOB is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${CI_IMAGE_FINGERPRINT:?CI_IMAGE_FINGERPRINT is required}"

image_manifest="${TUNEFORGE_CI_IMAGE_MANIFEST:-/usr/share/tuneforge-ci/producer-inputs.sha256}"
if [[ ! -f "$image_manifest" ]] ||
  [[ "$(sha256sum "$image_manifest" | cut -d' ' -f1)" != "$CI_IMAGE_FINGERPRINT" ]] ||
  ! (cd "$GITHUB_WORKSPACE" && sha256sum --check --strict --status "$image_manifest"); then
  echo "Whole CI image build inputs do not match this checkout; build a current full final candidate or promote a verified image." >&2
  exit 1
fi

soxr_root="${TUNEFORGE_CI_SOXR_ROOT:-/opt/tuneforge-ci/soxr}"
soxr_runtime_root="${soxr_root}/host-test"

if [[ ! -f "${soxr_root}/payload.sha256" ]] ||
  [[ ! -f "${soxr_root}/build-inputs.sha256" ]] ||
  [[ ! -f "${soxr_runtime_root}/include/soxr.h" ]] ||
  [[ ! -e "${soxr_runtime_root}/lib/libsoxr.so" ]] ||
  [[ ! -f "${soxr_runtime_root}/provenance.json" ]]; then
  echo "CI image is missing the prebuilt SoXR payload. Publish and promote a current tuneforge-ci image." >&2
  exit 1
fi

if ! (cd "${soxr_root}" && sha256sum --check --strict --status payload.sha256); then
  echo "CI image SoXR payload failed integrity verification. Rebuild and promote tuneforge-ci." >&2
  exit 1
fi

if ! grep -Fq '"-DWITH_PFFFT=ON"' "${soxr_runtime_root}/provenance.json"; then
  echo "CI image SoXR payload does not use the required PFFFT profile." >&2
  exit 1
fi

if ! (cd "${GITHUB_WORKSPACE}" &&
  sha256sum --check --strict --status "${soxr_root}/build-inputs.sha256"); then
  echo "CI image SoXR build inputs do not match this checkout. Publish and promote a current tuneforge-ci image." >&2
  exit 1
fi

music_root="${TUNEFORGE_CI_MUSIC_CORE_ROOT:-/opt/tuneforge-ci/music-core}"
if [[ ! -f "${music_root}/payload.sha256" ]] ||
  ! (cd "${music_root}" && sha256sum --check --strict --status payload.sha256); then
  echo "CI image music-core payload is missing or corrupt; build a current full final candidate." >&2
  exit 1
fi
node "${GITHUB_WORKSPACE}/scripts/ci-music-core.mjs" verify "${music_root}"

if [[ "${CC:-}" != /usr/bin/clang-18 || "${CXX:-}" != /usr/bin/clang++-18 ]]; then
  echo "CI image must select CC=/usr/bin/clang-18 and CXX=/usr/bin/clang++-18; got CC=${CC:-unset} CXX=${CXX:-unset}." >&2
  exit 1
fi
validation_dir="$(mktemp -d)"
trap 'rm -rf "$validation_dir"' EXIT
for compiler in "$CC" "$CXX"; do
  if [[ ! -x "$compiler" ]] || ! "$compiler" --version | grep -Eq 'clang version 18\.'; then
    echo "CI image native compiler is missing or is not Clang 18: $compiler" >&2
    exit 1
  fi
  printf 'selected: %s\nresolved: %s\n' "$compiler" "$(readlink -f "$compiler")"
  "$compiler" --version
done > "${validation_dir}/native-compiler.txt"
compiler_evidence="${TUNEFORGE_CI_COMPILER_EVIDENCE:-/usr/share/tuneforge-ci/native-compiler.txt}"
if ! cmp -s "$compiler_evidence" "${validation_dir}/native-compiler.txt"; then
  echo "CI image native compiler identities do not match native-compiler.txt." >&2
  exit 1
fi
cat "${validation_dir}/native-compiler.txt"
cat > "${validation_dir}/conditional-array.cpp" <<'CPP'
#include <iostream>
#include <string>
#ifndef __GLIBCXX__
#error Native CI consumers require libstdc++ compatibility
#endif
static const int major[] = {0,2,1,2,1,2,1,1,2,1,2,1};
static const int minor[] = {2,1,2,2,1,2,1,2,1,0,2,1};
std::string mode() { return "major"; }
double number(const std::string& name) { return name == "pitchClass" ? 1 : 0; }
int main() {
  const int result = (mode() == "minor" ? minor : major)[int(number("pitchClass"))];
  std::cout << result << '\n';
  return result == 2 ? 0 : 1;
}
CPP
for optimization in 0 3; do
  if ! "$CXX" -std=c++17 "-O${optimization}" -Wall -Wextra -Werror \
    "${validation_dir}/conditional-array.cpp" -o "${validation_dir}/conditional-array"; then
    echo "CI image native C++ conditional-array regression failed to compile at -O${optimization}." >&2
    exit 1
  fi
  if ! result="$("${validation_dir}/conditional-array")" || [[ "$result" != 2 ]]; then
    echo "CI image native C++ conditional-array regression failed at -O${optimization}: expected 2, got ${result:-no output}." >&2
    exit 1
  fi
done

ffmpeg_path="$(command -v ffmpeg)"
ffprobe_path="$(command -v ffprobe)"
test "${ffmpeg_path}" = "${TUNEFORGE_CI_EXPECTED_FFMPEG_PATH:-/usr/bin/ffmpeg}"
test "${ffprobe_path}" = "${TUNEFORGE_CI_EXPECTED_FFPROBE_PATH:-/usr/bin/ffprobe}"

{
  printf '## %s CI image\n\n' "${GITHUB_JOB}"
  printf -- '- Image: `%s`\n' "${CI_IMAGE_REFERENCE}"
  printf -- '- FFmpeg: `%s` — `%s`\n' "${ffmpeg_path}" "$("${ffmpeg_path}" -version | sed -n '1p')"
  printf -- '- FFprobe: `%s` — `%s`\n' "${ffprobe_path}" "$("${ffprobe_path}" -version | sed -n '1p')"
  printf -- '- Native compiler: Clang 18 — verification passed\n'
  printf -- '- SoXR: `%s` — verified payload and build inputs\n' "${soxr_runtime_root}"
  printf -- '- Music core: `%s` — verified WASM, manifest, notices and pins\n' "${music_root}"
} >> "${GITHUB_STEP_SUMMARY}"
