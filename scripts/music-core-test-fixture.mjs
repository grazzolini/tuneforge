import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flatpakSourceSnapshotInputs } from "./flatpak-source-snapshots.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

// Snapshot tests use source files and non-executable generated fixtures, never local build caches.
export function populateFlatpakSnapshotFixture(destination) {
  const inputs = [...new Set(Object.values(flatpakSourceSnapshotInputs).flat()
    .map(input => typeof input === "string" ? input : input.source))];
  const generated = ["packages/music-core/vendor/gingo-src", "packages/music-core/build/artifacts/wasm"];
  const sourceInputs = inputs.filter(input => !generated.includes(input));
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repository, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const input of sourceInputs) {
    if (statSync(path.join(repository, input)).isDirectory()) mkdirSync(path.join(destination, input), { recursive: true });
  }
  for (const file of files) {
    if (!sourceInputs.some(input => file === input || file.startsWith(input + "/")) ||
      !existsSync(path.join(repository, file))) continue;
    const target = path.join(destination, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repository, file), target);
  }
  const sourcePath = "cpp/snapshot-fixture.cpp";
  const bytes = Buffer.from("// Synthetic snapshot source; never compiled.\n");
  const vendor = path.join(destination, generated[0], sourcePath);
  mkdirSync(path.dirname(vendor), { recursive: true });
  writeFileSync(vendor, bytes);
  const lockPath = path.join(destination, "packages/music-core/sources.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.files = [{ path: sourcePath, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") }];
  writeFileSync(lockPath, JSON.stringify(lock));
  const wasm = path.join(destination, generated[1]);
  mkdirSync(wasm, { recursive: true });
  for (const name of ["manifest.json", "music-core.mjs", "music-core.wasm"])
    writeFileSync(path.join(wasm, name), "Synthetic snapshot fixture: " + name + "\n");
}
