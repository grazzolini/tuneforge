import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectAndroidTools } from "./validate-android-release-jni.mjs";
import { validateSoxrOutput } from "./build-soxr.mjs";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const desktopDir = path.join(repoRoot, "apps/desktop");
const androidDir = path.join(desktopDir, "src-tauri/gen/android");
const tauriCli = path.join(desktopDir, "node_modules/.bin/tauri");
const androidEnv = path.join(scriptDir, "android-arm64-env.sh");
const prepareGenerated = path.join(scriptDir, "android-prepare-generated.sh");
const prepareModelAssets = path.join(scriptDir, "prepare-android-model-assets.mjs");
const defaultFfmpegRoot = path.join(repoRoot, "packaging/ffmpeg/generated/android-arm64-v8a");
const defaultSoxrRoot = path.join(repoRoot, "packaging/soxr/generated/android-arm64-v8a");
const packageLock = path.join(desktopDir, "src-tauri/target/.tuneforge-android-package.lock");
const publishableVariables = [
  "TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH", "TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS",
  "TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD", "TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD",
  "TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256",
];
const signingBlocks = [["// TUNEFORGE-PUBLISHABLE-SIGNING-BEGIN", "// TUNEFORGE-PUBLISHABLE-SIGNING-END"],
  ["// TUNEFORGE-PUBLISHABLE-RELEASE-BEGIN", "// TUNEFORGE-PUBLISHABLE-RELEASE-END"],
  ["// TUNEFORGE-LOCAL-SIGNING-BEGIN", "// TUNEFORGE-LOCAL-SIGNING-END"],
  ["// TUNEFORGE-LOCAL-BUILD-BEGIN", "// TUNEFORGE-LOCAL-BUILD-END"],
  ["// TUNEFORGE-LOCAL-RELEASE-BEGIN", "// TUNEFORGE-LOCAL-RELEASE-END"]];
