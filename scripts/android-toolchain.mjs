import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const validatedNdkRevision = "29.0.14206865";
export const minimumNdkMajor = 29;
export const androidToolchainProfiles = Object.freeze([
  Object.freeze({ id: "current", agp: "9.3.3", kotlin: "2.2.10", gradle: "9.8.1", maximumJava: 27,
    minimumSdk: 37, maximumSdk: 37, minimumBuildTools: "36.0.0",
    gradleSha256: "dce76f55f8e251a3a1f130eb120f30b3d271de2b76c9b0729d316b5a1b6dc01f" }),
  Object.freeze({ id: "baseline", agp: "8.11.0", kotlin: "1.9.25", gradle: "8.14.3", maximumJava: 24,
    minimumSdk: 36, maximumSdk: 36, minimumBuildTools: "35.0.0",
    gradleSha256: "bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531" }),
]);
const directory = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false;
const executable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
};
const capture = (command, args, options) => {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  return { ok: !result.error && result.status === 0, output: result.stdout ?? "" };
};
const canonicalRoot = (root) => {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
};

function explicitRoot(env, aliases, label) {
  const configured = aliases.map((name) => env[name]).filter(Boolean).map((root) => path.resolve(root));
  const canonical = configured.map(canonicalRoot);
  if (new Set(canonical).size > 1) throw new Error(`${aliases.join(" and ")} must identify the same ${label}.`);
  return configured[0];
}

function stablePackageRevision(value) {
  // Pinned repository Revision grammar: the optional fourth component is the preview number.
  const match = /^[ \t\n\v\f\r]*([0-9]+)(?:\.([0-9]+)(?:\.([0-9]+))?)?([ \t\n\v\f\r-]*)?(?:(rc|alpha|beta|\.)([0-9]+))?[ \t\n\v\f\r]*$/.exec(value);
  return Boolean(match && match[0].length === value.length && [1, 2, 3, 6].every((index) =>
    match[index] === undefined || Number(match[index]) <= 2147483647) && Number(match[6] ?? 0) === 0);
}

export function androidHostPrebuilt(hostPlatform = process.platform, hostArch = process.arch) {
  if (hostPlatform === "linux" && hostArch === "x64") return "linux-x86_64";
  if (hostPlatform === "darwin" && ["x64", "arm64"].includes(hostArch)) return "darwin-x86_64";
  throw new Error(`Unsupported Android build host: ${hostPlatform}/${hostArch}. Use Linux x86_64 or macOS x86_64/arm64.`);
}

