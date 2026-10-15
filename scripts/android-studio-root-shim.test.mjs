import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { configureAndroidToolchain } from "./android-configure-toolchain.mjs";
import { androidToolchainProfiles, resolveSdk, readLocalNdkPath, escapeLocalProperty } from "./android-toolchain.mjs";

const fixtures = JSON.parse(fs.readFileSync(new URL("./testdata/tauri-android-templates.json", import.meta.url), "utf8"));

function shimFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-studio-shim-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generated = path.join(root, "apps/desktop/src-tauri/gen/android");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(new URL("./android-studio-root-shim.sh", import.meta.url), path.join(root, "scripts/android-studio-root-shim.sh"));
  fs.copyFileSync(new URL("./android-toolchain.mjs", import.meta.url), path.join(root, "scripts/android-toolchain.mjs"));
  fs.cpSync(new URL("./android-studio-root-shim-templates", import.meta.url), path.join(root, "scripts/android-studio-root-shim-templates"), { recursive: true });
  for (const [file, contents] of Object.entries(fixtures.versions["2.12.1"])) {
    fs.mkdirSync(path.dirname(path.join(generated, file)), { recursive: true });
    fs.writeFileSync(path.join(generated, file), contents.replace("{{android.min-sdk-version}}", "26"));
  }
  fs.writeFileSync(path.join(generated, "settings.gradle"), "include ':app'\n");
  for (const file of ["gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar"]) {
    fs.writeFileSync(path.join(generated, file), "fixture wrapper; never execute\n");
  }
  return { root, generated };
}

function sdkPlatform(sdk, version, { metadata = "", complete = true } = {}) {
  const platform = path.join(sdk, "platforms", `android-${version}`);
  fs.mkdirSync(platform, { recursive: true });
  fs.writeFileSync(path.join(platform, "source.properties"), `Pkg.Revision=1\nAndroidVersion.ApiLevel=${version}\n${metadata}`);
  fs.writeFileSync(path.join(platform, "build.prop"), "");
  if (version.includes(".")) {
    const codename = metadata.match(/^AndroidVersion.CodeName=(.*)$/m)?.[1];
    const preview = /AndroidVersion\.(?:PreviewSdkInt|BetaVersion)=[1-9]/.test(metadata);
    fs.writeFileSync(path.join(platform, "package.xml"), `<r:repository xmlns:r="http://schemas.android.com/repository/android/common/02" xmlns:p="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><localPackage path="platforms;android-${version}"><type-details xsi:type="p:platformDetailsType"><api-level>${version}</api-level><base-extension>true</base-extension><layoutlib api="15"/>` +
      (codename ? `<codename>${codename}</codename>` : "") + (preview ? "<beta-number>1</beta-number>" : "") +
      "</type-details><revision><major>1</major></revision><display-name>Android SDK Platform</display-name></localPackage></r:repository>");
  }
  if (complete) fs.writeFileSync(path.join(platform, "android.jar"), "fixture platform");
  else fs.rmSync(path.join(platform, "android.jar"), { force: true });
}

