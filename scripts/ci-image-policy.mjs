import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const paths = {
  desktopPackage: "apps/desktop/package.json",
  lockfile: "pnpm-lock.yaml",
  dockerfile: ".github/ci/Dockerfile",
  imageReadme: ".github/ci/README.md",
  imageWorkflow: ".github/workflows/ci-image.yml",
  mainWorkflow: ".github/workflows/ci.yml",
  pagesWorkflow: ".github/workflows/pages.yml",
  dependabot: ".github/dependabot.yml",
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

const ciImageReference =
  "ghcr.io/grazzolini/tuneforge-ci@sha256:6b12309d6ce40b047567ce82f7a434b6a1a74f6c5f515480c49b374a3f289bb7";
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
  check(
    /push:\n    branches:\n      - main\n    paths:\n      - \.github\/ci\/\*\*\n      - \.github\/workflows\/ci-image\.yml\n  workflow_dispatch:/.test(imageWorkflow),
    "CI image workflow must publish only for trusted main image inputs or manual dispatch",
  );
  check(
    !/^\s+- (?:package\.json|pnpm-lock\.yaml)$/m.test(imageWorkflow),
    "Package or lockfile changes must not publish the CI image",
  );
  check(imageWorkflow.includes("platforms: linux/amd64"), "CI image must build only linux/amd64");
  check(
    imageWorkflow.includes(
      "tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    ),
    "CI image must publish a unique commit/run/attempt tag",
  );
  check(!/:latest\b|:main\b/.test(imageWorkflow), "CI image workflow must not publish moving tags");
  check(imageWorkflow.includes("provenance: mode=max"), "CI image build must request provenance");
  check(imageWorkflow.includes("sbom: true"), "CI image build must request an SBOM");
  for (const line of imageWorkflow.matchAll(/^\s*uses:\s+[^@\n]+@([^\s#]+)/gm)) {
    check(/^[0-9a-f]{40}$/.test(line[1]), `Action must use a full commit SHA: ${line[0].trim()}`);
  }

  const copyInstructions = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)].map((match) => match[1]);
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
    copyInstructions.length === 1 && copyInstructions[0] === "README.md /usr/share/doc/tuneforge-ci/README.md",
    "CI image build context must copy only its license/provenance notice",
  );
  check(
    !pagesWorkflow.includes("ghcr.io/grazzolini/tuneforge-ci"),
    "Pages/release media workflow must not consume the CI image",
  );
  check(
    mainWorkflow.includes(
      ".github/ci/*|.github/workflows/ci-image.yml|.github/workflows/ci.yml)",
    ),
    "CI image definitions and publisher changes must select the full CI gate",
  );
  check(
    /package-ecosystem: docker\n    directory: "\/\.github\/ci"/.test(dependabot),
    "Dependabot must track Docker base-image digests under .github/ci",
  );

  const jobs = workflowJobs(mainWorkflow);
  const workflowImageReference = mainWorkflow.match(
    /^env:\n  CI_IMAGE_REFERENCE:\s+(\S+)$/m,
  )?.[1];
  const consumerBlocks = ciImageConsumers.map((name) => [
    name,
    workflowJobBlock(mainWorkflow, name),
  ]);
  const imageConsumers = jobs
    .map(({ name, block }) => ({ name, block, image: jobContainerImage(block) }))
    .filter(({ image }) =>
      image?.match(/^ghcr\.io\/grazzolini\/tuneforge-ci(?::|@|$)/),
    );
  check(
    jobs.every(({ block }) => jobContainerImage(block) !== "!unparsed") &&
      workflowImageReference === ciImageReference &&
      JSON.stringify(imageConsumers.map(({ name }) => name).sort()) ===
      JSON.stringify([...ciImageConsumers].sort()) &&
      imageConsumers.every(({ image }) => image === ciImageReference) &&
      consumerBlocks.every(([, block]) => block.includes(`    container: ${ciImageReference}`)),
    "Exactly backend, e2e, and desktop_tauri must consume the same pinned CI image digest",
  );
  for (const [name, block] of consumerBlocks) {
    check(block.includes("    runs-on: ubuntu-24.04"), `${name} must use ubuntu-24.04`);
    check(
      block.includes("    defaults:\n      run:\n        shell: bash"),
      `${name} must default run steps to Bash`,
    );
    const checkoutIndex = block.indexOf("uses: actions/checkout@");
    const verifierCalls = verifierCallIndexes(block);
    check(
      verifierCalls.length === 1 &&
        checkoutIndex >= 0 &&
        verifierCalls[0] > checkoutIndex,
      `${name} must call the shared CI image verifier once after checkout`,
    );
    check(!/\bapt(?:-get)?\b/.test(block), `${name} must not execute apt in PR CI`);
    check(!block.includes("--with-deps"), `${name} must not use Playwright --with-deps`);
    check(!/^\s+credentials:/m.test(block), `${name} must not configure container credentials`);
    check(!jobGrantsPackagesWrite(block), `${name} must not receive packages: write`);
  }
  check(
    JSON.stringify(
      jobs
        .filter(({ block }) => verifierCallIndexes(block).length > 0)
        .map(({ name }) => name)
        .sort(),
    ) === JSON.stringify([...ciImageConsumers].sort()),
    "Only CI image consumers may call the shared verifier",
  );
  const e2eBlock = workflowJobBlock(mainWorkflow, "e2e");
  check(
    e2eBlock.includes(
      "pnpm --filter @tuneforge/desktop exec playwright install chromium",
    ),
    "e2e must install only the lockfile-matched Chromium browser at runtime",
  );
  const tauriBlock = workflowJobBlock(mainWorkflow, "desktop_tauri");
  check(
    tauriBlock.includes(
      "uses: actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659 # v1",
    ) &&
      tauriBlock.includes("toolchain: ${{ env.RUST_VERSION }}") &&
      tauriBlock.includes("cache: false") &&
      tauriBlock.includes('rustflags: ""'),
    "desktop_tauri must bootstrap pinned Rust without action-managed caching or rustflags",
  );

  if (errors.length > 0) {
    throw new Error(`CI image policy violations:\n- ${errors.join("\n- ")}`);
  }

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
