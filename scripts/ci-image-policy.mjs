import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkImageInputs, imageInventory } from "./ci-image-impact.mjs";

const paths = {
  desktopPackage: "apps/desktop/package.json",
  lockfile: "pnpm-lock.yaml",
  dockerfile: ".github/ci/Dockerfile",
  dockerignore: ".github/ci/Dockerfile.dockerignore",
  imageReadme: ".github/ci/README.md",
  imageWorkflow: ".github/workflows/ci-image.yml",
  mainWorkflow: ".github/workflows/ci.yml",
  pagesWorkflow: ".github/workflows/pages.yml",
  dependabot: ".github/dependabot.yml",
  buildSoxr: "scripts/build-soxr-runtime.mjs",
  sourceSnapshot: "scripts/deterministic-source-snapshot.mjs",
  imageVerifier: "scripts/verify-ci-image.sh",
  candidateHelper: "scripts/ci-image-run.sh",
  promoted: ".github/ci/promoted-image.json",
};

const playwrightNoblePackages = [
  "xvfb",
  "fonts-noto-color-emoji",
  "fonts-unifont",
  "libfontconfig1",
  "libfreetype6",
  "xfonts-cyrillic",
  "xfonts-scalable",
  "fonts-liberation",
  "fonts-ipafont-gothic",
  "fonts-wqy-zenhei",
  "fonts-tlwg-loma-otf",
  "fonts-freefont-ttf",
  "libasound2t64",
  "libatk-bridge2.0-0t64",
  "libatk1.0-0t64",
  "libatspi2.0-0t64",
  "libcairo2",
  "libcups2t64",
  "libdbus-1-3",
  "libdrm2",
  "libgbm1",
  "libglib2.0-0t64",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
];

const ciImageConsumers = ["backend", "e2e", "desktop_tauri"];
function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function dockerArg(dockerfile, name) {
  return dockerfile.match(new RegExp(`^ARG ${name}=([^\\s]+)$`, "m"))?.[1];
}

function dockerQuotedArgWords(dockerfile, name) {
  const value = dockerfile.match(new RegExp(`^ARG ${name}="([\\s\\S]*?)"$`, "m"))?.[1];
  return value?.replace(/\\\r?\n/g, " ").trim().split(/\s+/);
}

function mappingKey(line, indentation) {
  const content = line.match(new RegExp(`^ {${indentation}}(?!\\s)(.+)$`))?.[1];
  if (!content || content.startsWith("#")) return undefined;
  const singleQuoted = content.match(/^'((?:[^']|'')*)'\s*:/)?.[1];
  if (singleQuoted !== undefined) return singleQuoted.replaceAll("''", "'");
  const doubleQuoted = content.match(/^"((?:[^"\\]|\\.)*)"\s*:/)?.[1];
  if (doubleQuoted !== undefined) {
    try {
      return JSON.parse(`"${doubleQuoted}"`);
    } catch {
      return `!unparsed:${content}`;
    }
  }
  return content.match(/^([^:]+?)\s*:/)?.[1].trimEnd() ?? `!unparsed:${content}`;
}

function levelTwoMappingKey(line) {
  return mappingKey(line, 2);
}

function topLevelMappingKeys(yaml, name) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start === -1) return [];
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;
    const key = levelTwoMappingKey(line);
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

function workflowJobs(workflow) {
  const lines = workflow.split("\n");
  const jobsStart = lines.findIndex((line) => line === "jobs:");
  if (jobsStart === -1) return [];
  const starts = [];
  let jobsEnd = lines.length;
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      jobsEnd = index;
      break;
    }
    const name = levelTwoMappingKey(line);
    if (name !== undefined) starts.push({ name, index });
  }
  return starts.map(({ name, index }, position) => ({
    name,
    block: `${lines.slice(index, starts[position + 1]?.index ?? jobsEnd).join("\n")}\n`,
  }));
}

function workflowJobBlock(workflow, name) {
  return workflowJobs(workflow).find((job) => job.name === name)?.block ?? "";
}

function verifierCallIndexes(block) {
  return [...block.matchAll(/^(?: {8}run:| {6}- run:) bash scripts\/verify-ci-image\.sh$/gm)].map((match) => match.index);
}

