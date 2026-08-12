import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  acquirePackagingLock,
  artifactFromMetadata,
  configurePublishableSigning,
  configureReleaseDebugSigning,
  generatedState,
  normalizeFingerprint,
  parseMode,
  pinnedEnv,
  preparedState,
  publishableBuildEnv,
  readPublishableConfig,
  removeOwnedSigning,
  requirePrepared,
  requireExecutables,
  resolveJava,
  resolveNdk,
  resolveSdk,
  runPublishableTransaction,
  sanitizedEnv,
  validatePublishableCredentials,
  verifyPublishable,
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
test("prepared state requires outputs owned by the explicit preparation command", (t) => {
  const root = path.join(temp(t), "android");
  completeGenerated(root);
  assert.throws(() => requirePrepared(root), /Run pnpm package:android:prepare/);
  for (const relative of ["app/proguard-tuneforge.pro",
    "app/src/main/java/com/tuneforge/desktop/PowerInhibitionService.kt",
    "app/src/main/res/values/ic_launcher_background.xml"]) {
    const candidate = path.join(root, relative); fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, "prepared");
  }
  assert.deepEqual(preparedState(root), { ready: true, missing: [] });
  assert.doesNotThrow(() => requirePrepared(root));
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
test("packaging exposes explicit prepare, debug, local-release, and publishable modes", () => {
  for (const [args, expected] of [[[], "local-release"], [["--prepare"], "prepare"],
    [["--debug"], "debug"], [["--publishable"], "publishable"]]) assert.equal(parseMode(args), expected);
  for (const args of [["--debug", "--publishable"], ["--release"]]) assert.throws(() => parseMode(args), /Usage/);
});
function signingEnv(keystore, fingerprint = "ab".repeat(32)) {
  return {
    TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH: keystore,
    TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS: "release-key",
    TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD: "store secret",
    TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD: "key secret",
    TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256: fingerprint,
  };
}
test("publishable inputs require complete environment values, an absolute readable file, and fingerprint syntax", (t) => {
  const root = temp(t);
  const keystore = path.join(root, "release.p12");
  fs.writeFileSync(keystore, "unchanged");
  const env = signingEnv(keystore);
  assert.equal(readPublishableConfig(env).expectedFingerprint, "ab".repeat(32));
  assert.equal(normalizeFingerprint(Array(32).fill("AB").join(":")), "ab".repeat(32));
  for (const name of Object.keys(env)) assert.throws(() => readPublishableConfig({ ...env, [name]: "" }), /incomplete/);
  for (const [candidate, message] of [["release.p12", /absolute/],
    [path.join(root, "missing.p12"), /readable regular file/], [root, /readable regular file/]]) {
    assert.throws(() => readPublishableConfig({ ...env,
      TUNEFORGE_ANDROID_RELEASE_KEYSTORE_PATH: candidate }), message);
  }
  assert.throws(() => readPublishableConfig(env, { access: () => { throw new Error("denied"); } }), /readable/);
  assert.throws(() => readPublishableConfig({ ...env,
    TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256: "invalid" }), /fingerprint/);
});
function credentialHarness(t) {
  const root = temp(t);
  const javaHome = path.join(root, "jdk");
  for (const name of ["keytool", "jar", "jarsigner"]) executable(path.join(javaHome, "bin", name));
  const keystore = path.join(root, "release.p12");
  fs.writeFileSync(keystore, "keystore bytes");
  const certificate = Buffer.from("certificate der");
  return { root, java: { home: javaHome }, keystore, certificate,
    fingerprint: crypto.createHash("sha256").update(certificate).digest("hex") };
}
test("credential preflight is secret-safe and reports categorical failures", (t) => {
  const harness = credentialHarness(t);
  const env = signingEnv(harness.keystore, harness.fingerprint);
  const config = readPublishableConfig(env);
  const runner = (failure, calls = []) => (command, args, options) => {
    calls.push({ command, args, options });
    if (failure === "store" && args.includes("-list") || failure === "alias" && args.includes("-exportcert") ||
        failure === "key" && command.endsWith("jarsigner")) return { ok: false, output: "secret diagnostic" };
    if (command.endsWith("keytool") && args.includes("-exportcert")) return { ok: true,
      output: failure === "fingerprint" ? Buffer.from("other cert") : harness.certificate };
    if (command.endsWith("jarsigner")) fs.writeFileSync(args[args.indexOf("-signedjar") + 1], "signed");
    return { ok: true, output: "" };
  };
  const calls = [];
  assert.equal(validatePublishableCredentials(harness.java, config, { env,
    runSensitive: runner(undefined, calls), tempRoot: harness.root }), harness.fingerprint);
  const serializedArgs = JSON.stringify(calls.map((call) => call.args));
  assert.doesNotMatch(serializedArgs, /store secret|key secret/);
  for (const provider of ["storepass:env", "keypass:env"]) assert.match(serializedArgs, new RegExp(provider));
  for (const { command, args, options } of calls) {
    const sensitive = command.endsWith("keytool") || command.endsWith("jarsigner");
    if (sensitive) assert.equal(args[args.indexOf("-storetype") + 1], "PKCS12");
    assert.equal(options.env.TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD, sensitive ? "store secret" : undefined);
    assert.equal(options.env.TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD, command.endsWith("jarsigner") ? "key secret" : undefined);
    for (const name of ["KEYSTORE_PATH", "EXPECTED_CERT_SHA256"]) assert.equal(
      options.env[`TUNEFORGE_ANDROID_RELEASE_${name}`], undefined);
  }
  for (const [failure, message] of [["store", /PKCS12 or store password/], ["alias", /certificate alias/],
    ["fingerprint", /fingerprint does not match/], ["key", /private key or key password/]]) {
    assert.throws(() => validatePublishableCredentials(harness.java, config,
      { env, tempRoot: harness.root, runSensitive: runner(failure) }), (error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /store secret|key secret|secret diagnostic/);
      return true;
    });
  }
  assert.equal(fs.readFileSync(harness.keystore, "utf8"), "keystore bytes");
  assert.equal(fs.readdirSync(harness.root).some((name) => name.startsWith("tuneforge-android-signing-")), false);
});
test("JDK 17 validates a synthetic PKCS12 with environment password providers", (t) => {
  let java;
  try { java = resolveJava(); } catch { t.skip("JDK 17 unavailable"); return; }
  const root = temp(t);
  const keystore = path.join(root, "synthetic.p12");
  const keytool = path.join(java.home, "bin/keytool");
  const hash = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const fixtureEnv = { ...sanitizedEnv(process.env), FIXTURE_STORE_PASSWORD: "storepass",
    FIXTURE_KEY_PASSWORD: "storepass" };
  const generated = spawnSync(keytool, ["-genkeypair", "-alias", "synthetic-release", "-keyalg", "RSA",
    "-keysize", "2048", "-validity", "1", "-dname", "CN=TuneForge Synthetic Test", "-keystore", keystore,
    "-storetype", "PKCS12", "-storepass:env", "FIXTURE_STORE_PASSWORD", "-keypass:env", "FIXTURE_KEY_PASSWORD",
    "-noprompt"], { env: fixtureEnv, stdio: "ignore" });
  assert.equal(generated.status, 0);
  const certificate = spawnSync(keytool, ["-exportcert", "-alias", "synthetic-release", "-keystore", keystore,
    "-storetype", "PKCS12", "-storepass:env", "FIXTURE_STORE_PASSWORD"],
  { env: fixtureEnv, encoding: null, stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(certificate.status, 0);
  const fingerprint = crypto.createHash("sha256").update(certificate.stdout).digest("hex");
  const before = hash(keystore);
  const env = signingEnv(keystore, fingerprint);
  env.TUNEFORGE_ANDROID_RELEASE_KEY_ALIAS = "synthetic-release";
  env.TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD = "storepass";
  env.TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD = "storepass";
  assert.equal(validatePublishableCredentials(java, readPublishableConfig(env), { env, tempRoot: root }), fingerprint);
  assert.equal(hash(keystore), before);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith("tuneforge-android-signing-")), false);
});
test("publishable Gradle signing is marker-owned, environment-only, restored cleanly, and has no debug fallback", () => {
  const original = [
    "android {", "    buildTypes {", '        getByName("release") {',
    debugSigningLineForTest(), "            isMinifyEnabled = true", "        }", "    }", "}", "",
  ].join("\n");
  const configured = configurePublishableSigning(original);
  assert.doesNotMatch(configured, /getByName\("debug"\)/);
  assert.match(configured, /getByName\("tuneforgePublishable"\)/);
  assert.match(configured, /storeType = "PKCS12"/);
  for (const name of ["KEYSTORE_PATH", "KEY_ALIAS", "STORE_PASSWORD", "KEY_PASSWORD"]) {
    assert.match(configured, new RegExp(`System\\.getenv\\("TUNEFORGE_ANDROID_RELEASE_${name}"\\)`));
  }
  assert.doesNotMatch(configured, /store secret|key secret/);
  assert.equal(removeOwnedSigning(configured),
    original.replace(`${debugSigningLineForTest()}\n`, ""));
  assert.equal(configurePublishableSigning(configured), configured);
});
function debugSigningLineForTest() {
  return '            signingConfig = signingConfigs.getByName("debug")';
}
test("publishable verification requires strict apksigner flags, one signer, fingerprint, and Tauri version", () => {
  const fingerprint = "ab".repeat(32);
  const calls = [];
  const success = (command, args) => {
    calls.push([command, args]);
    if (command === "/apksigner") return { ok: true, output: `Signer #1 certificate SHA-256 digest: ${fingerprint}` };
    return { ok: true, output: "package: name='com.tuneforge.desktop' versionName='1.2.3'\nnative-code: 'arm64-v8a'" };
  };
  assert.doesNotThrow(() => verifyPublishable("/app.apk",
    { apksigner: "/apksigner", aapt2: "/aapt2" }, fingerprint, "1.2.3", { runCapture: success }));
  assert.deepEqual(calls[0][1], ["verify", "--verbose", "--print-certs", "--Werr", "/app.apk"]);
  const verifyWith = (signature, badging = "versionName='1.2.3'\nnative-code: 'arm64-v8a'") => verifyPublishable("/app.apk",
    { apksigner: "/apksigner", aapt2: "/aapt2" }, fingerprint, "1.2.3", {
      runCapture: (command) => ({ ok: true, output: command === "/apksigner" ? signature : badging }),
    });
  const signer = `Signer #1 certificate SHA-256 digest: ${fingerprint}`;
  for (const [signature, badging, message] of [
    ["", undefined, /exactly one signer/],
    [`${signer}\nSigner #2 certificate SHA-256 digest: ${fingerprint}`, undefined, /exactly one signer/],
    [`Signer #1 certificate SHA-256 digest: ${"cd".repeat(32)}`, undefined, /expected certificate/],
    [signer, "versionName='9.9.9'\nnative-code: 'arm64-v8a'", /versionName/],
    [signer, "versionName='1.2.3' application-debuggable\nnative-code: 'arm64-v8a'", /non-debuggable/],
  ]) assert.throws(() => verifyWith(signature, badging), message);
  assert.throws(() => verifyPublishable("/app.apk", { apksigner: "/apksigner", aapt2: "/aapt2" },
    fingerprint, "1.2.3", { runCapture: () => ({ ok: false, output: "secret diagnostic" }) }), /signature verification/);
});
test("release variables are removed from unrelated children and scoped to the publishable build", () => {
  const source = { KEEP: "yes", ...signingEnv("/release.p12") };
  const clean = sanitizedEnv(source);
  assert.deepEqual(clean, { KEEP: "yes" });
  assert.deepEqual(source, { KEEP: "yes", ...signingEnv("/release.p12") });
  const build = publishableBuildEnv(clean, source);
  assert.equal(build.KEEP, "yes");
  for (const name of ["KEYSTORE_PATH", "KEY_ALIAS", "STORE_PASSWORD", "KEY_PASSWORD"]) {
    assert.equal(build[`TUNEFORGE_ANDROID_RELEASE_${name}`], source[`TUNEFORGE_ANDROID_RELEASE_${name}`]);
  }
  assert.equal(build.TUNEFORGE_ANDROID_RELEASE_EXPECTED_CERT_SHA256, undefined);
  const discoveryCalls = [];
  const discoveryEnv = sanitizedEnv({ JAVA_HOME: "/java17", ...signingEnv("/release.p12") });
  resolveJava({ env: discoveryEnv, hostPlatform: "darwin",
    isExecutable: () => true,
    runCapture: (command, args, options) => {
      discoveryCalls.push({ command, args, options });
      return { ok: true, output: command === "/usr/libexec/java_home" ? "/java17" : 'openjdk version "17.0.20"' };
    },
  });
  assert.equal(discoveryCalls.every((call) => call.options.env.TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD === undefined), true);
});
test("packaging lock rejects contention and never removes a lock whose ownership changed", (t) => {
  const lockPath = path.join(temp(t), "target/package.lock");
  const first = acquirePackagingLock(lockPath, { token: "owner-one" });
  assert.throws(() => acquirePackagingLock(lockPath, { token: "owner-two" }), /already locked/);
  const owner = path.join(lockPath, "owner");
  assert.equal(fs.readFileSync(owner, "utf8"), "owner-one");
  fs.writeFileSync(owner, "other-owner");
  assert.equal(first.release(), false);
  assert.equal(fs.existsSync(lockPath), true);
  fs.writeFileSync(owner, "owner-one");
  assert.equal(first.release(), true);
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(lockPath), false);
});
function transactionHarness(t) {
  const root = temp(t);
  const buildFile = path.join(root, "build.gradle.kts");
  const originalGradle = "original generated Gradle bytes\n";
  fs.writeFileSync(buildFile, originalGradle);
  const intermediates = ["app.apk", "output-metadata.json", "mapping.txt"]
    .map((name) => path.join(root, "generated", name));
  const [rawApk, metadataPath, mapping] = intermediates;
  for (const [index, file] of intermediates.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `prior-${index}`);
  }
  const outputDir = path.join(root, "bundle");
  const destination = path.join(outputDir, "publishable.apk");
  const staging = path.join(outputDir, ".publishable.attempt-one.tmp");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(destination, "prior-final");
  const tempHome = path.join(root, "android-home");
  fs.mkdirSync(tempHome);
  const build = () => {
    assert.equal(intermediates.every((file) => !fs.existsSync(file)), true);
    for (const [file, contents] of [[rawApk, "new-apk"], [metadataPath, "current metadata"],
      [mapping, "new-mapping"]]) fs.writeFileSync(file, contents);
  };
  return { buildFile, originalGradle, rawApk, metadataPath, mapping,
    intermediates, destination, staging, tempHome, build, resolveRaw: () => rawApk };
}
function runHarnessAttempt(harness, overrides = {}, operations = {}) {
  return runPublishableTransaction({ ...harness, configure: () => "temporary signing config with environment names only\n",
    validate: () => {}, ...overrides }, operations);
}
test("publishable transaction validates unique staged bytes before atomic destination rename", (t) => {
  const harness = transactionHarness(t);
  const otherAttempt = path.join(path.dirname(harness.staging), ".publishable.other-attempt.tmp");
  fs.writeFileSync(otherAttempt, "other invocation");
  const order = [];
  const result = runHarnessAttempt(harness, { validate: (apk) => {
    order.push("validate");
    assert.equal(apk, harness.staging);
    assert.equal(fs.readFileSync(apk, "utf8"), "new-apk");
    assert.equal(fs.readFileSync(harness.destination, "utf8"), "prior-final");
  } }, {
    write: (file, contents) => { if (contents === harness.originalGradle) order.push("restore"); fs.writeFileSync(file, contents); },
    cleanupTemp: (candidate) => {
      order.push("temp-cleanup");
      fs.rmSync(candidate, { recursive: true, force: true });
    },
    rename: (from, to) => { if (from === harness.staging) order.push("rename"); fs.renameSync(from, to); },
  });
  assert.equal(result, harness.destination);
  assert.deepEqual(order, ["validate", "restore", "temp-cleanup", "rename"]);
  assert.equal(fs.readFileSync(harness.destination, "utf8"), "new-apk");
  assert.equal(fs.readFileSync(harness.buildFile, "utf8"), harness.originalGradle);
  assert.deepEqual(harness.intermediates.map((file) => fs.readFileSync(file, "utf8")), ["new-apk", "current metadata", "new-mapping"]);
  assert.equal(fs.existsSync(harness.tempHome), false);
  assert.equal(fs.readFileSync(otherAttempt, "utf8"), "other invocation");
});
for (const failure of ["build", "validation", "temp cleanup"]) {
  test(`publishable transaction removes attempt outputs and preserves final after ${failure} failure`, (t) => {
    const harness = transactionHarness(t);
    const build = () => { harness.build(); if (failure === "build") throw new Error("build failure"); };
    const validate = () => { if (failure === "validation") throw new Error("validation failure"); };
    const cleanupTemp = (candidate) => {
      fs.rmSync(candidate, { recursive: true, force: true });
      if (failure === "temp cleanup") throw new Error("temp cleanup failure");
    };
    assert.throws(() => runHarnessAttempt(harness, { build, validate }, { cleanupTemp }), new RegExp(failure));
    assert.equal(fs.readFileSync(harness.buildFile, "utf8"), harness.originalGradle);
    assert.equal(harness.intermediates.every((file) => !fs.existsSync(file)), true);
    assert.equal(fs.readFileSync(harness.destination, "utf8"), "prior-final");
    assert.equal(fs.existsSync(harness.staging), false);
    assert.equal(fs.existsSync(harness.tempHome), false);
  });
}
test("artifact metadata requires the exact universal variant and path", () => {
  const valid = { artifactType: { type: "APK" }, variantName: "universalRelease",
    elements: [{ type: "SINGLE", filters: [], outputFile: "app-universal-release.apk" }] };
  const metadata = JSON.stringify(valid);
  assert.equal(artifactFromMetadata(metadata, false, "/out/output-metadata.json"),
    "/out/app-universal-release.apk");
  assert.throws(() => artifactFromMetadata(metadata, true, "/out/output-metadata.json"), /universalDebug/);
  for (const invalid of [
    { ...valid, artifactType: { type: "BUNDLE" } },
    { ...valid, elements: [{ ...valid.elements[0], type: "SPLIT" }] },
    { ...valid, elements: [{ ...valid.elements[0], filters: [{ filterType: "ABI", value: "arm64-v8a" }] }] },
    { ...valid, elements: [{ ...valid.elements[0], outputFile: "../unsafe-release.apk" }] },
  ]) assert.throws(() => artifactFromMetadata(JSON.stringify(invalid), false,
    "/out/output-metadata.json"), /safe unfiltered/);
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
  assert.equal(env.GRADLE_USER_HOME, path.join(root, ".gradle"));
  assert.match(env.GRADLE_OPTS, /-Dorg\.gradle\.daemon=false/);
  assert.match(env.CARGO_TARGET_DIR, /android-ndk-29-0-1$/);
  const tool = path.join(root, "apksigner");
  executable(tool);
  assert.doesNotThrow(() => requireExecutables([tool]));
  fs.chmodSync(tool, 0o644);
  assert.throws(() => requireExecutables([tool]), /apksigner/);
});
test("only the explicit prepare mode initializes, generates icons, and prepares generated Android", () => {
  const source = fs.readFileSync(new URL("./package-android.mjs", import.meta.url), "utf8");
  for (const pattern of [/"android", "init"/g, /Android icon generation/g, /\[prepareGenerated\]/g]) {
    assert.equal(source.match(pattern)?.length, 1);
  }
  assert.match(source, /validate-android-release-jni\.mjs"\), "--apk", apk/);
  assert.doesNotMatch(source, /\.android\/debug\.keystore|Existing debug keystore required/);
  const rootScripts = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  const desktopScripts = JSON.parse(fs.readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8")).scripts;
  assert.equal(rootScripts["package:android:prepare"], "pnpm --filter @tuneforge/desktop android:prepare");
  assert.equal(desktopScripts["android:prepare"], "node ../../scripts/package-android.mjs --prepare");
  assert.equal(Object.values(desktopScripts).filter((command) => command.includes("--prepare")).length, 1);
  const tracked = ["../.gitignore", "../docs/MOBILE.md", "../docs/PACKAGING.md"]
    .map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
  for (const extension of ["p12", "pfx", "jks", "keystore"]) {
    assert.match(tracked, new RegExp(`^\\*\\.${extension}$`, "m"));
  }
  const privateSourceTerms = [["kee", "pass", "xc"], ["password", " manager"], ["attach", "ment"]]
    .map((parts) => parts.join(""));
  assert.doesNotMatch(tracked, new RegExp(privateSourceTerms.join("|"), "i"));
});
