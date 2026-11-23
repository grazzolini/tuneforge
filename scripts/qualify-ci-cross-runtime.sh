#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
work="$(mktemp -d "${TMPDIR:-/tmp}/tuneforge-ci-qualify.XXXXXX")"
suffix="${work##*.}"
shared="tuneforge-ci-qualify:shared-${suffix}"
base="tuneforge-ci-qualify:base-${suffix}"
container=
owns_images=false
cleanup() {
  if [[ -n "$container" ]]; then docker rm "$container" >/dev/null || true; fi
  if "$owns_images"; then docker image rm "$shared" "$base" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

if [[ "$#" = 0 ]]; then
  owns_images=true
  started="$(date +%s)"
  docker build --platform linux/amd64 --no-cache --pull --file .github/ci/Dockerfile --tag "$shared" .
  printf 'Shared cold build: %s s\n' "$(( $(date +%s) - started ))"
  started="$(date +%s)"
  docker build --platform linux/amd64 --file .github/ci/Dockerfile --target shared-base --tag "$base" .
  printf 'Base build with shared layers cached: %s s\n' "$(( $(date +%s) - started ))"
elif [[ "$#" = 2 ]]; then
  shared="$1"
  base="$2"
else
  echo "Usage: bash scripts/qualify-ci-cross-runtime.sh [SHARED_IMAGE BASE_IMAGE]" >&2
  exit 1
fi

shared_layers="$(docker image inspect --format '{{json .RootFS.Layers}}' "$shared")"
base_layers="$(docker image inspect --format '{{json .RootFS.Layers}}' "$base")"
node --input-type=module -e '
  const [shared, base] = process.argv.slice(1).map(JSON.parse);
  if (shared.length !== base.length + 1 || base.some((layer, index) => layer !== shared[index])) {
    throw new Error("Expected identical shared base layers with exactly one additional payload layer");
  }
' "$shared_layers" "$base_layers"

archive() {
  local label="$1" image="$2" started
  started="$(date +%s)"
  docker image save "$image" | gzip -n -6 > "$work/$label.tar.gz"
  printf '%s Docker archive: %s bytes, export/compress %s s\n' "$label" \
    "$(wc -c < "$work/$label.tar.gz" | tr -d ' ')" "$(( $(date +%s) - started ))"
  started="$(date +%s)"
  docker image load --input "$work/$label.tar.gz" >/dev/null
  printf '%s local load with cached layers: %s s\n' "$label" "$(( $(date +%s) - started ))"
}
archive shared "$shared"
archive base "$base"

runtime=/opt/tuneforge-ci/cross-runtime
docker run --rm --platform linux/amd64 --network none "$base" test ! -e "$runtime"
container="$(docker create --platform linux/amd64 "$shared")"
started="$(date +%s)"
docker cp "$container:$runtime/." - | gzip -n -6 > "$work/payload.tar.gz"
printf 'Separate payload archive: %s bytes, export/compress %s s\n' \
  "$(wc -c < "$work/payload.tar.gz" | tr -d ' ')" "$(( $(date +%s) - started ))"
docker cp "$container:$runtime/payload.sha256" "$work/expected.sha256"
expected_manifest="$(node -p '
  const manifest = require("node:fs").readFileSync(process.argv[1]);
  require("node:crypto").createHash("sha256").update(manifest).digest("hex");
' "$work/expected.sha256")"

probe="$(cat <<'BASH'
set -euo pipefail
cd /opt/tuneforge-ci/cross-runtime
if [[ "$#" = 1 ]]; then
  tar --no-overwrite-dir -xzf -
  printf "%s  payload.sha256\n" "$1" | sha256sum --check --strict
fi
sha256sum --check --strict --status payload.sha256
venv/bin/python -IB -c "import librosa, soundfile; from tuneforge_music_core import _native"
BASH
)"
started="$(date +%s)"
docker run --rm --platform linux/amd64 --network none "$shared" bash -c "$probe"
printf 'Shared container startup, verify and import: %s s\n' "$(( $(date +%s) - started ))"
started="$(date +%s)"
# A Linux filesystem preserves case-sensitive archive entries on macOS hosts.
docker run --rm -i --platform linux/amd64 --network none --tmpfs "$runtime:rw,exec" \
  "$base" bash -c "$probe" bash "$expected_manifest" < "$work/payload.tar.gz"
printf 'Separate container startup, local stream, extract, verify and import: %s s\n' "$(( $(date +%s) - started ))"