// Recognize canonical platform metadata supported by sdklib 31.11.0/32.3.3, not all non-strict JAXB shapes.
function readPlatformXml(file) {
  let source;
  try { source = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); } catch { return undefined; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) return undefined;
  const decode = (value) => value.replace(/&([^;]+);/g, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const numeric = /^#(?:x([0-9a-f]+)|(\d+))$/i.exec(entity);
    if (!numeric) throw new Error("Unsupported XML entity");
    const code = Number.parseInt(numeric[1] ?? numeric[2], numeric[1] ? 16 : 10);
    if (!Number.isInteger(code) || (code < 0x20 && ![9, 10, 13].includes(code)) || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff) || [0xfffe, 0xffff].includes(code)) throw new Error("Invalid XML character");
    return String.fromCodePoint(code);
  });
  const stack = [];
  let root, offset = 0;
  try {
    while (offset < source.length) {
      if (source.startsWith("<!--", offset)) {
        const end = source.indexOf("-->", offset + 4);
        if (end < 0 || source.slice(offset + 4, end).includes("--")) return undefined;
        offset = end + 3; continue;
      }
      if (source.startsWith("<?xml", offset) && !root && !source.slice(0, offset).trim()) {
        const end = source.indexOf("?>", offset + 5); if (end < 0) return undefined;
        offset = end + 2; continue;
      }
      if (source.startsWith("<![CDATA[", offset)) {
        const end = source.indexOf("]]>", offset + 9); if (end < 0 || !stack.length) return undefined;
        stack.at(-1).text += source.slice(offset + 9, end); offset = end + 3; continue;
      }
      if (source[offset] !== "<") {
        const end = source.indexOf("<", offset), text = source.slice(offset, end < 0 ? source.length : end);
        if (/&(?![^;&\s]+;)/.test(text) || text.includes("]]>")) return undefined;
        if (stack.length) stack.at(-1).text += decode(text); else if (text.trim()) return undefined;
        offset += text.length; continue;
      }
      const close = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(source.slice(offset));
      if (close) {
        if (stack.pop()?.qualified !== close[1]) return undefined;
        offset += close[0].length; continue;
      }
      const open = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(offset));
      if (!open) return undefined; // DTDs, entity declarations and processing instructions are unsupported.
      offset += open[0].length;
      const attributes = {};
      while (!/^\s*\/?>/.test(source.slice(offset))) {
        const attribute = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^<>]*?)\2/.exec(source.slice(offset));
        if (!attribute || Object.hasOwn(attributes, attribute[1]) || /&(?![^;&\s]+;)/.test(attribute[3])) return undefined;
        attributes[attribute[1]] = decode(attribute[3]); offset += attribute[0].length;
      }
      const ending = /^\s*(\/?)>/.exec(source.slice(offset)); offset += ending[0].length;
      const namespaces = { ...(stack.at(-1)?.namespaces ?? {}), xml: "http://www.w3.org/XML/1998/namespace" };
      for (const [key, value] of Object.entries(attributes)) {
        if (key === "xmlns") namespaces[""] = value;
        else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
      }
      const expanded = (name, attribute = false) => {
        const parts = name.split(":");
        if (parts.length > 2 || (parts.length === 2 && !namespaces[parts[0]])) throw new Error("Invalid XML namespace");
        return `${parts.length === 2 ? namespaces[parts[0]] : attribute ? "" : namespaces[""] ?? ""}|${parts.at(-1)}`;
      };
      const expandedAttributes = {};
      for (const [key, value] of Object.entries(attributes)) {
        if (key === "xmlns" || key.startsWith("xmlns:")) continue;
        const name = expanded(key, true); if (Object.hasOwn(expandedAttributes, name)) return undefined;
        expandedAttributes[name] = value;
      }
      const node = { qualified: open[1], name: expanded(open[1]), attributes: expandedAttributes, namespaces, children: [], text: "" };
      if (stack.length) stack.at(-1).children.push(node); else if (root) return undefined; else root = node;
      if (!ending[1]) stack.push(node);
    }
    if (stack.length || !/^http:\/\/schemas\.android\.com\/repository\/android\/common\/0[12]\|repository$/.test(root?.name ?? "")) return undefined;
    const child = (node, name) => {
      const matches = node.children.filter((candidate) => {
        const [namespace, local] = candidate.name.split("|");
        return local === name && (!namespace || /^http:\/\/schemas\.android\.com\/(?:repository\/android\/common\/0[12]|sdk\/android\/repo\/repository2?\/0[1-4])$/.test(namespace));
      });
      if (matches.length > 1) throw new Error("Ambiguous XML metadata");
      return matches[0];
    };
    const local = child(root, "localPackage"), details = local && child(local, "type-details");
    if (local && child(local, "display-name")?.text.trim().startsWith("Unknown")) return undefined;
    const type = details?.attributes["http://www.w3.org/2001/XMLSchema-instance|type"]?.split(":");
    if (type?.length !== 2 || type[1] !== "platformDetailsType") return undefined;
    const schema = details.namespaces[type[0]]?.match(/^http:\/\/schemas\.android\.com\/sdk\/android\/repo\/repository2?\/0([1-4])$/)?.[1];
    if (!schema) return undefined;
    const text = (name) => child(details, name)?.text.trim();
    const codename = text("codename");
    const base = text("base-extension");
    if ((codename && codename !== "REL") || (base !== undefined && !["true", "1"].includes(base)) ||
        ["beta-api-level", "beta-number", "canary-number"].some((name) => text(name) !== undefined)) return { excluded: true };
    const api = text("api-level"), revision = child(local, "revision");
    let packagePreview;
    try { packagePreview = revision && child(revision, "preview"); } catch { return { excluded: true }; }
    if (packagePreview && (packagePreview.children.length || !/^[ \t\r\n]*[0-9]+[ \t\r\n]*$/.test(packagePreview.text) ||
        Number(packagePreview.text) > 2147483647 || Number(packagePreview.text) > 0)) return { excluded: true };
    if (!local.attributes["|path"] || !child(local, "display-name")?.text.trim() || !child(details, "layoutlib") ||
        !/^\d+$/.test(child(revision ?? { children: [] }, "major")?.text.trim() ?? "") ||
        !(Number(schema) < 3 ? /^\d+$/ : /^\d+(?:\.\d+)?$/).test(api ?? "")) return undefined;
    return { api };
  } catch { return undefined; }
}

