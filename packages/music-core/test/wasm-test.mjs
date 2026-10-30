import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const args of [["tools/build.mjs", "--target", "wasm", "--check"], ["tools/generate_types.mjs", "--check"], ["test/artifact-metadata.mjs"], ["test/wasm-boundary.mjs"], ["test/runtime-parity.mjs"]]) {
  execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
}
