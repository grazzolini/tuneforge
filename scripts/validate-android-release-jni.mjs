import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const activityClass = "com.tuneforge.desktop.MainActivity";
const requiredMethods = new Map([
  ["setTuneForgePowerInhibition", "(I)Ljava/lang/String;"],
  ["getTuneForgePowerInhibitionStatus", "()Ljava/lang/String;"],
  ["getTuneForgeAudioPermissionState", "()Ljava/lang/String;"],
  ["requestTuneForgeAudioPermission", "()Ljava/lang/String;"],
]);

export function parseJniRules(source) {
  const lines = source.replace(/#.*/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => /\*|\.\.\./.test(line)) ||
    lines[0] !== `-keepclassmembers class ${activityClass} {` || lines.at(-1) !== "}") {
    throw new Error("JNI rules must be one narrow MainActivity -keepclassmembers block without wildcards.");
  }
  const methods = lines.slice(1, -1).map((line) => {
    const match = /^public\s+([\w.]+)\s+([A-Za-z_$][\w$]*)\(([^)]*)\);$/.exec(line);
    if (!match) throw new Error(`Invalid JNI rule: ${line}`);
    const parameters = match[3] ? match[3].split(",").map((item) => item.trim()) : [];
    return { returnType: match[1], name: match[2], parameters, descriptor: `(${parameters.map(javaDescriptor).join("")})${javaDescriptor(match[1])}` };
  });
  if (lines.length !== 6 || methods.length !== requiredMethods.size ||
    methods.some((method) => requiredMethods.get(method.name) !== method.descriptor) ||
    new Set(methods.map((method) => method.name)).size !== methods.length) {
    throw new Error("JNI rules must preserve exactly the four Rust-called MainActivity methods.");
  }
  return methods;
}

export function resolveReleaseArtifact(metadataPath) {
  const metadataFile = path.resolve(metadataPath);
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  if (metadata.variantName !== "universalRelease" || metadata.artifactType?.type !== "APK" ||
    !Array.isArray(metadata.elements) || metadata.elements.length !== 1) {
    throw new Error("Expected universalRelease APK output metadata with exactly one element.");
  }
  const element = metadata.elements[0];
  if (element.type !== "SINGLE" || !Array.isArray(element.filters) || element.filters.length !== 0 ||
    typeof element.outputFile !== "string" || path.isAbsolute(element.outputFile) ||
    !element.outputFile.endsWith(".apk")) {
    throw new Error("Release APK metadata element must be one unfiltered SINGLE relative .apk output.");
  }
  const output = path.resolve(path.dirname(metadataFile), element.outputFile);
  if (path.relative(path.dirname(metadataFile), output).startsWith("..") || !existsSync(output)) {
    throw new Error("Release APK output path is unsafe or missing.");
  }
  return output;
}

export function selectAndroidTools(sdkRoot) {
  const buildTools = path.join(sdkRoot, "build-tools");
  if (!existsSync(buildTools)) throw new Error(`Android build-tools directory is missing: ${buildTools}`);
  const versions = readdirSync(buildTools).sort(compareVersions).reverse();
  for (const version of versions) {
    const root = path.join(buildTools, version);
    const tools = Object.fromEntries(["aapt2", "apksigner", "dexdump"].map((name) => [name, path.join(root, name)]));
    if (Object.values(tools).every(existsSync)) return { ...tools, version };
  }
  throw new Error("No Android build-tools version contains aapt2, apksigner, and dexdump.");
}

export function assertDexMethods(xmlDocuments, methods) {
  const classes = (Array.isArray(xmlDocuments) ? xmlDocuments : [xmlDocuments]).flatMap(parseDexXml);
  if (classes.length !== 1) throw new Error(`DEX must contain exactly one ${activityClass} class.`);
  const declared = classes[0].methods;
  for (const expected of methods) {
    const matches = declared.filter((method) => method.name === expected.name);
    if (matches.length !== 1) throw new Error(`DEX must contain exactly one ${expected.name} method.`);
    const actual = matches[0];
    const descriptor = `(${actual.parameters.map(javaDescriptor).join("")})${javaDescriptor(actual.returnType)}`;
    if (descriptor !== expected.descriptor) {
      throw new Error(`DEX signature mismatch for ${expected.name}: expected ${expected.descriptor}, got ${descriptor}.`);
    }
  }
}

