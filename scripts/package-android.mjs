import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectAndroidTools } from "./validate-android-release-jni.mjs";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const desktopDir = path.join(repoRoot, "apps/desktop");
const androidDir = path.join(desktopDir, "src-tauri/gen/android");
const tauriCli = path.join(desktopDir, "node_modules/.bin/tauri");
const androidEnv = path.join(scriptDir, "android-arm64-env.sh");
const prepareGenerated = path.join(scriptDir, "android-prepare-generated.sh");
const generatedMarkers = [
  ["app/build.gradle.kts", "file"], ["app/src/main/AndroidManifest.xml", "file"],
  ["app/src/main/java/com/tuneforge/desktop/MainActivity.kt", "file"],
  ["app/src/main/res", "directory"],
  ["gradle/wrapper/gradle-wrapper.jar", "file"], ["gradle/wrapper/gradle-wrapper.properties", "file"],
  ["gradlew", "executable"],
  ["settings.gradle", "file"],
];
function capture(command, args, { cwd = repoRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}
function run(command, args, { cwd = repoRoot, env = process.env, label } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${label ?? path.basename(command)} failed.`);
}
function executable(candidate) { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } }
function directory(candidate) { try { return fs.statSync(candidate).isDirectory(); } catch { return false; } }
export function resolveJava(
  { env = process.env, hostPlatform = process.platform, runCapture = capture, isExecutable = executable } = {},
) {
  const candidates = env.JAVA_HOME ? [env.JAVA_HOME] : [];
  if (hostPlatform === "darwin") {
    const system = runCapture("/usr/libexec/java_home", ["-v", "17"]);
    if (system.ok) candidates.push(system.output.split(/\r?\n/)[0]);
    candidates.push("/opt/homebrew/opt/openjdk@17", "/usr/local/opt/openjdk@17");
  }
  for (const home of candidates.map((candidate) => path.resolve(candidate))) {
    const java = path.join(home, "bin/java");
    if (!isExecutable(java) || !isExecutable(path.join(home, "bin/javac"))) continue;
    const result = runCapture(java, ["-version"]);
    if (result.ok && /(?:java|openjdk) version "17(?:[."])/i.test(result.output)) {
      return { home, version: result.output.match(/17(?:\.\d+)+/)?.[0] ?? "17" };
    }
  }
  throw new Error("JDK 17 not found. Install Homebrew openjdk@17 or set JAVA_HOME to JDK 17.");
}
export function resolveSdk(
  { env = process.env, homeDir = os.homedir(), runCapture = capture, isDirectory = directory } = {},
) {
  const configured = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]
    .filter(Boolean).map((candidate) => path.resolve(candidate));
  if (new Set(configured).size > 1) throw new Error("ANDROID_HOME and ANDROID_SDK_ROOT must identify the same SDK.");
  const info = runCapture("android", ["info", "sdk"]);
  const reported = info.ok ? info.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) : "";
  const candidates = [configured[0], reported, path.join(homeDir, "Library/Android/sdk")].filter(Boolean);
  const sdk = candidates.map((candidate) => path.resolve(candidate)).find(isDirectory);
  if (sdk) return sdk;
  throw new Error("Android SDK not found. Set matching ANDROID_HOME/ANDROID_SDK_ROOT values.");
}
export function resolveNdk(sdk, { env = process.env, runCapture = capture } = {}) {
  const result = runCapture("bash", [androidEnv, "/usr/bin/printenv", "ANDROID_NDK_HOME"],
    { env: { ...env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } });
  if (!result.ok) throw new Error(`Android NDK discovery failed: ${result.output}`);
  const ndk = path.resolve(result.output.split(/\r?\n/).filter(Boolean).at(-1));
  const version = fs.readFileSync(path.join(ndk, "source.properties"), "utf8")
    .match(/^Pkg\.Revision\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!version) throw new Error(`Selected Android NDK revision is missing: ${ndk}`);
  return { path: ndk, version };
}
export function requireExecutables(candidates, isExecutable = executable) {
  const missing = candidates.find((candidate) => !isExecutable(candidate));
  if (missing) throw new Error(`Required Android tool missing or not executable: ${missing}`);
}
function requireTools(sdk, runCapture = capture) {
  const tools = selectAndroidTools(sdk);
  requireExecutables([...Object.values(tools).filter((value) => path.isAbsolute(value)), tauriCli]);
  if (!fs.existsSync(path.join(sdk, "platforms/android-36/android.jar"))) {
    throw new Error("Android API 36 platform is not installed.");
  }
  const rust = runCapture("rustup", ["target", "list", "--installed"]);
  if (!rust.ok || !rust.output.split(/\s+/).includes("aarch64-linux-android")) {
    throw new Error("Rust target aarch64-linux-android is not installed.");
  }
  return tools;
}
export function generatedState(baseDir = androidDir) {
  if (!fs.existsSync(baseDir)) return { state: "absent", missing: [] };
  const missing = generatedMarkers.filter(([relative, type]) => {
    const candidate = path.join(baseDir, relative);
    try {
      const stat = fs.statSync(candidate);
      return type === "directory" ? !stat.isDirectory() : !stat.isFile() ||
        (type === "executable" && !executable(candidate));
    } catch { return true; }
  }).map(([relative]) => relative);
  return missing.length ? { state: "partial", missing } : { state: "complete", missing: [] };
}
export function configureReleaseDebugSigning(buildFile = path.join(androidDir, "app/build.gradle.kts")) {
  const contents = fs.readFileSync(buildFile, "utf8");
  const line = '            signingConfig = signingConfigs.getByName("debug")';
  if (contents.includes(line)) return false;
  const marker = '        getByName("release") {\n            isMinifyEnabled = true';
  if (!contents.includes(marker)) throw new Error("Generated release build marker not found.");
  fs.writeFileSync(buildFile, contents.replace(marker, `        getByName("release") {\n${line}\n            isMinifyEnabled = true`));
  return true;
}
export function artifactFromMetadata(raw, debug, metadataPath) {
  const metadata = JSON.parse(raw);
  const mode = debug ? "debug" : "release";
  const variant = `universal${debug ? "Debug" : "Release"}`;
  const outputFile = `app-universal-${mode}.apk`;
  if (metadata.variantName !== variant || metadata.elements?.length !== 1 ||
      metadata.elements[0].outputFile !== outputFile) throw new Error(`Expected exact ${variant} APK metadata.`);
  return path.join(path.dirname(metadataPath), outputFile);
}
export function pinnedEnv(java, sdk, ndk, { env = process.env, homeDir = os.homedir() } = {}) {
  return { ...env, CI: "true", JAVA_HOME: java.home, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
    ANDROID_NDK_HOME: ndk.path, ANDROID_NDK_ROOT: ndk.path, ANDROID_USER_HOME: path.join(homeDir, ".android"),
    ANDROID_SDK_HOME: homeDir, ANDROID_PREFS_ROOT: homeDir,
    CARGO_TARGET_DIR: path.join(desktopDir, "src-tauri/target", `android-ndk-${ndk.version.replaceAll(".", "-")}`),
    PATH: `${path.join(java.home, "bin")}${path.delimiter}${env.PATH ?? ""}` };
}
function verifySpecific(debug, tools, env) {
  const mode = debug ? "debug" : "release";
  const metadataPath = path.join(androidDir, `app/build/outputs/apk/universal/${mode}/output-metadata.json`);
  const apk = artifactFromMetadata(fs.readFileSync(metadataPath, "utf8"), debug, metadataPath);
  if (!fs.statSync(apk, { throwIfNoEntry: false })?.isFile()) throw new Error(`APK missing: ${apk}`);
  if (!debug) {
    const mapping = path.join(androidDir, "app/build/outputs/mapping/universalRelease/mapping.txt");
    if (!fs.statSync(mapping, { throwIfNoEntry: false })?.size) throw new Error(`Release mapping missing or empty: ${mapping}`);
  } else {
    if (!capture(tools.apksigner, ["verify", apk], { env }).ok) throw new Error(`APK signature invalid: ${apk}`);
    const badging = capture(tools.aapt2, ["dump", "badging", apk], { env });
    if (!badging.ok || !/\bapplication-debuggable\b/.test(badging.output)) {
      throw new Error(`Debug APK is not debuggable: ${apk}`);
    }
  }
  return apk;
}
export function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== "--debug") || argv.length > 1) throw new Error("Usage: package-android.mjs [--debug]");
  const debug = argv.includes("--debug");
  const mode = debug ? "debug" : "release";
  console.log(`[android package] preparation (${mode})`);
  const java = resolveJava();
  const sdk = resolveSdk();
  const ndk = resolveNdk(sdk);
  const env = pinnedEnv(java, sdk, ndk);
  const tools = requireTools(sdk);
  const keystore = path.join(os.homedir(), ".android/debug.keystore");
  if (!fs.statSync(keystore, { throwIfNoEntry: false })?.isFile()) throw new Error(`Existing debug keystore required: ${keystore}`);
  console.log(`[android package] JDK ${java.version}; SDK ${sdk}; NDK ${ndk.version} (${ndk.path})`);
  const state = generatedState();
  if (state.state === "partial") throw new Error(`Generated Android project is partial: ${state.missing.join(", ")}`);
  if (state.state === "absent") run("bash", [androidEnv, tauriCli, "android", "init", "--ci", "--skip-targets-install"],
    { cwd: desktopDir, env, label: "Tauri Android init" });
  const ready = generatedState();
  if (ready.state !== "complete") throw new Error(`Generated Android project incomplete: ${ready.missing.join(", ")}`);
  configureReleaseDebugSigning();
  run(tauriCli, ["icon", "--output", "src-tauri/target/android-icons", "src-tauri/icons/icon.png"],
    { cwd: desktopDir, env, label: "Android icon generation" });
  run("bash", [prepareGenerated], { env, label: "Generated Android preparation" });
  console.log(`[android package] build (${mode})`);
  const args = [androidEnv, tauriCli, "android", "build", "--ci", "--target", "aarch64", "--apk"];
  if (debug) args.push("--debug");
  run("bash", args, { cwd: desktopDir, env, label: `Tauri Android ${mode} build` });
  requireExecutables(debug ? [tools.aapt2, tools.apksigner] : [tools.aapt2, tools.apksigner, tools.dexdump]);
  const apk = verifySpecific(debug, tools, env);
  if (!debug) run(process.execPath, [path.join(scriptDir, "validate-android-release-jni.mjs")],
    { env, label: "Android release JNI validation" });
  console.log(`[android package] ${debug ? "debug" : "optimized release-profile"} APK: ${apk}`);
  console.log(`[android package] completion (${mode}, debug-key signed)`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`[android package] failure: ${error.message}`); process.exitCode = 1; }
}
