import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelBundlePlan, DEFAULT_LYRICS_MODEL } from "./model-bundle-metadata.mjs";
import {
  defaultPackageOptions,
  normalizeFlatpakProfiles,
  packageOptionsToGeneratorArgs,
} from "./package-options.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const LV_CHORDIA_CHECKPOINT_BYTES = 28_730_939;
const LV_CHORDIA_SOURCE_REVISION = "9d7de7bbf45efa6731ec8dc62d35280f141c0702";
const flatpakGeneratedRoot = path.join(workspaceRoot, "packaging", "flatpak", "generated");

export const REVIEWED_FLATPAK_PYTHON_LICENSES = Object.freeze({
  alembic: "MIT", "annotated-doc": "MIT", "annotated-types": "MIT", anyio: "MIT",
  "audioop-lts": "PSF-2.0", certifi: "MPL-2.0", cffi: "MIT", "charset-normalizer": "MIT",
  click: "BSD-3-Clause", cryptography: "Apache-2.0 OR BSD-3-Clause", decorator: "BSD-2-Clause",
  "beat-this": "MIT", demucs: "MIT", einops: "MIT", fastapi: "MIT", filelock: "Unlicense",
  flatbuffers: "Apache-2.0", fsspec: "BSD-3-Clause",
  greenlet: "MIT", h11: "MIT", "hf-xet": "Apache-2.0", httpcore: "BSD-3-Clause",
  httpx: "BSD-3-Clause", "huggingface-hub": "Apache-2.0", idna: "BSD-3-Clause",
  h5py: "BSD-3-Clause", hatchling: "MIT", "importlib-resources": "Apache-2.0", jinja2: "BSD-3-Clause",
  joblib: "BSD-3-Clause", julius: "MIT", lameenc: "LGPL-3.0-only", "lazy-loader": "BSD-3-Clause",
  librosa: "ISC", llvmlite: "BSD-2-Clause", "lv-chordia": "MIT", mako: "MIT",
  markupsafe: "BSD-3-Clause", mido: "MIT", "more-itertools": "MIT", mpmath: "BSD-3-Clause",
  msgpack: "Apache-2.0", narwhals: "MIT", networkx: "BSD-3-Clause", numba: "BSD-2-Clause",
  numpy: "BSD-3-Clause", "onnxruntime": "MIT", "openai-whisper": "MIT",
  packaging: "Apache-2.0 OR BSD-2-Clause", pathspec: "MPL-2.0", platformdirs: "MIT",
  pluggy: "MIT", pooch: "BSD-3-Clause", "pretty-midi": "MIT", protobuf: "BSD-3-Clause",
  pycparser: "BSD-3-Clause", pydantic: "MIT",
  "pydantic-core": "MIT", pyyaml: "MIT", regex: "Apache-2.0", requests: "Apache-2.0",
  pydub: "MIT", "rotary-embedding-torch": "MIT", safetensors: "Apache-2.0",
  "scikit-learn": "BSD-3-Clause", scipy: "BSD-3-Clause", setuptools: "MIT", six: "MIT",
  soundfile: "BSD-3-Clause", soxr: "LGPL-2.1-or-later", sphn: "MIT",
  sqlalchemy: "MIT", starlette: "BSD-3-Clause", sympy: "BSD-3-Clause",
  threadpoolctl: "BSD-3-Clause", tiktoken: "MIT", torch: "BSD-3-Clause",
  torchaudio: "BSD-2-Clause", tqdm: "MPL-2.0 AND MIT", "typing-extensions": "PSF-2.0",
  tomlkit: "MIT", "trove-classifiers": "Apache-2.0", "typing-inspection": "MIT",
  urllib3: "MIT", uvicorn: "BSD-3-Clause", wheel: "MIT",
  "cuda-bindings": "Apache-2.0", "cuda-pathfinder": "Apache-2.0", "cuda-toolkit": "Apache-2.0",
  triton: "MIT",
});

function reviewedFlatpakLicense(name, metadata) {
  if (name.startsWith("nvidia-")) return "LicenseRef-NVIDIA-Software-License";
  return metadata[name];
}

