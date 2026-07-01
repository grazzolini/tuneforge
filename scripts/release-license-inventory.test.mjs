import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseLicenseInventory,
  collectToolStatuses,
  formatReleaseLicenseInventory,
  releaseInventoryCommands,
} from "./release-license-inventory.mjs";
import { DEFAULT_LYRICS_MODEL } from "./model-bundle-metadata.mjs";

test("release inventory commands cover JS, Python, and Rust without writing reports", () => {
  const checklist = buildReleaseLicenseInventory();
  const commandsById = new Map(checklist.inventoryCommands.map((command) => [command.id, command]));

  assert.deepEqual(Array.from(commandsById.keys()), ["javascript", "python", "rust"]);
  assert.equal(commandsById.get("javascript").commands[0].shell, "pnpm licenses list --recursive");
  assert.match(commandsById.get("python").commands[0].shell, /uv export .* --all-groups --all-extras/);
  assert.match(commandsById.get("python").commands[1].shell, /python -m pip inspect --local/);
  assert.equal(
    commandsById.get("rust").commands[0].shell,
    "cd apps/desktop/src-tauri && cargo about generate --format json --locked",
  );
  for (const command of checklist.inventoryCommands) {
    assert.equal(command.writesFiles, false);
  }
});

test("model policy documents default no-bundle packaging and explicit bundle commands", () => {
  const checklist = buildReleaseLicenseInventory();

  assert.equal(checklist.modelPolicy.defaultPackageOptions.modelBundle, false);
  assert.ok(
    checklist.modelPolicy.defaultPackageCommands.every((entry) => !entry.command.includes("--model-bundle")),
  );
  assert.ok(
    checklist.modelPolicy.explicitModelBundleCommands.every((entry) => entry.command.includes("--model-bundle")),
  );
  assert.ok(checklist.modelPolicy.cachePaths.includes("~/.cache/torch/hub/checkpoints"));
  assert.ok(checklist.modelPolicy.cachePaths.includes("~/.cache/whisper"));
  assert.ok(checklist.modelPolicy.explicitBundleSourceCount > 0);
  assert.ok(checklist.modelPolicy.explicitBundleBytes > 0);
});

test("model policy output is stable when lyrics model env is overridden", () => {
  const baseline = withLyricsModelEnv(undefined, () => buildReleaseLicenseInventory().modelPolicy);
  const overridden = withLyricsModelEnv("tiny", () => buildReleaseLicenseInventory().modelPolicy);

  assert.equal(overridden.defaultLyricsModel, DEFAULT_LYRICS_MODEL);
  assert.equal(overridden.explicitBundleSourceCount, baseline.explicitBundleSourceCount);
  assert.equal(overridden.explicitBundleBytes, baseline.explicitBundleBytes);
  assert.deepEqual(overridden.defaultPackageOptions, baseline.defaultPackageOptions);
});

test("tool status collection can report missing cargo-about without throwing", () => {
  const statuses = collectToolStatuses(releaseInventoryCommands, {
    checkTool(tool) {
      return {
        tool,
        available: tool !== "cargo-about",
        detail: tool === "cargo-about" ? "cargo-about not found" : "available",
      };
    },
  });

  assert.deepEqual(
    statuses.map((status) => [status.tool, status.available]),
    [
      ["pnpm", true],
      ["uv", true],
      ["cargo", true],
      ["cargo-about", false],
    ],
  );
  assert.match(formatReleaseLicenseInventory(buildReleaseLicenseInventory({
    includeToolStatus: true,
    checkTool(tool) {
      return statuses.find((status) => status.tool === tool);
    },
  })), /cargo-about missing/);
});

function withLyricsModelEnv(value, callback) {
  const originalValue = process.env.TUNEFORGE_LYRICS_MODEL;
  if (value === undefined) {
    delete process.env.TUNEFORGE_LYRICS_MODEL;
  } else {
    process.env.TUNEFORGE_LYRICS_MODEL = value;
  }

  try {
    return callback();
  } finally {
    if (originalValue === undefined) {
      delete process.env.TUNEFORGE_LYRICS_MODEL;
    } else {
      process.env.TUNEFORGE_LYRICS_MODEL = originalValue;
    }
  }
}
