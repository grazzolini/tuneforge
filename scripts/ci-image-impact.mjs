import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const inventoryPath = ".github/ci/image-inputs.json";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safePath = (value) => typeof value === "string" && /^[.\w/-]+$/.test(value) &&
  !path.isAbsolute(value) && !value.split("/").includes("..");

export function imageInventory(root = repositoryRoot) {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryPath), "utf8"));
  if (inventory.schemaVersion !== 1 || inventory.platform !== "linux/amd64") {
    throw new Error("Unsupported CI image inventory schema/platform");
  }
  const inputs = [...new Set(inventory.components.flatMap((component) => {
    for (const key of ["name", "source", "license", "probes", "consumers", "inputs"]) {
      if (!component[key]?.length) throw new Error(`CI image component missing ${key}`);
    }
    return component.inputs;
  }))].sort();
  if (inputs.some((input) => !safePath(input) || path.posix.normalize(input) !== input)) {
    throw new Error("Unsafe or noncanonical CI image input path");
  }
  return { ...inventory, inputs };
}

export function checkImageInputs(root = repositoryRoot) {
  const inventory = imageInventory(root);
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  for (const relative of inventory.inputs) {
    const stat = fs.lstatSync(path.join(root, relative));
    if (!stat.isFile()) throw new Error(`CI image input must be a regular file: ${relative}`);
  }
  const dockerfile = read(".github/ci/Dockerfile").replace(/\\\r?\n/g, " ");
  const stages = new Set([...dockerfile.matchAll(/^\s*FROM\s+\S+\s+AS\s+([\w-]+)$/gmi)].map((match) => match[1]));
  if (/^\s*ADD\b/im.test(dockerfile)) throw new Error("Unregistered Docker ADD input; use reviewed explicit COPY");
  if (/^\s*RUN\s+(?:--\S+\s+)*--mount(?:=|\s)/im.test(dockerfile)) {
    throw new Error("Unsupported Docker RUN --mount input; register dependencies through reviewed explicit COPY");
  }
  const copied = new Set();
  for (const match of dockerfile.matchAll(/^\s*COPY\s+(.+)$/gmi)) {
    const words = match[1].trim().split(/\s+/);
    if (words[0].startsWith("--from=")) {
      if (!stages.has(words[0].slice(7))) throw new Error(`Unregistered/external Docker stage: ${words[0]}`);
      continue;
    }
    for (const source of words.slice(0, -1)) {
      if (!safePath(source) || !inventory.inputs.includes(source)) {
        throw new Error(`Unregistered Docker COPY input: ${source}; declare component, source, license, probes and consumers`);
      }
      copied.add(source);
    }
  }
  const ignore = read(".github/ci/Dockerfile.dockerignore").trim().split(/\r?\n/);
  if (ignore[0] !== "**") throw new Error("CI Docker context must default-deny with **");
  for (const line of ignore.slice(1)) {
    if (!line.startsWith("!") || (!line.endsWith("/") && !inventory.inputs.includes(line.slice(1)))) {
      throw new Error(`Unregistered Docker context input: ${line}`);
    }
  }
  for (const relative of copied) {
    if (!ignore.includes(`!${relative}`)) throw new Error(`Docker context excludes registered COPY input: ${relative}`);
  }
  for (const relative of inventory.inputs.filter((input) => input.endsWith(".mjs"))) {
    const source = read(relative);
    if (!inventory.registeredReads[relative]) throw new Error(`Register repository reads for ${relative}`);
    if (/\bimport\s*\(/.test(source) || /\brequire\s*\(/.test(source)) {
      throw new Error(`Unsupported dynamic import/require in image input ${relative}; register an auditable static dependency`);
    }
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!specifier.startsWith(".") || !inventory.inputs.includes(dependency)) {
        throw new Error(`Unregistered local/external import ${relative} -> ${specifier}`);
      }
    }
    // Literal repository paths in producer code must be registered. Generated outputs and
    // Android-only notices are outside the host-test build; dynamic reads require review below.
    for (const match of source.matchAll(/["']((?:scripts|packaging|\.github)\/[^"'\n]+\.(?:mjs|json|patch))["']/g)) {
      if (!inventory.inputs.includes(match[1])) throw new Error(`Unregistered repository read ${relative} -> ${match[1]}`);
    }
    if (digest(source) !== inventory.readAuditSha256?.[relative]) {
      throw new Error(`Read dependency audit required for ${relative}: review dynamic filesystem reads, snapshot lists and host-test branches, then register readAuditSha256=${digest(source)} in ${inventoryPath}`);
    }
  }
  for (const lockPath of inventory.components.flatMap((component) => component.locks ?? [])) {
    const lock = JSON.parse(read(lockPath));
    if (!inventory.inputs.includes(lock.patch?.path)) throw new Error(`Unregistered lock patch ${lockPath} -> ${lock.patch?.path}`);
    if (digest(fs.readFileSync(path.join(root, lock.patch.path))) !== lock.patch.sha256) {
      throw new Error(`Lock patch checksum drift: ${lock.patch.path}`);
    }
    if (!/^https:\/\//.test(lock.source?.url) || !/^[a-f0-9]{64}$/.test(lock.source?.sha256)) {
      throw new Error(`Unpinned upstream source in ${lockPath}`);
    }
    const scan = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if ((key === "path" || key === "lockPath") && typeof item === "string" &&
            !inventory.inputs.includes(item)) throw new Error(`Unregistered lock input ${lockPath} -> ${item}`);
        scan(item);
      }
    };
    scan(lock);
  }
  return inventory;
}

