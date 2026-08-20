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

function levelTwoMappingKey(line) {
  const content = line.match(/^  (?!\s)(.+)$/)?.[1];
  if (!content) return undefined;
  const singleQuoted = content.match(/^'((?:[^']|'')*)'\s*:/)?.[1];
  if (singleQuoted !== undefined) return singleQuoted.replaceAll("''", "'");
  const doubleQuoted = content.match(/^"((?:[^"\\]|\\.)*)"\s*:/)?.[1];
  if (doubleQuoted !== undefined) {
    try {
      return JSON.parse(`"${doubleQuoted}"`);
    } catch {
      return `"${doubleQuoted}"`;
    }
  }
  return content.match(/^([^:]+?)\s*:/)?.[1].trimEnd() ?? `!unparsed:${content}`;
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