function installedSdkPlatforms(sdk) {
  const platforms = path.join(sdk, "platforms");
  if (!directory(platforms)) return [];
  return fs.readdirSync(platforms).flatMap((name) => {
    if (!/^android-\d+(?:\.\d+)?$/.test(name)) return [];
    const root = path.join(platforms, name);
    if (!["android.jar", "build.prop"].every((file) => fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile())) return [];
    const xml = readPlatformXml(path.join(root, "package.xml"));
    if (xml?.excluded) return [];
    let api = xml?.api;
    if (api === undefined) {
      let source;
      try { source = fs.readFileSync(path.join(root, "source.properties"), "utf8"); } catch { return []; }
      const property = (key, trim = true) => {
        const value = source.match(new RegExp(`^[ \\t]*${key.replaceAll(".", "\\.")}[ \\t]*=[ \\t]*([^\\r\\n]*)`, "m"))?.[1];
        return trim ? value?.trim() : value;
      };
      const preview = property("AndroidVersion.PreviewSdkInt"), beta = property("AndroidVersion.BetaVersion"), codename = property("AndroidVersion.CodeName");
      const base = property("AndroidVersion.IsBaseSdk");
      if ((preview !== undefined && preview !== "0") || beta || (codename && codename !== "REL") ||
          (base !== undefined && base.toLowerCase() !== "true") ||
          !stablePackageRevision(property("Pkg.Revision", false) ?? "")) return [];
      api = property("AndroidVersion.ApiLevel");
      if (!/^\d+$/.test(api ?? "")) return [];
    }
    const [majorString, minorString] = api.split(".");
    const major = Number(majorString), minor = minorString === undefined ? undefined : Number(minorString);
    if (!Number.isSafeInteger(major) || (minor !== undefined && !Number.isSafeInteger(minor))) return [];
    return [{ major, minor, version: minor === undefined ? String(major) : `${major}.${minor}` }];
  }).sort(compareSdkPlatforms);
}

function compareSdkPlatforms(left, right) {
  return compareVersions(right?.version ?? "0", left?.version ?? "0") ||
    Number(right?.minor !== undefined) - Number(left?.minor !== undefined);
}

export function selectSdkPlatform(sdk, { minimumSdk = androidToolchainProfiles[0].minimumSdk,
  maximumSdk = androidToolchainProfiles[0].maximumSdk } = {}) {
  const selected = installedSdkPlatforms(sdk).find((platform) => platform.major >= minimumSdk &&
    platform.major <= maximumSdk && (maximumSdk !== 36 || platform.minor === undefined));
  if (!selected) throw new Error(`Android API ${minimumSdk}${maximumSdk === Infinity ? " or newer" : ""} stable platform is not installed.`);
  return selected;
}

export function hasSdkPlatform(sdk, { major, minor }) {
  return installedSdkPlatforms(sdk).some((platform) => platform.major === major && platform.minor === minor);
}

