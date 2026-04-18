import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(__filename), "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");
const backendRoot = path.resolve(workspaceRoot, "apps", "backend");
const openApiJson = path.resolve(packageRoot, "openapi.json");
const generatedPath = path.resolve(packageRoot, "src", "generated", "openapi.ts");

execFileSync(
  "uv",
  [
    "run",
    "--project",
    backendRoot,
    "--python",
    "3.11",
    "python",
    "-m",
    "app.export_openapi",
    openApiJson,
  ],
  { stdio: "inherit", cwd: workspaceRoot },
);

execFileSync(
  "pnpm",
  ["exec", "openapi-typescript", openApiJson, "-o", generatedPath],
  { stdio: "inherit", cwd: packageRoot },
);

