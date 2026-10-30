import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { build } = await import(require.resolve("vite"));

test("production boot defers modules that synchronously need the initialized music core", async () => {
  // Inspect the real production graph without executing any generated application assets.
  const result = await build({
    root: desktop,
    configFile: `${desktop}vite.config.ts`,
    logLevel: "silent",
    build: { write: false },
  });
  const chunks = result.output.filter((output) => output.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry);
  assert.ok(entry, "production entry chunk exists");
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  function reachable(start, dynamic = false, visited = new Set()) {
    if (visited.has(start.fileName)) return visited;
    visited.add(start.fileName);
    for (const name of [...start.imports, ...(dynamic ? start.dynamicImports : [])]) {
      const chunk = byName.get(name);
      if (chunk) reachable(chunk, dynamic, visited);
    }
    return visited;
  }
  const eager = reachable(entry);
  const all = reachable(entry, true);
  for (const module of ["/src/lib/music.ts", "/src/lib/instrumentKnowledge.ts"]) {
    const owners = chunks.filter((chunk) => Object.keys(chunk.modules).some((id) => id.endsWith(module)));
    if (module.endsWith("/music.ts")) assert.ok(owners.length, `${module} remains in the application`);
    assert.ok(owners.every((chunk) => all.has(chunk.fileName)), `${module} is reachable after boot`);
    assert.ok(owners.every((chunk) => !eager.has(chunk.fileName)), `${module} must load after core initialization`);
  }
});