test("Studio root shim follows selected generated profiles across switches", (t) => {
  const { root, generated } = shimFixture(t);
  fs.appendFileSync(path.join(generated, "gradle.properties"), "\ncustom.setting=preserved\ntargetList=x86_64\narchList=x86_64\nabiList=x86_64\n");
  const sdk = path.join(root, "sdk");
  for (const version of ["36", "37"]) sdkPlatform(sdk, version);
  const baseline = androidToolchainProfiles.find(({ id }) => id === "baseline");
  const current = androidToolchainProfiles.find(({ id }) => id === "current");
  for (const profile of [baseline, current, baseline]) {
    configureAndroidToolchain(generated, { profile: profile.id, compileSdk: profile.minimumSdk,
      buildToolsVersion: profile.minimumBuildTools, ndkRevision: "29.0.14206865", ndkRoot: path.join(root, "ndk") });
    const result = spawnSync("bash", [path.join(root, "scripts/android-studio-root-shim.sh")], {
      cwd: root, env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    for (const file of ["build.gradle.kts", "gradle/wrapper/gradle-wrapper.properties", "buildSrc/build.gradle.kts"]) {
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), fs.readFileSync(path.join(generated, file), "utf8"));
    }
    const properties = fs.readFileSync(path.join(root, "gradle.properties"), "utf8");
    const generatedProperties = fs.readFileSync(path.join(generated, "gradle.properties"), "utf8");
    for (const line of generatedProperties.split(/\r?\n/).filter((line) => line && !/^(targetList|archList|abiList|android\.builder\.sdkDownload)=/.test(line))) {
      assert.ok(properties.split(/\r?\n/).includes(line), line);
    }
    for (const property of ["targetList=aarch64", "archList=arm64", "abiList=arm64-v8a", "android.builder.sdkDownload=false"]) {
      assert.equal(properties.split(/\r?\n/).filter((line) => line.startsWith(`${property.split("=")[0]}=`)).join("\n"), property);
    }
    assert.equal(properties.includes("android.builtInKotlin=false"), profile.id === "current");
    const build = fs.readFileSync(path.join(root, "build.gradle.kts"), "utf8");
    assert.ok(build.includes(`com.android.tools.build:gradle:${profile.agp}`));
    assert.ok(build.includes(`org.jetbrains.kotlin:kotlin-gradle-plugin:${profile.kotlin}`));
    assert.equal(build.split(`dsl.buildToolsVersion = "${profile.minimumBuildTools}"`).length - 1, 2);
    assert.match(fs.readFileSync(path.join(root, "settings.gradle"), "utf8"), /apps\/desktop\/src-tauri\/gen\/android\/app/);
  }
});

function isolatedShimFixture(t) {
  const { root, generated } = shimFixture(t), home = path.join(root, "home");
  // Keep discovery inside the fixture while exercising the real shared resolver.
  fs.renameSync(path.join(root, "scripts/android-toolchain.mjs"), path.join(root, "scripts/android-toolchain-source.mjs"));
  fs.writeFileSync(path.join(root, "scripts/android-toolchain.mjs"), `
import fs from "node:fs";
import { resolveSdk as discover, resolveGeneratedSdk as discoverGenerated } from "./android-toolchain-source.mjs";
export { hasSdkPlatform, readGeneratedSdk, readGeneratedNdk, escapeLocalProperty } from "./android-toolchain-source.mjs";
const fixtureRoot = ${JSON.stringify(root)};
const isolatedOptions = (options) => ({ ...options, env: process.env,
    isDirectory: (candidate) => candidate.startsWith(fixtureRoot + "/") && fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory(),
    isExecutable: (candidate) => {
      if (!candidate.startsWith(fixtureRoot + "/")) return false;
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
    },
    runCapture: () => ({ ok: false, output: "" }) });
export function resolveSdk(options = {}) { return discover(isolatedOptions(options)); }
export function resolveGeneratedSdk(required, options = {}) { return discoverGenerated(required, isolatedOptions(options)); }
`);
  const env = { ...process.env, HOME: home };
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"]) delete env[name];
  const runShim = (overrides = {}) => spawnSync("bash", [path.join(root, "scripts/android-studio-root-shim.sh")], {
    cwd: root, env: { ...env, ...overrides }, encoding: "utf8",
  });
  return { root, generated, home, env, runShim };
}

