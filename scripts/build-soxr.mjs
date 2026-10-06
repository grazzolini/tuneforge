import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSoxr } from "./build-soxr-runtime.mjs";

export * from "./build-soxr-runtime.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSoxr(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