function parseDexXml(xml) {
  const stack = [];
  const targets = [];
  const tags = /<\/?(package|class|method|constructor|parameter)\b([^>]*)>/g;
  for (const match of xml.matchAll(tags)) {
    const [tag, element, rawAttributes] = match;
    const closing = tag.startsWith("</");
    const selfClosing = /\/\s*>$/.test(tag);
    if (closing) {
      const node = stack.pop();
      if (!node || node.element !== element) throw new Error(`Malformed DEX XML: unexpected closing ${element}.`);
      if (element === "parameter" && !/^\s*$/.test(xml.slice(node.contentStart, match.index))) {
        throw new Error(`Malformed DEX XML: parameter ${node.type ?? ""} has content.`);
      }
      if (element === "class" && node.target) targets.push(node);
      continue;
    }
    const attributes = rawAttributes.replace(/\/\s*$/, "");
    const node = { element, name: xmlAttribute(attributes, "name"), contentStart: match.index + tag.length };
    if (element === "package") node.packageName = node.name;
    if (element === "class") {
      const packageNode = [...stack].reverse().find((item) => item.element === "package");
      node.target = packageNode?.packageName === "com.tuneforge.desktop" && node.name === "MainActivity";
      node.methods = [];
    }
    if (element === "method" || element === "constructor") {
      const classNode = [...stack].reverse().find((item) => item.element === "class");
      if (!classNode) throw new Error(`Malformed DEX XML: ${element} outside class.`);
      node.returnType = xmlAttribute(attributes, "return");
      node.parameters = [];
      if (element === "method" && classNode.target) classNode.methods.push(node);
    }
    if (element === "parameter") {
      const memberNode = [...stack].reverse().find((item) => item.element === "method" || item.element === "constructor");
      if (!memberNode) throw new Error("Malformed DEX XML: parameter outside method or constructor.");
      node.type = xmlAttribute(attributes, "type");
      if (memberNode.element === "method") memberNode.parameters.push(node.type);
    }
    if (selfClosing) {
      if (element === "class" && node.target) targets.push(node);
      continue;
    }
    stack.push(node);
  }
  if (stack.length) throw new Error(`Malformed DEX XML: unclosed ${stack.at(-1).element}.`);
  return targets;
}

export function validateReleaseJni({ root = workspaceRoot, run = runCommand } = {}) {
  const rules = parseJniRules(readFileSync(path.join(root, "apps/desktop/src-tauri/proguard-tuneforge.pro"), "utf8"));
  const apk = resolveReleaseArtifact(path.join(root, "apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/output-metadata.json"));
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "Library/Android/sdk");
  const tools = selectAndroidTools(sdkRoot);
  const badging = run(tools.aapt2, ["dump", "badging", apk]);
  if (/application-debuggable/.test(badging) || !/native-code:.*'arm64-v8a'/.test(badging)) {
    throw new Error("Release APK must be non-debuggable and contain arm64-v8a native code.");
  }
  run(tools.apksigner, ["verify", "--verbose", apk]);
  let tempDir;
  try {
    const dexFiles = run("unzip", ["-Z1", apk]).split("\n").filter((file) => /^classes\d*\.dex$/.test(file)).sort(compareDexNames);
    if (!dexFiles.length) throw new Error("Release APK contains no classes*.dex files.");
    tempDir = mkdtempSync(path.join(os.tmpdir(), "tuneforge-jni-dex-"));
    run("unzip", ["-qq", apk, ...dexFiles, "-d", tempDir]);
    const xmlDocuments = dexFiles.map((file) => run(tools.dexdump, ["-l", "xml", path.join(tempDir, file)]));
    assertDexMethods(xmlDocuments, rules);
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function javaDescriptor(type) {
  const primitive = { void: "V", boolean: "Z", byte: "B", char: "C", short: "S", int: "I", long: "J", float: "F", double: "D" };
  if (primitive[type]) return primitive[type];
  if (!type || !/^[\w.]+(?:\[\])*$/.test(type)) throw new Error(`Unsupported Java type in JNI rule or DEX output: ${type}`);
  const dimensions = (type.match(/\[\]/g) ?? []).length;
  return `${"[".repeat(dimensions)}L${type.replace(/\[\]/g, "").replaceAll(".", "/")};`;
}

function xmlAttribute(attributes, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function compareDexNames(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    validateReleaseJni();
    console.log("Android release JNI validation passed.");
  } catch (error) {
    console.error(`Android release JNI validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