test("Studio root shim discovers host SDK defaults and SDK-only overrides without an NDK", (t) => {
  const { root, home, env, runShim } = isolatedShimFixture(t);
  const sdk = path.join(home, process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  sdkPlatform(sdk, "37");
  let result = runShim();
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const local = path.join(root, "local.properties");
  assert.equal(fs.readFileSync(local, "utf8"), `sdk.dir=${escapeLocalProperty(sdk)}\n`);
  const managerSdk = path.join(root, "manager-sdk"), discoveryBin = path.join(root, "bin");
  const manager = path.join(managerSdk, "cmdline-tools/latest/bin/sdkmanager");
  fs.mkdirSync(path.dirname(manager), { recursive: true }); fs.mkdirSync(discoveryBin);
  fs.writeFileSync(manager, "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(manager, path.join(discoveryBin, "sdkmanager"));
  sdkPlatform(managerSdk, "37");
  result = runShim({ PATH: `${discoveryBin}${path.delimiter}${env.PATH}` });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(fs.readFileSync(local, "utf8"), `sdk.dir=${escapeLocalProperty(managerSdk)}\n`);
  const macSdk = path.join(home, "Library/Android/sdk"); fs.mkdirSync(macSdk, { recursive: true });
  assert.equal(resolveSdk({ env: {}, homeDir: home, hostPlatform: "darwin",
    isDirectory: (candidate) => candidate === macSdk, runCapture: () => ({ ok: false, output: "" }) }), macSdk);
  if (macSdk !== sdk) fs.rmSync(macSdk, { recursive: true });
  const override = path.join(root, "override-sdk"), alias = path.join(root, "sdk-alias");
  sdkPlatform(override, "37"); fs.symlinkSync(override, alias, "dir");
  result = runShim({ ANDROID_HOME: alias, ANDROID_SDK_ROOT: override });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(fs.readFileSync(local, "utf8"), `sdk.dir=${escapeLocalProperty(alias)}\n`);
  const manual = "sdk.dir=/manual/sdk\ncustom.setting=preserved\n";
  fs.writeFileSync(local, manual);
  for (const overrides of [{ ANDROID_HOME: override, ANDROID_SDK_ROOT: sdk }, { ANDROID_HOME: path.join(root, "missing") }]) {
    result = runShim(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /same SDK|Configured Android SDK/);
    assert.equal(fs.readFileSync(local, "utf8"), manual);
  }
  fs.rmSync(sdk, { recursive: true });
  result = runShim();
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /local.properties.*preserved/);
  assert.equal(fs.readFileSync(local, "utf8"), manual);
});

function rootSentinels(root) {
  const files = ["settings.gradle", "build.gradle.kts", "gradle.properties", "gradlew", "gradlew.bat",
    "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties", "buildSrc/build.gradle.kts",
    "buildSrc/src/main/java/com/tuneforge/desktop/kotlin/BuildTask.kt",
    "buildSrc/src/main/java/com/tuneforge/desktop/kotlin/RustPlugin.kt", "local.properties"];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `manual sentinel for ${file}\n`);
  }
  return () => files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]);
}

test("Studio root shim honors recorded SDK paths and rejects conflicting overrides before writes", (t) => {
  const { root, generated, home, runShim } = isolatedShimFixture(t);
  const sdk = path.join(root, "external SDK"), alias = path.join(root, "SDK alias");
  const competing = path.join(home, process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  sdkPlatform(sdk, "37"); sdkPlatform(competing, "37"); fs.symlinkSync(sdk, alias, "dir");
  const properties = path.join(generated, "local.properties"), app = path.join(generated, "app/build.gradle.kts");
  const appBefore = fs.readFileSync(app, "utf8"), absentNdk = path.join(root, "uninstalled NDK");
  for (const recorded of [sdk, path.relative(generated, sdk), alias]) {
    const encoded = escapeLocalProperty(recorded).replace("SDK", "\\u0053DK");
    const original = `# preserve SDK selection\r\nsdk.dir : ${encoded}\r\nndk.dir=${escapeLocalProperty(absentNdk)}\r\ncustom.setting=preserved\r\n`;
    fs.writeFileSync(properties, original);
    const result = runShim();
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(fs.readFileSync(path.join(root, "local.properties"), "utf8"),
      `sdk.dir=${escapeLocalProperty(path.resolve(generated, recorded))}\nndk.dir=${escapeLocalProperty(absentNdk)}\n`);
    assert.equal(fs.readFileSync(properties, "utf8"), original);
    assert.equal(fs.readFileSync(app, "utf8"), appBefore);
    const snapshot = rootSentinels(root), before = snapshot();
    const conflict = runShim({ ANDROID_HOME: competing });
    assert.notEqual(conflict.status, 0); assert.match(conflict.stderr, /sdk.dir conflicts.*Remove or align/);
    assert.deepEqual(snapshot(), before); assert.equal(fs.readFileSync(properties, "utf8"), original);
    const matching = runShim({ ANDROID_HOME: alias, ANDROID_SDK_ROOT: sdk });
    assert.equal(matching.status, 0, matching.error?.message ?? matching.stderr);
    assert.equal(fs.readFileSync(properties, "utf8"), original);
  }
  for (const invalid of ["sdk.dir=", "sdk.dir=/missing-sdk", "sdk.dir=/bad\\uZZZZ", `sdk.dir=${sdk}\nsdk.dir=${sdk}`]) {
    fs.writeFileSync(properties, `${invalid}\n`);
    const snapshot = rootSentinels(root), before = snapshot();
    const result = runShim();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /sdk.dir/);
    assert.deepEqual(snapshot(), before); assert.equal(fs.readFileSync(properties, "utf8"), `${invalid}\n`);
    assert.equal(fs.readFileSync(app, "utf8"), appBefore);
  }
});

