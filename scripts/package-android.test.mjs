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
  configureLocalBuild,
  configureProfileableManifest,
  configurePublishableSigning,
  configureReleaseDebugSigning,
  configureAndroidToolchainFromEnv,
  configureTestAdaptiveIcon,
  configureTestStrings,
  generatedState,
  ensureLocalTestKeystore,
  normalizeFingerprint,
  parseMode,
  parseAndroidOptions,
  pinnedEnv,
  preparedState,
  publishableBuildEnv,
  readPublishableConfig,
  removeOwnedSigning,
  requirePrepared,
  requireExecutables,
  requireTools,
  resolveJava,
  resolveAndroidToolchain,
  resolveNdk,
  resolveSdk,
  selectSdkPlatform,
  runPublishableTransaction,
  sanitizedEnv,
  soxrValidationOptions,
  validatePublishableCredentials,
  verifyPublishable,
  verifyExecutorchAar,
  verifyOnnxRuntimeAar,
  verifyPreparedFfmpeg,
  verifyPreparedSoxr,
  verifyApplicationId,
  verifyLocalSigner,
  verifyProfileable,
  withTemporaryConfigurations,
  withTemporaryAndroidIcons,
} from "./package-android.mjs";
import { TEST_PACKAGE } from "./package-profile.mjs";
import { whisperVulkanShaderTool, selectedShaderNdkRevision, prepareWhisperNativeSource } from "./prepare-whisper-native-source.mjs";
import { configureAndroidToolchain } from "./android-configure-toolchain.mjs";
import { androidToolchainProfiles, readGeneratedNdk, resolveGeneratedNdk, readLocalNdkPath, escapeLocalProperty, hasSdkPlatform } from "./android-toolchain.mjs";
const ndkRevision = whisperVulkanShaderTool.ndkRevision;