const debugSigningLine = '            signingConfig = signingConfigs.getByName("debug")';
const generatedMarkers = [
  ["app/build.gradle.kts", "file"], ["app/src/main/AndroidManifest.xml", "file"],
  ["app/src/main/java/com/tuneforge/desktop/MainActivity.kt", "file"],
  ["app/src/main/res", "directory"], ["gradle/wrapper/gradle-wrapper.jar", "file"],
  ["gradle/wrapper/gradle-wrapper.properties", "file"], ["gradlew", "executable"], ["settings.gradle", "file"],
];
const executorchAarSha256 = "a4a836b9fadd5b9afdf07b8533b2c3326695d04a58dd37e2cdfe709e804854fb";
export const onnxRuntimeAndroidArtifact = Object.freeze({
  coordinate: "com.microsoft.onnxruntime:onnxruntime-android:1.29.0",
  version: "1.29.0",
  license: "MIT",
  size: 51_897_836,
  sha256: "e97540ca78fe36f6fe2013f82843414fb843b6c7681fb04644cba5e1406662dd",
});
function capture(command, args, { cwd = repoRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}
function sensitiveCapture(command, args, { cwd = repoRoot, env = process.env, binary = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: binary ? null : "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return { ok: !result.error && result.status === 0, output: result.stdout ?? (binary ? Buffer.alloc(0) : "") };
}
function run(command, args, { cwd = repoRoot, env = process.env, label } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${label ?? path.basename(command)} failed.`);
}
function executable(candidate) { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } }
function directory(candidate) { try { return fs.statSync(candidate).isDirectory(); } catch { return false; } }
export function parseMode(argv) {
  if (argv.length === 0) return "local-release";
  if (argv.length === 1 && argv[0] === "--prepare") return "prepare";
  if (argv.length === 1 && argv[0] === "--debug") return "debug";
  if (argv.length === 1 && argv[0] === "--publishable") return "publishable";
  throw new Error("Usage: package-android.mjs [--prepare|--debug|--publishable]");
}
export function parseAndroidOptions(argv) {
  let modelBundle = false;
  let profile = false;
  let testIdentity = false;
  let packageName;
  const modeArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    } else if (value === "--model-bundle") {
      if (modelBundle) throw new Error("--model-bundle may be supplied only once.");
      modelBundle = true;
    } else if (value === "--profile") {
      if (profile) throw new Error("--profile may be supplied only once.");
      profile = true;
    } else if (value === "--test-identity") {
      if (testIdentity) throw new Error("--test-identity may be supplied only once.");
      testIdentity = true;
    } else if (value === "--package-name") {
      if (packageName !== undefined) throw new Error("--package-name may be supplied only once.");
      packageName = argv[index + 1];
      if (!packageName || packageName.startsWith("--")) throw new Error("--package-name requires an Android application ID.");
      index += 1;
    } else {
      modeArgs.push(value);
    }
  }
  const mode = parseMode(modeArgs);
  if (profile && mode !== "local-release") {
    throw new Error("--profile is allowed only for the optimized local release-profile build.");
  }
  if ((testIdentity || packageName !== undefined) && ["prepare", "publishable"].includes(mode)) {
    throw new Error("Android identity options are allowed only for local debug or release-profile builds.");
  }
  if (packageName !== undefined) validateLocalPackageName(packageName);
  return { mode, modelBundle, profile, testIdentity, packageName };
}

export function validateLocalPackageName(value) {
  if (value === "com.tuneforge.desktop") throw new Error("The production Android application ID is reserved for publishable builds.");
  const segments = value.split(".");
  if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(segment))) {
    throw new Error("--package-name must be a valid Android application ID with at least two segments.");
  }
  return value;
}
export function sanitizedEnv(env = process.env) {
  const result = { ...env };
  for (const name of publishableVariables) delete result[name];
  return result;
}
export function publishableBuildEnv(baseEnv, sourceEnv) {
  const result = sanitizedEnv(baseEnv);
  for (const name of publishableVariables.slice(0, 4)) result[name] = sourceEnv[name];
  return result;
}
export function acquirePackagingLock(lockPath = packageLock, {
  token = crypto.randomUUID(), mkdir = fs.mkdirSync, write = fs.writeFileSync,
  read = fs.readFileSync, remove = fs.rmSync,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try { mkdir(lockPath); } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Android packaging is already locked. If the lock is stale, verify no packaging process is active before removing it manually.");
    }
    throw error;
  }
  const owner = path.join(lockPath, "owner");
  try { write(owner, token, { flag: "wx", mode: 0o600 }); } catch (error) {
    remove(lockPath, { recursive: true, force: true });
    throw error;
  }
  return {
    token,
    release() {
      if (!fs.existsSync(lockPath)) return true;
      let current;
      try { current = read(owner, "utf8"); } catch { current = undefined; }
      if (current !== token) return false;
      try { remove(lockPath, { recursive: true, force: true }); } catch { return false; }
      return true;
    },
  };
}
export function normalizeFingerprint(value) {
  const fingerprint = value.trim();
  if (/^[0-9a-f]{64}$/i.test(fingerprint)) return fingerprint.toLowerCase();
  if (/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(fingerprint)) {
    return fingerprint.replaceAll(":", "").toLowerCase();
  }
  throw new Error("Publishable certificate fingerprint must be 64 hex characters or 32 colon-separated bytes.");
}
export function readPublishableConfig(env = process.env, { statFile = fs.statSync, access = fs.accessSync } = {}) {
  const missing = publishableVariables.filter((name) => typeof env[name] !== "string" || env[name].length === 0);
  if (missing.length) throw new Error(`Publishable signing environment is incomplete: ${missing.join(", ")}.`);
  const keystore = env.TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH;
  if (!path.isAbsolute(keystore)) throw new Error("Publishable keystore path must be absolute.");
  let stat;
  try { stat = statFile(keystore); access(keystore, fs.constants.R_OK); } catch {
    throw new Error("Publishable keystore must be a readable regular file."); }
  if (!stat.isFile()) throw new Error("Publishable keystore must be a readable regular file.");
  return {
    keystore,
    alias: env.TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS,
    expectedFingerprint: normalizeFingerprint(env.TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256),
  };
}
export function validatePublishableCredentials(java, config, {
  env = process.env, runSensitive = sensitiveCapture, tempRoot = os.tmpdir(),
} = {}) {
  const keytool = path.join(java.home, "bin/keytool");
  const jar = path.join(java.home, "bin/jar");
  const jarsigner = path.join(java.home, "bin/jarsigner");
  requireExecutables([keytool, jar, jarsigner]);
  const cleanEnv = sanitizedEnv(env);
  const storeEnv = {
    ...cleanEnv,
    TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD: env.TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD,
  };
  const keyEnv = {
    ...storeEnv,
    TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD: env.TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD,
  };
  const storeArgs = ["-keystore", config.keystore, "-storetype", "PKCS12",
    "-storepass:env", "TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD"];
  if (!runSensitive(keytool, ["-list", ...storeArgs], { env: storeEnv }).ok) {
    throw new Error("Publishable PKCS12 or store password validation failed.");
  }
  const certificate = runSensitive(keytool, ["-exportcert", "-alias", config.alias, ...storeArgs],
    { env: storeEnv, binary: true });
  if (!certificate.ok || !Buffer.isBuffer(certificate.output) || certificate.output.length === 0) {
    throw new Error("Publishable certificate alias validation failed.");
  }
  const fingerprint = crypto.createHash("sha256").update(certificate.output).digest("hex");
  if (fingerprint !== config.expectedFingerprint) {
    throw new Error("Publishable certificate fingerprint does not match the expected SHA-256 value.");
  }
  const temporary = fs.mkdtempSync(path.join(tempRoot, "tuneforge-android-signing-"));
  try {
    const empty = path.join(temporary, "empty");
    const unsigned = path.join(temporary, "unsigned.jar");
    const signed = path.join(temporary, "signed.jar");
    fs.mkdirSync(empty);
    if (!runSensitive(jar, ["--create", "--file", unsigned, "-C", empty, "."], { env: cleanEnv }).ok) {
      throw new Error("JDK signing probe preparation failed.");
    }
    const result = runSensitive(jarsigner, ["-keystore", config.keystore, "-storetype", "PKCS12",
      "-storepass:env", "TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD",
      "-keypass:env", "TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD", "-signedjar", signed,
      unsigned, config.alias], { env: keyEnv });
    if (!result.ok || !fs.statSync(signed, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("Publishable private key or key password validation failed.");
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return fingerprint;
}
export function resolveJava(
  { env = process.env, hostPlatform = process.platform, runCapture = capture, isExecutable = executable } = {},
) {
  const candidates = env.JAVA_HOME ? [env.JAVA_HOME] : [];
  if (hostPlatform === "darwin") {
    const system = runCapture("/usr/libexec/java_home", ["-v", "17"], { env });
    if (system.ok) candidates.push(system.output.split(/\r?\n/)[0]);
    candidates.push("/opt/homebrew/opt/openjdk@17", "/usr/local/opt/openjdk@17");
  }
  for (const home of candidates.map((candidate) => path.resolve(candidate))) {
    const java = path.join(home, "bin/java");
    if (!isExecutable(java) || !isExecutable(path.join(home, "bin/javac"))) continue;
    const result = runCapture(java, ["-version"], { env });
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
  const info = runCapture("android", ["info", "sdk"], { env });
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
function requireTools(sdk, runCapture = capture, env = process.env) {
  const tools = selectAndroidTools(sdk);
  requireExecutables([...Object.values(tools).filter((value) => path.isAbsolute(value)), tauriCli]);
  if (!fs.existsSync(path.join(sdk, "platforms/android-36/android.jar"))) {
    throw new Error("Android API 36 platform is not installed.");
  }
  const rust = runCapture("rustup", ["target", "list", "--installed"], { env });
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
export function preparedState(baseDir = androidDir) {
  const required = ["app/proguard-tuneforge.pro", "app/src/main/java/com/tuneforge/desktop/PowerInhibitionService.kt",
    "app/src/main/java/com/tuneforge/desktop/ModelAssetDescriptor.java",
    "app/src/main/java/com/tuneforge/desktop/BeatThisRunner.java",
    "app/src/main/java/com/tuneforge/desktop/CremaRunner.java",
    "app/src/main/java/com/tuneforge/desktop/WhisperModelInstaller.java",
    "app/src/main/java/com/tuneforge/desktop/InferenceLock.java",
    "app/src/main/res/values/ic_launcher_background.xml",
    "app/src/main/jniLibs/arm64-v8a/libavcodec.so",
    "app/src/main/jniLibs/arm64-v8a/libavfilter.so",
    "app/src/main/jniLibs/arm64-v8a/libavformat.so",
    "app/src/main/jniLibs/arm64-v8a/libavutil.so",
    "app/src/main/jniLibs/arm64-v8a/libswresample.so",
    "app/src/main/jniLibs/arm64-v8a/libmp3lame.so",
    "app/src/main/jniLibs/arm64-v8a/libsoxr.so",
    "app/src/main/assets/ffmpeg/provenance.json",
    "app/src/main/assets/soxr/provenance.json"];
  const missing = required.filter((relative) => !fs.statSync(path.join(baseDir, relative),
    { throwIfNoEntry: false })?.isFile());
  return { ready: missing.length === 0, missing };
}
export function verifyExecutorchAar(gradleHome) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.name === "executorch-android-1.4.0.aar") matches.push(candidate);
    }
  };
  const cache = path.join(gradleHome, "caches");
  if (fs.statSync(cache, { throwIfNoEntry: false })?.isDirectory()) visit(cache);
  if (!matches.some((file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === executorchAarSha256)) {
    throw new Error("ExecuTorch Android 1.4.0 AAR SHA-256 verification failed.");
  }
}
export function verifyOnnxRuntimeAar(gradleHome) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.name === "onnxruntime-android-1.29.0.aar") matches.push(candidate);
    }
  };
  const cache = path.join(gradleHome, "caches");
  if (fs.statSync(cache, { throwIfNoEntry: false })?.isDirectory()) visit(cache);
  if (!matches.some((file) => fs.statSync(file).size === onnxRuntimeAndroidArtifact.size &&
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === onnxRuntimeAndroidArtifact.sha256)) {
    throw new Error("ONNX Runtime Android 1.29.0 AAR size or SHA-256 verification failed.");
  }
}
export function requirePrepared(baseDir = androidDir) {
  const generated = generatedState(baseDir);
  const prepared = generated.state === "complete" ? preparedState(baseDir) : { ready: false };
  if (generated.state !== "complete" || !prepared.ready) throw new Error(
    "Android project is not prepared. Run pnpm package:android:prepare first.");
}
export function verifyPreparedSoxr(soxrRoot, baseDir = androidDir) {
  const pairs = [
    ["lib/libsoxr.so", "app/src/main/jniLibs/arm64-v8a/libsoxr.so"],
    ["provenance.json", "app/src/main/assets/soxr/provenance.json"],
  ];
  const provenance = path.join(soxrRoot, "provenance.json");
  let provenanceJson;
  try { provenanceJson = fs.readFileSync(provenance, "utf8"); } catch {
    throw new Error(`Verified Android libsoxr runtime is incomplete: ${soxrRoot}`);
  }
  if (!provenanceJson.includes('"-DWITH_PFFFT=ON"')) {
    throw new Error(`Verified Android libsoxr runtime does not use the required PFFFT profile: ${soxrRoot}`);
  }
  for (const [sourceRelative, stagedRelative] of pairs) {
    const source = path.join(soxrRoot, sourceRelative);
    const staged = path.join(baseDir, stagedRelative);
    let matches = false;
    try { matches = fs.readFileSync(source).equals(fs.readFileSync(staged)); } catch {}
    if (!matches) {
      throw new Error(
        `Generated Android libsoxr staging does not match the selected verified runtime (${stagedRelative}). ` +
        "Native Android preparation did not complete successfully.",
      );
    }
  }
}
export function verifyPreparedFfmpeg(ffmpegRoot, baseDir = androidDir) {
  const pairs = [
    ...["avcodec", "avfilter", "avformat", "avutil", "swresample", "mp3lame"]
      .map((name) => [`lib/lib${name}.so`, `app/src/main/jniLibs/arm64-v8a/lib${name}.so`]),
    ["provenance.json", "app/src/main/assets/ffmpeg/provenance.json"],
  ];
  for (const [sourceRelative, stagedRelative] of pairs) {
    let matches = false;
    try {
      matches = fs.readFileSync(path.join(ffmpegRoot, sourceRelative))
        .equals(fs.readFileSync(path.join(baseDir, stagedRelative)));
    } catch {}
    if (!matches) {
      throw new Error(
        `Generated Android FFmpeg staging does not match the selected verified runtime (${stagedRelative}). ` +
        "Native Android preparation did not complete successfully.",
      );
    }
  }
}

function prepareNativeProject({ env, ffmpegRoot, soxrRoot, sourceEnv = process.env }) {
  if (!sourceEnv.TUNEFORGE_ANDROID_FFMPEG_ROOT) {
    run(process.execPath, [path.join(scriptDir, "build-ffmpeg.mjs"),
      "--target", "android-arm64-v8a", "--ensure"], { env, label: "Android FFmpeg runtime build" });
  }
  if (!sourceEnv.TUNEFORGE_ANDROID_SOXR_ROOT) {
    run(process.execPath, [path.join(scriptDir, "build-soxr.mjs"),
      "--target", "android-arm64-v8a", "--ensure"], { env, label: "Android libsoxr runtime build" });
  }
  validateSoxrOutput(soxrRoot, "android-arm64-v8a", soxrValidationOptions(env));
  run(process.execPath, [path.join(scriptDir, "validate-packaged-ffmpeg.mjs"),
    "--target", "android-arm64-v8a", "--root", ffmpegRoot],
  { env, label: "Android FFmpeg runtime validation" });
  const state = generatedState();
  if (state.state === "partial") throw new Error(`Generated Android project is partial: ${state.missing.join(", ")}`);
  if (state.state === "absent") run("bash", [androidEnv, tauriCli, "android", "init", "--ci", "--skip-targets-install"],
    { cwd: desktopDir, env, label: "Tauri Android init" });
  if (generatedState().state !== "complete") throw new Error("Generated Android project initialization failed.");
  run(tauriCli, ["icon", "--output", "src-tauri/target/android-icons", "src-tauri/icons/icon.png"],
    { cwd: desktopDir, env, label: "Android icon generation" });
  run("bash", [prepareGenerated], { env, label: "Generated Android preparation" });
  requirePrepared();
  verifyPreparedFfmpeg(ffmpegRoot);
  verifyPreparedSoxr(soxrRoot);
}
export function soxrValidationOptions(env) {
  return { readelf: env.LLVM_READELF };
}
export function removeOwnedSigning(contents) {
  let result = contents;
  for (const [begin, end] of signingBlocks) {
    const pattern = new RegExp(`^[ \\t]*${begin.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*?^[ \\t]*${end.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\r?\\n?`, "gm");
    result = result.replace(pattern, "");
  }
  return result;
}
export function configureReleaseDebugSigning(buildFile = path.join(androidDir, "app/build.gradle.kts")) {
  const contents = removeOwnedSigning(fs.readFileSync(buildFile, "utf8"));
  if (contents.includes(debugSigningLine)) {
    if (contents !== fs.readFileSync(buildFile, "utf8")) fs.writeFileSync(buildFile, contents);
    return false;
  }
  const marker = '        getByName("release") {\n            isMinifyEnabled = true';
  if (!contents.includes(marker)) throw new Error("Generated release build marker not found.");
  fs.writeFileSync(buildFile, contents.replace(marker, `        getByName("release") {\n${debugSigningLine}\n            isMinifyEnabled = true`));
  return true;
}
export function configurePublishableSigning(contents) {
  const clean = removeOwnedSigning(contents);
  const buildTypes = "    buildTypes {";
  const release = '        getByName("release") {';
  if (!clean.includes(buildTypes) || !clean.includes(release)) throw new Error(
    "Generated signing insertion markers not found.");
  const withoutDebug = clean.replace(`${debugSigningLine}\n`, "");
  const signing = ["    // TUNEFORGE-PUBLISHABLE-SIGNING-BEGIN", "    signingConfigs {",
    '        create("tuneforgePublishable") {',
    '            storeFile = file(System.getenv("TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH"))',
    '            storeType = "PKCS12"',
    '            storePassword = System.getenv("TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD")',
    '            keyAlias = System.getenv("TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS")',
    '            keyPassword = System.getenv("TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD")',
    "        }", "    }", "    // TUNEFORGE-PUBLISHABLE-SIGNING-END", ""].join("\n");
  const selection = [release, "            // TUNEFORGE-PUBLISHABLE-RELEASE-BEGIN",
    '            signingConfig = signingConfigs.getByName("tuneforgePublishable")',
    "            // TUNEFORGE-PUBLISHABLE-RELEASE-END"].join("\n");
  return withoutDebug.replace(buildTypes, `${signing}${buildTypes}`).replace(release, selection);
}

const localKeyAlias = "tuneforge-test";
const localKeyPassword = "tuneforge-test";
export function ensureLocalTestKeystore(java, {
  homeDir = os.homedir(), env = process.env, runSensitive = sensitiveCapture,
} = {}) {
  const directory = path.join(homeDir, ".android");
  const keystore = path.join(directory, "tuneforge-test.keystore");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keytool = path.join(java.home, "bin/keytool");
  requireExecutables([keytool]);
  const keyEnv = { ...sanitizedEnv(env), TUNEFORGE_ANDROID_TEST_KEY_PASSWORD: localKeyPassword };
  if (!fs.existsSync(keystore)) {
    const temporary = path.join(directory, `.tuneforge-test.${crypto.randomUUID()}.keystore`);
    try {
      const generated = runSensitive(keytool, ["-genkeypair", "-alias", localKeyAlias,
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
        "-dname", "CN=TuneForge Android Local Test,O=TuneForge,C=US", "-keystore", temporary,
        "-storetype", "JKS", "-storepass:env", "TUNEFORGE_ANDROID_TEST_KEY_PASSWORD",
        "-keypass:env", "TUNEFORGE_ANDROID_TEST_KEY_PASSWORD", "-noprompt"], { env: keyEnv });
      if (!generated.ok) throw new Error("Local Android test keystore creation failed.");
      try { fs.linkSync(temporary, keystore); } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const listed = runSensitive(keytool, ["-list", "-alias", localKeyAlias, "-keystore", keystore,
    "-storetype", "JKS", "-storepass:env", "TUNEFORGE_ANDROID_TEST_KEY_PASSWORD"], { env: keyEnv });
  const certificate = runSensitive(keytool, ["-exportcert", "-alias", localKeyAlias,
    "-keystore", keystore, "-storetype", "JKS", "-storepass:env",
    "TUNEFORGE_ANDROID_TEST_KEY_PASSWORD"], { env: keyEnv, binary: true });
  if (!listed.ok || !certificate.ok || !Buffer.isBuffer(certificate.output) || certificate.output.length === 0) {
    throw new Error("Existing local Android test keystore is invalid; it was not replaced.");
  }
  fs.chmodSync(keystore, 0o600);
  return { path: keystore, alias: localKeyAlias, password: localKeyPassword,
    fingerprint: crypto.createHash("sha256").update(certificate.output).digest("hex") };
}

export function configureLocalBuild(contents, applicationId) {
  const clean = removeOwnedSigning(contents);
  const buildTypes = "    buildTypes {";
  const debug = '        getByName("debug") {';
  const release = '        getByName("release") {';
  const identity = '        applicationId = "com.tuneforge.desktop"';
  if (!clean.includes(buildTypes) || !clean.includes(debug) || !clean.includes(release) || !clean.includes(identity)) {
    throw new Error("Generated local Android build markers are missing.");
  }
  const signing = ["    // TUNEFORGE-LOCAL-SIGNING-BEGIN", "    signingConfigs {",
    '        create("tuneforgeLocal") {',
    '            storeFile = file(System.getenv("TUNEFORGE_ANDROID_TEST_KEYSTORE_PATH"))',
    '            storeType = "JKS"',
    '            storePassword = System.getenv("TUNEFORGE_ANDROID_TEST_KEY_PASSWORD")',
    '            keyAlias = "tuneforge-test"',
    '            keyPassword = System.getenv("TUNEFORGE_ANDROID_TEST_KEY_PASSWORD")',
    "        }", "    }", "    // TUNEFORGE-LOCAL-SIGNING-END", ""].join("\n");
  const selection = [debug, "            // TUNEFORGE-LOCAL-BUILD-BEGIN",
    '            signingConfig = signingConfigs.getByName("tuneforgeLocal")',
    "        // TUNEFORGE-LOCAL-BUILD-END"].join("\n");
  const configured = clean.replace(identity, `        applicationId = "${applicationId}"`)
    .replace(buildTypes, `${signing}${buildTypes}`)
    .replace(debug, selection)
    .replace(release, [release, "            // TUNEFORGE-LOCAL-RELEASE-BEGIN",
      '            signingConfig = signingConfigs.getByName("tuneforgeLocal")',
      "            // TUNEFORGE-LOCAL-RELEASE-END"].join("\n"));
  return configured;
}
export function configureProfileableManifest(contents) {
  if (/<profileable\b/.test(contents)) {
    throw new Error("Generated Android manifest already contains a profileable declaration.");
  }
  const application = /<application\b[\s\S]*?>/.exec(contents);
  if (!application) throw new Error("Generated Android application manifest marker is missing.");
  return contents.replace(application[0], `${application[0]}\n        <profileable android:shell="true" />`);
}
export function withTemporaryConfigurations(configurations, action, {
  read = (file) => fs.readFileSync(file, "utf8"), write = fs.writeFileSync,
} = {}) {
  const snapshots = configurations.map(({ file, configure }) => ({
    file, configure, contents: read(file),
  }));
  try {
    for (const snapshot of snapshots) write(snapshot.file, snapshot.configure(snapshot.contents));
    return action();
  } finally {
    let restoreError;
    for (const snapshot of snapshots.reverse()) {
      try { write(snapshot.file, snapshot.contents); } catch (error) { restoreError ??= error; }
    }
    if (restoreError) throw restoreError;
  }
}
export function artifactFromMetadata(raw, debug, metadataPath) {
  const metadata = JSON.parse(raw);
  const mode = debug ? "debug" : "release";
  const variant = `universal${debug ? "Debug" : "Release"}`;
  const element = metadata.elements?.[0];
  if (metadata.variantName !== variant || metadata.artifactType?.type !== "APK" ||
      metadata.elements?.length !== 1 || element?.type !== "SINGLE" ||
      !Array.isArray(element.filters) || element.filters.length !== 0 ||
      typeof element.outputFile !== "string" || path.isAbsolute(element.outputFile) ||
      !element.outputFile.endsWith(`-${mode}.apk`)) throw new Error(`Expected one safe unfiltered ${variant} APK metadata element.`);
  const output = path.resolve(path.dirname(metadataPath), element.outputFile);
  if (path.relative(path.dirname(metadataPath), output).startsWith("..")) {
    throw new Error(`Expected one safe unfiltered ${variant} APK metadata element.`);
  }
  return output;
}
export function pinnedEnv(java, sdk, ndk, { env = process.env, homeDir } = {}) {
  if (!homeDir) throw new Error("An isolated Android home is required.");
  return { ...env, CI: "true", JAVA_HOME: java.home, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
    ANDROID_NDK_HOME: ndk.path, ANDROID_NDK_ROOT: ndk.path, ANDROID_USER_HOME: path.join(homeDir, ".android"),
    ANDROID_SDK_HOME: homeDir, ANDROID_PREFS_ROOT: homeDir, GRADLE_USER_HOME: path.join(homeDir, ".gradle"),
    GRADLE_OPTS: `${env.GRADLE_OPTS ?? ""} -Dorg.gradle.daemon=false`.trim(),
    CARGO_TARGET_DIR: path.join(desktopDir, "src-tauri/target", `android-ndk-${ndk.version.replaceAll(".", "-")}`),
    PATH: `${path.join(java.home, "bin")}${path.delimiter}${env.PATH ?? ""}` };
}
export function verifyPublishable(apk, tools, expectedFingerprint, expectedVersion, { env = process.env, runCapture = capture } = {}) {
  const signature = runCapture(tools.apksigner, ["verify", "--verbose", "--print-certs", "--Werr", apk], { env });
  if (!signature.ok) throw new Error("Publishable APK signature verification failed.");
  const signers = [...signature.output.matchAll(/^Signer #(\d+) certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/gim)];
  if (signers.length !== 1 || signers[0][1] !== "1") {
    throw new Error("Publishable APK must contain exactly one signer.");
  }
  if (normalizeFingerprint(signers[0][2]) !== expectedFingerprint) {
    throw new Error("Publishable APK signer does not match the expected certificate SHA-256 fingerprint.");
  }
  const badging = runCapture(tools.aapt2, ["dump", "badging", apk], { env });
  const version = badging.output.match(/\bversionName='([^']+)'/)?.[1];
  if (!badging.ok || /application-debuggable/.test(badging.output) || !/native-code:.*'arm64-v8a'/.test(badging.output)) {
    throw new Error("Publishable APK must be non-debuggable and contain arm64-v8a native code.");
  }
  if (version !== expectedVersion) throw new Error("Publishable APK versionName does not match Tauri configuration.");
}
export function verifyApplicationId(apk, tools, expectedApplicationId, {
  env = process.env, runCapture = capture,
} = {}) {
  const badging = runCapture(tools.aapt2, ["dump", "badging", apk], { env });
  const applicationId = badging.output.match(/^package: name='([^']+)'/m)?.[1];
  if (!badging.ok || applicationId !== expectedApplicationId) {
    throw new Error(`Android APK applicationId must be ${expectedApplicationId}.`);
  }
}
export function verifyLocalSigner(apk, tools, expectedFingerprint, {
  env = process.env, runCapture = capture,
} = {}) {
  const signature = runCapture(tools.apksigner,
    ["verify", "--verbose", "--print-certs", "--Werr", apk], { env });
  const signers = [...signature.output.matchAll(/^Signer #(\d+) certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/gim)];
  if (!signature.ok || signers.length !== 1 || signers[0][1] !== "1" ||
      normalizeFingerprint(signers[0][2]) !== expectedFingerprint) {
    throw new Error("Local Android APK signer does not match the persistent test certificate.");
  }
}
export function verifyProfileable(apk, tools, {
  env = process.env, runCapture = capture,
} = {}) {
  const badging = runCapture(tools.aapt2, ["dump", "badging", apk], { env });
  const manifest = runCapture(tools.aapt2,
    ["dump", "xmltree", apk, "--file", "AndroidManifest.xml"], { env });
  const profileable = /E:\s+profileable\b[\s\S]*?A:\s+(?:http:\/\/schemas\.android\.com\/apk\/res\/android:)?shell(?:\([^)]*\))?=(?:true|\(type 0x12\)0xffffffff)\b/;
  if (!badging.ok || /\bapplication-debuggable\b/.test(badging.output) ||
      !manifest.ok || !profileable.test(manifest.output)) {
    throw new Error("Profile APK must be non-debuggable and profileable by the Android shell user.");
  }
}
export function verifyProfileSymbols(symbols, mapping, readelf, {
  runCapture = capture,
} = {}) {
  if (!fs.statSync(symbols, { throwIfNoEntry: false })?.size ||
      !fs.statSync(mapping, { throwIfNoEntry: false })?.size) {
    throw new Error("Profile build symbols or R8 mapping are missing.");
  }
  const sections = runCapture(readelf, ["--sections", symbols]);
  if (!sections.ok || !/\s\.symtab\s/.test(sections.output)) {
    throw new Error("Profile build host library does not retain a native symbol table.");
  }
}
export function runPublishableTransaction({
  buildFile, configure, intermediates, metadataPath, staging, destination, tempHome, build, resolveRaw, validate,
}, {
  read = (file) => fs.readFileSync(file, "utf8"), write = fs.writeFileSync,
  rename = fs.renameSync, copy = fs.copyFileSync, remove = fs.rmSync, mkdir = fs.mkdirSync,
  cleanupTemp = (candidate) => fs.rmSync(candidate, { recursive: true, force: true }),
} = {}) {
  const snapshot = read(buildFile);
  let committed = false;
  try {
    for (const file of intermediates) remove(file, { recursive: true, force: true });
    write(buildFile, configure(snapshot));
    build();
    const rawApk = resolveRaw(metadataPath);
    mkdir(path.dirname(staging), { recursive: true });
    copy(rawApk, staging);
    validate(staging);
    write(buildFile, snapshot);
    cleanupTemp(tempHome);
    rename(staging, destination);
    committed = true;
    return destination;
  } catch (error) {
    if (!committed) {
      remove(staging, { force: true });
      for (const file of intermediates) remove(file, { recursive: true, force: true });
      try { write(buildFile, snapshot); } finally { cleanupTemp(tempHome); }
    }
    throw error;
  }
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
  return { apk, metadataPath };
}
export function main(argv = process.argv.slice(2)) {
  const { mode, modelBundle, profile, packageName } = parseAndroidOptions(argv);
  const debug = mode === "debug";
  const publishable = mode === "publishable";
  const sourceEnv = { ...process.env };
  const cleanEnv = sanitizedEnv(sourceEnv);
  console.log(`[android package] start (${mode})`);
  const lock = acquirePackagingLock();
  let isolatedHome;
  try {
    const config = publishable ? readPublishableConfig(sourceEnv) : undefined;
    const java = resolveJava({ env: cleanEnv });
    const sdk = resolveSdk({ env: cleanEnv });
    const ndk = resolveNdk(sdk, { env: cleanEnv });
    if (config) validatePublishableCredentials(java, config, { env: sourceEnv });
    const tools = requireTools(sdk, capture, cleanEnv);
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-android-home-"));
    const ffmpegRoot = path.resolve(sourceEnv.TUNEFORGE_ANDROID_FFMPEG_ROOT ?? defaultFfmpegRoot);
    const soxrRoot = path.resolve(sourceEnv.TUNEFORGE_ANDROID_SOXR_ROOT ?? defaultSoxrRoot);
    const ndkHost = process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
    const llvmReadelf = path.join(ndk.path, "toolchains/llvm/prebuilt", ndkHost, "bin/llvm-readelf");
    const env = {
      ...pinnedEnv(java, sdk, ndk, { env: cleanEnv, homeDir: isolatedHome }),
      TUNEFORGE_ANDROID_FFMPEG_ROOT: ffmpegRoot,
      TUNEFORGE_ANDROID_SOXR_ROOT: soxrRoot,
      LLVM_READELF: llvmReadelf,
    };
    prepareNativeProject({ env, ffmpegRoot, soxrRoot, sourceEnv });
    const localSigning = mode !== "prepare" && !publishable
      ? ensureLocalTestKeystore(java, { env: cleanEnv }) : undefined;
    const buildEnv = publishable ? publishableBuildEnv(env, sourceEnv) : localSigning ? {
      ...env,
      TUNEFORGE_ANDROID_TEST_KEYSTORE_PATH: localSigning.path,
      TUNEFORGE_ANDROID_TEST_KEY_PASSWORD: localSigning.password,
    } : env;
    console.log(`[android package] JDK ${java.version}; SDK ${sdk}; NDK ${ndk.version} (${ndk.path})`);
    if (mode === "prepare") {
      if (modelBundle) run(process.execPath, [prepareModelAssets], { env, label: "Android model bundle preparation" });
      else fs.rmSync(path.join(androidDir, "app/src/main/assets/models"), { recursive: true, force: true });
      console.log("[android package] completion (prepare)");
      return;
    }
    const buildFile = path.join(androidDir, "app/build.gradle.kts");
    if (modelBundle) run(process.execPath, [prepareModelAssets], { env, label: "Android model bundle preparation" });
    else fs.rmSync(path.join(androidDir, "app/src/main/assets/models"), { recursive: true, force: true });
    const rawApk = path.join(androidDir, "app/build/outputs/apk/universal/release/app-universal-release.apk");
    const metadata = path.join(path.dirname(rawApk), "output-metadata.json");
    const mapping = path.join(androidDir, "app/build/outputs/mapping/universalRelease/mapping.txt");
    if (publishable) {
      const cleanGradle = removeOwnedSigning(fs.readFileSync(buildFile, "utf8"));
      if (cleanGradle !== fs.readFileSync(buildFile, "utf8")) fs.writeFileSync(buildFile, cleanGradle);
      const tauriConfig = JSON.parse(fs.readFileSync(path.join(desktopDir, "src-tauri/tauri.conf.json"), "utf8"));
      const outputDir = path.join(desktopDir, "src-tauri/target/release/bundle/apk");
      const destination = path.join(outputDir, `TuneForge_${tauriConfig.version}_android_aarch64_publishable.apk`);
      const staging = path.join(outputDir, `.${path.basename(destination)}.${lock.token}.tmp`);
      const build = () => { console.log(`[android package] build (${mode})`);
        run("bash", [androidEnv, tauriCli, "android", "build", "--ci", "--target", "aarch64", "--apk"],
          { cwd: desktopDir, env: buildEnv, label: "Tauri Android publishable build" });
        verifyExecutorchAar(buildEnv.GRADLE_USER_HOME);
        verifyOnnxRuntimeAar(buildEnv.GRADLE_USER_HOME);
        requireExecutables([tools.aapt2, tools.apksigner, tools.dexdump]);
      };
      const resolveRaw = (metadataPath) => {
        const apk = artifactFromMetadata(fs.readFileSync(metadataPath, "utf8"), false, metadataPath);
        if (!fs.statSync(apk, { throwIfNoEntry: false })?.isFile()) throw new Error("Publishable APK output is missing.");
        if (!fs.statSync(mapping, { throwIfNoEntry: false })?.size) throw new Error("Publishable release mapping is missing or empty.");
        return apk;
      };
      const validate = (apk) => { verifyPublishable(
        apk, tools, config.expectedFingerprint, tauriConfig.version, { env });
        run(process.execPath, [path.join(scriptDir, "validate-android-release-jni.mjs"), "--apk", apk],
          { env, label: "Android release JNI validation" });
      };
      const output = runPublishableTransaction({ buildFile, configure: configurePublishableSigning,
        intermediates: [path.dirname(rawApk), mapping], metadataPath: metadata, staging, destination,
        tempHome: isolatedHome, build, resolveRaw, validate });
      isolatedHome = undefined;
      console.log(`[android package] publishable APK: ${output}`);
      console.log("[android package] completion (publishable, release-key signed)");
    } else {
      const configurations = [{ file: buildFile, configure: (contents) => configureLocalBuild(
        contents, packageName ?? "com.tuneforge.desktop.test") }];
      if (profile) configurations.push({
        file: path.join(androidDir, "app/src/main/AndroidManifest.xml"),
        configure: configureProfileableManifest,
      });
      withTemporaryConfigurations(configurations, () => {
        console.log(`[android package] build (${profile ? "profile" : mode})`);
        const args = [androidEnv, tauriCli, "android", "build", "--ci", "--target", "aarch64", "--apk"];
        if (debug) args.push("--debug");
        run("bash", args, { cwd: desktopDir, env: buildEnv, label: `Tauri Android ${mode} build` });
        if (!fs.readFileSync(buildFile, "utf8").includes("TUNEFORGE-LOCAL-BUILD-BEGIN")) {
          throw new Error("Generated Android build replaced the temporary local signing configuration.");
        }
        verifyExecutorchAar(buildEnv.GRADLE_USER_HOME);
        verifyOnnxRuntimeAar(buildEnv.GRADLE_USER_HOME);
        requireExecutables(debug ? [tools.aapt2, tools.apksigner] : [tools.aapt2, tools.apksigner, tools.dexdump]);
        const artifact = verifySpecific(debug, tools, buildEnv);
        verifyApplicationId(artifact.apk, tools, packageName ?? "com.tuneforge.desktop.test", { env: buildEnv });
        verifyLocalSigner(artifact.apk, tools, localSigning.fingerprint, { env: buildEnv });
        if (!debug) run(process.execPath, [path.join(scriptDir, "validate-android-release-jni.mjs")],
          { env, label: "Android release JNI validation" });
        if (profile) {
          const symbols = path.join(buildEnv.CARGO_TARGET_DIR, "aarch64-linux-android/release/libtuneforge.so");
          verifyProfileable(artifact.apk, tools, { env: buildEnv });
          verifyProfileSymbols(symbols, mapping, llvmReadelf);
          console.log(`[android package] native profile symbols: ${symbols}`);
          console.log(`[android package] R8 mapping: ${mapping}`);
        }
        console.log(`[android package] ${debug ? "debug" : "optimized release-profile"} APK: ${artifact.apk}`);
        console.log(`[android package] completion (${profile ? "profile, " : ""}${mode}, debug-key signed)`);
      });
    }
  } finally {
    try {
      if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
    } finally {
      lock.release();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`[android package] failure: ${error.message}`); process.exitCode = 1; }
}