export function readGeneratedSdk(file) {
  let source;
  try { source = fs.readFileSync(file, "utf8"); }
  catch { throw new Error("Generated Android app/build.gradle.kts is missing or unreadable. Initialize the Android scaffold first."); }
  const literal = (name, optional = false) => {
    const declarations = [...source.matchAll(new RegExp(`^[ \\t]*${name}\\b[^\\r\\n]*`, "gm"))];
    if (optional && declarations.length === 0) return undefined;
    const value = declarations[0]?.[0].match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(\\d+)[ \\t]*(?://.*)?$`))?.[1];
    if (declarations.length !== 1 || value === undefined || !Number.isSafeInteger(Number(value))) {
      throw new Error(`Generated Android ${name} must have one unambiguous numeric literal declaration.`);
    }
    return Number(value);
  };
  const required = { major: literal("compileSdk"), minor: literal("compileSdkMinor", true),
    path: readLocalSdkPath(path.join(path.dirname(file), "..", "local.properties")) };
  if (required.path && !directory(required.path)) throw new Error("Generated local.properties sdk.dir must identify an installed SDK directory. Remove or align sdk.dir before reconfiguration.");
  return required;
}

function readLocalPath(file, key, allowRelative) {
  if (!fs.existsSync(file)) return undefined;
  const declarations = [...fs.readFileSync(file, "utf8").matchAll(new RegExp(`^[ \\t\\f]*${key.replaceAll(".", "\\.")}(?:[ \\t\\f]*[=:][ \\t\\f]*|[ \\t\\f]+|$)([^\\r\\n]*)`, "gm"))];
  if (!declarations.length) return undefined;
  if (declarations.length !== 1) throw new Error(`local.properties ${key} must have one unambiguous declaration.`);
  const value = declarations[0][1];
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") { decoded += value[index]; continue; }
    const escaped = value[++index];
    if (escaped === undefined) throw new Error(`local.properties ${key} continuation is unsupported.`);
    if (escaped === "u") {
      const hex = value.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error(`local.properties ${key} has an invalid Unicode escape.`);
      decoded += String.fromCharCode(Number.parseInt(hex, 16)); index += 4;
    } else decoded += ({ t: "\t", n: "\n", r: "\r", f: "\f" })[escaped] ?? escaped;
  }
  if (!decoded || decoded.includes("\0")) throw new Error(`local.properties ${key} must identify a valid directory path.`);
  if (!allowRelative && !path.isAbsolute(decoded)) throw new Error(`local.properties ${key} must be an absolute path.`);
  return allowRelative ? path.resolve(path.dirname(file), decoded) : decoded;
}

export function readLocalNdkPath(file) { return readLocalPath(file, "ndk.dir", false); }
export function readLocalSdkPath(file) { return readLocalPath(file, "sdk.dir", true); }