function parseGeneratedRequirements(contents, label) {
  return contents.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^([^=]+)==(.+)$/.exec(line);
    if (!match) throw new Error(`Malformed ${label} requirement: ${line}`);
    return { name: match[1].toLowerCase().replace(/[-_.]+/g, "-"), version: match[2] };
  });
}

export function buildFlatpakProfileComponentInventory({
  generatedRoot = flatpakGeneratedRoot,
  strict = false,
  licenseMetadata = REVIEWED_FLATPAK_PYTHON_LICENSES,
  selectedProfiles,
} = {}) {
  const selectionPath = path.join(generatedRoot, "flatpak-profile-selection.json");
  const normalizedProfiles = normalizeFlatpakProfiles(selectedProfiles ?? (
    existsSync(selectionPath)
      ? JSON.parse(readFileSync(selectionPath, "utf8")).profiles
      : undefined
  ));
  const selected = new Set(normalizedProfiles);
  const profiles = [
    { id: "cpu", prefix: "python", requirementFiles: ["python-requirements.txt", "python-build-requirements.txt"] },
    { id: "nvidia-core", prefix: "python-nvidia-torch-core", requirementFiles: ["python-nvidia-torch-core-requirements.txt"] },
    { id: "nvidia-runtime", prefix: "python-nvidia-torch-runtime", requirementFiles: ["python-nvidia-torch-runtime-requirements.txt"] },
    { id: "legacy-nvidia-core", prefix: "python-legacy-torch-core", requirementFiles: ["python-legacy-torch-core-requirements.txt"] },
    { id: "legacy-nvidia-runtime", prefix: "python-legacy-torch-runtime", requirementFiles: ["python-legacy-torch-runtime-requirements.txt"] },
  ].filter(({ id }) => id === "cpu" || selected.has(id.startsWith("legacy-") ? "legacy-nvidia" : "nvidia"));
  const requiredFiles = profiles.flatMap(({ prefix, requirementFiles }) => [
    ...requirementFiles, `${prefix}-sources.json`, `${prefix}-size-report.json`,
  ]);
  const missingFiles = requiredFiles.filter((file) => !existsSync(path.join(generatedRoot, file)));
  if (missingFiles.length > 0) {
    if (strict) throw new Error(`Missing generated Flatpak profile inventory: ${missingFiles.join(", ")}`);
    return { generated: false, selectedProfiles: normalizedProfiles, profiles: [], errors: [] };
  }
  const errors = [];
  const inventory = profiles.map(({ id, prefix, requirementFiles }) => {
    const requirementRows = requirementFiles.flatMap((file) => parseGeneratedRequirements(
      readFileSync(path.join(generatedRoot, file), "utf8"), id,
    ));
    const requirements = Array.from(
      new Map(requirementRows.map((row) => [`${row.name}@${row.version}`, row])).values(),
    );
    const artifacts = JSON.parse(readFileSync(path.join(generatedRoot, `${prefix}-size-report.json`), "utf8"));
    const sources = JSON.parse(readFileSync(path.join(generatedRoot, `${prefix}-sources.json`), "utf8"));
    const artifactKeys = new Set(artifacts.map((entry) =>
      `${entry.name.toLowerCase().replace(/[-_.]+/g, "-")}@${entry.version}`));
    for (const { name, version } of requirements) {
      if (!artifactKeys.has(`${name}@${version}`)) errors.push(`${id}: requirement ${name} ${version} lacks an exact generated artifact`);
    }
    const components = artifacts.map((artifact) => {
      const name = artifact.name.toLowerCase().replace(/[-_.]+/g, "-");
      const { version } = artifact;
      const source = sources.find((entry) =>
        entry.url === artifact.url && entry["dest-filename"] === artifact.fileName);
      const license = reviewedFlatpakLicense(name, licenseMetadata);
      if (!source || !/^[a-f0-9]{64}$/.test(source.sha256)) errors.push(`${id}: ${name} ${version} lacks an exact generated source/hash`);
      if (!license) errors.push(`${id}: ${name} ${version} lacks reviewed license metadata`);
      return {
        name, version, license: license ?? null,
        fileName: artifact?.fileName ?? null,
        sha256: source?.sha256 ?? null,
      };
    });
    return { id, components };
  });
  if (strict && errors.length > 0) throw new Error(errors.join("; "));
  return { generated: true, selectedProfiles: normalizedProfiles, profiles: inventory, errors };
}

