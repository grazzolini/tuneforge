#!/usr/bin/env bash
set -euo pipefail
command_workdir="${CI_IMAGE_WORKDIR:-$PWD}"
cd "${GITHUB_WORKSPACE:?}"
fingerprint="$(node scripts/ci-image-impact.mjs --fingerprint)"
checkout_sha="$(git rev-parse HEAD)"
[[ "${checkout_sha}" = "${GITHUB_SHA:?}" ]]
mode="${1:?select|build|require|load|run|script|cleanup}"; shift
case "${mode}" in
  select)
    selected="$(node --input-type=module -e '
      import fs from "node:fs";
      const record = JSON.parse(fs.readFileSync(".github/ci/promoted-image.json"));
      if (!/^sha256:[a-f0-9]{64}$/.test(record.digest) || record.platform !== "linux/amd64") throw Error("Invalid promoted image record");
      if ((record.producerFingerprint === null) !== (record.sourceRevision === null) ||
          (record.producerFingerprint !== null && (!/^[a-f0-9]{64}$/.test(record.producerFingerprint) || !/^[a-f0-9]{40}$/.test(record.sourceRevision)))) throw Error("Invalid promoted recipe identity");
      console.log(record.producerFingerprint === process.argv[1] ? "promoted" : "candidate");
      console.log(`ghcr.io/grazzolini/tuneforge-ci@${record.digest}`);
    ' "${fingerprint}")"
    {
      printf 'selection=%s\n' "$(sed -n '1p' <<< "$selected")"
      printf 'reference=%s\n' "$(sed -n '2p' <<< "$selected")"
      printf 'fingerprint=%s\ncheckout_sha=%s\n' "$fingerprint" "$checkout_sha"
    } >> "${GITHUB_OUTPUT:?}"
    ;;
  build)
    directory="${1:?artifact directory}"
    mkdir -p "$directory"
    docker build --platform linux/amd64 --no-cache --pull --file .github/ci/Dockerfile --tag tuneforge-ci-candidate .
    trap 'docker image rm tuneforge-ci-candidate >/dev/null' EXIT
    image_id="$(docker image inspect --format '{{.Id}}' tuneforge-ci-candidate)"
    docker save --output "${directory}/image.tar" "$image_id"
    archive_sha="$(sha256sum "${directory}/image.tar" | cut -d' ' -f1)"
    node --input-type=module -e '
      import fs from "node:fs";
      const [directory, checkoutSHA, producerFingerprint, archiveSHA, configImageID] = process.argv.slice(1);
      fs.writeFileSync(`${directory}/metadata.json`, JSON.stringify({ checkoutSHA, producerFingerprint, archiveSHA, configImageID, platform: "linux/amd64" }, null, 2) + "\n");
    ' "$directory" "$checkout_sha" "$fingerprint" "$archive_sha" "$image_id"
    ;;
  require)
    [[ "${CI_SCOPE_RESULT:?}" = success ]]
    case "${CI_IMAGE_SELECTION:?}" in
      promoted) ;;
      candidate) [[ "${CI_IMAGE_CANDIDATE_RESULT:?}" = success && "${CI_IMAGE_ARTIFACT_ID:?}" =~ ^[0-9]+$ ]] ;;
      *) echo "Unknown CI image selection" >&2; exit 1 ;;
    esac
    ;;
  load)
    bash scripts/ci-image-run.sh require
    selection="${CI_IMAGE_SELECTION:?}"
    if [[ "$selection" = candidate ]]; then
      [[ "${CI_IMAGE_CANDIDATE_RESULT:?}" = success && "${CI_IMAGE_ARTIFACT_ID:?}" =~ ^[0-9]+$ ]]
      directory="${1:?artifact directory}"
      image_id="$(node --input-type=module -e '
        import fs from "node:fs"; import crypto from "node:crypto";
        const [directory, checkout, fingerprint] = process.argv.slice(1);
        const m = JSON.parse(fs.readFileSync(`${directory}/metadata.json`));
        if (m.checkoutSHA !== checkout || m.producerFingerprint !== fingerprint || m.platform !== "linux/amd64" || !/^sha256:[a-f0-9]{64}$/.test(m.configImageID)) throw Error("Candidate checkout/recipe/platform/config identity mismatch");
        const hash = crypto.createHash("sha256");
        for await (const chunk of fs.createReadStream(`${directory}/image.tar`)) hash.update(chunk);
        if (hash.digest("hex") !== m.archiveSHA) throw Error("Candidate archive checksum mismatch");
        console.log(m.configImageID);
      ' "$directory" "$checkout_sha" "$fingerprint")"
      loaded="$(docker load --input "${directory}/image.tar")"
      trap 'while IFS= read -r loaded_id; do docker image rm "$loaded_id" >/dev/null; done < <(sed -n "s/^Loaded image ID: \(sha256:[a-f0-9]\{64\}\)$/\1/p" <<< "$loaded")' EXIT
      printf '%s\n' "$loaded"
      if ! grep -Fxq "Loaded image ID: ${image_id}" <<< "$loaded"; then
        echo "Candidate archive config image ID does not match metadata" >&2; exit 1
      fi
      rm -f "${directory}/image.tar"
      reference="$image_id"
    elif [[ "$selection" = promoted ]]; then
      record="$(GITHUB_OUTPUT=/dev/stdout bash scripts/ci-image-run.sh select)"
      grep -qx 'selection=promoted' <<< "$record"
      reference="$(sed -n 's/^reference=//p' <<< "$record")"
      docker pull --platform linux/amd64 "$reference"
    else
      echo "Unknown image selector: ${selection}" >&2; exit 1
    fi
    [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$reference")" = linux/amd64 ]]
    identity="$(printf '%s\n%s\n' "$(docker image inspect --format '{{.Id}}' "$reference")" "$fingerprint" | sha256sum | cut -d' ' -f1)"
    printf '%s\n' "$identity" > .github/ci/.selected-image-key
    printf 'CI_IMAGE_REFERENCE=%s\nCI_IMAGE_FINGERPRINT=%s\n' "$reference" "$fingerprint" >> "${GITHUB_ENV:?}"
    printf 'identity=%s\n' "$identity" >> "${GITHUB_OUTPUT:?}"
    trap - EXIT
    ;;
  run|script)
    reference="${CI_IMAGE_REFERENCE:?}"
    [[ "$reference" =~ ^(ghcr.io/grazzolini/tuneforge-ci@)?sha256:[a-f0-9]{64}$ ]]
    [[ "${CI_IMAGE_FINGERPRINT:?}" = "$fingerprint" ]]
    [[ "$command_workdir" = "$GITHUB_WORKSPACE" || "$command_workdir" = "$GITHUB_WORKSPACE/"* ]]
    if [[ "$mode" = script ]]; then
      [[ "${1:?script file}" = "${RUNNER_TEMP:?}/"* && -f "$1" ]]
      shell_args=("$1")
    else
      shell_args=(-c "${1:?command}")
    fi
    runner_home="${RUNNER_TEMP:?}/ci-image-home"
    mkdir -p "$runner_home"
    printf 'root:x:0:0:root:/root:/bin/bash\nrunner:x:%s:%s:runner:%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$runner_home" > "$RUNNER_TEMP/ci-passwd"
    args=(--rm --init --user "$(id -u):$(id -g)" --workdir "$command_workdir"
      --mount "type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE"
      --mount "type=bind,src=$RUNNER_TEMP,dst=$RUNNER_TEMP"
      --mount "type=bind,src=$RUNNER_TEMP/ci-passwd,dst=/etc/passwd,readonly" --env "HOME=$runner_home")
    tool_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    python_lib=""
    for tool in node python; do
      if [[ "$tool" = python && -z "${pythonLocation:-}" ]]; then continue; fi
      if command -v "$tool" >/dev/null; then
        binary="$(realpath "$(command -v "$tool")")"
        [[ "$binary" = /opt/hostedtoolcache/* ]] || { echo "Unsupported hosted ${tool} path: $binary" >&2; exit 1; }
        prefix="$(dirname "$(dirname "$binary")")"
        args+=(--mount "type=bind,src=$prefix,dst=$prefix,readonly")
        tool_path="${prefix}/bin:$tool_path"
        if [[ "$tool" = python ]]; then python_lib="${prefix}/lib"; fi
      fi
    done
    if [[ -n "${CI_PNPM_ROOT:-}" ]]; then
      args+=(--mount "type=bind,src=$CI_PNPM_ROOT,dst=$CI_PNPM_ROOT")
      tool_path="${CI_PNPM_BIN:?}:$tool_path"
      store="$(pnpm store path --silent)"; mkdir -p "$store"
      args+=(--mount "type=bind,src=$store,dst=$store" --env "npm_config_store_dir=$store")
    fi
    if [[ "${CI_USE_UV:-false}" = true ]]; then
      binary="$(realpath "$(command -v uv)")"
      args+=(--mount "type=bind,src=$binary,dst=$binary,readonly")
      tool_path="$(dirname "$binary"):$tool_path"
      uv_cache="${UV_CACHE_DIR:-$HOME/.cache/uv}"; mkdir -p "$uv_cache"
      args+=(--mount "type=bind,src=$uv_cache,dst=$uv_cache" --env "UV_CACHE_DIR=$uv_cache")
    fi
    if [[ -n "${RUST_VERSION:-}" ]]; then
      rustup="${RUSTUP_HOME:-$HOME/.rustup}"; cargo="${CARGO_HOME:-$HOME/.cargo}"
      mkdir -p "$RUNNER_TEMP/ci-cargo-home"
      args+=(--mount "type=bind,src=$RUNNER_TEMP/ci-cargo-home,dst=$cargo")
      args+=(--mount "type=bind,src=$rustup,dst=$rustup" --env "RUSTUP_HOME=$rustup" --env "CARGO_HOME=$cargo")
      for subtree in bin registry git; do
        mkdir -p "$cargo/$subtree"
        args+=(--mount "type=bind,src=$cargo/$subtree,dst=$cargo/$subtree")
      done
      tool_path="$cargo/bin:$tool_path"
    fi
    for variable in CI GITHUB_ACTIONS GITHUB_JOB GITHUB_SHA GITHUB_WORKSPACE GITHUB_ENV GITHUB_OUTPUT GITHUB_STEP_SUMMARY RUNNER_TEMP RUSTUP_TOOLCHAIN RUSTFLAGS E2E_TMPDIR E2E_ARTIFACT_DIR E2E_JOB_STARTED_AT PNPM_HOME PNPM_CONFIG_GLOBAL_SHIMS; do
      if [[ -v "$variable" ]]; then args+=(--env "$variable=${!variable}"); fi
    done
    args+=(--env "PATH=$tool_path" --env "CI_IMAGE_REFERENCE=$reference" --env "CI_IMAGE_FINGERPRINT=$fingerprint"
      --env TUNEFORGE_SOXR_ROOT=/opt/tuneforge-ci/soxr/host-test
      --env "LD_LIBRARY_PATH=/opt/tuneforge-ci/soxr/host-test/lib${python_lib:+:$python_lib}")
    docker run "${args[@]}" "$reference" bash -euo pipefail "${shell_args[@]}"
    ;;
  cleanup)
    rm -f .github/ci/.selected-image-key
    if [[ "${CI_IMAGE_SELECTION:-}" = candidate && "${CI_IMAGE_REFERENCE:-}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      docker image rm "$CI_IMAGE_REFERENCE"
    fi
    ;;
  *) echo "Unknown CI image operation: $mode" >&2; exit 1 ;;
esac