export function escapeLocalProperty(value) {
  return value.replace(/[\\ \t\r\n\f:=#!]/g, (character) =>
    ({ "\t": "\\t", "\r": "\\r", "\n": "\\n", "\f": "\\f" })[character] ?? `\\${character}`);
}

export function readGeneratedNdk(file, { requireVersion = true } = {}) {
  const source = fs.readFileSync(file, "utf8");
  const literal = (name, required) => {
    const declarations = [...source.matchAll(new RegExp(`^[ \\t]*${name}\\b[^\\r\\n]*`, "gm"))];
    if (!required && !declarations.length) return undefined;
    const quoted = declarations[0]?.[0].match(/^[ \t]*[A-Za-z]+[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\.)*")[ \t]*(?:\/\/.*)?$/)?.[1];
    if (declarations.length !== 1 || !quoted) throw new Error(`Generated Android ${name} must have one unambiguous string literal declaration.`);
    let json = '"';
    for (let index = 1; index < quoted.length - 1; index += 1) {
      const character = quoted[index];
      if (character === "$") throw new Error(`Generated Android ${name} must not interpolate values.`);
      if (character === "\\") {
        const escaped = quoted[++index];
        json += escaped === "$" ? "$" : `\\${escaped}`;
      } else json += character;
    }
    try { return JSON.parse(`${json}"`); }
    catch { throw new Error(`Generated Android ${name} has unsupported string escapes.`); }
  };
  const version = literal("ndkVersion", requireVersion), ndkPath = literal("ndkPath", false);
  if (version !== undefined && !/^\d+(?:\.\d+)+$/.test(version)) throw new Error("Generated Android ndkVersion must be a stable numeric revision.");
  if (ndkPath !== undefined && !path.isAbsolute(ndkPath)) throw new Error("Generated Android ndkPath must be absolute.");
  const localPath = readLocalNdkPath(path.join(path.dirname(file), "..", "local.properties"));
  if (ndkPath && localPath && canonicalRoot(ndkPath) !== canonicalRoot(localPath)) {
    throw new Error("Generated Android ndkPath conflicts with local.properties ndk.dir. Reconfigure the Android toolchain.");
  }
  return { version, path: ndkPath ?? localPath, localPath };
}

export function resolveGeneratedNdk(sdk, recorded, options = {}) {
  const env = options.env ?? process.env;
  try {
    const configured = explicitRoot(env, ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"], "NDK");
    if (configured && recorded.path && canonicalRoot(configured) !== canonicalRoot(recorded.path)) {
      throw new Error("Explicit NDK override disagrees with the generated NDK path.");
    }
    const root = configured ?? recorded.path;
    return resolveNdk(sdk, { ...options, requiredRevision: recorded.version,
      env: root ? { ...env, ANDROID_NDK_HOME: root, ANDROID_NDK_ROOT: root, NDK_HOME: root } : env });
  } catch (error) {
    throw new Error(`${error.message} Reconfigure with matching NDK overrides using pnpm package:android:prepare before opening Studio.`);
  }
}

export function resolveGeneratedSdk(required, options = {}) {
  const platform = `android-${required.major}${required.minor === undefined ? "" : `.${required.minor}`}`;
  try {
    const env = options.env ?? process.env;
    const configured = explicitRoot(env, ["ANDROID_HOME", "ANDROID_SDK_ROOT"], "SDK");
    if (configured && required.path && canonicalRoot(configured) !== canonicalRoot(required.path)) {
      throw new Error("local.properties sdk.dir conflicts with the selected SDK. Remove or align sdk.dir before reconfiguration.");
    }
    const root = configured ?? required.path;
    const selected = resolveSdk({ ...options, env: root ? { ...env, ANDROID_HOME: root, ANDROID_SDK_ROOT: root } : env,
      allCandidates: true }).find((sdk) => hasSdkPlatform(sdk, required));
    if (!selected) throw new Error("No discovered SDK contains the required complete stable platform.");
    return selected;
  } catch (error) { throw new Error(`Required Android SDK platform ${platform}: ${error.message}`); }
}

export function resolveSdk({ env = process.env, homeDir = os.homedir(), hostPlatform = process.platform,
  runCapture = capture, isDirectory = directory, isExecutable = executable, allCandidates = false } = {}) {
  const configured = explicitRoot(env, ["ANDROID_HOME", "ANDROID_SDK_ROOT"], "SDK");
  if (configured) {
    if (!isDirectory(configured)) throw new Error(`Configured Android SDK directory not found: ${configured}`);
    return allCandidates ? [configured] : configured;
  }
  const candidates = [];
  // Resolve symlinks before walking out of cmdline-tools/<version>/bin or tools/bin.
  for (const entry of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const manager = path.resolve(entry, "sdkmanager");
    if (!isExecutable(manager)) continue;
    let real;
    try { real = fs.realpathSync(manager); } catch { continue; }
    const bin = path.dirname(real);
    const tools = path.dirname(bin);
    if (path.basename(path.dirname(tools)) === "cmdline-tools") candidates.push(path.resolve(tools, "../.."));
    else if (path.basename(tools) === "tools") candidates.push(path.dirname(tools));
  }
  const info = runCapture("android", ["info", "sdk"], { env });
  if (info.ok) candidates.push(info.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1));
  candidates.push(path.join(homeDir, hostPlatform === "darwin" ? "Library/Android/sdk" : "Android/Sdk"));
  if (hostPlatform === "linux") candidates.push("/opt/android-sdk", "/usr/lib/android-sdk");
  const installed = [...new Set(candidates.filter(Boolean).map((root) => path.resolve(root)))].filter(isDirectory);
  const platform = (root) => installedSdkPlatforms(root)[0];
  installed.sort((left, right) => compareSdkPlatforms(platform(left), platform(right)));
  const sdk = installed[0];
  if (sdk) return allCandidates ? installed : sdk;
  throw new Error("Android SDK not found. Install SDK command-line tools or set matching ANDROID_HOME/ANDROID_SDK_ROOT values.");
}

export function readNdkRevision(root) {
  let properties;
  try { properties = fs.readFileSync(path.join(root, "source.properties"), "utf8"); } catch { return undefined; }
  const revision = properties.match(/^\s*Pkg\.Revision\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!/^\d+(?:\.\d+)+$/.test(revision ?? "") || /^(?:Pkg\.Desc|Pkg\.Revision)\s*=.*\b(?:beta|alpha|rc|preview)\b/im.test(properties)) return undefined;
  return revision;
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export function resolveNdk(sdk, { env = process.env, hostPlatform = process.platform, hostArch = process.arch,
  standaloneRoots = ["/opt/android-ndk"], isExecutable = executable, requiredRevision } = {}) {
  const prebuilt = androidHostPrebuilt(hostPlatform, hostArch);
  const configured = explicitRoot(env, ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"], "NDK");
  const validate = (root) => {
    const version = readNdkRevision(root);
    if (!version || Number(version.split(".")[0]) < minimumNdkMajor) {
      throw new Error(`Android NDK requires stable numeric Pkg.Revision >= ${minimumNdkMajor} at ${root}; found ${version ?? "no stable revision"}. Install a current stable NDK (major ${minimumNdkMajor} or newer) using sdkmanager.`);
    }
    if (requiredRevision !== undefined && version !== requiredRevision) {
      throw new Error(`Android NDK revision ${version} does not match generated ndkVersion ${requiredRevision} at ${root}.`);
    }
    const bin = path.join(root, "toolchains/llvm/prebuilt", prebuilt, "bin");
    const tools = ["aarch64-linux-android26-clang", "aarch64-linux-android26-clang++", "llvm-ar", "llvm-readelf"]
      .map((tool) => path.join(bin, tool));
    tools.push(path.join(root, "shader-tools", prebuilt, "glslc"));
    const missing = tools.find((tool) => !isExecutable(tool));
    if (missing) throw new Error(`Required Android NDK tool missing or not executable: ${missing}`);
    return { path: root, version };
  };
  if (configured) return validate(configured);
  const sideBySide = path.join(sdk, "ndk");
  const candidates = directory(sideBySide) ? fs.readdirSync(sideBySide).map((name) => path.join(sideBySide, name)) : [];
  candidates.push(...standaloneRoots);
  const installed = [];
  let failure;
  for (const root of candidates) {
    try { installed.push(validate(root)); } catch (error) { if (directory(root)) failure ??= error; }
  }
  installed.sort((left, right) => compareVersions(right.version, left.version));
  if (installed.length) return installed[0];
  throw failure ?? new Error(`Android NDK >= ${minimumNdkMajor} not found. Install a current stable NDK (major ${minimumNdkMajor} or newer) using sdkmanager, or set matching ANDROID_NDK_HOME/ANDROID_NDK_ROOT/NDK_HOME values.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const hostPlatform = process.argv[2] ?? process.platform;
    const hostArch = process.argv[3] ?? process.arch;
    const studio = process.argv[4] === "--studio";
    if (process.argv.length > 4 && (!studio || process.argv.length !== 6)) {
      throw new Error("Usage: android-toolchain.mjs [host-platform host-arch [--studio app/build.gradle.kts]]");
    }
    let sdk;
    if (studio) sdk = resolveGeneratedSdk(readGeneratedSdk(process.argv[5]), { hostPlatform });
    else try { sdk = resolveSdk({ hostPlatform }); } catch (error) {
      // Direct native-runtime builds need an NDK, without requiring a full SDK.
      if ((process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT || process.env.NDK_HOME) &&
          !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
        sdk = path.join(os.homedir(), hostPlatform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
      } else throw error;
    }
    const ndk = studio ? resolveGeneratedNdk(sdk, readGeneratedNdk(process.argv[5]), { hostPlatform, hostArch })
      : resolveNdk(sdk, { hostPlatform, hostArch });
    process.stdout.write(`${sdk}\n${ndk.path}\n${ndk.version}\n${androidHostPrebuilt(hostPlatform, hostArch)}\n`);
    if (compareVersions(ndk.version, validatedNdkRevision) > 0) {
      console.error(`[android toolchain] NDK ${ndk.version} is newer than validated ${validatedNdkRevision}; packaging is unvalidated.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
