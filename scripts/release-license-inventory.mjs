import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelBundlePlan, DEFAULT_LYRICS_MODEL } from "./model-bundle-metadata.mjs";
import {
  defaultPackageOptions,
  packageOptionsToGeneratorArgs,
} from "./package-options.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const LV_CHORDIA_CHECKPOINT_BYTES = 28_730_939;
const LV_CHORDIA_SOURCE_REVISION = "9d7de7bbf45efa6731ec8dc62d35280f141c0702";

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
        label: "Default TensorFlow release dependency SBOM",
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
        label: "Opt-in ONNX release dependency SBOM",
        command: [
          "uv",
          "export",
          "--format",
          "cyclonedx1.5",
          "--frozen",
          "--all-groups",
          "--extra",
          "advanced-chords-onnx",
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
          "3.11",
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

export function buildReleaseLicenseInventory({ includeToolStatus = false, checkTool = checkToolAvailability } = {}) {
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
    includeBeatThis: defaultOptions.beatThis,
    includeCremaOnnx: true,
    lyricsModel: DEFAULT_LYRICS_MODEL,
  });
  const bundledManifestEntries = [
    ...bundledPlan.manifest.torch_checkpoints,
    ...bundledPlan.manifest.whisper_models,
  ];

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
        "cd apps/backend && uv run --python 3.11 --locked --all-groups " +
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
      defaultLyricsModel: DEFAULT_LYRICS_MODEL,
      explicitBundleSourceCount: bundledPlan.sources.length,
      explicitBundleBytes: sumBundleBytes(bundledManifestEntries),
      cremaOnnxBundleSourceCount: cremaOnnxBundledPlan.manifest.crema_onnx_files.length,
      cremaOnnxBundleBytes: sumBundleBytes(cremaOnnxBundledPlan.manifest.crema_onnx_files),
    },
    risks: [
      "Default release package commands must not pass --model-bundle.",
      "Plain Crema ONNX packages must not include model bytes; the explicit model bundle contains only the pinned files.",
      "Demucs pretrained-weight redistribution is unclear/restricted upstream.",
      "FFmpeg and ffprobe are host-installed and are not bundled.",
      "Python package license metadata can be incomplete; review missing fields manually.",
      "Do not commit redirected inventory reports or generated package resources.",
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

  const checklist = buildReleaseLicenseInventory({ includeToolStatus: options.check });
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