const TOOL_DEFINITIONS = {
  pnpm: {
    executable: "pnpm",
    args: ["--version"],
    installHint: "Use the repository package manager from package.json.",
  },
  uv: {
    executable: "uv",
    args: ["--version"],
    installHint: "Install uv before collecting Python dependency metadata.",
  },
  cargo: {
    executable: "cargo",
    args: ["--version"],
    installHint: "Install the Rust toolchain before collecting Rust crate metadata.",
  },
  "cargo-about": {
    executable: "cargo-about",
    args: ["--version"],
    installHint: "Install cargo-about, then rerun the Rust inventory command.",
  },
};

export const releaseInventoryCommands = [
  {
    id: "javascript",
    label: "JavaScript / TypeScript",
    cwd: ".",
    commands: [
      {
        label: "Resolved workspace license inventory",
        command: ["pnpm", "licenses", "list", "--recursive"],
      },
    ],
    tools: ["pnpm"],
    writesFiles: false,
    note: "Prints the resolved pnpm workspace license inventory to stdout.",
  },
  {
    id: "python",
    label: "Python backend",
    cwd: "apps/backend",
    commands: [
      {
        label: "Default ONNX release dependency SBOM",
        command: [
          "uv",
          "export",
          "--format",
          "cyclonedx1.5",
          "--frozen",
          "--all-groups",
          "--extra",
          "advanced-chords",
          "--extra",
          "advanced-beats",
          "--extra",
          "lv-chordia",
        ],
      },
      {
        label: "Installed package metadata",
        command: [
          "uv",
          "run",
          "--no-sync",
          "--python",
          "3.14",
          "python",
          "-m",
          "pip",
          "inspect",
          "--local",
        ],
      },
    ],
    tools: ["uv"],
    writesFiles: false,
    note:
      "Run metadata inspection after the backend release environment is synced; --no-sync avoids changing it.",
  },
  {
    id: "rust",
    label: "Rust desktop shell",
    cwd: "apps/desktop/src-tauri",
    commands: [
      {
        label: "cargo-about JSON inventory",
        command: ["cargo", "about", "generate", "--format", "json", "--locked"],
      },
    ],
    tools: ["cargo", "cargo-about"],
    writesFiles: false,
    note:
      "Uses apps/desktop/src-tauri/about.toml; cargo-about is an external CLI, not a repo dependency.",
  },
];

export function shellCommand({ cwd, command }) {
  const renderedCommand = command.map(quoteShellArg).join(" ");
  return cwd && cwd !== "." ? `cd ${quoteShellArg(cwd)} && ${renderedCommand}` : renderedCommand;
}

