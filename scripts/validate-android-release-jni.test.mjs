import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertDexMethods, parseCli, parseJniRules, resolveReleaseArtifact, selectAndroidTools,
  validateReleaseJni } from "./validate-android-release-jni.mjs";

const rules = `-keepclassmembers class com.tuneforge.desktop.MainActivity {
    public java.lang.String setTuneForgePowerInhibition(int);
    public java.lang.String getTuneForgePowerInhibitionStatus();
    public java.lang.String getTuneForgeAudioPermissionState();
    public java.lang.String requestTuneForgeAudioPermission();
}`;

test("parses only exact narrow JNI rules", () => {
  const methods = parseJniRules(rules);
  assert.deepEqual(methods.map(({ name, descriptor }) => [name, descriptor]), [
    ["setTuneForgePowerInhibition", "(I)Ljava/lang/String;"],
    ["getTuneForgePowerInhibitionStatus", "()Ljava/lang/String;"],
    ["getTuneForgeAudioPermissionState", "()Ljava/lang/String;"],
    ["requestTuneForgeAudioPermission", "()Ljava/lang/String;"],
  ]);
  assert.throws(() => parseJniRules(rules.replace("getTuneForgeAudioPermissionState()", "*")), /wildcards/);
  assert.throws(() => parseJniRules(rules.replace("setTuneForgePowerInhibition(int)", "setTuneForgePowerInhibition()")), /exactly/);
});

test("accepts only one safe universal release APK output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-jni-metadata-"));
  const apk = path.join(root, "app-universal-release.apk");
  writeFileSync(apk, "apk");
  const metadata = path.join(root, "output-metadata.json");
  writeFileSync(metadata, JSON.stringify({
    artifactType: { type: "APK" }, variantName: "universalRelease",
    elements: [{ type: "SINGLE", filters: [], outputFile: path.basename(apk) }],
  }));
  assert.equal(resolveReleaseArtifact(metadata), apk);
  writeFileSync(metadata, JSON.stringify({ artifactType: { type: "APK" }, variantName: "universalRelease", elements: [{ type: "SINGLE", filters: [], outputFile: "../unsafe.apk" }] }));
  assert.throws(() => resolveReleaseArtifact(metadata), /unsafe/);
});

test("validates an explicit APK, falls through empty SDK values, and rejects invalid CLI forms", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-jni-explicit-"));
  const rulesPath = path.join(root, "apps/desktop/src-tauri/proguard-tuneforge.pro");
  mkdirSync(path.dirname(rulesPath), { recursive: true }); writeFileSync(rulesPath, rules);
  const apk = path.join(root, "staged.apk"); writeFileSync(apk, "apk");
  const sdkRoot = path.join(root, "sdk");
  for (const tool of ["aapt2", "apksigner", "dexdump"]) {
    const candidate = path.join(sdkRoot, "build-tools/36.0.0", tool);
    mkdirSync(path.dirname(candidate), { recursive: true }); writeFileSync(candidate, "");
  }
  const calls = [];
  validateReleaseJni({ root, apk, sdkRoot: "", env: { ANDROID_HOME: "", ANDROID_SDK_ROOT: sdkRoot },
    run: (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("aapt2")) return "native-code: 'arm64-v8a'";
      if (command === "unzip" && args[0] === "-Z1") return "classes.dex";
      if (command.endsWith("dexdump")) return dexXml(parseJniRules(rules));
      return "";
    },
  });
  assert.equal(calls.filter(([, args]) => args.includes(apk)).length, 4);
  assert.deepEqual(parseCli(["--apk", apk]), { apk });
  for (const argv of [["--apk"], ["--other", apk], ["--apk", apk, "extra"]]) assert.throws(() => parseCli(argv), /Usage/);
  assert.throws(() => validateReleaseJni({ root, apk: path.join(root, "missing.apk"), sdkRoot }), /missing/);
});

test("selects highest complete Android build-tools version", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-jni-sdk-"));
  for (const version of ["35.0.0", "36.0.0"]) {
    const dir = path.join(root, "build-tools", version);
    mkdirSync(dir, { recursive: true });
    for (const tool of ["aapt2", "apksigner", "dexdump"]) writeFileSync(path.join(dir, tool), "");
  }
  assert.equal(selectAndroidTools(root).version, "36.0.0");
});

test("requires exact DEX class method descriptors", () => {
  const methods = parseJniRules(rules);
  const xml = dexXml(methods);
  assert.doesNotThrow(() => assertDexMethods(xml, methods));
  assert.throws(() => assertDexMethods(
    xml.replace('return="java.lang.String"', 'return="int"'),
    methods,
  ), /signature mismatch/);
});

test("rejects duplicate MainActivity classes across DEX documents", () => {
  const methods = parseJniRules(rules);
  const xml = dexXml(methods);
  assert.throws(() => assertDexMethods([xml, xml], methods), /exactly one/);
});

test("rejects malformed parameter XML", () => {
  const methods = parseJniRules(rules);
  const xml = dexXml(methods);
  assert.throws(() => assertDexMethods(xml.replace("</parameter>", "</method>"), methods), /unexpected closing method/);
  assert.throws(() => assertDexMethods(xml.replace("\n</parameter>", "content</parameter>"), methods), /parameter int has content/);
});

test("rejects unclosed classes, methods, and extra closing tags", () => {
  const methods = parseJniRules(rules);
  const xml = dexXml(methods);
  assert.throws(() => assertDexMethods(xml.replace("</class></package>", ""), methods), /unclosed class/);
  assert.throws(() => assertDexMethods(xml.replace("</method>", "</class>"), methods), /unexpected closing class/);
  assert.throws(() => assertDexMethods(xml.replace("</constructor>", "</method>"), methods), /unexpected closing method/);
  assert.throws(() => assertDexMethods(`${xml}</method>`, methods), /unexpected closing method/);
});

function dexXml(methods) {
  return `<package name="com.tuneforge.desktop"><class name="MainActivity"><constructor name="&lt;init&gt;" return="void"><parameter name="arg0" type="int">\n</parameter></constructor>${methods.map((method) =>
    `<method name="${method.name}" return="java.lang.String">${method.name === "setTuneForgePowerInhibition" ? '<parameter name="arg0" type="int">\n</parameter>' : ""}</method>`,
  ).join("")}</class></package>`;
}