test("Android model bundle remains explicit and composes with build modes", () => {
  assert.deepEqual(parseAndroidOptions([]), {
    mode: "local-release", modelBundle: false, profile: false, testIdentity: false, packageName: undefined,
  });
  assert.deepEqual(parseAndroidOptions(["--debug", "--model-bundle"]), {
    mode: "debug", modelBundle: true, profile: false, testIdentity: false, packageName: undefined,
  });
  assert.deepEqual(parseAndroidOptions(["--debug", "--", "--model-bundle"]), {
    mode: "debug", modelBundle: true, profile: false, testIdentity: false, packageName: undefined,
  });
  assert.deepEqual(parseAndroidOptions(["--model-bundle", "--prepare"]), {
    mode: "prepare", modelBundle: true, profile: false, testIdentity: false, packageName: undefined,
  });
  assert.deepEqual(parseAndroidOptions(["--debug", "--test-identity"]), {
    mode: "debug", modelBundle: false, profile: false, testIdentity: true, packageName: undefined,
  });
  assert.throws(() => parseAndroidOptions(["--publishable", "--test-identity"]), /only for local/);
  assert.equal(parseAndroidOptions(["--debug", "--package-name", "com.example.fixture"]).packageName,
    "com.example.fixture");
  for (const args of [["--prepare", "--package-name", "com.example.fixture"],
    ["--publishable", "--package-name", "com.example.fixture"],
    ["--package-name", "com.tuneforge.desktop"], ["--package-name", "invalid"],
    ["--package-name", "com.bad-name.app"],
    ["--package-name", "com.one", "--package-name", "com.two"]]) {
    assert.throws(() => parseAndroidOptions(args));
  }
});
test("profiling is limited to a temporary optimized local build", (t) => {
  assert.equal(parseAndroidOptions(["--profile"]).profile, true);
  for (const args of [["--profile", "--prepare"], ["--profile", "--debug"],
    ["--profile", "--publishable"], ["--profile", "--profile"]]) {
    assert.throws(() => parseAndroidOptions(args), /--profile/);
  }
  const root = temp(t);
  const build = path.join(root, "build.gradle.kts");
  const manifest = path.join(root, "AndroidManifest.xml");
  fs.writeFileSync(build, "original build\n");
  fs.writeFileSync(manifest, '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    "    <application android:label=\"TuneForge\">\n    </application>\n</manifest>\n");
  assert.throws(() => withTemporaryConfigurations([
    { file: build, configure: (contents) => `${contents}temporary build\n` },
    { file: manifest, configure: configureProfileableManifest },
  ], () => {
    assert.match(fs.readFileSync(manifest, "utf8"), /<profileable android:shell="true" \/>/);
    throw new Error("synthetic build failure");
  }), /synthetic build failure/);
  assert.equal(fs.readFileSync(build, "utf8"), "original build\n");
  assert.doesNotMatch(fs.readFileSync(manifest, "utf8"), /profileable/);
  assert.throws(() => configureProfileableManifest("<application><profileable /></application>"),
    /already contains/);
});
test("profile APK verification requires shell profiling and rejects debuggable output", () => {
  const verify = (badging, manifest) => verifyProfileable("app.apk", { aapt2: "/aapt2" }, {
    runCapture: (_command, args) => ({ ok: true, output: args.includes("badging") ? badging : manifest }),
  });
  const manifest = "E: profileable\n  A: http://schemas.android.com/apk/res/android:shell(0x0101054d)=true";
  assert.doesNotThrow(() => verify("package: name='com.tuneforge.desktop.test'", manifest));
  assert.throws(() => verify("application-debuggable", manifest), /non-debuggable/);
  assert.throws(() => verify("package: name='com.tuneforge.desktop.test'", "E: application"), /profileable/);
});

test("Android packaging verifies the pinned ExecuTorch AAR", (t) => {
  const root = temp(t);
  const aar = path.join(root, "caches/modules/files/executorch-android-1.4.0.aar");
  fs.mkdirSync(path.dirname(aar), { recursive: true });
  fs.writeFileSync(aar, "wrong");
  assert.throws(() => verifyExecutorchAar(root), /SHA-256 verification failed/);
});
test("Android packaging verifies the pinned ONNX Runtime AAR", (t) => {
  const root = temp(t);
  const aar = path.join(root, "caches/modules/files/onnxruntime-android-1.29.0.aar");
  fs.mkdirSync(path.dirname(aar), { recursive: true });
  fs.writeFileSync(aar, "wrong");
  assert.throws(() => verifyOnnxRuntimeAar(root), /size or SHA-256 verification failed/);
});
test("test APK identity is verified from packaged badging", () => {
  const tools = { aapt2: "/sdk/aapt2" };
  const good = () => ({ ok: true, output: `package: name='${TEST_PACKAGE.id}' versionCode='1'` });
  assert.doesNotThrow(() => verifyApplicationId("app.apk", tools, TEST_PACKAGE.id, {
    runCapture: good,
  }));
  assert.throws(() => verifyApplicationId("app.apk", tools, TEST_PACKAGE.id, {
    runCapture: () => ({ ok: true, output: "package: name='com.tuneforge.desktop'" }),
  }), /applicationId/);
});

test("local Android label and icons restore after success and failure", (t) => {
  const root = temp(t);
  const strings = path.join(root, "strings.xml");
  const resourceRoot = path.join(root, "res");
  const iconRoot = path.join(root, "test-icons", "android");
  const icon = path.join("mipmap-mdpi", "ic_launcher.png");
  const background = path.join("values", "ic_launcher_background.xml");
  const adaptive = path.join("mipmap-anydpi-v26", "ic_launcher.xml");
  const monochrome = path.join("drawable", "ic_launcher_monochrome.xml");
  for (const base of [resourceRoot, iconRoot]) {
    fs.mkdirSync(path.join(base, "mipmap-mdpi"), { recursive: true });
    fs.mkdirSync(path.join(base, "values"), { recursive: true });
    fs.mkdirSync(path.join(base, "mipmap-anydpi-v26"), { recursive: true });
  }
  const productionIcon = Buffer.from([0, 255, 17, 32]);
  const testIcon = Buffer.from([0, 1, 240, 255]);
  const adaptiveXml = '<?xml version="1.0"?><adaptive-icon>' +
    '<foreground android:drawable="@mipmap/ic_launcher_foreground"/>' +
    '<background android:drawable="@color/ic_launcher_background"/></adaptive-icon>';
  fs.writeFileSync(strings,
    '<resources><string name="app_name">TuneForge</string><string name="main_activity_title">TuneForge</string></resources>');
  fs.writeFileSync(path.join(resourceRoot, icon), productionIcon);
  fs.writeFileSync(path.join(resourceRoot, background), "production-background");
  fs.writeFileSync(path.join(resourceRoot, adaptive), adaptiveXml);
  fs.writeFileSync(path.join(iconRoot, icon), testIcon);
  fs.writeFileSync(path.join(iconRoot, background), "test-background");
  fs.writeFileSync(path.join(iconRoot, adaptive), adaptiveXml);
  const build = () => withTemporaryConfigurations([{ file: strings, configure: configureTestStrings }],
    () => withTemporaryAndroidIcons(resourceRoot, iconRoot, () => {
      assert.match(fs.readFileSync(strings, "utf8"), /TuneForge Test/);
      assert.deepEqual(fs.readFileSync(path.join(resourceRoot, icon)), testIcon);
      assert.match(fs.readFileSync(path.join(resourceRoot, adaptive), "utf8"),
        /<monochrome android:drawable="@drawable\/ic_launcher_monochrome"\/>/);
      assert.match(fs.readFileSync(path.join(resourceRoot, monochrome), "utf8"), /android:pathData=/);
    }));
  build();
  assert.deepEqual(fs.readFileSync(path.join(resourceRoot, icon)), productionIcon);
  assert.equal(fs.readFileSync(path.join(resourceRoot, background), "utf8"), "production-background");
  assert.equal(fs.readFileSync(path.join(resourceRoot, adaptive), "utf8"), adaptiveXml);
  assert.equal(fs.existsSync(path.join(resourceRoot, monochrome)), false);
  assert.doesNotMatch(fs.readFileSync(strings, "utf8"), /TuneForge Test/);
  assert.throws(() => withTemporaryConfigurations([{ file: strings, configure: configureTestStrings }],
    () => withTemporaryAndroidIcons(resourceRoot, iconRoot, () => { throw new Error("build failed"); })), /build failed/);
  assert.deepEqual(fs.readFileSync(path.join(resourceRoot, icon)), productionIcon);
  assert.equal(fs.readFileSync(path.join(resourceRoot, adaptive), "utf8"), adaptiveXml);
  assert.equal(fs.existsSync(path.join(resourceRoot, monochrome)), false);
  assert.doesNotMatch(fs.readFileSync(strings, "utf8"), /TuneForge Test/);
  assert.throws(() => configureTestStrings('<resources><string name="app_name">TuneForge</string></resources>'),
    /main_activity_title/);
  assert.throws(() => configureTestAdaptiveIcon("<adaptive-icon></adaptive-icon>"), /marker/);
});

test("generated Android quoted labels keep their quotes and restore exactly", (t) => {
  const strings = path.join(temp(t), "strings.xml");
  const original = '<resources>\n    <string name="app_name">"TuneForge"</string>\n' +
    '    <string name="main_activity_title">"TuneForge"</string>\n</resources>\n';
  fs.writeFileSync(strings, original);
  const configuration = [{ file: strings, configure: configureTestStrings }];
  withTemporaryConfigurations(configuration, () => {
    assert.match(fs.readFileSync(strings, "utf8"), /<string name="app_name">"TuneForge Test"<\/string>/);
    assert.match(fs.readFileSync(strings, "utf8"), /<string name="main_activity_title">"TuneForge Test"<\/string>/);
  });
  assert.equal(fs.readFileSync(strings, "utf8"), original);
  assert.throws(() => withTemporaryConfigurations(configuration, () => { throw new Error("build failed"); }),
    /build failed/);
  assert.equal(fs.readFileSync(strings, "utf8"), original);
  assert.throws(() => configureTestStrings('<string name="app_name">"TuneForge"</string>'),
    /main_activity_title/);
});
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-android-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function executable(candidate) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, "#!/bin/sh\n");
  fs.chmodSync(candidate, 0o755);
}
test("explicit Java home is authoritative even with a discoverable macOS JDK", () => {
  const files = new Set(["/java8/bin/java", "/java8/bin/javac", "/java17/bin/java", "/java17/bin/javac"]);
  const calls = [];
  assert.throws(() => resolveJava({
    env: { JAVA_HOME: "/java8" }, hostPlatform: "darwin",
    isExecutable: (candidate) => files.has(candidate),
    runCapture: (command) => {
      calls.push(command);
      return { ok: true, output: command.startsWith("/java17/") ? 'openjdk version "17.0.20"' : 'java version "1.8.0"' };
    },
  }), /must be version 17/);
  assert.equal(calls.includes("/usr/libexec/java_home"), false);
  assert.throws(() => resolveJava({ env: { JAVA_HOME: "/missing" }, hostPlatform: "darwin",
    isExecutable: () => false, runCapture: () => assert.fail("invalid override must not discover another JDK") }),
  /Java executable not found/);
});
test("macOS JDK discovery retains system and Homebrew fallbacks without an override", () => {
  for (const [systemOk, home] of [[true, "/java17"], [false, "/opt/homebrew/opt/openjdk@17"],
    [false, "/usr/local/opt/openjdk@17"]]) {
    const result = resolveJava({ env: {}, hostPlatform: "darwin",
      isExecutable: (candidate) => candidate.startsWith(`${home}/bin/`),
      runCapture: (command) => command === "/usr/libexec/java_home"
        ? { ok: systemOk, output: "/java17" }
        : { ok: true, output: path.basename(command) === "javac" ? "javac 17.0.20" : 'openjdk version "17.0.20"' },
    });
    assert.equal(result.home, home);
  }
});
test("Linux Java discovery resolves direct and Arch-style symlinked PATH entries with spaces", (t) => {
  const root = temp(t);
  const home = path.join(root, "jdk 17");
  executable(path.join(home, "bin/java"));
  executable(path.join(home, "bin/javac"));
  const systemBin = path.join(root, "system bin");
  fs.mkdirSync(systemBin);
  const current = path.join(root, "default-runtime");
  fs.symlinkSync(home, current);
  fs.symlinkSync(path.join(current, "bin/java"), path.join(systemBin, "java"));
  for (const bin of [path.join(home, "bin"), systemBin]) {
    const result = resolveJava({ env: { PATH: `${root}/missing${path.delimiter}${bin}` }, hostPlatform: "linux",
      runCapture: (command) => ({ ok: true,
        output: path.basename(command) === "javac" ? "javac 17.0.20" : 'openjdk version "17.0.20"' }),
    });
    assert.deepEqual(result, { home, version: "17.0.20" });
  }
});
test("Java discovery distinguishes absent Java, JRE-only installs and wrong runtime or compiler majors", (t) => {
  const root = temp(t);
  assert.throws(() => resolveJava({ env: { PATH: root }, hostPlatform: "linux", jvmRoots: [] }), /Java not found on PATH/);
  const home = path.join(root, "jre");
  executable(path.join(home, "bin/java"));
  assert.throws(() => resolveJava({ env: { PATH: path.join(home, "bin") }, hostPlatform: "linux", jvmRoots: [] }),
    /compiler missing.*full JDK, not only a JRE/);
  executable(path.join(home, "bin/javac"));
  for (const [runtime, compiler, message] of [[16, 16, /Java must be version 17/],
    [28, 28, /Java must be version 17/],
    [17, 21, /Java compiler must match runtime/]]) {
    assert.throws(() => resolveJava({ env: { JAVA_HOME: home }, hostPlatform: "linux",
      runCapture: (command) => ({ ok: true, output: path.basename(command) === "javac"
        ? `javac ${compiler}.0.1` : `openjdk version "${runtime}.0.1"` }),
    }), message);
  }
  const result = resolveJava({ env: { JAVA_HOME: "/java17" }, isExecutable: () => true,
    runCapture: (command) => ({ ok: true, output: path.basename(command) === "javac"
      ? "javac 17" : 'openjdk version "17"' }),
  });
  assert.equal(result.home, "/java17");
});
test("Java discovery failures preserve guidance without exposing the configured home", () => {
  const home = "/private/synthetic-java-secret";
  for (const [java, javac, runtime, compiler, message] of [
    [false, false, 17, 17, /Java executable not found.*full JDK/],
    [true, false, 17, 17, /JDK compiler missing.*full JDK/],
    [true, true, 16, 16, /Java must be version 17.*found 16/],
    [true, true, 17, 21, /Java compiler must match runtime major 17/],
  ]) {
    assert.throws(() => resolveJava({ env: { JAVA_HOME: home },
      isExecutable: (command) => command.endsWith("/javac") ? javac : java,
      runCapture: (command) => ({ ok: true, output: command.endsWith("/javac")
        ? `javac ${compiler}` : `openjdk version "${runtime}"` }),
    }), (error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /private|synthetic-java-secret/);
      return true;
    });
  }
});
test("SDK uses matching environment before CLI and default", (t) => {
  const root = temp(t);
  const envSdk = path.join(root, "env");
  const cliSdk = path.join(root, "cli");
  fs.mkdirSync(envSdk);
  fs.mkdirSync(cliSdk);
  assert.equal(resolveSdk({
    env: { ANDROID_HOME: envSdk, ANDROID_SDK_ROOT: envSdk }, homeDir: root,
    runCapture: () => assert.fail("explicit SDK must not invoke optional CLI"),
  }), envSdk);
  assert.throws(() => resolveSdk({
    env: { ANDROID_HOME: envSdk, ANDROID_SDK_ROOT: cliSdk },
  }), /same SDK/);
  fs.rmSync(envSdk, { recursive: true });
  assert.throws(() => resolveSdk({ env: { ANDROID_HOME: envSdk }, homeDir: root,
    runCapture: () => assert.fail("invalid SDK override must not fall back") }), /Configured Android SDK/);
  assert.equal(resolveSdk({ env: {}, homeDir: root,
    runCapture: () => ({ ok: true, output: cliSdk }) }), cliSdk);
});
test("SDK discovery uses platform defaults when optional convenience CLI is absent", (t) => {
  const root = temp(t);
  for (const [hostPlatform, relative] of [["linux", "Android/Sdk"], ["darwin", "Library/Android/sdk"]]) {
    const sdk = path.join(root, relative);
    fs.mkdirSync(sdk, { recursive: true });
    assert.equal(resolveSdk({ env: {}, homeDir: root, hostPlatform,
      runCapture: () => ({ ok: false, output: "" }) }), sdk);
  }
  assert.throws(() => resolveSdk({ env: {}, homeDir: path.join(root, "absent"), hostPlatform: "linux", isDirectory: () => false,
    runCapture: () => ({ ok: false, output: "" }) }), /SDK not found/);
});
test("SDK aliases accept symlinks while invalid explicit roots never fall back", (t) => {
  const root = temp(t), sdk = path.join(root, "sdk"), alias = path.join(root, "sdk-link");
  fs.mkdirSync(sdk);
  fs.symlinkSync(sdk, alias, "dir");
  const options = { homeDir: root, runCapture: () => assert.fail("explicit SDK must not discover alternatives") };
  for (const [first, second] of [[sdk, alias], [alias, sdk]]) {
    assert.equal(resolveSdk({ ...options, env: { ANDROID_HOME: first, ANDROID_SDK_ROOT: second } }), first);
  }
  const other = path.join(root, "other"); fs.mkdirSync(other);
  assert.throws(() => resolveSdk({ ...options, env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: other } }), /same SDK/);
  const missing = path.join(root, "missing"), broken = path.join(root, "broken-link");
  fs.symlinkSync(missing, broken, "dir");
  for (const selected of [missing, broken]) {
    assert.throws(() => resolveSdk({ ...options, env: { ANDROID_HOME: selected, ANDROID_SDK_ROOT: selected } }), /Configured Android SDK/);
    assert.throws(() => resolveSdk({ ...options, env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: selected } }), /same SDK/);
  }
});
function ndkFixture(root, revision, host = "linux-x86_64") {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "source.properties"), `Pkg.Revision = ${revision}\n`);
  for (const tool of ["aarch64-linux-android26-clang", "aarch64-linux-android26-clang++", "llvm-ar", "llvm-readelf"]) {
    executable(path.join(root, "toolchains/llvm/prebuilt", host, "bin", tool));
  }
  executable(path.join(root, "shader-tools", host, "glslc"));
  return root;
}
test("NDK aliases accept symlinks while invalid explicit roots never fall back", (t) => {
  const root = temp(t), ndk = ndkFixture(path.join(root, "ndk"), ndkRevision);
  const alias = path.join(root, "ndk-link"); fs.symlinkSync(ndk, alias, "dir");
  const other = ndkFixture(path.join(root, "other"), "30.0.10000000");
  const missing = path.join(root, "missing"), broken = path.join(root, "broken-link");
  fs.symlinkSync(missing, broken, "dir");
  const options = { standaloneRoots: [other], hostPlatform: "linux", hostArch: "x64" };
  const aliases = ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"];
  for (const name of aliases) {
    const env = Object.fromEntries(aliases.map((key) => [key, key === name ? alias : ndk]));
    assert.deepEqual(resolveNdk(root, { ...options, env }), { path: env.ANDROID_NDK_HOME, version: ndkRevision });
    assert.throws(() => resolveNdk(root, { ...options, env: { ...env, [name]: other } }), /same NDK/);
    for (const selected of [missing, broken]) {
      assert.throws(() => resolveNdk(root, { ...options, env: { [name]: selected } }), /no stable revision/);
      assert.throws(() => resolveNdk(root, { ...options, env: { ...env, [name]: selected } }), /same NDK/);
    }
  }
  fs.unlinkSync(path.join(ndk, "shader-tools/linux-x86_64/glslc"));
  assert.throws(() => resolveNdk(root, { ...options, env: { ANDROID_NDK_HOME: ndk, ANDROID_NDK_ROOT: alias, NDK_HOME: ndk } }), /glslc/);
});
test("NDK discovery selects the newest complete stable revision and validates explicit aliases", (t) => {
  const root = temp(t);
  const old = ndkFixture(path.join(root, "ndk", "old"), ndkRevision);
  const newer = ndkFixture(path.join(root, "ndk", "new"), "30.0.10000000");
  ndkFixture(path.join(root, "ndk", "numeric-low"), "30.0.9");
  ndkFixture(path.join(root, "ndk", "preview"), "31.0.1 beta1");
  const incomplete = ndkFixture(path.join(root, "ndk", "incomplete"), "31.0.2");
  fs.unlinkSync(path.join(incomplete, "shader-tools/linux-x86_64/glslc"));
  const options = { env: {}, standaloneRoots: [], hostPlatform: "linux", hostArch: "x64" };
  assert.deepEqual(resolveNdk(root, options), { path: newer, version: "30.0.10000000" });
  assert.deepEqual(resolveNdk(root, { ...options, env: { ANDROID_NDK_ROOT: old } }), { path: old, version: ndkRevision });
  assert.throws(() => resolveNdk(root, { ...options, env: { ANDROID_NDK_HOME: old, ANDROID_NDK_ROOT: newer } }), /same NDK/);
  assert.throws(() => resolveNdk(root, { ...options, env: { ANDROID_NDK_HOME: incomplete } }), /glslc/);
  const standalone = ndkFixture(path.join(root, "standalone"), "30.1.1");
  assert.equal(resolveNdk(root, { ...options, standaloneRoots: [standalone] }).path, standalone);
});
test("shared NDK revision query performs no source preparation", (t) => {
  const root = temp(t);
  const script = path.resolve("scripts/prepare-whisper-native-source.mjs");
  const result = spawnSync(process.execPath, [script, "--ndk-revision"], { cwd: root,
    env: { ...sanitizedEnv(process.env), HOME: path.join(root, "home"),
      CARGO_HOME: path.join(root, "cargo"), CARGO_TARGET_DIR: path.join(root, "target") }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${ndkRevision}\n`);
  assert.equal(result.stderr, "");
  assert.deepEqual(fs.readdirSync(root), []);
});
test("invalid explicit NDK revisions fail without fallback or source preparation", (t) => {
  const root = temp(t);
  const ndk = path.join(root, "explicit");
  const options = { standaloneRoots: [], env: { ANDROID_NDK_ROOT: ndk } };
  assert.throws(() => resolveNdk(root, options), /no stable revision/);
  fs.mkdirSync(ndk);
  for (const revision of ["28.0.13004108", "30.0.1 beta1", "malformed", ""]) {
    fs.writeFileSync(path.join(ndk, "source.properties"), `Pkg.Revision = ${revision}\n`);
    assert.throws(() => resolveNdk(root, options), /stable numeric Pkg.Revision >= 29/);
  }
});

test("resolved Android environment selects llvm-readelf for libsoxr validation", () => {
  const env = { LLVM_READELF: "/selected/ndk/bin/llvm-readelf" };
  const args = ["-h", "-l", "-d", "/runtime/libsoxr.so"];
  const output = "Machine: AArch64\nLOAD 0x4000\n";
  const options = soxrValidationOptions(env, (command, actualArgs, actualOptions) => {
    assert.equal(command, env.LLVM_READELF);
    assert.deepEqual(actualArgs, args);
    assert.deepEqual(actualOptions, { env });
    return { ok: true, output };
  });
  assert.equal(options.readelf, env.LLVM_READELF);
  assert.equal(options.runTool(options.readelf, args, { capture: true }), output);
});
test("libsoxr ELF invocation failures exclude tool paths and process diagnostics", () => {
  const env = { LLVM_READELF: "/private/synthetic-readelf-secret" };
  for (const runCapture of [
    () => ({ ok: false, output: "synthetic-stderr-secret", error: new Error("synthetic-spawn-secret") }),
    () => { throw new Error("synthetic-spawn-secret"); },
  ]) {
    const options = soxrValidationOptions(env, runCapture);
    assert.throws(() => options.runTool(options.readelf, ["-h", "/runtime/libsoxr.so"]), (error) => {
      assert.equal(error.message, "Android libsoxr ELF inspection failed.");
      assert.doesNotMatch(error.message, /private|synthetic|libsoxr\.so/);
      return true;
    });
  }
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
    "app/src/main/assets/soxr/provenance.json",
  ]) {
    const candidate = path.join(root, relative); fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, "prepared");
  }
  assert.deepEqual(preparedState(root), { ready: true, missing: [] });
  assert.doesNotThrow(() => requirePrepared(root));
});
test("Android builds reject stale staged libsoxr artifacts", (t) => {
  const root = temp(t);
  const soxr = path.join(root, "owned-soxr");
  const android = path.join(root, "android");
  const pairs = [
    ["lib/libsoxr.so", "app/src/main/jniLibs/arm64-v8a/libsoxr.so", "runtime"],
    ["provenance.json", "app/src/main/assets/soxr/provenance.json",
      JSON.stringify({ cmake: ["-DWITH_PFFFT=ON"] })],
  ];
  for (const [sourceRelative, stagedRelative, contents] of pairs) {
    const source = path.join(soxr, sourceRelative);
    const staged = path.join(android, stagedRelative);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(source, contents);
    fs.writeFileSync(staged, contents);
  }
  assert.doesNotThrow(() => verifyPreparedSoxr(soxr, android));
  fs.writeFileSync(path.join(android, pairs[0][1]), "stale PFFFT-disabled runtime");
  assert.throws(() => verifyPreparedSoxr(soxr, android), /preparation did not complete/);
});
test("Android builds reject stale staged FFmpeg artifacts", (t) => {
  const root = temp(t);
  const ffmpeg = path.join(root, "owned-ffmpeg");
  const android = path.join(root, "android");
  const pairs = [
    ...["avcodec", "avfilter", "avformat", "avutil", "swresample", "mp3lame"]
      .map((name) => [`lib/lib${name}.so`, `app/src/main/jniLibs/arm64-v8a/lib${name}.so`]),
    ["provenance.json", "app/src/main/assets/ffmpeg/provenance.json"],
  ];
  for (const [sourceRelative, stagedRelative] of pairs) {
    const source = path.join(ffmpeg, sourceRelative);
    const staged = path.join(android, stagedRelative);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(source, sourceRelative);
    fs.writeFileSync(staged, sourceRelative);
  }
  assert.doesNotThrow(() => verifyPreparedFfmpeg(ffmpeg, android));
  fs.writeFileSync(path.join(android, pairs[2][1]), "stale FFmpeg runtime");
  assert.throws(() => verifyPreparedFfmpeg(ffmpeg, android),
    /preparation did not complete/);
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
        failure === "key" && command.endsWith("jarsigner")) return { ok: false, output: `secret diagnostic ${env.TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD} ${env.TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD}` };
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
test("local Gradle identity and persistent signer are temporary marker-owned configuration", () => {
  const original = ["android {", '        applicationId = "com.tuneforge.desktop"',
    "    buildTypes {", '        getByName("debug") {', "        }", '        getByName("release") {',
    "            isMinifyEnabled = true", "        }", "    }", "}", ""].join("\n");
  const configured = configureLocalBuild(original, "com.example.fixture");
  assert.match(configured, /applicationId = "com\.example\.fixture"/);
  assert.match(configured, /getByName\("tuneforgeLocal"\)/);
  assert.match(configured, /TUNEFORGE_ANDROID_TEST_KEYSTORE_PATH/);
  assert.equal(configured.match(/getByName\("debug"\)/g)?.length, 1);
  assert.equal(removeOwnedSigning(configured).replace('applicationId = "com.example.fixture"',
    'applicationId = "com.tuneforge.desktop"'), original);
});
test("local APK verification requires the persistent test certificate", () => {
  const fingerprint = "ab".repeat(32);
  assert.doesNotThrow(() => verifyLocalSigner("app.apk", { apksigner: "/apksigner" }, fingerprint, {
    runCapture: () => ({ ok: true, output: `Signer #1 certificate SHA-256 digest: ${fingerprint}` }),
  }));
  assert.throws(() => verifyLocalSigner("app.apk", { apksigner: "/apksigner" }, fingerprint, {
    runCapture: () => ({ ok: true, output: `Signer #1 certificate SHA-256 digest: ${"cd".repeat(32)}` }),
  }), /persistent test certificate/);
});
test("Build Tools scheme-prefixed signer output passes strict local and publishable verification", () => {
  const fingerprint = "ab".repeat(32);
  const output = `Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nV2 Signer: certificate SHA-256 digest: ${fingerprint}`;
  const calls = [];
  const runCapture = (command, args) => {
    calls.push([command, args]);
    return { ok: true, output: command === "/apksigner" ? output
      : "versionName='1.2.3'\nnative-code: 'arm64-v8a'" };
  };
  const tools = { apksigner: "/apksigner", aapt2: "/aapt2" };
  assert.doesNotThrow(() => verifyLocalSigner("/app.apk", tools, fingerprint, { runCapture }));
  assert.doesNotThrow(() => verifyPublishable("/app.apk", tools, fingerprint, "1.2.3", { runCapture }));
  for (const [command, args] of calls.filter(([command]) => command === "/apksigner")) {
    assert.equal(command, "/apksigner");
    assert.deepEqual(args, ["verify", "--verbose", "--print-certs", "--Werr", "/app.apk"]);
  }
});
test("signer formats retain one logical identity across documented schemes and exclude source stamps", () => {
  const fingerprint = "ab".repeat(32);
  const flag = (version) => `Verified using v${version} scheme (${version === "1" ? "JAR signing" : `APK Signature Scheme v${version}`}): true`;
  const row = (label, digest = fingerprint) => `${label} certificate SHA-256 digest: ${digest}`;
  const outputs = [
    row("Signer #1", "AB:".repeat(31) + "AB"),
    ...["1", "2", "3"].map((version) => `${flag(version)}\nNumber of signers: 1\n${row(`V${version === "3" ? "3.0" : version} Signer:`)}`),
    `${flag("3.1")}\nNumber of signers: 1\n${row("V3.1 Signer: (minSdkVersion=33 (dev release=true), maxSdkVersion=2147483647)")}`,
    `${flag("3")}\n${flag("3.1")}\nNumber of signers: 1\n${row("V3.0 Signer: (minSdkVersion=28, maxSdkVersion=32)")}\n${row("V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647)")}`,
    `${flag("2")}\nNumber of signers: 1\n${row("V2 Signer:")}\n${row("Source Stamp Signer:", "cd".repeat(32))}`,
    `${row("Signer #1")}\n${row("Source Stamp Signer", "cd".repeat(32))}`,
  ];
  for (const output of outputs) {
    const runCapture = (command) => ({ ok: true, output: command === "/apksigner" ? output
      : "versionName='1.2.3'\nnative-code: 'arm64-v8a'" });
    assert.doesNotThrow(() => verifyLocalSigner("app.apk", { apksigner: "/apksigner" }, fingerprint, { runCapture }), output);
    assert.doesNotThrow(() => verifyPublishable("app.apk", { apksigner: "/apksigner", aapt2: "/aapt2" },
      fingerprint, "1.2.3", { runCapture }), output);
  }
});
test("signer parsing rejects malformed, unsupported, and ambiguous verifier output", () => {
  const fingerprint = "ab".repeat(32);
  const legacy = `Signer #1 certificate SHA-256 digest: ${fingerprint}`;
  const row = `V2 Signer: certificate SHA-256 digest: ${fingerprint}`;
  const flag = "Verified using v2 scheme (APK Signature Scheme v2): true";
  const modern = `${flag}\nNumber of signers: 1\n${row}`;
  const repeated = `Verified using v3 scheme (APK Signature Scheme v3): true\nVerified using v3.1 scheme (APK Signature Scheme v3.1): true\nNumber of signers: 1\nV3.0 Signer: (minSdkVersion=28, maxSdkVersion=32) certificate SHA-256 digest: ${fingerprint}\nV3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${fingerprint}`;
  const outputs = [
    "", `${legacy}\n${legacy}`, `${legacy}\nSigner #2 certificate SHA-256 digest: ${fingerprint}`,
    `${modern}\n${row}`, `${modern}\n${legacy}`, `${legacy}\n${row}`,
    modern.replace("signers: 1", "signers: 2"), `${modern}\nNumber of signers: 1`,
    `${modern.replace("signers: 1", "signers: 2").replace("V2 Signer:", "V2 Signer #1:")}\nV2 Signer #2: certificate SHA-256 digest: ${fingerprint}`,
    modern.replace("signers: 1", "signers: 0"), modern.replace("signers: 1", "signers 1"),
    modern.replace("Number of signers: 1\n", ""), modern.replace("true", "false"),
    modern.replace(`${flag}\n`, ""), `${modern}\n${flag}`,
    modern.replace("APK Signature Scheme v2", "unknown scheme"),
    modern.replace(fingerprint, fingerprint.slice(1)), modern.replace(fingerprint, "zz".repeat(32)),
    modern.replace(fingerprint, "ab:".repeat(32)), modern.replace("digest:", "digest"),
    modern.replace("V2 Signer:", "V2 Signer #1:"), modern.replace("V2 Signer:", "Unknown Signer:"),
    modern.replace("V2 Signer:", "V3.2 Hybrid Classical Signer:"),
    `${modern}\nV2 Signer #2: certificate SHA-256 digest: ${fingerprint}`,
    repeated.replace(/ab(?=[ab]*$)/, "cd"), repeated.replace("minSdkVersion=33", "minSdkVersion=32"),
    repeated.replace("maxSdkVersion=32", "maxSdkVersion=27"),
    repeated.replace("minSdkVersion=28", "minSdkVersion=0"),
    `${repeated}\nV3.0 Signer: (minSdkVersion=26, maxSdkVersion=27) certificate SHA-256 digest: ${fingerprint}`,
    repeated.replace("maxSdkVersion=2147483647", "maxSdkVersion=9007199254740992"),
    repeated.replace("V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647)", "V3.1 Signer:"),
    `${modern}\nVerified using v1 scheme (JAR signing): true\nV1 Signer: certificate SHA-256 digest: ${fingerprint}`,
    `Source Stamp Signer: certificate SHA-256 digest: ${fingerprint}`,
    `${modern}\nSource Stamp Signer: certificate SHA-256 digest: invalid`,
  ];
  for (const output of outputs) {
    const runCapture = (command) => ({ ok: true, output: command === "/apksigner" ? output
      : "versionName='1.2.3'\nnative-code: 'arm64-v8a'" });
    assert.throws(() => verifyLocalSigner("app.apk", { apksigner: "/apksigner" }, fingerprint, { runCapture }),
      /unsupported or ambiguous.*exactly one signer/, output);
    assert.throws(() => verifyPublishable("app.apk", { apksigner: "/apksigner", aapt2: "/aapt2" },
      fingerprint, "1.2.3", { runCapture }), /unsupported or ambiguous.*exactly one signer/, output);
  }
});
test("modern signer fingerprint mismatches remain distinct from failed cryptographic verification", () => {
  const fingerprint = "ab".repeat(32);
  const output = `Verified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nV2 Signer: certificate SHA-256 digest: ${"cd".repeat(32)}`;
  for (const [verify, mismatch] of [
    [(options) => verifyLocalSigner("app.apk", { apksigner: "/apksigner" }, fingerprint, options), /persistent test certificate/],
    [(options) => verifyPublishable("app.apk", { apksigner: "/apksigner" }, fingerprint, "1.2.3", options), /expected certificate/],
  ]) {
    assert.throws(() => verify({ runCapture: () => ({ ok: true, output }) }), mismatch);
    assert.throws(() => verify({ runCapture: () => ({ ok: false, output: "private diagnostic" }) }),
      (error) => /signature verification failed/.test(error.message) && !error.message.includes("private diagnostic"));
  }
});
test("local test keystore is stable and corrupt files are never replaced", (t) => {
  let java;
  try { java = resolveJava(); } catch { t.skip("JDK 17 unavailable"); return; }
  const root = temp(t);
  const first = ensureLocalTestKeystore(java, { homeDir: root });
  const before = crypto.createHash("sha256").update(fs.readFileSync(first.path)).digest("hex");
  const second = ensureLocalTestKeystore(java, { homeDir: root });
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(first.path)).digest("hex"), before);
  fs.writeFileSync(first.path, "corrupt");
  assert.throws(() => ensureLocalTestKeystore(java, { homeDir: root }), /not replaced/);
  assert.equal(fs.readFileSync(first.path, "utf8"), "corrupt");
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
test("release variables are removed from unrelated children and scoped to the publishable build", (t) => {
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
  const discoveryEnv = { JAVA_HOME: "/java17", ...signingEnv("/release.p12") };
  resolveJava({ env: discoveryEnv, hostPlatform: "darwin",
    isExecutable: () => true,
    runCapture: (command, args, options) => {
      discoveryCalls.push({ command, args, options });
      return { ok: true, output: path.basename(command) === "javac" ? "javac 17.0.20" : 'openjdk version "17.0.20"' };
    },
  });
  assert.equal(discoveryCalls.every((call) => call.options.env.TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD === undefined), true);
  const root = temp(t);
  const runCapture = (command, args, options) => {
    for (const name of Object.keys(signingEnv("/release.p12"))) assert.equal(options.env[name], undefined);
    return { ok: true, output: root };
  };
  assert.equal(resolveSdk({ env: signingEnv("/release.p12"), homeDir: root, runCapture }), root);
  ndkFixture(root, ndkRevision);
  assert.equal(resolveNdk(root, { env: { ANDROID_NDK_HOME: root, ...signingEnv("/release.p12") },
    hostPlatform: "linux", hostArch: "x64", runCapture }).path, root);
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
test("all Android package modes share one native preparation path", () => {
  const source = fs.readFileSync(new URL("./package-android.mjs", import.meta.url), "utf8");
  for (const pattern of [/"android", "init"/g, /Android icon generation/g, /\[prepareGenerated\]/g]) {
    assert.equal(source.match(pattern)?.length, 1);
  }
  assert.ok(source.indexOf("prepareNativeProject({ env") < source.indexOf('if (mode === "prepare")'));
  assert.match(source, /build-ffmpeg\.mjs"\),\s+"--target", "android-arm64-v8a", "--ensure"/);
  assert.match(source, /build-soxr\.mjs"\),\s+"--target", "android-arm64-v8a", "--ensure"/);
  assert.match(source, /validateSoxrOutput\(soxrRoot, "android-arm64-v8a", soxrValidationOptions\(env\)\)/);
  assert.ok(source.indexOf("verifyPreparedFfmpeg(ffmpegRoot)") > source.indexOf("[prepareGenerated]"));
  assert.ok(source.indexOf("verifyPreparedSoxr(soxrRoot)") > source.indexOf("[prepareGenerated]"));
  assert.match(source, /validate-android-release-jni\.mjs"\), "--apk", apk/);
  assert.match(source, /\.android.*tuneforge-test\.keystore|tuneforge-test\.keystore/);
  assert.match(source, /run\("bash", args, \{ cwd: desktopDir, env: buildEnv,/);
  assert.match(source, /if \(publishable\) \{\s+const cleanGradle = removeOwnedSigning/);
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

test("direct Android initialization records package-manager context for the Gradle callback", (t) => {
  const source = fs.readFileSync(new URL("./package-android.mjs", import.meta.url), "utf8");
  assert.match(source, /run\("bash", \[androidEnv, "pnpm", "exec", "tauri", "android", "init", "--ci", "--skip-targets-install"\]/);
  const env = Object.fromEntries(Object.entries(sanitizedEnv(process.env))
    .filter(([name]) => !name.startsWith("npm_") && !name.startsWith("PNPM_")));
  const desktop = path.resolve("apps/desktop");
  const metadata = spawnSync("pnpm", ["exec", "node", "-e",
    "console.log(JSON.stringify({name:process.env.PNPM_PACKAGE_NAME,agent:process.env.npm_config_user_agent}))"],
  { cwd: desktop, env, encoding: "utf8" });
  assert.equal(metadata.status, 0, metadata.stderr);
  const selected = JSON.parse(metadata.stdout);
  assert.equal(selected.name, "@tuneforge/desktop");
  assert.match(selected.agent, /^pnpm\//);
  const callback = spawnSync("pnpm", ["tauri", "android", "android-studio-script", "--help"],
    { cwd: path.join(desktop, "src-tauri"), env: { ...env, LIBCLANG_PATH: temp(t) }, encoding: "utf8" });
  assert.equal(callback.status, 0, callback.stderr);
  assert.match(callback.stdout, /android-studio-script/);
  assert.doesNotMatch(callback.stderr, /MODULE_NOT_FOUND|Cannot find module/);
});


test("CLI credential-preflight failure excludes synthetic signing secrets", (t) => {
  const root = temp(t);
  const storeSecret = "synthetic-store-sentinel-584";
  const keySecret = "synthetic-key-sentinel-584";
  const env = { ...sanitizedEnv(process.env), ...signingEnv(path.join(root, "missing.p12")),
    TUNEFORGE_ANDROID_RELEASE_STORE_PASSWORD: storeSecret,
    TUNEFORGE_ANDROID_RELEASE_KEY_PASSWORD: keySecret };
  const result = spawnSync(process.execPath, [path.resolve("scripts/package-android.mjs"), "--publishable"],
    { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /readable regular file/);
  assert.equal(output.includes(storeSecret), false);
  assert.equal(output.includes(keySecret), false);
});

test("host JDK discovery chooses the newest full compatible installed JDK", (t) => {
  const root = temp(t), jvms = path.join(root, "jvms");
  for (const major of [17, 21, 27, 28]) {
    executable(path.join(jvms, String(major), "bin/java"));
    executable(path.join(jvms, String(major), "bin/javac"));
  }
  const result = resolveJava({ env: { PATH: path.join(jvms, "17/bin") }, hostPlatform: "linux", jvmRoots: [jvms],
    runCapture: (command) => {
      const major = path.basename(path.dirname(path.dirname(command)));
      return { ok: true, output: path.basename(command) === "javac" ? `javac ${major}.0.1` : `openjdk version "${major}.0.1"` };
    } });
  assert.equal(result.home, path.join(jvms, "27"));
  assert.equal(result.version, "27.0.1");
});
test("validated macOS SDK inventory remains sufficient for Android packaging", (t) => {
  const sdk = temp(t);
  for (const major of [35, 36]) {
    platformFixture(sdk, String(major));
  }
  for (const version of ["34.0.0", "35.0.0"]) {
    for (const tool of ["aapt2", "apksigner", "dexdump", "zipalign"]) executable(path.join(sdk, "build-tools", version, tool));
  }
  const tools = requireTools(sdk, () => ({ ok: true, output: "aarch64-linux-android" }), {});
  assert.equal(tools.compileSdk, 36);
  assert.equal(tools.version, "35.0.0");
});
function profileInventory(t, hostPlatform, { platform = "36", tools = "35.0.0", java = [17], ndk = ndkRevision } = {}) {
  const root = temp(t), sdk = path.join(root, hostPlatform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  platformFixture(sdk, platform);
  for (const tool of ["aapt2", "apksigner", "dexdump", "zipalign"]) executable(path.join(sdk, "build-tools", tools, tool));
  ndkFixture(path.join(sdk, "ndk", ndk), ndk, hostPlatform === "darwin" ? "darwin-x86_64" : "linux-x86_64");
  const homes = java.map((major) => path.join(root, `jdk-${major}`));
  for (const home of homes) { executable(path.join(home, "bin/java")); executable(path.join(home, "bin/javac")); }
  const options = { env: { PATH: homes.map((home) => path.join(home, "bin")).join(path.delimiter) },
    hostPlatform, hostArch: hostPlatform === "darwin" ? "arm64" : "x64", homeDir: root, jvmRoots: [], standaloneRoots: [],
    isExecutable: (candidate) => {
      if (candidate === path.resolve("apps/desktop/node_modules/.bin/tauri")) return true;
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
    },
    runCapture: (command) => {
      if (command === "rustup") return { ok: true, output: "aarch64-linux-android" };
      if (command === "/usr/libexec/java_home") return { ok: true, output: homes.join("\n") };
      const major = command.match(/jdk-(\d+)/)?.[1];
      return { ok: Boolean(major), output: major ? (path.basename(command) === "javac" ? `javac ${major}.0.1` : `openjdk version "${major}.0.1"`) : "" };
    } };
  return { root, sdk, homes, options };
}
test("toolchain profiles follow complete capabilities across Linux and macOS inventories", (t) => {
  for (const hostPlatform of ["linux", "darwin"]) {
    for (const [inventory, expected] of [
      [{}, ["baseline", "17.0.1", "36", "35.0.0", ndkRevision]],
      [{ platform: "37.2", tools: "37.0.0", java: [17, 27], ndk: "30.0.16248370" }, ["current", "27.0.1", "37.2", "37.0.0", "30.0.16248370"]],
      [{ java: [27, 17] }, ["baseline", "17.0.1", "36", "35.0.0", ndkRevision]],
    ]) {
      const { options, sdk } = profileInventory(t, hostPlatform, inventory);
      platformFixture(sdk, "36.1");
      const selected = resolveAndroidToolchain(options);
      assert.deepEqual([selected.tools.profile, selected.java.version, selected.tools.sdkVersion, selected.tools.version, selected.ndk.version], expected);
      assert.equal(selected.sdk, sdk);
    }
  }
});
test("AGP API cap rejects unsupported platforms and preserves supported minor ordering and baseline fallback", (t) => {
  for (const hostPlatform of ["linux", "darwin"]) {
    const { sdk, options } = profileInventory(t, hostPlatform, { platform: "38", tools: "37.0.0", java: [17, 27] });
    assert.throws(() => resolveAndroidToolchain(options), (error) => {
      assert.match(error.message, /current: JDK 17–27, API 37 \(integer or major.minor platform\)/);
      assert.match(error.message, /baseline: JDK 17–24, API 36 \(integer platform\)/);
      return true;
    });
    assert.throws(() => selectSdkPlatform(sdk), /API 37 stable platform/);
    for (const version of ["37", "37.2", "37.10", "38.99"]) platformFixture(sdk, version);
    for (const [version, minor] of [["37.10", 10], ["37.2", 2], ["37", undefined]]) {
      const selected = resolveAndroidToolchain({ ...options, env: { ...options.env, ANDROID_HOME: sdk } });
      assert.equal(selected.tools.profile, "current");
      assert.equal(selected.sdk, sdk);
      assert.equal(selected.tools.sdkVersion, version);
      assert.deepEqual(selectSdkPlatform(sdk), { major: 37, minor, version });
      fs.rmSync(path.join(sdk, "platforms", `android-${version}`), { recursive: true });
    }
    platformFixture(sdk, "36.1");
    assert.throws(() => resolveAndroidToolchain(options), /No complete compatible Android toolchain/);
    platformFixture(sdk, "36");
    const baseline = resolveAndroidToolchain(options);
    assert.equal(baseline.tools.profile, "baseline");
    assert.equal(baseline.tools.sdkVersion, "36");
    assert.equal(baseline.tools.compileSdkMinor, undefined);
    assert.equal(baseline.java.version, "17.0.1");
  }
});
test("AGP API cap executable probes preserve missing and nonexecutable tool rejection", (t) => {
  const { sdk, homes, options } = profileInventory(t, "linux", { platform: "37.2", tools: "37.0.0" });
  const tauri = path.resolve("apps/desktop/node_modules/.bin/tauri");
  assert.throws(() => resolveAndroidToolchain({ ...options,
    isExecutable: (candidate) => candidate !== tauri && options.isExecutable(candidate) }), /Required Android tool.*tauri/);
  const current = androidToolchainProfiles[0];
  assert.equal(requireTools(sdk, options.runCapture, options.env, undefined, options.isExecutable).profile, "current");
  for (const tool of [path.join(sdk, "build-tools/37.0.0/zipalign"), path.join(homes[0], "bin/javac"),
    path.join(sdk, "ndk", ndkRevision, "shader-tools/linux-x86_64/glslc")]) {
    fs.chmodSync(tool, 0o644);
    assert.throws(() => resolveAndroidToolchain(options), /No complete compatible Android toolchain/);
    fs.chmodSync(tool, 0o755);
  }
  const missing = path.join(sdk, "build-tools/37.0.0/zipalign"); fs.unlinkSync(missing);
  assert.throws(() => requireTools(sdk, options.runCapture, options.env, current), /zipalign/);
});
test("complete profile selection preserves authoritative overrides and reports incompatible inventory", (t) => {
  const { sdk, homes, options } = profileInventory(t, "linux", { java: [27, 17] });
  assert.throws(() => resolveAndroidToolchain({ ...options, env: { ...options.env, JAVA_HOME: homes[0] } }), /No complete compatible.*17–24/);
  assert.equal(resolveAndroidToolchain({ ...options, env: { ...options.env, JAVA_HOME: homes[1], ANDROID_HOME: sdk } }).tools.profile, "baseline");
  assert.throws(() => resolveAndroidToolchain({ ...options, env: { ...options.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: path.dirname(sdk) } }), /same SDK/);
  assert.throws(() => resolveAndroidToolchain({ ...options, env: { ...options.env, NDK_HOME: path.join(sdk, "missing") } }), /No complete compatible.*no stable revision/);
  assert.throws(() => resolveAndroidToolchain({ ...options, env: { ...options.env, NDK_HOME: path.join(sdk, "ndk", ndkRevision), ANDROID_NDK_HOME: sdk } }), /same NDK/);
  fs.rmSync(path.join(sdk, "platforms/android-36"), { recursive: true });
  platformFixture(sdk, "35");
  assert.throws(() => resolveAndroidToolchain(options), /No complete compatible.*API 36 stable platform/);
});
test("explicit compatible Java remains authoritative when a newer complete profile is available", (t) => {
  const { options, homes, sdk } = profileInventory(t, "darwin", { platform: "37.2", tools: "37.0.0", java: [17, 27] });
  const selected = resolveAndroidToolchain({ ...options, env: { ...options.env, JAVA_HOME: homes[0], ANDROID_HOME: sdk } });
  assert.equal(selected.tools.profile, "current"); assert.equal(selected.java.version, "17.0.1");
});
test("incomplete newer SDK cannot hide a complete baseline SDK", (t) => {
  const { options, sdk, root } = profileInventory(t, "linux", { java: [27, 17] });
  const newer = path.join(root, "reported SDK");
  platformFixture(newer, "37.2");
  for (const tool of ["aapt2", "apksigner", "dexdump"]) executable(path.join(newer, "build-tools/37.0.0", tool));
  ndkFixture(path.join(newer, "ndk/30.0.1"), "30.0.1");
  const runCapture = (command, ...args) => command === "android" ? { ok: true, output: newer } : options.runCapture(command, ...args);
  const selected = resolveAndroidToolchain({ ...options, runCapture });
  assert.equal(selected.tools.profile, "baseline"); assert.equal(selected.sdk, sdk); assert.equal(selected.java.version, "17.0.1");
  assert.throws(() => resolveAndroidToolchain({ ...options, runCapture, env: { ...options.env, ANDROID_HOME: newer } }), /No complete compatible/);
  executable(path.join(newer, "build-tools/37.0.0/zipalign"));
  const current = resolveAndroidToolchain({ ...options, runCapture });
  assert.equal(current.tools.profile, "current"); assert.equal(current.sdk, newer); assert.equal(current.java.version, "27.0.1");
});
test("SDK ranking compares complete selected capabilities instead of unusable newer platforms", (t) => {
  const { options, sdk, root } = profileInventory(t, "linux");
  for (const tool of ["aapt2", "apksigner", "dexdump", "zipalign"]) executable(path.join(sdk, "build-tools/36.0.0", tool));
  const reported = path.join(root, "reported SDK");
  platformFixture(reported, "36"); platformFixture(reported, "37.2");
  for (const tool of ["aapt2", "apksigner", "dexdump", "zipalign"]) executable(path.join(reported, "build-tools/35.0.0", tool));
  ndkFixture(path.join(reported, "ndk", ndkRevision), ndkRevision);
  const runCapture = (command, ...args) => command === "android" ? { ok: true, output: reported } : options.runCapture(command, ...args);
  const selected = resolveAndroidToolchain({ ...options, runCapture });
  assert.equal(selected.tools.profile, "baseline"); assert.equal(selected.sdk, sdk); assert.equal(selected.tools.version, "36.0.0");
});
test("SDK discovery resolves sdkmanager symlinks and Linux system locations", (t) => {
  const root = temp(t), sdk = path.join(root, "SDK with spaces"), bin = path.join(root, "bin");
  const manager = path.join(sdk, "cmdline-tools/latest/bin/sdkmanager");
  executable(manager); fs.mkdirSync(bin); fs.symlinkSync(manager, path.join(bin, "sdkmanager"));
  assert.equal(resolveSdk({ env: { PATH: bin }, homeDir: root, runCapture: () => ({ ok: false, output: "" }) }), fs.realpathSync(sdk));
  for (const selected of ["/opt/android-sdk", "/usr/lib/android-sdk"]) {
    assert.equal(resolveSdk({ env: {}, homeDir: root, hostPlatform: "linux", isDirectory: (candidate) => candidate === selected,
      runCapture: () => ({ ok: false, output: "" }) }), selected);
  }
});
test("compilation SDK selects the newest supported stable platform without changing runtime target", (t) => {
  const root = temp(t);
  for (const version of ["36", "37", "38", "39-preview"]) {
    platformFixture(root, version);
  }
  assert.deepEqual(selectSdkPlatform(root), { major: 37, minor: undefined, version: "37" });
  fs.rmSync(path.join(root, "platforms/android-37"), { recursive: true });
  assert.throws(() => selectSdkPlatform(root), /API 37/);
});
const scaffoldFixtures = JSON.parse(fs.readFileSync(new URL("./testdata/tauri-android-templates.json", import.meta.url), "utf8"));
function scaffold(root, version) {
  for (const [file, source] of Object.entries(scaffoldFixtures.versions[version])) {
    const destination = path.join(root, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source.replace("{{android.min-sdk-version}}", "26"));
  }
}
test("owned generator migrates exact legacy and current Tauri templates preserving custom files and signing", (t) => {
  for (const version of ["2.11.4", "2.12.1"]) {
    const root = path.join(temp(t), version); scaffold(root, version);
    const app = path.join(root, "app/build.gradle.kts");
    fs.appendFileSync(app, '\n// custom local block\n');
    configureReleaseDebugSigning(app);
    const wrapperJar = path.join(root, "gradle/wrapper/gradle-wrapper.jar");
    fs.writeFileSync(wrapperJar, "preserved bootstrap");
    const selected = { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision: "30.0.10000000", ndkRoot: path.join(root, "external ndk") };
    configureAndroidToolchain(root, selected);
    const migrated = fs.readFileSync(app, "utf8");
    for (const pattern of [/compileSdk = 37/, /targetSdk = 36/, /minSdk = 26/, /ndkVersion = "30.0.10000000"/,
      /buildToolsVersion = "37.0.0"/, /compilerOptions/, /optimization/, /signingConfigs\.getByName\("debug"\)/, /custom local block/]) assert.match(migrated, pattern);
    assert.doesNotMatch(migrated, /kotlinOptions|getDefaultProguardFile/);
    const task = fs.readFileSync(path.join(root, "buildSrc/src/main/java/com/tuneforge/desktop/kotlin/BuildTask.kt"), "utf8");
    assert.match(task, /execOperations.exec/); assert.doesNotMatch(task, /project.exec|project.projectDir/);
    assert.match(task, /var projectDir: String/); assert.match(task, /{{tauri-binary}}/);
    const plugin = fs.readFileSync(path.join(root, "buildSrc/src/main/java/com/tuneforge/desktop/kotlin/RustPlugin.kt"), "utf8");
    assert.match(plugin, /project.tasks.register/); assert.match(plugin, /projectDir = project.projectDir.path/);
    assert.equal(fs.readFileSync(wrapperJar, "utf8"), "preserved bootstrap");
    const snapshots = Object.keys(scaffoldFixtures.versions[version]).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
    configureAndroidToolchain(root, selected);
    for (const [file, contents] of snapshots) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), contents, file);
    configureAndroidToolchain(root, { ...selected, ndkRevision: "30.1.1", compileSdk: 37, compileSdkMinor: 3 });
    assert.match(fs.readFileSync(app, "utf8"), /ndkVersion = "30.1.1"/);
    assert.match(fs.readFileSync(app, "utf8"), /compileSdkMinor = 3/);
    assert.match(fs.readFileSync(app, "utf8"), /targetSdk = 36/);
  }
});
test("toolchain generation reverses profiles without losing signing, custom content, or source provenance", (t) => {
  for (const version of ["2.11.4", "2.12.1"]) {
    for (const initial of androidToolchainProfiles) {
      const root = temp(t); scaffold(root, version);
      const app = path.join(root, "app/build.gradle.kts");
      configureReleaseDebugSigning(app);
      fs.appendFileSync(app, "\n// custom app configuration\n");
      fs.appendFileSync(path.join(root, "gradle.properties"), "\ncustom.setting=preserved\n");
      const wrapperJar = path.join(root, "gradle/wrapper/gradle-wrapper.jar");
      fs.writeFileSync(wrapperJar, "original wrapper bootstrap");
      const select = (profile) => ({ profile: profile.id, compileSdk: profile.minimumSdk,
        ...(profile.id === "current" ? { compileSdkMinor: 2 } : {}), buildToolsVersion: profile.minimumBuildTools,
        ndkRevision, ndkRoot: path.join(root, "selected ndk") });
      const snapshot = () => Object.keys(scaffoldFixtures.versions[version]).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
      const verify = (profile) => {
        const source = fs.readFileSync(app, "utf8");
        assert.match(source, /minSdk = 26/); assert.match(source, /targetSdk = 36/);
        assert.match(source, /signingConfigs\.getByName\("debug"\)/); assert.match(source, /custom app configuration/);
        assert.equal((source.match(/compileOptions\s*\{/g) ?? []).length, 1);
        if (profile.id === "baseline") {
          assert.match(source, /compileSdk = 36/); assert.match(source, /kotlinOptions\s*\{\s*jvmTarget = "1\.8"/);
          assert.match(source, /isMinifyEnabled = true/); assert.match(source, /getDefaultProguardFile\("proguard-android-optimize.txt"\)/);
          assert.doesNotMatch(source, /compileSdkMinor|compilerOptions|JvmTarget|optimization/);
        } else {
          assert.match(source, /compileSdk = 37\n    compileSdkMinor = 2/); assert.match(source, /compilerOptions/);
          assert.match(source, /optimization\s*\{\s*enable = true/); assert.doesNotMatch(source, /kotlinOptions|getDefaultProguardFile/);
        }
        for (const relative of ["build.gradle.kts", "buildSrc/build.gradle.kts"]) {
          assert.ok(fs.readFileSync(path.join(root, relative), "utf8").includes(`com.android.tools.build:gradle:${profile.agp}`));
        }
        const rootGradle = fs.readFileSync(path.join(root, "build.gradle.kts"), "utf8");
        assert.ok(rootGradle.includes(`kotlin-gradle-plugin:${profile.kotlin}`));
        assert.equal((rootGradle.match(/TUNEFORGE-BUILD-TOOLS-BEGIN/g) ?? []).length, 1);
        assert.equal((rootGradle.match(new RegExp(`dsl.buildToolsVersion = "${profile.minimumBuildTools}"`, "g")) ?? []).length, 2);
        const properties = fs.readFileSync(path.join(root, "gradle.properties"), "utf8");
        assert.match(properties, /custom.setting=preserved/); assert.match(properties, /android.builder.sdkDownload=false/);
        assert.deepEqual(properties.match(/^android\.useAndroidX=.*$/gm), ["android.useAndroidX=true"]);
        if (profile.id === "baseline") assert.doesNotMatch(properties, /android.builtInKotlin|android.newDsl|android.proguard.failOnMissingFiles/);
        else for (const flag of ["android.builtInKotlin=false", "android.newDsl=false", "android.proguard.failOnMissingFiles=false"]) assert.ok(properties.includes(flag));
        const wrapper = fs.readFileSync(path.join(root, "gradle/wrapper/gradle-wrapper.properties"), "utf8");
        assert.ok(wrapper.includes(`gradle-${profile.gradle}-bin.zip`)); assert.ok(wrapper.includes(`distributionSha256Sum=${profile.gradleSha256}`));
        assert.equal(fs.readFileSync(wrapperJar, "utf8"), "original wrapper bootstrap");
        assert.match(fs.readFileSync(path.join(root, "buildSrc/src/main/java/com/tuneforge/desktop/kotlin/BuildTask.kt"), "utf8"), /execOperations.exec/);
      };
      configureAndroidToolchain(root, select(initial)); verify(initial);
      const first = snapshot(); configureAndroidToolchain(root, select(initial));
      assert.deepEqual(snapshot(), first, `${version} ${initial.id} idempotence`);
      const other = androidToolchainProfiles.find((profile) => profile !== initial);
      configureAndroidToolchain(root, select(other)); verify(other);
      configureAndroidToolchain(root, select(initial)); verify(initial);
      assert.deepEqual(snapshot(), first, `${version} ${initial.id} round trip`);
    }
  }
});
test("AndroidX remains explicitly enabled across toolchain profiles and generated template migrations", (t) => {
  for (const version of ["2.12.1", "2.11.4"]) {
    for (const profile of [...androidToolchainProfiles].reverse()) {
      for (const override of ["", "android.useAndroidX=false\n", "android.useAndroidX=false\n android.useAndroidX : false\nandroid.useAndroidX=true\n"]) {
        const root = temp(t); scaffold(root, version);
        const properties = path.join(root, "gradle.properties");
        fs.appendFileSync(properties, `\ncustom.setting=preserved\n${override}`);
        const configurationCache = fs.readFileSync(properties, "utf8").match(/^org\.gradle\.configuration-cache=.*$/m)?.[0];
        const selected = { profile: profile.id, compileSdk: profile.minimumSdk, buildToolsVersion: profile.minimumBuildTools,
          ndkRevision, ndkRoot: path.join(root, "ndk") };
        configureAndroidToolchain(root, selected);
        const configured = fs.readFileSync(properties, "utf8");
        assert.deepEqual(configured.match(/^[ \t]*android\.useAndroidX\s*[=:].*$/gm), ["android.useAndroidX=true"], `${version} ${profile.id}`);
        assert.equal(configured.match(/^org\.gradle\.configuration-cache=.*$/m)?.[0], configurationCache);
        assert.match(configured, /^custom\.setting=preserved$/m);
        assert.match(configured, /^android\.builder\.sdkDownload=false$/m);
        configureAndroidToolchain(root, selected);
        assert.equal(fs.readFileSync(properties, "utf8"), configured);
      }
    }
  }
});
test("incompatible profile settings and unrecognized Kotlin downgrade fail before any generated writes", (t) => {
  const root = temp(t); scaffold(root, "2.12.1");
  const selected = { profile: "baseline", compileSdk: 36, buildToolsVersion: "35.0.0", ndkRevision, ndkRoot: path.join(root, "ndk") };
  const snapshot = () => Object.keys(scaffoldFixtures.versions["2.12.1"]).map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  const before = snapshot();
  for (const override of [{ compileSdkMinor: 1 }, { compileSdk: 37 }, { buildToolsVersion: "34.0.0" }, { profile: "unknown" }]) {
    assert.throws(() => configureAndroidToolchain(root, { ...selected, ...override }), /invalid/);
    assert.deepEqual(snapshot(), before);
  }
  const app = path.join(root, "app/build.gradle.kts");
  fs.writeFileSync(app, fs.readFileSync(app, "utf8").replace("jvmTarget = JvmTarget.JVM_1_8", 'jvmTarget = JvmTarget.JVM_1_8\n        freeCompilerArgs.add("custom")'));
  const custom = snapshot();
  assert.throws(() => configureAndroidToolchain(root, selected), /compilerOptions marker is missing/);
  assert.deepEqual(snapshot(), custom);
});
test("AGP API cap rejects unsupported generation before changing any scaffold file", (t) => {
  for (const version of ["2.11.4", "2.12.1"]) {
    const root = temp(t); scaffold(root, version);
    const snapshot = () => Object.keys(scaffoldFixtures.versions[version]).map((file) =>
      [file, fs.readFileSync(path.join(root, file), "utf8")]);
    const before = snapshot();
    for (const compileSdk of [38, 39]) {
      assert.throws(() => configureAndroidToolchain(root, { profile: "current", compileSdk,
        compileSdkMinor: 2, buildToolsVersion: "37.0.0", ndkRevision, ndkRoot: path.join(root, "ndk") }), /invalid/);
      assert.deepEqual(snapshot(), before);
    }
  }
});
test("selected Build Tools apply to application and external library DSL without changing library sources", (t) => {
  const parent = temp(t), root = path.join(parent, "generated");
  scaffold(root, "2.12.1");
  const library = path.join(parent, "external-library/build.gradle.kts");
  const librarySource = 'plugins { id("com.android.library") }\nandroid {\n    compileSdk = 36\n    buildToolsVersion = "36.0.0"\n    defaultConfig { minSdk = 24; targetSdk = 35 }\n}\n';
  fs.mkdirSync(path.dirname(library));
  fs.writeFileSync(library, librarySource);
  const settingsFile = path.join(root, "settings.gradle");
  fs.appendFileSync(settingsFile, "\ninclude ':external-library'\nproject(':external-library').projectDir = file('../external-library')\n");
  const settings = fs.readFileSync(settingsFile, "utf8");
  fs.appendFileSync(path.join(root, "build.gradle.kts"), "\n// custom root configuration\n");
  const selected = { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision: "30.0.1", ndkRoot: "/selected/ndk" };
  configureAndroidToolchain(root, selected);
  const rootFile = path.join(root, "build.gradle.kts");
  const generated = fs.readFileSync(rootFile, "utf8");
  const owned = generated.match(/\/\/ TUNEFORGE-BUILD-TOOLS-BEGIN\n([\s\S]*?)\/\/ TUNEFORGE-BUILD-TOOLS-END/);
  assert.ok(owned, "Root Gradle configuration must propagate selected Build Tools to Android modules");
  const block = owned[1];
  assert.match(block, /subprojects\s*\{/);
  for (const [plugin, extension] of [["application", "Application"], ["library", "Library"]]) {
    assert.match(block, new RegExp(`plugins\\.withId\\("com\\.android\\.${plugin}"\\)`));
    assert.match(block, new RegExp(`${extension}AndroidComponentsExtension::class\\.java\\)\\.finalizeDsl\\s*\\{\\s*dsl ->\\s*dsl\\.buildToolsVersion = "37\\.0\\.0"`));
  }
  assert.doesNotMatch(block, /compileSdk|minSdk|targetSdk/);
  assert.match(generated, /custom root configuration/);
  assert.equal(fs.readFileSync(library, "utf8"), librarySource);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), settings);
  assert.match(fs.readFileSync(path.join(root, "gradle.properties"), "utf8"), /^android\.builder\.sdkDownload=false$/m);
  configureAndroidToolchain(root, selected);
  assert.equal(fs.readFileSync(rootFile, "utf8"), generated);
  configureAndroidToolchain(root, { ...selected, buildToolsVersion: "38.0.0" });
  const reselected = fs.readFileSync(rootFile, "utf8");
  assert.equal(reselected.match(/TUNEFORGE-BUILD-TOOLS-BEGIN/g).length, 1);
  assert.equal(reselected.match(/dsl\.buildToolsVersion = "38\.0\.0"/g).length, 2);
  assert.doesNotMatch(reselected, /dsl\.buildToolsVersion = "37\.0\.0"/);
  assert.match(fs.readFileSync(path.join(root, "app/build.gradle.kts"), "utf8"), /buildToolsVersion = "38.0.0"/);
  assert.equal(fs.readFileSync(library, "utf8"), librarySource);
});

test("unknown scaffold markers fail before any toolchain file changes", (t) => {
  const root = temp(t); scaffold(root, "2.11.4");
  fs.writeFileSync(path.join(root, "buildSrc/src/main/java/com/tuneforge/desktop/kotlin/RustPlugin.kt"), "custom unsupported plugin");
  const before = fs.readFileSync(path.join(root, "build.gradle.kts"), "utf8");
  assert.throws(() => configureAndroidToolchain(root, { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision: "30.0.1", ndkRoot: "/selected/ndk" }), /unrecognized/);
  assert.equal(fs.readFileSync(path.join(root, "build.gradle.kts"), "utf8"), before);
});

test("NDK aliases accept symlinks for standalone Whisper metadata without relaxing conflicts", (t) => {
  const root = temp(t), ndk = path.join(root, "standalone NDK"), other = path.join(root, "different NDK");
  const revision = "30.0.10000000";
  for (const directory of [ndk, other]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "source.properties"), `Pkg.Revision = ${revision}\n`);
  }
  const aliases = ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"];
  const link = path.join(root, "NDK alias"), secondLink = path.join(root, "second alias");
  fs.symlinkSync(ndk, link, "dir"); fs.symlinkSync(link, secondLink, "dir");
  for (const paths of [[ndk, link, secondLink], [link, secondLink, ndk], [secondLink, ndk, link]]) {
    assert.equal(selectedShaderNdkRevision(Object.fromEntries(aliases.map((name, index) => [name, paths[index]]))), revision);
  }
  for (const name of aliases) {
    assert.equal(selectedShaderNdkRevision({ [name]: ndk }), revision, "Standalone metadata does not require an SDK or executable tools");
    assert.throws(() => selectedShaderNdkRevision({ [name]: other, [aliases[(aliases.indexOf(name) + 1) % aliases.length]]: link }), /same NDK/);
  }
  const missing = path.join(root, "missing NDK"), broken = path.join(root, "broken alias");
  fs.symlinkSync(missing, broken, "dir");
  for (const invalid of [missing, broken]) {
    for (const name of aliases) {
      assert.throws(() => selectedShaderNdkRevision({ [name]: invalid }), /Selected Whisper NDK must declare stable Pkg.Revision/);
    }
    assert.throws(() => selectedShaderNdkRevision({ ANDROID_NDK_HOME: invalid, NDK_HOME: ndk }), /same NDK/);
  }
  assert.equal(selectedShaderNdkRevision({}), ndkRevision);
});

test("Whisper source cache and Cargo target storage follow the actual selected NDK", async (t) => {
  const root = temp(t);
  assert.equal(selectedShaderNdkRevision({}), ndkRevision);
  const first = ndkFixture(path.join(root, "ndk29"), ndkRevision);
  const second = ndkFixture(path.join(root, "ndk30"), "30.0.10000000");
  assert.equal(selectedShaderNdkRevision({ ANDROID_NDK_HOME: second }), "30.0.10000000");
  assert.equal(selectedShaderNdkRevision({ NDK_HOME: second }), "30.0.10000000");
  assert.throws(() => selectedShaderNdkRevision({ NDK_HOME: first, ANDROID_NDK_HOME: second }), /same NDK/);
  assert.throws(() => selectedShaderNdkRevision({ ANDROID_NDK_HOME: first, ANDROID_NDK_ROOT: second }), /same NDK/);
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const patchSha256 = hash(new URL("./patches/whisper-rs-sys-0.15.0-tuneforge.patch", import.meta.url));
  const dtwHelperSha256 = hash(new URL("../apps/desktop/src-tauri/native/whisper-rs-sys/tuneforge_dtw.h", import.meta.url));
  const textHelperSha256 = hash(new URL("../apps/desktop/src-tauri/native/whisper-rs-sys/tuneforge_text.h", import.meta.url));
  const spec = { name: "fixture", version: "1", size: 1, sha256: "crate-hash" }, vulkanSpec = { sha256: "headers-hash" };
  const destinations = [];
  for (const version of [ndkRevision, "30.0.10000000"]) {
    const identity = crypto.createHash("sha256")
      .update([patchSha256, dtwHelperSha256, textHelperSha256, vulkanSpec.sha256, version].join(":"))
      .digest("hex").slice(0, 12);
    const destination = path.join(root, `fixture-1-${identity}`);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, ".tuneforge-source.json"), JSON.stringify({ archiveSha256: spec.sha256,
      patchSha256, dtwHelperSha256, textHelperSha256, vulkanHeadersSha256: vulkanSpec.sha256,
      vulkanShaderNdkRevision: version }));
    fs.writeFileSync(path.join(destination, ".tuneforge-vulkan-ndk-revision"), version);
    destinations.push(await prepareWhisperNativeSource({ destinationRoot: root, spec, vulkanSpec, ndkRevision: version,
      fetchImpl: () => assert.fail("cached selected source must not download") }));
    assert.equal(destinations.at(-1), destination);
  }
  assert.notEqual(destinations[0], destinations[1]);
  const environment = (ndk) => pinnedEnv({ home: "/java" }, "/sdk", ndk, { env: {}, homeDir: root });
  assert.notEqual(environment({ path: first, version: ndkRevision }).CARGO_TARGET_DIR,
    environment({ path: second, version: "30.0.10000000" }).CARGO_TARGET_DIR);
});

test("rendered Tauri buildSrc layout is required instead of raw template paths", (t) => {
  const root = temp(t); scaffold(root, "2.12.1");
  assert.equal(scaffoldFixtures.renderedPackagePath, "java/com/tuneforge/desktop");
  for (const name of ["BuildTask", "RustPlugin"]) {
    assert.ok(fs.existsSync(path.join(root, `buildSrc/src/main/java/com/tuneforge/desktop/kotlin/${name}.kt`)));
    assert.equal(fs.existsSync(path.join(root, `buildSrc/src/main/kotlin/${name}.kt`)), false);
  }
  configureAndroidToolchain(root, { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision: "30.0.1", ndkRoot: "/external/ndk" });
});
test("Tauri NDK_HOME uses the selected authoritative root including external installations", (t) => {
  const root = temp(t), external = ndkFixture(path.join(root, "external ndk"), "30.0.1");
  const incomplete = ndkFixture(path.join(root, "sdk/ndk/31.0.1"), "31.0.1");
  fs.unlinkSync(path.join(incomplete, "shader-tools/linux-x86_64/glslc"));
  const selected = resolveNdk(path.join(root, "sdk"), { env: { NDK_HOME: external }, standaloneRoots: [], hostPlatform: "linux", hostArch: "x64" });
  assert.deepEqual(selected, { path: external, version: "30.0.1" });
  assert.throws(() => resolveNdk(root, { env: { NDK_HOME: external, ANDROID_NDK_HOME: incomplete } }), /same NDK/);
  assert.throws(() => resolveNdk(root, { env: { NDK_HOME: "/missing" } }), /no stable revision/);
  const env = pinnedEnv({ home: "/java" }, "/sdk", selected, { homeDir: root, env: { NDK_HOME: incomplete } });
  assert.equal(env.NDK_HOME, external);
  assert.equal(env.ANDROID_NDK_HOME, external);
  assert.equal(env.ANDROID_NDK_ROOT, external);
});
test("Gradle receives an escaped absolute external NDK path and retains its exact revision", (t) => {
  const root = temp(t); scaffold(root, "2.12.1");
  const ndkRoot = path.join(root, 'standalone "NDK" $& ${quoted} \\tools');
  const selected = { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision: "30.0.1", ndkRoot };
  const app = path.join(root, "app/build.gradle.kts");
  configureAndroidToolchain(root, selected);
  const source = fs.readFileSync(app, "utf8");
  const line = source.split("\n").find((entry) => entry.trimStart().startsWith("ndkPath ="));
  assert.equal(line.trim(), `ndkPath = ${JSON.stringify(ndkRoot).replaceAll("$", "\\$")}`);
  assert.match(source, /ndkVersion = "30\.0\.1"/);
  configureAndroidToolchain(root, selected);
  assert.equal(fs.readFileSync(app, "utf8"), source);
});
test("conflicting local.properties ndk.dir fails before writes and preserves other local properties", (t) => {
  const root = temp(t); scaffold(root, "2.11.4");
  const selectedNdk = ndkFixture(path.join(root, "external NDK"), "30.0.1");
  const competingNdk = ndkFixture(path.join(root, "sdk/ndk/30.0.1"), "30.0.1");
  const properties = path.join(root, "local.properties");
  const unrelated = "sdk.dir=/custom/sdk\nlocal.custom=preserved\n";
  fs.writeFileSync(properties, unrelated + `ndk.dir=${competingNdk}\n`);
  const snapshots = Object.keys(scaffoldFixtures.versions["2.11.4"]).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
  const selected = { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision: "30.0.1", ndkRoot: selectedNdk };
  assert.throws(() => configureAndroidToolchain(root, selected), /ndk.dir conflicts/);
  for (const [file, contents] of snapshots) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), contents, file);
  assert.equal(fs.readFileSync(properties, "utf8"), unrelated + `ndk.dir=${competingNdk}\n`);
  const matching = unrelated + `ndk.dir=${selectedNdk.replaceAll(" ", "\\ ")}\n`;
  fs.writeFileSync(properties, matching);
  configureAndroidToolchain(root, selected);
  assert.equal(fs.readFileSync(properties, "utf8"), matching);
  const app = path.join(root, "app/build.gradle.kts");
  const source = fs.readFileSync(app, "utf8");
  assert.doesNotMatch(source, /\bndkPath\s*=/);
  assert.match(source, /ndkVersion = "30\.0\.1"/);
  configureAndroidToolchain(root, selected);
  assert.equal(fs.readFileSync(app, "utf8"), source);
});

test("NDK aliases accept symlinks while honoring recorded external paths and exact generated revisions", (t) => {
  const root = temp(t); scaffold(root, "2.12.1");
  const sdk = path.join(root, "sdk"), external = ndkFixture(path.join(root, 'external "NDK" $dollar ${literal} \\tools'), ndkRevision);
  const pinned = ndkFixture(path.join(sdk, "ndk", ndkRevision), ndkRevision);
  const newer = ndkFixture(path.join(sdk, "ndk/30.0.10000000"), "30.0.10000000");
  const app = path.join(root, "app/build.gradle.kts");
  const options = { env: {}, hostPlatform: "linux", hostArch: "x64", standaloneRoots: [] };
  configureAndroidToolchain(root, { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision, ndkRoot: external });
  const source = fs.readFileSync(app, "utf8"), recorded = readGeneratedNdk(app);
  assert.equal(recorded.path, external);
  assert.equal(recorded.version, ndkRevision);
  assert.deepEqual(resolveGeneratedNdk(sdk, recorded, options), { path: external, version: ndkRevision });
  const alias = path.join(root, "ndk-alias"); fs.symlinkSync(external, alias, "dir");
  assert.deepEqual(resolveGeneratedNdk(sdk, recorded, { ...options,
    env: { ANDROID_NDK_ROOT: alias, NDK_HOME: external } }), { path: alias, version: ndkRevision });
  assert.throws(() => resolveGeneratedNdk(sdk, recorded, { ...options, env: { ANDROID_NDK_HOME: newer } }), /disagrees.*Reconfigure/);
  assert.throws(() => resolveGeneratedNdk(sdk, { ...recorded, version: "30.0.10000000" }, options), /does not match generated ndkVersion.*Reconfigure/);
  fs.writeFileSync(app, source.replace(/^\s*ndkPath\s*=.*\n/m, ""));
  assert.deepEqual(resolveGeneratedNdk(sdk, readGeneratedNdk(app), options), { path: pinned, version: ndkRevision });
  fs.unlinkSync(path.join(external, "shader-tools/linux-x86_64/glslc"));
  assert.throws(() => resolveGeneratedNdk(sdk, recorded, options), /glslc.*Reconfigure/);
  for (const declaration of ['ndkPath = "${dynamic}"', 'ndkPath = "/a"\n    ndkPath = "/b"', 'ndkVersion = "29.0.1"\n    ndkVersion = "30.0.1"']) {
    const name = declaration.startsWith("ndkPath") ? "ndkPath" : "ndkVersion";
    fs.writeFileSync(app, source.replace(new RegExp(`^[ \\t]*${name}\\s*=.*\\n`, "gm"), "").replace("android {", `android {\n    ${declaration}`));
    assert.throws(() => readGeneratedNdk(app), /literal declaration|interpolate/);
  }
});

test("NDK aliases accept symlinks with escaped Java properties consistently across configuration and Studio", (t) => {
  const root = temp(t); scaffold(root, "2.12.1");
  const external = ndkFixture(path.join(root, 'external "NDK" ${literal} \\tools'), ndkRevision);
  const alias = path.join(root, 'external alias "NDK" ${literal} \\tools'); fs.symlinkSync(external, alias, "dir");
  const properties = path.join(root, "local.properties"), app = path.join(root, "app/build.gradle.kts");
  const selected = { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision, ndkRoot: external };
  for (const delimiter of ["=", " : ", " "]) {
    fs.writeFileSync(properties, `ndk.dir${delimiter}${escapeLocalProperty(alias).replace("external", "\\u0065xternal")}\n`);
    assert.equal(readLocalNdkPath(properties), alias);
    configureAndroidToolchain(root, selected);
    const recorded = readGeneratedNdk(app);
    assert.equal(recorded.localPath, alias);
    assert.deepEqual(resolveGeneratedNdk(path.join(root, "sdk"), recorded, {
      env: {}, hostPlatform: "linux", hostArch: "x64", standaloneRoots: [],
    }), { path: alias, version: ndkRevision });
  }
  const before = fs.readFileSync(app, "utf8");
  for (const declaration of ["ndk.dir=relative", "ndk.dir=/bad\\uZZZZ", "ndk.dir=/a\\", "ndk.dir=/a\nndk.dir=/a"]) {
    fs.writeFileSync(properties, `${declaration}\n`);
    assert.throws(() => configureAndroidToolchain(root, selected), /absolute|Unicode|continuation|unambiguous/);
    assert.equal(fs.readFileSync(app, "utf8"), before);
  }
});

function platformXml(version, { preview = "0", beta = "", codename, base = "true" } = {}) {
  return `<r:repository xmlns:r="http://schemas.android.com/repository/android/common/02" xmlns:p="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><localPackage path="platforms;android-${version}"><type-details xsi:type="p:platformDetailsType"><api-level>${version}</api-level><base-extension>${base}</base-extension><layoutlib api="15"/>` +
    (codename === undefined ? "" : `<codename>${codename}</codename>`) + (beta ? `<beta-number>${beta}</beta-number>` : "") +
    (preview === "0" ? "" : `<canary-number>${preview}</canary-number>`) + "</type-details><revision><major>1</major></revision><display-name>Android SDK Platform</display-name></localPackage></r:repository>";
}
function platformFixture(sdk, version, { preview = "0", beta = "", codename, complete = true, xml = version.includes(".") } = {}) {
  const platform = path.join(sdk, "platforms", `android-${version}`);
  fs.mkdirSync(platform, { recursive: true });
  fs.writeFileSync(path.join(platform, "source.properties"),
    `Pkg.Revision=1\nAndroidVersion.ApiLevel=${version}\nAndroidVersion.PreviewSdkInt=${preview}\nAndroidVersion.BetaVersion=${beta}\n` +
    (codename === undefined ? "" : `AndroidVersion.CodeName=${codename}\n`) + "Pkg.Desc=Android SDK Platform\n");
  if (complete) fs.writeFileSync(path.join(platform, "android.jar"), "fixture");
  fs.writeFileSync(path.join(platform, "build.prop"), "");
  if (xml) fs.writeFileSync(path.join(platform, "package.xml"), platformXml(version, { preview, beta, codename }));
  return platform;
}
test("stable integer and dotted SDK platforms use numeric major/minor ordering and complete metadata", (t) => {
  const root = temp(t);
  platformFixture(root, "36");
  platformFixture(root, "37.0");
  platformFixture(root, "37.2");
  platformFixture(root, "37.10");
  platformFixture(root, "37.11.1");
  platformFixture(root, "38.0", { beta: "1" });
  platformFixture(root, "39.0", { preview: "1" });
  platformFixture(root, "40-preview");
  platformFixture(root, "41.0", { complete: false });
  assert.deepEqual(selectSdkPlatform(root), { major: 37, minor: 10, version: "37.10" });
  fs.unlinkSync(path.join(root, "platforms/android-37.10/android.jar"));
  assert.deepEqual(selectSdkPlatform(root), { major: 37, minor: 2, version: "37.2" });
  fs.unlinkSync(path.join(root, "platforms/android-37.2/android.jar"));
  platformFixture(root, "37");
  assert.deepEqual(selectSdkPlatform(root), { major: 37, minor: 0, version: "37.0" });
  fs.unlinkSync(path.join(root, "platforms/android-37.0/android.jar"));
  assert.deepEqual(selectSdkPlatform(root), { major: 37, minor: undefined, version: "37" });
});

test("stable integer and dotted SDK metadata uses XML identity first and legacy metadata only as fallback", (t) => {
  const root = temp(t), platform = platformFixture(root, "37", { xml: true });
  const xmlFile = path.join(platform, "package.xml"), properties = path.join(platform, "source.properties");
  fs.writeFileSync(xmlFile, platformXml("37.1").replaceAll("r:", "z:").replaceAll("xmlns:r=", "xmlns:z=").replaceAll("repository2/03", "repository2/04"));
  fs.unlinkSync(properties);
  assert.deepEqual(selectSdkPlatform(root), { major: 37, minor: 1, version: "37.1" });
  assert.equal(hasSdkPlatform(root, { major: 37, minor: undefined }), false);
  fs.writeFileSync(properties, "Pkg.Revision=1\nAndroidVersion.ApiLevel=36\nAndroidVersion.CodeName=REL\n");
  fs.writeFileSync(xmlFile, "<broken>");
  assert.equal(hasSdkPlatform(root, { major: 36, minor: undefined }), true);
  assert.throws(() => selectSdkPlatform(root), /API 37/);
  fs.writeFileSync(xmlFile, platformXml("37.1").replace("Android SDK Platform", "Unknown package"));
  assert.equal(hasSdkPlatform(root, { major: 36, minor: undefined }), true);
  fs.unlinkSync(xmlFile);
  fs.writeFileSync(properties, "Pkg.Revision=1\nAndroidVersion.ApiLevel=37\nAndroidVersion.ApiMinorLevel=1\n");
  assert.deepEqual(selectSdkPlatform(root), { major: 37, minor: undefined, version: "37" });
  assert.equal(hasSdkPlatform(root, { major: 37, minor: 1 }), false);
  for (const legacy of ["AndroidVersion.ApiLevel=37\n", "Pkg.Revision=bad\nAndroidVersion.ApiLevel=37\n",
    "Pkg.Revision=1\n", "Pkg.Revision=1\nAndroidVersion.ApiLevel=37.1\n", "Pkg.Revision=1\nAndroidVersion.ApiLevel=bad\n"]) {
    fs.writeFileSync(properties, legacy);
    assert.throws(() => selectSdkPlatform(root), /API 37/);
  }
});

test("stable integer and dotted SDK metadata rejects preview and extension targets without legacy fallback", (t) => {
  const root = temp(t), platform = platformFixture(root, "37", { xml: true });
  const xml = path.join(platform, "package.xml"), properties = path.join(platform, "source.properties");
  for (const metadata of [{ codename: "Preview" }, { codename: "rel" }, { beta: "1" }, { preview: "1" }, { base: "false" }]) {
    fs.writeFileSync(xml, platformXml("37", metadata));
    assert.throws(() => selectSdkPlatform(root), /API 37/);
  }
  fs.writeFileSync(xml, platformXml("37").replace("<base-extension>true</base-extension>", ""));
  assert.equal(selectSdkPlatform(root).version, "37");
  fs.writeFileSync(xml, platformXml("37").replace("<base-extension>true</base-extension>", "<base-extension>true</base-extension><extension-level>20</extension-level>"));
  assert.equal(selectSdkPlatform(root).version, "37");
  fs.unlinkSync(xml);
  fs.appendFileSync(properties, "AndroidVersion.IsBaseSdk=false\n");
  assert.throws(() => selectSdkPlatform(root), /API 37/);
  fs.writeFileSync(properties, "Pkg.Revision=1\nAndroidVersion.ApiLevel=37\nAndroidVersion.IsBaseSdk=true\nAndroidVersion.ExtensionLevel=20\n");
  assert.equal(selectSdkPlatform(root).version, "37");
});

test("stable integer and dotted SDK metadata requires complete files and rejects malformed XML fragments", (t) => {
  const root = temp(t), platform = platformFixture(root, "37.2");
  const xml = path.join(platform, "package.xml");
  fs.unlinkSync(path.join(platform, "source.properties"));
  for (const invalid of [`<!--${platformXml("37.2")}-->`, `<broken>${platformXml("37.2")}`,
    platformXml("37.2").replace("</type-details>", "</wrong>"), platformXml("37.2").replace("<api-level>37.2</api-level>", "<!--<api-level>37.2</api-level>-->")]) {
    fs.writeFileSync(xml, invalid);
    assert.throws(() => selectSdkPlatform(root), /API 37/);
  }
  fs.writeFileSync(xml, platformXml("37.2"));
  for (const name of ["build.prop", "android.jar"]) {
    fs.unlinkSync(path.join(platform, name));
    assert.throws(() => selectSdkPlatform(root), /API 37/);
    fs.mkdirSync(path.join(platform, name));
    assert.throws(() => selectSdkPlatform(root), /API 37/);
    fs.rmdirSync(path.join(platform, name)); fs.writeFileSync(path.join(platform, name), "");
  }
  const reported = path.join(root, "reported"), home = path.join(root, "Android/Sdk");
  fs.mkdirSync(path.join(reported, "platforms/android-38"), { recursive: true });
  fs.writeFileSync(path.join(reported, "platforms/android-38/android.jar"), "");
  platformFixture(home, "37.1");
  assert.equal(resolveSdk({ env: {}, homeDir: root, hostPlatform: "linux", isDirectory: (candidate) => [reported, home].includes(candidate),
    runCapture: () => ({ ok: true, output: reported }) }), home);
});

test("stable integer and dotted SDK package revisions reject previews independently of stable API metadata", (t) => {
  const root = temp(t), platform = platformFixture(root, "37", { codename: "REL" });
  const properties = path.join(platform, "source.properties"), original = fs.readFileSync(properties, "utf8");
  for (const revision of ["1", "1.2.3", "1rc0", "2beta0", "1 -- alpha0", "1.2.3.0", "2147483647.0.0"]) {
    fs.writeFileSync(properties, original.replace("Pkg.Revision=1", `Pkg.Revision=${revision}`));
    assert.equal(selectSdkPlatform(root).version, "37", revision);
  }
  for (const revision of ["1rc1", "2beta1", "3 alpha1", "1.2.3.4", "1.2.3-.4", "2147483648", "1rc2147483648", "1\u00a0rc0", "1 rc-1"]) {
    fs.writeFileSync(properties, original.replace("Pkg.Revision=1", `Pkg.Revision=${revision}`));
    assert.throws(() => selectSdkPlatform(root), /API 37/, revision);
  }
  fs.writeFileSync(properties, original);
  for (const preview of [undefined, "0", "1", "-1", "", "bad", "2147483648", "0</preview><preview>0", "<major>0</major>"]) {
    const xml = platformXml("37", { codename: "REL" }).replace("</revision>",
      `${preview === undefined ? "" : `<preview>${preview}</preview>`}</revision>`);
    fs.writeFileSync(path.join(platform, "package.xml"), xml);
    if (preview === undefined || preview === "0") assert.equal(selectSdkPlatform(root).version, "37");
    else assert.throws(() => selectSdkPlatform(root), /API 37/, "Recognized XML previews must not fall back to release properties");
  }
  const inventory = profileInventory(t, "linux", { platform: "37", tools: "37.0.0" });
  fs.writeFileSync(path.join(inventory.sdk, "platforms/android-37/source.properties"), "Pkg.Revision=1rc1\nAndroidVersion.ApiLevel=37\n");
  assert.throws(() => resolveAndroidToolchain({ ...inventory.options, env: { ...inventory.options.env, ANDROID_HOME: inventory.sdk },
    runCapture: (command, ...args) => {
      assert.notEqual(command, "android", "Authoritative preview-only SDK must not discover an alternative");
      return inventory.options.runCapture(command, ...args);
    } }), /No complete compatible Android toolchain/);
});

test("SDK aliases accept symlinks while enforcing recorded SDK consistency before generated writes", (t) => {
  const first = profileInventory(t, "linux"), second = profileInventory(t, "linux", { platform: "37", tools: "37.0.0" });
  const options = { ...first.options, runCapture: (command, ...args) => command === "android"
    ? { ok: true, output: second.sdk } : first.options.runCapture(command, ...args) };
  const selected = resolveAndroidToolchain(options);
  assert.equal(selected.sdk, second.sdk);
  const root = temp(t); scaffold(root, "2.12.1");
  const properties = path.join(root, "local.properties");
  const env = { ...pinnedEnv(selected.java, selected.sdk, selected.ndk, { env: {}, homeDir: path.join(root, "home"), tools: selected.tools }),
    TUNEFORGE_ANDROID_BUILD_TOOLS: selected.tools.version, TUNEFORGE_ANDROID_NDK_REVISION: selected.ndk.version };
  const snapshot = () => Object.keys(scaffoldFixtures.versions["2.12.1"]).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
  fs.writeFileSync(properties, `# manual SDK\nsdk.dir=${escapeLocalProperty(first.sdk)}\n`);
  const before = snapshot(), conflicting = fs.readFileSync(properties, "utf8");
  assert.throws(() => configureAndroidToolchainFromEnv(root, env), /sdk.dir conflicts.*Remove or align/);
  assert.deepEqual(snapshot(), before); assert.equal(fs.readFileSync(properties, "utf8"), conflicting);
  const alias = path.join(root, "SDK alias"); fs.symlinkSync(second.sdk, alias, "dir");
  for (const sdk of [second.sdk, path.relative(root, second.sdk), alias]) {
    const value = escapeLocalProperty(sdk).replace("Android", "\\u0041ndroid");
    const original = `# preserve comments\r\nsdk.dir : ${value}\r\nndk.dir=${escapeLocalProperty(selected.ndk.path)}\r\ncustom.setting=preserved\r\n`;
    fs.writeFileSync(properties, original);
    configureAndroidToolchainFromEnv(root, env);
    assert.equal(fs.readFileSync(properties, "utf8"), original);
  }
  for (const invalid of ["sdk.dir=", "sdk.dir=/bad\\uZZZZ", "sdk.dir=/a\\", `sdk.dir=${second.sdk}\nsdk.dir=${second.sdk}`]) {
    fs.writeFileSync(properties, `${invalid}\n`); const stable = snapshot();
    assert.throws(() => configureAndroidToolchainFromEnv(root, env), /sdk.dir/);
    assert.deepEqual(snapshot(), stable); assert.equal(fs.readFileSync(properties, "utf8"), `${invalid}\n`);
  }
  fs.unlinkSync(properties);
  configureAndroidToolchainFromEnv(root, env);
  assert.equal(fs.existsSync(properties), false, "Absent SDK property remains usable through selected environment aliases");
  const stable = snapshot(), missing = { ...env }; delete missing.ANDROID_HOME; delete missing.ANDROID_SDK_ROOT;
  assert.throws(() => configureAndroidToolchainFromEnv(root, missing), /selected Android SDK must be provided/);
  assert.throws(() => configureAndroidToolchainFromEnv(root, { ...env, ANDROID_SDK_ROOT: first.sdk }), /same SDK/);
  assert.deepEqual(snapshot(), stable);
});
test("stable integer and dotted SDK codenames exclude previews from selection and root ranking", (t) => {
  for (const version of ["37", "37.2"]) {
    for (const codename of [undefined, "", "REL", "  REL  ", "   ", "Baklava"]) {
      for (const missingFlags of [false, true]) {
        const root = temp(t), platform = platformFixture(root, version, { codename });
        if (missingFlags) {
          const metadata = path.join(platform, "source.properties");
          fs.writeFileSync(metadata, fs.readFileSync(metadata, "utf8").replace(/^AndroidVersion\.(?:PreviewSdkInt|BetaVersion)=.*\n/gm, ""));
        }
        if (codename === "Baklava") assert.throws(() => selectSdkPlatform(root), /API 37 stable platform/);
        else assert.equal(selectSdkPlatform(root).version, version);
      }
    }
  }
  const root = temp(t), reported = path.join(root, "reported"), home = path.join(root, "Android/Sdk");
  platformFixture(reported, "37.10", { codename: "Baklava" });
  platformFixture(home, "37.2", { codename: "REL" });
  const options = { env: {}, homeDir: root, hostPlatform: "linux",
    isDirectory: (candidate) => [reported, home].includes(candidate), runCapture: () => ({ ok: true, output: reported }) };
  assert.equal(resolveSdk(options), home);
  platformFixture(reported, "37", { codename: "REL" });
  assert.equal(selectSdkPlatform(reported).version, "37");
  assert.equal(resolveSdk(options), home);
});
test("SDK root discovery ranks the same complete stable dotted platforms as platform selection", (t) => {
  const root = temp(t), reported = path.join(root, "reported"), home = path.join(root, "Android/Sdk");
  platformFixture(reported, "37.0");
  platformFixture(reported, "39.0", { preview: "1" });
  platformFixture(reported, "40.0", { complete: false });
  platformFixture(home, "37.2");
  const options = { env: {}, homeDir: root, hostPlatform: "linux",
    isDirectory: (candidate) => [reported, home].includes(candidate),
    runCapture: () => ({ ok: true, output: reported }) };
  assert.equal(resolveSdk(options), home);
  assert.equal(selectSdkPlatform(resolveSdk(options)).version, "37.2");
  platformFixture(reported, "37.10");
  assert.equal(resolveSdk(options), reported);
  assert.equal(selectSdkPlatform(resolveSdk(options)).version, "37.10");
  fs.unlinkSync(path.join(reported, "platforms/android-37.10/android.jar"));
  fs.unlinkSync(path.join(home, "platforms/android-37.2/android.jar"));
  platformFixture(home, "37");
  assert.equal(resolveSdk(options), reported);
  assert.equal(selectSdkPlatform(resolveSdk(options)).version, "37.0");
});
test("selected SDK major/minor propagates through preflight, environment, and scaffold reselection", (t) => {
  const root = temp(t), generated = path.join(root, "generated");
  scaffold(generated, "2.11.4");
  for (const version of ["37.2", "37.0", "37"]) {
    const sdk = path.join(root, `sdk-${version}`);
    platformFixture(sdk, version);
    for (const name of ["aapt2", "apksigner", "dexdump", "zipalign"]) executable(path.join(sdk, "build-tools/37.0.0", name));
    const tools = requireTools(sdk, (command, args) => {
      assert.equal(command, "rustup"); assert.deepEqual(args, ["target", "list", "--installed"]);
      return { ok: true, output: "aarch64-linux-android\n" };
    }, {});
    const expectedMinor = version.includes(".") ? Number(version.split(".")[1]) : undefined;
    assert.equal(tools.compileSdk, 37);
    assert.equal(tools.compileSdkMinor, expectedMinor);
    assert.equal(tools.sdkVersion, version);
    const env = {
      ...pinnedEnv({ home: "/java" }, sdk, { path: "/selected/ndk", version: "30.0.1" }, {
        homeDir: root, tools, env: { TUNEFORGE_ANDROID_COMPILE_SDK_MINOR: "9" },
      }),
      TUNEFORGE_ANDROID_BUILD_TOOLS: tools.version, TUNEFORGE_ANDROID_NDK_REVISION: "30.0.1",
    };
    assert.equal(env.TUNEFORGE_ANDROID_COMPILE_SDK, "37");
    assert.equal(env.TUNEFORGE_ANDROID_COMPILE_SDK_MINOR, expectedMinor === undefined ? "" : String(expectedMinor));
    configureAndroidToolchainFromEnv(generated, env);
    const app = path.join(generated, "app/build.gradle.kts"), source = fs.readFileSync(app, "utf8");
    assert.match(source, /compileSdk = 37\b/);
    assert.match(source, /targetSdk = 36\b/); assert.match(source, /minSdk = 26\b/);
    if (expectedMinor === undefined) assert.doesNotMatch(source, /compileSdkMinor/);
    else assert.deepEqual(source.match(/compileSdkMinor = \d+/g), [`compileSdkMinor = ${expectedMinor}`]);
    configureAndroidToolchainFromEnv(generated, env);
    assert.equal(fs.readFileSync(app, "utf8"), source);
  }
});