export function buildReleaseLicenseInventory({
  includeToolStatus = false,
  checkTool = checkToolAvailability,
  strictFlatpakProfiles = false,
  flatpakProfiles,
} = {}) {
  const toolStatuses = includeToolStatus
    ? collectToolStatuses(releaseInventoryCommands, { checkTool })
    : [];
  const defaultOptions = defaultPackageOptions();
  const defaultGeneratorArgs = packageOptionsToGeneratorArgs(defaultOptions);
  const bundledPlan = buildModelBundlePlan({
    includeBeatThis: defaultOptions.beatThis,
    lyricsModel: DEFAULT_LYRICS_MODEL,
  });
  const cremaOnnxBundledPlan = buildModelBundlePlan({
    includeCremaOnnx: true,
    lyricsModel: DEFAULT_LYRICS_MODEL,
  });
  const bundledManifestEntries = [
    ...bundledPlan.manifest.torch_checkpoints,
    ...bundledPlan.manifest.whisper_models,
  ];
  const flatpakProfileComponents = buildFlatpakProfileComponentInventory({
    strict: strictFlatpakProfiles,
    selectedProfiles: flatpakProfiles,
  });
  const selectedFlatpakProfiles = new Set(flatpakProfileComponents.selectedProfiles);
  const flatpakTorchProfiles = [
    {
      id: "cpu", refId: "com.tuneforge.desktop", torch: "2.13.0", torchaudio: "2.11.0",
      cudaFamily: null,
      artifact: "Tuneforge_<version>_x86_64.flatpak",
    },
    {
      id: "nvidia-core", refId: "com.tuneforge.desktop.Torch.Stack.Nvidia.Core",
      torch: "2.13.0", torchaudio: "2.11.0", triton: "3.7.1", cudaFamily: "13",
      artifact: "Tuneforge_<version>_Torch_Nvidia_Core_x86_64.flatpak",
    },
    {
      id: "nvidia-runtime", refId: "com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime",
      cudaFamily: "13", artifact: "Tuneforge_<version>_Torch_Nvidia_Runtime_x86_64.flatpak",
    },
    {
      id: "legacy-nvidia-core", refId: "com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Core",
      torch: "2.13.0+cu126", torchaudio: "2.11.0+cu126", triton: "3.7.1", cudaFamily: "12.6",
      artifact: "Tuneforge_<version>_Torch_LegacyNvidia_Core_x86_64.flatpak",
    },
    {
      id: "legacy-nvidia-runtime", refId: "com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Runtime",
      cudaFamily: "12.6", artifact: "Tuneforge_<version>_Torch_LegacyNvidia_Runtime_x86_64.flatpak",
    },
  ].filter(({ id }) => id === "cpu" || selectedFlatpakProfiles.has(
    id.startsWith("legacy-") ? "legacy-nvidia" : "nvidia",
  ));

  return {
    workspaceRoot: ".",
    generatedReportsCommitted: false,
    inventoryCommands: releaseInventoryCommands.map((item) => ({
      ...item,
      commands: item.commands.map((entry) => ({
        ...entry,
        shell: shellCommand({ cwd: item.cwd, command: entry.command }),
      })),
    })),
    toolStatuses,
    modelPolicy: {
      defaultPackageOptions: {
        lvChordia: defaultOptions.lvChordia,
        modelBundle: defaultOptions.modelBundle,
        generatorArgs: defaultGeneratorArgs,
      },
      defaultPackageCommands: [
        { platform: "macOS", command: "pnpm package:mac" },
        { platform: "Linux Flatpak", command: "pnpm package:linux" },
      ],
      onnxPackageCommands: [
        { platform: "macOS", command: "pnpm package:mac -- --crema-onnx" },
        { platform: "Linux Flatpak", command: "pnpm package:linux -- --crema-onnx" },
      ],
      explicitModelBundleCommands: [
        { platform: "macOS", command: "pnpm package:mac -- --model-bundle" },
        { platform: "Linux Flatpak", command: "pnpm package:linux -- --model-bundle" },
      ],
      cremaOnnxModelBundleCommands: [
        { platform: "macOS", command: "pnpm package:mac -- --crema-onnx --model-bundle" },
        {
          platform: "Linux Flatpak",
          command: "pnpm package:linux -- --crema-onnx --model-bundle",
        },
      ],
      cachePrewarmCommand:
        "cd apps/backend && uv run --python 3.14 --locked --all-groups " +
        "--extra advanced-chords --extra advanced-beats --extra lv-chordia " +
        "python -m app.cli.prewarm_models --include-crema --include-beat-this --include-lv-chordia",
      bundledDependencyWeights: {
        lvChordia: {
          checkpointBytes: LV_CHORDIA_CHECKPOINT_BYTES,
          checkpointCount: 5,
          packagePath: "share/lv-chordia/cache_data",
          sourceRevision: LV_CHORDIA_SOURCE_REVISION,
        },
      },
      cachePaths: [
        "$TUNEFORGE_DATA_DIR/cache/models/crema/0.2.0/65af18f49af5101267fd28f15ac8c452d98b8e3d",
        "$TORCH_HOME/hub/checkpoints",
        "$XDG_CACHE_HOME/torch/hub/checkpoints",
        "~/.cache/torch/hub/checkpoints",
        "$TUNEFORGE_LYRICS_CACHE_DIR",
        "$XDG_CACHE_HOME/whisper",
        "~/.cache/whisper",
      ],
      packageBundlePaths: [
        "apps/desktop/src-tauri/resources/backend/models/bundle",
        "apps/desktop/src-tauri/resources/backend/manifest.json",
        "packaging/flatpak/generated/model-bundle-sources.json",
        "packaging/flatpak/generated/model-bundle-manifest.json",
      ],
      flatpakTorchProfiles: flatpakTorchProfiles.map(({ artifact: _artifact, ...profile }) => profile),
      flatpakChecksumContents: flatpakTorchProfiles.map(({ artifact }) => artifact),
      flatpakProfileComponents,
      defaultLyricsModel: DEFAULT_LYRICS_MODEL,
      explicitBundleSourceCount: bundledPlan.sources.length,
      explicitBundleBytes: sumBundleBytes(bundledManifestEntries),
      cremaOnnxBundleSourceCount: cremaOnnxBundledPlan.manifest.crema_onnx_files.length,
      cremaOnnxBundleBytes: sumBundleBytes(cremaOnnxBundledPlan.manifest.crema_onnx_files),
    },
    risks: [
      "Default release package commands must not pass --model-bundle.",
      "Advanced Chords packages must include only the exact pinned Crema ONNX model and runtime-state files.",
      "Demucs pretrained-weight redistribution is unclear/restricted upstream.",
      "FFmpeg and ffprobe are host-installed and are not bundled.",
      "Python package license metadata can be incomplete; review missing fields manually.",
      "Do not commit redirected inventory reports or generated package resources.",
      "NVIDIA extension wheels require their bundled NVIDIA component license metadata review.",
    ],
  };
}

