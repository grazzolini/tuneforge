import { Buffer } from "node:buffer";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const blockSize = 512;
export const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function posixPath(value, label) {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe snapshot ${label}: ${value}`);
  }
  return normalized;
}

function octal(value, width, label) {
  const text = value.toString(8);
  if (text.length > width - 1) throw new Error(`USTAR ${label} overflow.`);
  return `${"0".repeat(width - 1 - text.length)}${text}\0`;
}

function tarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
  const slash = value.lastIndexOf("/", 155);
  if (slash <= 0 || Buffer.byteLength(value.slice(0, slash)) > 155 || Buffer.byteLength(value.slice(slash + 1)) > 100) {
    throw new Error(`USTAR path overflow: ${value}`);
  }
  return { prefix: value.slice(0, slash), name: value.slice(slash + 1) };
}

function put(buffer, offset, width, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > width) throw new Error("USTAR field overflow.");
  bytes.copy(buffer, offset);
}

function header(entry, epoch) {
  const output = Buffer.alloc(blockSize);
  const target = tarPath(entry.path);
  put(output, 0, 100, target.name);
  put(output, 100, 8, octal(entry.mode, 8, "mode"));
  put(output, 108, 8, octal(0, 8, "uid"));
  put(output, 116, 8, octal(0, 8, "gid"));
  put(output, 124, 12, octal(entry.size, 12, "size"));
  put(output, 136, 12, octal(epoch, 12, "mtime"));
  output.fill(0x20, 148, 156);
  put(output, 156, 1, entry.type);
  put(output, 157, 100, entry.link ?? "");
  put(output, 257, 6, "ustar\0");
  put(output, 263, 2, "00");
  put(output, 345, 155, target.prefix);
  const checksum = output.reduce((total, byte) => total + byte, 0);
  put(output, 148, 8, `${octal(checksum, 7, "checksum")} `);
  return output;
}

function collectEntry(root, source, destination, entries) {
  const absolute = path.resolve(root, source);
  const rootRelative = path.relative(root, absolute);
  if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) throw new Error(`Unsafe snapshot source: ${source}`);
  const stats = lstatSync(absolute);
  const archivePath = posixPath(destination, "path");
  if (stats.isDirectory()) {
    entries.push({ path: `${archivePath}/`, mode: stats.mode & 0o7777, size: 0, type: "5" });
    for (const name of readdirSync(absolute).sort(compareUtf8)) {
      collectEntry(root, path.join(source, name), `${archivePath}/${name}`, entries);
    }
  } else if (stats.isFile()) {
    entries.push({ path: archivePath, mode: stats.mode & 0o7777, size: stats.size, type: "0", absolute });
  } else if (stats.isSymbolicLink()) {
    const link = readlinkSync(absolute);
    if (Buffer.byteLength(link) > 100) throw new Error(`USTAR symlink target overflow: ${archivePath}`);
    entries.push({ path: archivePath, mode: 0o777, size: 0, type: "2", link });
  } else {
    throw new Error(`Unsupported snapshot entry type: ${source}`);
  }
}

export function createDeterministicSourceSnapshot({ root, outputPath, inputs, epoch: requestedEpoch }) {
  const epoch = Number(requestedEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Snapshot epoch must be a non-negative integer.");
  const entries = [];
  for (const { source, destination = source } of inputs) collectEntry(root, source, destination, entries);
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].path === entries[index].path) throw new Error(`Duplicate snapshot path: ${entries[index].path}`);
  }
  const chunks = [];
  for (const entry of entries) {
    chunks.push(header(entry, epoch));
    if (entry.type === "0") {
      const contents = readFileSync(entry.absolute);
      chunks.push(contents);
      const padding = (blockSize - (contents.length % blockSize)) % blockSize;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(blockSize * 2));
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporary, Buffer.concat(chunks));
  renameSync(temporary, outputPath);
  return { entryCount: entries.length, outputPath };
}
