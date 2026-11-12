import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const producerDir = path.join(repoRoot, "packaging/demucs-android");
const markerBegin = "// TUNEFORGE-DEMUCS-PACKAGING-BEGIN";
const markerEnd = "// TUNEFORGE-DEMUCS-PACKAGING-END";
const xmlMarker = "<!-- TUNEFORGE-DEMUCS-EXTRACTION -->";
const stageVariable = "TUNEFORGE_ANDROID_PACKAGE_STAGING";
const launcher = "libtuneforge_demucs_python.so";
const pythonArgs = ["run", "--no-project", "--python", "3.14"];

function runPython(script, args, env, capture = false) {
  const result = spawnSync("uv", [...pythonArgs, path.join(producerDir, script), ...args], {
    cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Android Demucs ${script} failed.`, { cause: result.error });
  }
  return capture ? JSON.parse(result.stdout) : undefined;
}

export function cleanAndroidDemucsStaging(androidDir) {
  const main = path.join(androidDir, "app/src/main");
  const gradleFile = path.join(androidDir, "app/build.gradle.kts");
  const manifestFile = path.join(main, "AndroidManifest.xml");
  const gradle = fs.readFileSync(gradleFile, "utf8");
  const cleanGradle = gradle.replace(new RegExp(`\\n?${markerBegin}[\\s\\S]*?${markerEnd}\\r?\\n?`, "g"), "");
  if (cleanGradle !== gradle) fs.writeFileSync(gradleFile, cleanGradle);
  const manifest = fs.readFileSync(manifestFile, "utf8");
  if (manifest.includes(xmlMarker)) {
    fs.writeFileSync(manifestFile, manifest.replace(`${xmlMarker}\n`, "")
      .replace(/\s+android:extractNativeLibs="true"/, ""));
  }
  for (const name of ["assets/demucs-runtime", "assets/models", `jniLibs/arm64-v8a/${launcher}`]) {
    fs.rmSync(path.join(main, name), { recursive: true, force: true });
  }
}

function defaultInputCache(env) {
  const homeCache = process.platform === "darwin" ? path.join(os.homedir(), "Library/Caches")
    : path.join(os.homedir(), ".cache");
  return path.join(env.XDG_CACHE_HOME || homeCache, "tuneforge-dev", "android-demucs");
}

export function produceAndroidDemucsRuntime({ stagingRoot, ndk, readelf, env }) {
  const root = path.join(stagingRoot, "runtime");
  const cache = path.resolve(env.TUNEFORGE_ANDROID_DEMUCS_INPUT_CACHE ?? defaultInputCache(env));
  console.log("[android package] building the verified Android Demucs runtime");
  const receipt = runPython("build_runtime.py", ["--cache", cache, "--output", root, "--ndk", ndk,
    "--readelf", readelf, ...(env.TUNEFORGE_ANDROID_DEMUCS_OFFLINE === "1" ? ["--offline"] : [])], env, true);
  runPython("validate_runtime.py", ["--root", root, "--readelf", readelf,
    "--expected-manifest-sha256", receipt.manifestSha256], env);
  return { root, receipt };
}

export function prepareAndroidDemucsRuntime({
  androidDir, stagingRoot, ndk, readelf, env = process.env, produce = produceAndroidDemucsRuntime,
}) {
  const { root, receipt } = produce({ stagingRoot, ndk, readelf, env });
  const assets = path.join(stagingRoot, "assets/demucs-runtime");
  const executable = path.join(stagingRoot, "jniLibs/arm64-v8a", launcher);
  const descriptor = fs.readFileSync(path.join(root, "manifest.json"));
  if (crypto.createHash("sha256").update(descriptor).digest("hex") !== receipt.manifestSha256) {
    throw new Error("Android Demucs staging manifest differs from the producer receipt.");
  }
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(assets, "manifest.json"), descriptor);
  fs.renameSync(path.join(root, "runtime.zip"), path.join(assets, "runtime.zip"));
  fs.renameSync(path.join(root, launcher), executable);
  fs.appendFileSync(path.join(androidDir, "app/build.gradle.kts"), `
${markerBegin}
System.getenv("${stageVariable}")?.let { stage ->
    android {
        sourceSets.getByName("main").assets.srcDir("$stage/assets")
        sourceSets.getByName("main").jniLibs.srcDir("$stage/jniLibs")
        packaging {
            jniLibs {
                useLegacyPackaging = true
                keepDebugSymbols += "**/${launcher}"
            }
        }
    }
}
${markerEnd}
`);
  return { assets, executable, receipt, env: { [stageVariable]: stagingRoot } };
}

export function validateAndroidDemucsApk({ apk, readelf, receipt, modelManifestSha256, report, env }) {
  runPython("validate_runtime.py", ["--apk", apk, "--readelf", readelf,
    "--expected-manifest-sha256", receipt.manifestSha256, "--expected-model-manifest-sha256", modelManifestSha256,
    "--report", report], env);
}