export function collectToolStatuses(commands, { checkTool = checkToolAvailability } = {}) {
  const toolNames = new Set(commands.flatMap((command) => command.tools));
  return Array.from(toolNames, (toolName) => checkTool(toolName));
}

export function checkToolAvailability(toolName) {
  const definition = TOOL_DEFINITIONS[toolName];
  if (!definition) {
    throw new Error(`Unknown inventory tool: ${toolName}`);
  }

  const result = spawnSync(definition.executable, definition.args, {
    cwd: workspaceRoot,
    stdio: "ignore",
  });
  if (result.error?.code === "ENOENT") {
    return {
      tool: toolName,
      available: false,
      detail: `${definition.executable} not found. ${definition.installHint}`,
    };
  }
  if (result.error) {
    return {
      tool: toolName,
      available: false,
      detail: result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      tool: toolName,
      available: false,
      detail: `${definition.executable} ${definition.args.join(" ")} exited ${result.status}.`,
    };
  }
  return { tool: toolName, available: true, detail: "available" };
}

export function formatReleaseLicenseInventory(checklist) {
  const lines = [
    "Release license inventory checklist",
    "",
    "Inventory commands:",
  ];
  for (const item of checklist.inventoryCommands) {
    lines.push(`- ${item.label}`);
    lines.push(`  cwd: ${item.cwd}`);
    for (const command of item.commands) {
      lines.push(`  ${command.label}: ${command.shell}`);
    }
    lines.push(`  writes files: ${item.writesFiles ? "yes" : "no"}`);
    lines.push(`  tools: ${formatToolList(item.tools, checklist.toolStatuses)}`);
    lines.push(`  note: ${item.note}`);
  }

  lines.push("");
  lines.push("Model-weight policy:");
  lines.push(`- default modelBundle: ${checklist.modelPolicy.defaultPackageOptions.modelBundle}`);
  lines.push(`- default LV Chordia: ${checklist.modelPolicy.defaultPackageOptions.lvChordia}`);
  lines.push(
    `- default package generator args: ${checklist.modelPolicy.defaultPackageOptions.generatorArgs.join(" ")}`,
  );
  for (const entry of checklist.modelPolicy.defaultPackageCommands) {
    lines.push(`- default ${entry.platform}: ${entry.command}`);
  }
  for (const entry of checklist.modelPolicy.explicitModelBundleCommands) {
    lines.push(`- explicit bundle ${entry.platform}: ${entry.command}`);
  }
  lines.push(`- cache prewarm: ${checklist.modelPolicy.cachePrewarmCommand}`);
  lines.push(`- cache paths: ${checklist.modelPolicy.cachePaths.join(", ")}`);
  lines.push(`- package bundle paths: ${checklist.modelPolicy.packageBundlePaths.join(", ")}`);
  for (const profile of checklist.modelPolicy.flatpakTorchProfiles) {
    const details = profile.torch
      ? [
        `Torch ${profile.torch}`,
        `Torchaudio ${profile.torchaudio}`,
        ...(profile.triton ? [`Triton ${profile.triton}`] : []),
        ...(profile.cudaFamily ? [`CUDA family ${profile.cudaFamily}`] : []),
      ]
      : [`CUDA/NVIDIA runtime family ${profile.cudaFamily}`];
    lines.push(`- Flatpak Torch ${profile.id}: ${profile.refId}, ${details.join(", ")}`);
  }
  lines.push(`- Flatpak SHA256SUMS: ${checklist.modelPolicy.flatpakChecksumContents.join(", ")}`);
  for (const profile of checklist.modelPolicy.flatpakProfileComponents.profiles) {
    lines.push(`- Flatpak ${profile.id} licensed components: ${profile.components.length}`);
  }
  lines.push(
    `- explicit bundle plan: ${checklist.modelPolicy.explicitBundleSourceCount} source files, ` +
      `${formatBytes(checklist.modelPolicy.explicitBundleBytes)}`,
  );
  lines.push(`- default lyrics model: ${checklist.modelPolicy.defaultLyricsModel}`);
  const lvChordia = checklist.modelPolicy.bundledDependencyWeights.lvChordia;
  lines.push(
    `- bundled LV Chordia checkpoints: ${lvChordia.checkpointCount} files, ` +
      `${formatBytes(lvChordia.checkpointBytes)}, revision ${lvChordia.sourceRevision}`,
  );

  lines.push("");
  lines.push("Risks / release checks:");
  for (const risk of checklist.risks) {
    lines.push(`- ${risk}`);
  }

  if (checklist.toolStatuses.length > 0) {
    lines.push("");
    lines.push("Tool availability:");
    for (const status of checklist.toolStatuses) {
      lines.push(`- ${status.tool}: ${status.available ? "ok" : "missing"} (${status.detail})`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatToolList(tools, statuses) {
  if (!statuses.length) {
    return tools.join(", ");
  }
  const statusesByTool = new Map(statuses.map((status) => [status.tool, status]));
  return tools
    .map((tool) => {
      const status = statusesByTool.get(tool);
      return status ? `${tool} ${status.available ? "ok" : "missing"}` : tool;
    })
    .join(", ");
}

function quoteShellArg(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sumBundleBytes(sources) {
  return sources.reduce((total, source) => total + Number(source.size ?? 0), 0);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function parseArgs(argv) {
  const args = new Set(argv[0] === "--" ? argv.slice(1) : argv);
  const allowed = new Set(["--check", "--json", "--help"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return {
    check: args.has("--check"),
    json: args.has("--json"),
    help: args.has("--help"),
  };
}

function usage() {
  return [
    "Usage:",
    "  pnpm release:license-inventory",
    "  pnpm release:license-inventory -- --check",
    "  pnpm release:license-inventory -- --json",
  ].join("\n");
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const checklist = buildReleaseLicenseInventory({
    includeToolStatus: options.check,
    strictFlatpakProfiles: options.check,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(checklist, null, 2)}\n`);
  } else {
    process.stdout.write(formatReleaseLicenseInventory(checklist));
  }

  if (options.check && checklist.toolStatuses.some((status) => !status.available)) {
    return 1;
  }
  return 0;
}

if (process.argv[1] === __filename) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