export function producerIdentity(root = repositoryRoot) {
  const inventory = checkImageInputs(root);
  const manifest = inventory.inputs.map((input) => `${digest(fs.readFileSync(path.join(root, input)))}  ${input}\n`).join("");
  return { fingerprint: digest(manifest), manifest, platform: inventory.platform };
}

export function imageImpact(paths, root = repositoryRoot) {
  const inventory = checkImageInputs(root);
  return paths.map((input) => {
    if (!safePath(input)) throw new Error(`Unsafe planned/diff path: ${input}`);
    input = path.posix.normalize(input);
    const components = inventory.components.filter((component) => component.inputs.includes(input)).map((component) => component.name);
    const classification = components.length ? "producer" : inventory.processInputs.includes(input) ?
      "publishing-process" : inventory.compatibilityInputs.includes(input) ? "consumer-compatibility" : "no known image impact";
    return { path: input, classification, components,
      chain: components.length ? `${input} -> ${components.join(", ")} -> final image -> backend/desktop_tauri/e2e` :
        classification === "no known image impact" ? "No registered producer dependency; reassess if scope adds imports, locks or Docker inputs" :
          `${input} -> ${classification} review -> existing final image compatibility` };
  });
}

function cli(args) {
  if (args[0] === "--") args.shift();
  const mode = args.shift();
  if (mode === "--check") {
    checkImageInputs();
    console.log("CI image input inventory and dependency closure valid");
    return;
  }
  if (mode === "--fingerprint" || mode === "--manifest") {
    const identity = producerIdentity();
    process.stdout.write(mode === "--manifest" ? identity.manifest : `${identity.fingerprint}\n`);
    return;
  }
  let paths;
  if (mode === "--paths" && args.length) paths = args;
  else if ((mode === "--diff" && args.length === 2) || (mode === "--working-tree" && args.length === 1)) {
    if (args.some((ref) => ref.startsWith("-"))) throw new Error("Git references must not be options");
    paths = execFileSync("git", ["diff", "--name-only", "-z", ...args, "--"], { cwd: repositoryRoot })
      .toString().split("\0").filter(Boolean);
    if (mode === "--working-tree") paths.push(...execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot }).toString().split("\0").filter(Boolean));
    paths = [...new Set(paths)];
  } else throw new Error("Use --paths PATH... | --diff BASE CHECKOUT | --working-tree BASE | --check | --fingerprint | --manifest");
  const impacts = imageImpact(paths);
  console.log(JSON.stringify({ inventory: inventoryPath, impacts,
    delivery: impacts.some((impact) => impact.classification === "producer") ?
      "producer PR -> whole final candidate validation -> merged main publication -> evidence/anonymous pull -> separate digest promotion -> consumers" :
      "review publishing process/consumer compatibility where selected; no known producer publication required",
    limits: "Recipe fingerprint is not byte identity: unversioned APT/transitive resolution is recorded per build in packages.txt. Review dynamically derived inputs when extending a producer." }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