function yamlScalar(value) {
  const scalar = value.trim().replace(/\s+#.*$/, "");
  if (scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replaceAll("''", "'");
  }
  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    try {
      return JSON.parse(scalar);
    } catch {
      return scalar;
    }
  }
  return scalar;
}

function jobContainerImage(block) {
  const lines = block.split("\n");
  const jobKeys = lines.map((line) => mappingKey(line, 4));
  if (jobKeys.some((key) => key?.startsWith("!unparsed:"))) return "!unparsed";
  const containerIndex = jobKeys.findIndex((key) => key === "container");
  if (containerIndex === -1) return undefined;
  const value = lines[containerIndex].match(
    /^    (?:container|'container'|"container")\s*:\s*(.*?)\s*$/,
  )?.[1];
  if (value === undefined) return undefined;
  if (value === "") {
    for (const line of lines.slice(containerIndex + 1)) {
      if (line.trim() === "") continue;
      const indentation = line.match(/^ */)?.[0].length ?? 0;
      if (indentation <= 4) break;
      const image = line.match(/^      (?:image|'image'|"image")\s*:\s*(.+?)\s*$/)?.[1];
      if (image !== undefined) return yamlScalar(image);
    }
    return undefined;
  }
  if (value.startsWith("{")) {
    const image = value.match(/(?:^\{\s*|,\s*)(?:image|'image'|"image")\s*:\s*([^,}]+)/)?.[1];
    return image === undefined ? undefined : yamlScalar(image);
  }
  return yamlScalar(value);
}

function jobGrantsPackagesWrite(block) {
  const lines = block.split("\n");
  const permissionsIndex = lines.findIndex((line) =>
    /^    (?:permissions|'permissions'|"permissions")\s*:/.test(line),
  );
  if (permissionsIndex === -1) return false;
  const value = lines[permissionsIndex].match(
    /^    (?:permissions|'permissions'|"permissions")\s*:\s*(.*?)\s*$/,
  )?.[1];
  if (value === undefined) return true;
  if (yamlScalar(value) === "write-all") return true;
  if (value.startsWith("{")) {
    const packages = value.match(
      /(?:^\{\s*|,\s*)(?:packages|'packages'|"packages")\s*:\s*([^,}]+)/,
    )?.[1];
    return packages !== undefined && yamlScalar(packages) === "write";
  }
  if (value !== "") return false;
  for (const line of lines.slice(permissionsIndex + 1)) {
    if (line.trim() === "") continue;
    const indentation = line.match(/^ */)?.[0].length ?? 0;
    if (indentation <= 4) break;
    const packages = line.match(
      /^      (?:packages|'packages'|"packages")\s*:\s*(.+?)\s*$/,
    )?.[1];
    if (packages !== undefined) return yamlScalar(packages) === "write";
  }
  return false;
}

function desktopLockfilePlaywrightVersion(lockfile) {
  const importer = lockfile.match(/\n  apps\/desktop:\n([\s\S]*?)(?=\n  \S)/)?.[1];
  return importer?.match(/\n      playwright:\n(?:        .*\n)*?        version: ([^\s]+)/)?.[1];
}

function packagePlaywrightVersion(packageJson) {
  const specifier = JSON.parse(packageJson).devDependencies?.playwright;
  return typeof specifier === "string" ? specifier.replace(/^[~^]/, "") : undefined;
}