test("Studio root shim rejects unusable recorded SDK platforms before all root writes", (t) => {
  const { root, generated, home, runShim } = isolatedShimFixture(t);
  const recordedSdk = path.join(root, "recorded SDK");
  const usableSdk = path.join(home, process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  sdkPlatform(recordedSdk, "36"); sdkPlatform(usableSdk, "37");
  const properties = path.join(generated, "local.properties"), app = path.join(generated, "app/build.gradle.kts");
  const original = `sdk.dir=${escapeLocalProperty(recordedSdk)}\n`, appBefore = fs.readFileSync(app, "utf8");
  fs.writeFileSync(properties, original);
  for (const preview of [false, true]) {
    if (preview) sdkPlatform(recordedSdk, "37", { metadata: "AndroidVersion.CodeName=Baklava\n" });
    const snapshot = rootSentinels(root);
    fs.writeFileSync(path.join(root, "local.properties"), `sdk.dir=${escapeLocalProperty(usableSdk)}\n`);
    const before = snapshot(), result = runShim();
    assert.notEqual(result.status, 0, "An authoritative SDK cannot fall back to manual root properties");
    assert.match(result.stderr, /Required Android SDK platform android-37/);
    assert.deepEqual(snapshot(), before);
    assert.equal(fs.readFileSync(properties, "utf8"), original);
    assert.equal(fs.readFileSync(app, "utf8"), appBefore);
  }
});

test("Studio root shim matches generated compilation platforms across SDK roots and exact minors", (t) => {
  const { root, generated, home, env, runShim } = isolatedShimFixture(t);
  const sdk = path.join(home, process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  const newer = path.join(root, "newer-sdk"), bin = path.join(root, "bin");
  const manager = path.join(newer, "cmdline-tools/latest/bin/sdkmanager");
  fs.mkdirSync(path.dirname(manager), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(manager, "#!/bin/sh\n", { mode: 0o755 }); fs.symlinkSync(manager, path.join(bin, "sdkmanager"));
  const discovery = { PATH: `${bin}${path.delimiter}${env.PATH}` };
  sdkPlatform(newer, "38");
  for (const version of ["36", "37", "37.0", "37.2", "37.10"]) sdkPlatform(sdk, version);
  const initial = runShim(discovery);
  assert.equal(initial.status, 0, initial.error?.message ?? initial.stderr);
  assert.equal(fs.readFileSync(path.join(root, "local.properties"), "utf8"), `sdk.dir=${escapeLocalProperty(sdk)}\n`);
  for (const [major, minor] of [[37, undefined], [37, 0], [37, 2], [36, undefined]]) {
    fs.rmSync(path.join(newer, "platforms"), { recursive: true });
    for (const version of ["38", "37.10", major === 36 ? "37" : minor === undefined ? "37.0" : "37"]) sdkPlatform(newer, version);
    configureAndroidToolchain(generated, { profile: major === 36 ? "baseline" : "current", compileSdk: major,
      compileSdkMinor: minor, buildToolsVersion: "37.0.0", ndkRevision: "29.0.14206865", ndkRoot: path.join(root, "ndk") });
    const result = runShim(discovery);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(fs.readFileSync(path.join(root, "local.properties"), "utf8"), `sdk.dir=${escapeLocalProperty(sdk)}\n`);
    const snapshot = rootSentinels(root), before = snapshot();
    const incompatible = runShim({ ...discovery, ANDROID_HOME: newer });
    assert.notEqual(incompatible.status, 0);
    assert.ok(incompatible.stderr.includes(`android-${major}${minor === undefined ? "" : `.${minor}`}`));
    assert.deepEqual(snapshot(), before, "Incompatible authoritative SDK must fail before root shim writes");
  }
});

test("Studio root shim rejects preview and incomplete required platforms while preserving manual SDK paths", (t) => {
  const { root, generated, home, runShim } = isolatedShimFixture(t);
  configureAndroidToolchain(generated, { compileSdk: 37, compileSdkMinor: 2, buildToolsVersion: "37.0.0",
    ndkRevision: "29.0.14206865", ndkRoot: path.join(root, "ndk") });
  const sdk = path.join(home, process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  sdkPlatform(sdk, "37.10");
  for (const invalid of [{ metadata: "AndroidVersion.PreviewSdkInt=1\n" },
    { metadata: "AndroidVersion.BetaVersion=1\n" }, { metadata: "AndroidVersion.CodeName=Baklava\n" }, { complete: false }]) {
    sdkPlatform(sdk, "37.2", invalid);
    const snapshot = rootSentinels(root), before = snapshot();
    const explicit = runShim({ ANDROID_SDK_ROOT: sdk });
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /Required Android SDK platform android-37\.2/);
    assert.deepEqual(snapshot(), before);
    const automatic = runShim();
    assert.equal(automatic.status, 0, automatic.error?.message ?? automatic.stderr);
    assert.match(automatic.stderr, /Required Android SDK platform android-37\.2/);
    assert.match(automatic.stderr, /local.properties.*preserved/);
    assert.equal(fs.readFileSync(path.join(root, "local.properties"), "utf8"), before.at(-1)[1]);
  }
});

test("Studio root shim rejects missing malformed and ambiguous compilation declarations before writes", (t) => {
  const { root, generated, runShim } = isolatedShimFixture(t), app = path.join(generated, "app/build.gradle.kts");
  const original = fs.readFileSync(app, "utf8"), snapshot = rootSentinels(root), before = snapshot();
  for (const declaration of ["", "compileSdk = sdkVersion", "compileSdk = 37 + 1", "compileSdk = 37\n    compileSdk = 37",
    'compileSdk = 37\n    compileSdkMinor = "2"', "compileSdk = 37\n    compileSdkMinor = 0\n    compileSdkMinor = 2"]) {
    fs.writeFileSync(app, original.replace(/^[ \t]*compileSdk\s*=.*$/m, `    ${declaration}`));
    const result = runShim();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Generated Android compileSdk(?:Minor)? must have one unambiguous numeric literal declaration/);
    assert.deepEqual(snapshot(), before);
  }
});

test("Studio root shim preserves the escaped generated ndk.dir without requiring installed NDK tools", (t) => {
  const { root, generated, runShim } = isolatedShimFixture(t), sdk = path.join(root, "sdk");
  sdkPlatform(sdk, "37");
  const ndkRoot = path.join(root, 'external "NDK" ${literal} \\tools');
  const properties = path.join(generated, "local.properties"), app = path.join(generated, "app/build.gradle.kts");
  const selected = { compileSdk: 37, buildToolsVersion: "37.0.0", ndkRevision: "29.0.14206865", ndkRoot };
  for (const delimiter of ["=", " : ", " "]) {
    const escaped = escapeLocalProperty(ndkRoot).replace("external", "\\u0065xternal");
    fs.writeFileSync(properties, `custom.setting=preserved\nndk.dir${delimiter}${escaped}\n`);
    configureAndroidToolchain(generated, selected);
    const before = fs.readFileSync(app, "utf8");
    assert.doesNotMatch(before, /\bndkPath\s*=/);
    const result = runShim({ ANDROID_HOME: sdk });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(readLocalNdkPath(path.join(root, "local.properties")), ndkRoot);
    assert.equal(fs.readFileSync(app, "utf8"), before);
    assert.equal(fs.existsSync(ndkRoot), false, "Shim must not require an installed NDK");
  }
  fs.writeFileSync(properties, "custom.setting=preserved\n");
  configureAndroidToolchain(generated, selected);
  const before = fs.readFileSync(app, "utf8");
  const result = runShim({ ANDROID_HOME: sdk });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(readLocalNdkPath(path.join(root, "local.properties")), undefined);
  assert.equal(fs.readFileSync(app, "utf8"), before);
  fs.writeFileSync(properties, `ndk.dir=${escapeLocalProperty(path.join(root, "stale-ndk"))}\n`);
  const snapshot = rootSentinels(root), sentinels = snapshot();
  const conflict = runShim({ ANDROID_HOME: sdk });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /ndkPath conflicts.*ndk.dir/);
  assert.deepEqual(snapshot(), sentinels);
});
