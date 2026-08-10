import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  artifactFromMetadata,
  configureReleaseDebugSigning,
  generatedState,
  pinnedEnv,
  requireExecutables,
  resolveJava,
  resolveNdk,
  resolveSdk,
} from "./package-android.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-android-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function executable(candidate) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, "#!/bin/sh\n");
  fs.chmodSync(candidate, 0o755);
}

test("stale Java falls back to discovered JDK 17", () => {
  const files = new Set(["/java8/bin/java", "/java8/bin/javac", "/java17/bin/java", "/java17/bin/javac"]);
  const result = resolveJava({
    env: { JAVA_HOME: "/java8" }, hostPlatform: "darwin",
    isExecutable: (candidate) => files.has(candidate),
    runCapture: (command) => {
      if (command === "/usr/libexec/java_home") return { ok: true, output: "/java17" };
      return { ok: true, output: command.startsWith("/java17/") ? 'openjdk version "17.0.20"' : 'java version "1.8.0"' };
    },
  });
  assert.equal(result.home, "/java17");
});

test("SDK uses matching environment before CLI and default", (t) => {
  const root = temp(t);
  const envSdk = path.join(root, "env");
  const cliSdk = path.join(root, "cli");
  fs.mkdirSync(envSdk);
  fs.mkdirSync(cliSdk);
  assert.equal(resolveSdk({
    env: { ANDROID_HOME: envSdk, ANDROID_SDK_ROOT: envSdk }, homeDir: root,
    runCapture: () => ({ ok: true, output: cliSdk }),
  }), envSdk);
  assert.throws(() => resolveSdk({
    env: { ANDROID_HOME: envSdk, ANDROID_SDK_ROOT: cliSdk },
  }), /same SDK/);
  fs.rmSync(envSdk, { recursive: true });
  assert.equal(resolveSdk({ env: {}, homeDir: root,
    runCapture: () => ({ ok: true, output: cliSdk }) }), cliSdk);
});

test("NDK discovery delegates selection to the shared helper", (t) => {
  const root = temp(t);
  const ndk = path.join(root, "ndk/29.0.14206865");
  fs.mkdirSync(ndk, { recursive: true });
  fs.writeFileSync(path.join(ndk, "source.properties"), "Pkg.Revision = 29.0.14206865\n");
  let invocation;
  const selected = resolveNdk(root, { env: { ANDROID_NDK_HOME: ndk },
    runCapture: (...args) => { invocation = args; return { ok: true, output: ndk }; } });
  assert.deepEqual(selected, { path: ndk, version: "29.0.14206865" });
  assert.deepEqual(invocation[1].slice(-2), ["/usr/bin/printenv", "ANDROID_NDK_HOME"]);
  assert.equal(invocation[2].env.ANDROID_HOME, root);
  assert.equal(invocation[2].env.ANDROID_NDK_HOME, ndk);
});

function completeGenerated(root) {
  for (const relative of [
    "app/build.gradle.kts", "app/src/main/AndroidManifest.xml",
    "app/src/main/java/com/tuneforge/desktop/MainActivity.kt",
    "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties",
    "settings.gradle",
  ]) {
    const candidate = path.join(root, relative);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, "");
  }
  fs.mkdirSync(path.join(root, "app/src/main/res"), { recursive: true });
  executable(path.join(root, "gradlew"));
}

test("generated state accepts initialized projects and still requires source markers", (t) => {
  const root = path.join(temp(t), "android");
  assert.equal(generatedState(root).state, "absent");
  completeGenerated(root);
  assert.equal(fs.existsSync(path.join(root, "tauri.settings.gradle")), false);
  assert.equal(generatedState(root).state, "complete");
  fs.rmSync(path.join(root, "app/src/main/java/com/tuneforge/desktop/MainActivity.kt"));
  assert.deepEqual(generatedState(root).missing, ["app/src/main/java/com/tuneforge/desktop/MainActivity.kt"]);
});

test("release debug signing is marker-based and idempotent", (t) => {
  const buildFile = path.join(temp(t), "build.gradle.kts");
  fs.writeFileSync(buildFile, '        getByName("release") {\n            isMinifyEnabled = true\n');
  assert.equal(configureReleaseDebugSigning(buildFile), true);
  const configured = fs.readFileSync(buildFile, "utf8");
  assert.match(configured, /signingConfig = signingConfigs\.getByName\("debug"\)/);
  assert.equal(configureReleaseDebugSigning(buildFile), false);
  assert.equal(fs.readFileSync(buildFile, "utf8"), configured);
});

test("artifact metadata requires the exact universal variant and path", () => {
  const metadata = JSON.stringify({
    variantName: "universalRelease", elements: [{ outputFile: "app-universal-release.apk" }],
  });
  assert.equal(artifactFromMetadata(metadata, false, "/out/output-metadata.json"),
    "/out/app-universal-release.apk");
  assert.throws(() => artifactFromMetadata(metadata, true, "/out/output-metadata.json"), /universalDebug/);
});

test("Android preference homes and tool executability are deterministic", (t) => {
  const root = temp(t);
  const env = pinnedEnv({ home: "/java" }, "/sdk", { path: "/ndk", version: "29.0.1" }, {
    env: { ANDROID_USER_HOME: "/wrong", ANDROID_SDK_HOME: "/wrong", ANDROID_PREFS_ROOT: "/wrong" },
    homeDir: root,
  });
  assert.equal(env.ANDROID_USER_HOME, path.join(root, ".android"));
  assert.equal(env.ANDROID_SDK_HOME, root);
  assert.equal(env.ANDROID_PREFS_ROOT, root);
  assert.match(env.CARGO_TARGET_DIR, /android-ndk-29-0-1$/);
  const tool = path.join(root, "apksigner");
  executable(tool);
  assert.doesNotThrow(() => requireExecutables([tool]));
  fs.chmodSync(tool, 0o644);
  assert.throws(() => requireExecutables([tool]), /apksigner/);
});