export function validateCiImagePolicy(root) {
  const desktopPackage = read(root, paths.desktopPackage);
  const lockfile = read(root, paths.lockfile);
  const dockerfile = read(root, paths.dockerfile);
  const imageReadme = read(root, paths.imageReadme);
  const imageWorkflow = read(root, paths.imageWorkflow);
  const mainWorkflow = read(root, paths.mainWorkflow);
  const pagesWorkflow = read(root, paths.pagesWorkflow);
  const dependabot = read(root, paths.dependabot);
  const buildSoxr = read(root, paths.buildSoxr);
  const sourceSnapshot = read(root, paths.sourceSnapshot);
  const imageVerifier = read(root, paths.imageVerifier);
  const errors = [];
  const check = (condition, message) => {
    if (!condition) errors.push(message);
  };

  const packageVersion = packagePlaywrightVersion(desktopPackage);
  const lockfileVersion = desktopLockfilePlaywrightVersion(lockfile);
  const imageVersion = dockerArg(dockerfile, "PLAYWRIGHT_VERSION");
  const imagePlaywrightPackages = dockerQuotedArgWords(
    dockerfile,
    "PLAYWRIGHT_SYSTEM_PACKAGES",
  );
  check(Boolean(packageVersion), "apps/desktop/package.json must declare Playwright");
  check(
    packageVersion === lockfileVersion,
    `Playwright package/lock versions differ (${packageVersion} vs ${lockfileVersion})`,
  );
  check(
    packageVersion === imageVersion,
    `Dockerfile PLAYWRIGHT_VERSION must be reviewed with Playwright ${packageVersion}`,
  );
  check(
    imageReadme.includes(`Playwright \`${imageVersion}\``),
    "CI image notice must record the reviewed Playwright version",
  );
  check(
    JSON.stringify(imagePlaywrightPackages) === JSON.stringify(playwrightNoblePackages) &&
      dockerfile.includes(
        'apt-get install -y --no-install-recommends "${playwright_system_packages[@]}"',
      ),
    "Dockerfile must contain the exact reviewed Playwright 1.62.1 Noble tools and Chromium packages",
  );
  check(
    dockerfile.includes("      libclang-dev \\\n") &&
      imageReadme.includes("`libclang-dev` for Rust bindgen"),
    "CI image must install and document libclang-dev for Rust bindgen",
  );
  const baseImages = [...dockerfile.matchAll(
    /^FROM (\S+)(?: AS (\S+))?$/gm,
  )].map((match) => ({ image: match[1], stage: match[2] }));
  check(
    baseImages.length === 3 &&
      baseImages[0].stage === "soxr-builder" &&
      baseImages[1].stage === "music-core-builder" &&
      baseImages[2].stage === undefined &&
      baseImages.every(base => base.image === baseImages[0].image) &&
      !dockerfile.includes("FROM --platform="),
    "CI image must use the same pinned Ubuntu base without constant FROM platform flags",
  );
  check(
    dockerfile.includes("      cmake \\\n") &&
      dockerfile.includes("      nodejs \\\n") &&
      dockerfile.includes("node scripts/build-soxr-runtime.mjs \\\n      --target host-test") &&
      dockerfile.includes("COPY --from=soxr-builder /opt/tuneforge-ci/soxr /opt/tuneforge-ci/soxr"),
    "CI image must build pinned host SoXR in its disposable builder and copy only the finished payload",
  );
  check(
    dockerfile.includes("ELF 64-bit LSB shared object, x86-64") &&
      dockerfile.includes('\"-DWITH_PFFFT=ON\"') &&
      dockerfile.includes("/tmp/verify-soxr") &&
      dockerfile.includes("> /opt/tuneforge-ci/soxr/build-tools.txt") &&
      dockerfile.includes("> payload.sha256"),
    "CI image must verify SoXR AMD64 linkage, PFFFT, resampling, tools, inputs, and payload hashes",
  );
  check(
    dockerfile.includes("COPY --from=music-core-builder /opt/tuneforge-ci/music-core /opt/tuneforge-ci/music-core") &&
      dockerfile.includes("node scripts/build-music-core.mjs --target wasm --summary") &&
      dockerfile.includes("node scripts/ci-music-core.mjs stage /opt/tuneforge-ci/music-core") &&
      dockerfile.includes("cd /opt/tuneforge-ci/music-core && sha256sum --check --strict payload.sha256"),
    "CI image must build, verify and copy the standalone music-core WASM payload",
  );
  for (const tool of ["NODE", "UV", "PYTHON"]) {
    check(Boolean(dockerArg(dockerfile, "MUSIC_" + tool + "_VERSION")) &&
      /^https:\/\//.test(dockerArg(dockerfile, "MUSIC_" + tool + "_URL")) &&
      /^[a-f0-9]{64}$/.test(dockerArg(dockerfile, "MUSIC_" + tool + "_SHA256")) &&
      dockerfile.includes('"${MUSIC_' + tool + '_SHA256}" /tmp/' + tool.toLowerCase() + (tool === "NODE" ? '.tar.xz' : tool === "UV" ? '.whl' : '.tar.gz') + ' | sha256sum -c -'),
      "Music-core builder must checksum-pin " + tool + " bootstrap artifacts");
  }
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
  check(!/COPY --from=music-core-builder (?!\/opt\/tuneforge-ci\/music-core |\/tmp\/producer-inputs.sha256 )/.test(finalStage) &&
    !/apt-get install[^;]*(?:nodejs|python3|emscripten)/.test(finalStage),
    "Music-core build tools and checkout must remain outside final image");
  const soxrBuildInputManifest = [
    "    sha256sum \\",
    "      scripts/build-soxr-runtime.mjs \\",
    "      scripts/deterministic-source-snapshot.mjs \\",
    "      packaging/soxr/sources.lock.json \\",
    "      packaging/soxr/patches/android-unversioned-soname.patch \\",
    "      > /opt/tuneforge-ci/soxr/build-inputs.sha256; \\",
  ].join("\n");
  check(
    dockerfile.includes(soxrBuildInputManifest),
    "CI image SoXR build-input manifest must hash the exact reviewed recipe, helper, lock, and patch",
  );

  check(
    JSON.stringify(topLevelMappingKeys(imageWorkflow, "on")) ===
      JSON.stringify(["push", "workflow_dispatch"]),
    "CI image workflow events must be exactly push and workflow_dispatch",
  );
  check(/^permissions: \{\}$/m.test(imageWorkflow), "CI image workflow must default to no permissions");
  check(
    /publish:\n(?:[\s\S]*?)    permissions:\n      contents: read\n      packages: write/.test(
      imageWorkflow,
    ),
    "Publish job must scope contents: read and packages: write",
  );
  const inventory = imageInventory(root);
  const publicationPaths = [...new Set(inventory.inputs.map(input => {
    const tree = inventory.sourceTrees?.find(tree => input.startsWith(tree.root + "/"));
    return tree ? tree.root + "/**" : input;
  })), paths.imageWorkflow].sort();
  check(
    imageWorkflow.includes("push:\n    branches:\n      - main\n    paths:\n") &&
      JSON.stringify([...imageWorkflow.slice(0, imageWorkflow.indexOf("  workflow_dispatch:")).matchAll(/^      - (.+)$/gm)].map((m) => m[1]).filter((v) => v !== "main").sort()) ===
        JSON.stringify(publicationPaths) &&
      workflowJobBlock(imageWorkflow, "publish").includes("    if: github.ref == 'refs/heads/main'"),
    "CI image workflow must publish only for trusted main image inputs or manual dispatch",
  );
  check(
    !/^\s+- (?:package\.json|pnpm-lock\.yaml)$/m.test(imageWorkflow),
    "Package or lockfile changes must not publish the CI image",
  );
  check(imageWorkflow.includes("platforms: linux/amd64"), "CI image must build only linux/amd64");
  check(
    imageWorkflow.includes("          context: .\n") &&
      imageWorkflow.includes("          file: .github/ci/Dockerfile\n"),
    "CI image workflow must use the restricted repository-root build context",
  );
  check(
    imageWorkflow.includes(
      "tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    ),
    "CI image must publish a unique commit/run/attempt tag",
  );
  check(!/:latest\b|:main\b/.test(imageWorkflow), "CI image workflow must not publish moving tags");
  check(imageWorkflow.includes("provenance: mode=max"), "CI image build must request provenance");
  check(imageWorkflow.includes("sbom: true"), "CI image build must request an SBOM");
  check(!imageWorkflow.includes("type=gha"), "CI image build must not consume Actions cache storage");
  for (const line of imageWorkflow.matchAll(/^\s*uses:\s+[^@\n]+@([^\s#]+)/gm)) {
    check(/^[0-9a-f]{40}$/.test(line[1]), `Action must use a full commit SHA: ${line[0].trim()}`);
  }

  const ffmpegDownload = dockerfile.indexOf(
    '--output "${ffmpeg_deb}" "${FFMPEG_DEB_URL}"',
  );
  const ffmpegChecksum = dockerfile.indexOf(
    '"${FFMPEG_DEB_SHA256}" "${ffmpeg_deb}" | sha256sum -c -',
  );
  const ffmpegInstall = dockerfile.indexOf(
    'apt-get install -y --no-install-recommends "${ffmpeg_deb}"',
  );
  check(
    ffmpegDownload >= 0 && ffmpegDownload < ffmpegChecksum && ffmpegChecksum < ffmpegInstall,
    "FFmpeg AMD64 package must be downloaded, checksum-verified, then installed",
  );
  check(
    buildSoxr.includes('from "./deterministic-source-snapshot.mjs"') &&
      !/flatpak|process\.env|SOURCE_DATE_EPOCH/i.test(sourceSnapshot),
    "SoXR snapshot serializer must remain independent of Flatpak source, epoch, and cache policy",
  );
  const soxrNoticeLines = buildSoxr.split("\n")
    .filter((line) => line.includes("THIRD_PARTY_NOTICES.md"));
  check(
    buildSoxr.includes('"scripts/build-soxr-runtime.mjs", "scripts/deterministic-source-snapshot.mjs"];') &&
      buildSoxr.includes(
        '...(target === "android-arm64-v8a" ? ["THIRD_PARTY_NOTICES.md"] : [])',
      ) &&
      buildSoxr.includes(
        'if (target === "android-arm64-v8a") correspondingSourceFiles.push("THIRD_PARTY_NOTICES.md");',
      ) &&
      soxrNoticeLines.every((line) => line.includes('target === "android-arm64-v8a"')) &&
      buildSoxr.includes('"node scripts/build-soxr-runtime.mjs --target host-test"'),
    "SoXR host corresponding sources must include the helper and rebuild command without repository-wide notices",
  );
  check(
    imageVerifier.includes("sha256sum --check --strict --status payload.sha256") &&
      imageVerifier.includes('sha256sum --check --strict --status "${soxr_root}/build-inputs.sha256"') &&
      imageVerifier.includes("Publish and promote a current tuneforge-ci image"),
    "CI image verifier must fail closed for missing, corrupt, or stale SoXR payloads",
  );
  check(
    !pagesWorkflow.includes("ghcr.io/grazzolini/tuneforge-ci"),
    "Pages/release media workflow must not consume the CI image",
  );
  check(
    mainWorkflow.includes(
      ".github/ci/*|.github/workflows/ci-image.yml|.github/workflows/ci.yml|packaging/soxr/*)",
    ),
    "CI image definitions and publisher changes must select the full CI gate",
  );
  check(
    mainWorkflow.includes("|LICENSE|THIRD_PARTY_NOTICES.md|SECURITY.md|"),
    "THIRD_PARTY_NOTICES.md must remain documentation-only CI scope",
  );
  check(
    /package-ecosystem: docker\n    directory: "\/\.github\/ci"/.test(dependabot),
    "Dependabot must track Docker base-image digests under .github/ci",
  );

  const jobs = workflowJobs(mainWorkflow);
  const record = JSON.parse(read(root, paths.promoted));
  check(/^sha256:[a-f0-9]{64}$/.test(record.digest) && record.platform === "linux/amd64" &&
    ((record.producerFingerprint === null && record.sourceRevision === null) ||
      (/^[a-f0-9]{64}$/.test(record.producerFingerprint) && /^[a-f0-9]{40}$/.test(record.sourceRevision))),
    "Promoted image must have an immutable digest and a valid recipe identity or explicit bootstrap identity");
  check(jobs.every(({ block }) => jobContainerImage(block) === undefined), "CI image jobs must run on the host through the shared Docker helper");
  const candidateBlock = workflowJobBlock(mainWorkflow, "ci-image-candidate");
  check(candidateBlock.includes("    runs-on: ubuntu-24.04") && candidateBlock.includes("    permissions:\n      contents: read") &&
    candidateBlock.includes("    needs: ci-scope") &&
    candidateBlock.includes("if: ${{ always() && (needs.ci-scope.result != 'success' || needs.ci-scope.outputs.image_selection != 'promoted') }}") &&
    candidateBlock.includes("if: needs.ci-scope.result != 'success' || needs.ci-scope.outputs.image_selection != 'candidate'\n        run: exit 1") &&
    candidateBlock.includes('run: bash scripts/ci-image-run.sh build "$RUNNER_TEMP/ci-image"') &&
    candidateBlock.includes("artifact_id: ${{ steps.upload.outputs.artifact-id }}") &&
    candidateBlock.includes("ref: ${{ github.sha }}\n          persist-credentials: false") &&
    candidateBlock.includes("if-no-files-found: error") &&
    !/--push|docker login|docker push|login-action|secrets\.|continue-on-error|privileged/.test(candidateBlock) && !jobGrantsPackagesWrite(candidateBlock),
    "Candidate image must fail closed on scope failure and export the full checkout image with a read-only token and exact artifact ID");
  const helper = read(root, paths.candidateHelper);
  check(helper.includes("docker build --platform linux/amd64 --no-cache --pull --file .github/ci/Dockerfile --tag tuneforge-ci-candidate .") &&
    !/--target|docker login|docker push|--privileged|docker\.sock|secrets\./.test(helper) &&
    helper.includes("Candidate archive config image ID does not match metadata") &&
    helper.includes("Candidate archive checksum mismatch") && helper.includes("Candidate checkout/recipe/platform/config identity mismatch"),
    "Shared image helper must build the full final recipe/platform and bind archive, checkout, fingerprint and config identity without publication or fallback");
  const scopeBlock = workflowJobBlock(mainWorkflow, "ci-scope");
  check(scopeBlock.includes("image_selection: ${{ steps.image.outputs.selection }}") &&
    scopeBlock.includes("run: bash scripts/ci-image-run.sh select") && scopeBlock.includes("run: node scripts/ci-image-impact.mjs --check") &&
    ["backend_static", "backend_ffmpeg", "desktop_tauri"].every((name) => scopeBlock.split("\n").some((line) => line.includes(name + ": ") && line.includes("steps.image.outputs.selection != 'promoted'"))),
    "Image selection must compare the full checkout recipe and force consumer gates during bootstrap or a promotion gap");
  for (const name of ciImageConsumers) {
    const block = workflowJobBlock(mainWorkflow, name);
    check(block.includes("    runs-on: ubuntu-24.04"), name + " must use ubuntu-24.04");
    check(block.includes("shell: bash ${{ github.workspace }}/scripts/ci-image-run.sh script {0}"), name + " must route native run steps through the absolute shared Docker shell");
    const scheduling = name === "e2e" ? "${{ always() }}" : "${{ always() && (needs.ci-image-candidate.result == 'failure' || needs.ci-image-candidate.result == 'cancelled' || needs.ci-scope.result != 'success' || " +
      (name === "backend" ? "needs.ci-scope.outputs.backend_static == 'true' || needs.ci-scope.outputs.backend_ffmpeg == 'true'" : "needs.ci-scope.outputs.desktop_tauri == 'true'") + ") }}";
    check(block.match(/^    if: (.*)$/m)?.[1] === scheduling, name + " must retain fail-closed required-job scheduling");
    const checkout = block.indexOf("uses: actions/checkout@"), require = block.indexOf("run: bash scripts/ci-image-run.sh require"),
      download = block.indexOf("uses: actions/download-artifact@"), load = block.indexOf('run: bash scripts/ci-image-run.sh load "$RUNNER_TEMP/ci-image"'), verify = verifierCallIndexes(block);
    check(block.includes("    needs: [ci-scope, ci-image-candidate]") &&
      block.includes("CI_SCOPE_RESULT: ${{ needs.ci-scope.result }}") && block.includes("CI_IMAGE_SELECTION: ${{ needs.ci-scope.outputs.image_selection }}") &&
      block.includes("CI_IMAGE_CANDIDATE_RESULT: ${{ needs.ci-image-candidate.result }}") && block.includes("CI_IMAGE_ARTIFACT_ID: ${{ needs.ci-image-candidate.outputs.artifact_id }}") &&
      block.includes("ref: ${{ github.sha }}\n          persist-credentials: false") &&
      verify.length === 1 && checkout >= 0 && checkout < require && require < download && download < load && load < verify[0],
      name + " must require selection success and load the exact checkout image before strict verification");
    const downloadStep = block.slice(download, block.indexOf("\n      - ", download));
    check(downloadStep.includes("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c") &&
      downloadStep.includes("artifact-ids: ${{ needs.ci-image-candidate.outputs.artifact_id }}") && downloadStep.includes("digest-mismatch: error") &&
      downloadStep.includes("path: ${{ runner.temp }}/ci-image") && !/^\s+(?:name|github-token|repository|run-id):/m.test(downloadStep),
      name + " must download only the exact same-run candidate artifact ID with digest verification");
    for (const index of [require, load, verify[0]]) {
      const step = block.slice(block.lastIndexOf("\n      - ", index), block.indexOf("\n      - ", index));
      check(!/^\s+(?:if|continue-on-error):/m.test(step), name + " must not skip or tolerate selected-image verification failures");
      if (index !== verify[0]) check(step.includes("shell: bash"), name + " must load images on the host");
      else check(!step.includes("shell:"), name + " must verify inside the selected image");
    }
    check(block.includes("if: always() && steps.image.outputs.identity != ''") && block.includes("run: bash scripts/ci-image-run.sh cleanup"), name + " must clean the selected image after failures");
    check(!/\bapt(?:-get)?\b|--with-deps/.test(block) && !/^\s+credentials:/m.test(block) && !jobGrantsPackagesWrite(block), name + " must not install system packages or receive publication credentials");
  }
  check(JSON.stringify(jobs.filter(({ block }) => verifierCallIndexes(block).length).map(({ name }) => name).sort()) === JSON.stringify([...ciImageConsumers].sort()), "Only CI image consumers may call the shared verifier");
  const e2eBlock = workflowJobBlock(mainWorkflow, "e2e"), tauriBlock = workflowJobBlock(mainWorkflow, "desktop_tauri");
  check(e2eBlock.includes("pnpm --filter @tuneforge/desktop exec playwright install chromium"), "e2e must install only the lockfile-matched Chromium browser at runtime");
  check(e2eBlock.includes(".github/ci/.selected-image-key") && ["backend", "e2e"].every((name) => workflowJobBlock(mainWorkflow, name).includes("cache-suffix: ${{ steps.image.outputs.identity }}")), "pnpm and uv caches must include selected image and producer identity");
  check(tauriBlock.includes("uses: actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659") &&
    tauriBlock.includes("toolchain: ${{ env.RUST_VERSION }}") && tauriBlock.includes("          cache: false\n") && tauriBlock.includes('rustflags: ""'), "desktop_tauri must bootstrap pinned Rust without action-managed caching or rustflags");
  check((tauriBlock.match(/uses: actions\/cache@/g) ?? []).length === 1 && tauriBlock.includes("key: cargo-v2-${{ steps.image.outputs.identity }}-") &&
    tauriBlock.includes('soxr_root="${TUNEFORGE_SOXR_ROOT:?}"') && !tauriBlock.includes("node scripts/build-soxr.mjs") && !tauriBlock.includes("python -m pip install"), "desktop_tauri must use one image-keyed Cargo cache and the prebuilt SoXR payload");
  check(imageVerifier.includes('sha256sum --check --strict --status "$image_manifest"') && imageVerifier.includes('!= "$CI_IMAGE_FINGERPRINT"'), "CI image verifier must reject missing, corrupt or stale whole-recipe manifests");
  const publishInputs = imageWorkflow.match(/uses: docker\/build-push-action@[^\n]+\n        with:\n([\s\S]*?)(?=\n      -)/)?.[1];
  check(publishInputs && [...publishInputs.matchAll(/^          ([\w-]+):/gm)].every((m) => ["context", "file", "platforms", "pull", "no-cache", "push", "tags", "labels", "provenance", "sbom"].includes(m[1])), "Publisher recipe options require explicit compatibility review; build arguments, targets and additional contexts are unsupported");

  if (errors.length > 0) {
    throw new Error(`CI image policy violations:\n- ${errors.join("\n- ")}`);
  }
  checkImageInputs(root);

  return {
    playwrightVersion: packageVersion,
    image: "ghcr.io/grazzolini/tuneforge-ci",
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const result = validateCiImagePolicy(root);
  console.log(`CI image policy valid for Playwright ${result.playwrightVersion}.`);
}
