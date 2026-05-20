import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(__filename), "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");
const backendRoot = path.resolve(workspaceRoot, "apps", "backend");
const legacyNvidiaMarker = path.resolve(backendRoot, ".venv", ".tuneforge-legacy-nvidia");
const openApiJson = path.resolve(packageRoot, "openapi.json");
const generatedPath = path.resolve(packageRoot, "src", "generated", "openapi.ts");

function backendVenvPython() {
  return path.resolve(backendRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

if (existsSync(legacyNvidiaMarker)) {
  const python = backendVenvPython();
  if (!existsSync(python)) {
    throw new Error("Legacy NVIDIA backend marker is present, but apps/backend/.venv is missing.");
  }

  execFileSync(python, ["-m", "app.export_openapi", openApiJson], {
    stdio: "inherit",
    cwd: backendRoot,
    env: {
      ...process.env,
      PYTORCH_ENABLE_MPS_FALLBACK: process.env.PYTORCH_ENABLE_MPS_FALLBACK ?? "1",
    },
  });
} else {
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
}

execFileSync(
  "pnpm",
  ["exec", "openapi-typescript", openApiJson, "-o", generatedPath, "--default-non-nullable", "false"],
  { stdio: "inherit", cwd: packageRoot },
);
