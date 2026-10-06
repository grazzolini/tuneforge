import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDeterministicSourceSnapshot } from "./deterministic-source-snapshot.mjs";
import { profilesFromConfig, testTauriOverlay } from "./package-profile.mjs";
export { compareUtf8 } from "./deterministic-source-snapshot.mjs";

export function validatedSourceDateEpoch(value, label = "SOURCE_DATE_EPOCH") {
  const epoch = Number(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(epoch) || epoch > 253402300799) {
    throw new Error(`${label} must be a positive integer Unix timestamp.`);
  }
  return value;
}

export function resolveSourceDateEpoch({ override = process.env.SOURCE_DATE_EPOCH } = {}) {
  return override === undefined ? "1" : validatedSourceDateEpoch(override);
}

export function createFlatpakSourceSnapshot({ root, outputPath, inputs, sourceDateEpoch = resolveSourceDateEpoch() }) {
  return createDeterministicSourceSnapshot({ root, outputPath, inputs, epoch: validatedSourceDateEpoch(sourceDateEpoch) });
}

export const flatpakSourceSnapshotInputs = {
  frontend: [
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/build-info.mjs",
    { source: "packaging/flatpak/seed-pnpm-store.mjs", destination: "seed-pnpm-store.mjs" },
    "apps/desktop/package.json", "apps/desktop/index.html", "apps/desktop/tsconfig.json",
    "apps/desktop/tsconfig.node.json", "apps/desktop/vite.config.ts", "apps/desktop/src",
    "packages/shared-types/package.json", "packages/shared-types/src",
  ],
  desktop: [
    "apps/desktop/src-tauri/Cargo.lock", "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/build.rs", "apps/desktop/src-tauri/tauri.conf.json",
    "apps/desktop/src-tauri/capabilities", "apps/desktop/src-tauri/icons",
    "apps/desktop/src-tauri/resources", "apps/desktop/src-tauri/src",
    "apps/backend/app/storage-profile.json", "apps/desktop/src-tauri/native/whisper-rs-sys",
  ],
  backend: [
    "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "LICENSES/crema-0.2.0-BSD-2-Clause.txt",
    "docs/PACKAGING.md", "apps/backend/app", "apps/backend/alembic", "apps/backend/alembic.ini",
    "apps/backend/pyproject.toml", { source: "packaging/demucs/models.json", destination: "apps/backend/demucs-models.json" },
    { source: "packaging/flatpak/ffmpeg-wrapper.sh", destination: "ffmpeg" },
    { source: "packaging/flatpak/ffprobe-wrapper.sh", destination: "ffprobe" },
    { source: "packaging/flatpak/com.tuneforge.desktop.desktop", destination: "com.tuneforge.desktop.desktop" },
    { source: "packaging/flatpak/com.tuneforge.desktop.metainfo.xml", destination: "com.tuneforge.desktop.metainfo.xml" },
    { source: "apps/desktop/src-tauri/icons/32x32.png", destination: "icons/32x32.png" },
    { source: "apps/desktop/src-tauri/icons/128x128.png", destination: "icons/128x128.png" },
    { source: "apps/desktop/src-tauri/icons/512x512.png", destination: "icons/512x512.png" },
  ],
};

export const flatpakDesktopSourceSnapshotInputs = Object.freeze(flatpakSourceSnapshotInputs.desktop);

export function createFlatpakDesktopSourceSnapshot({ root, outputPath, sourceDateEpoch }) {
  return createFlatpakSourceSnapshot({
    root,
    inputs: flatpakDesktopSourceSnapshotInputs.map((source) => ({ source })),
    outputPath,
    sourceDateEpoch,
  });
}

export function generateFlatpakSourceSnapshots({ root, generatedRoot: snapshotRoot, sourceDateEpoch = resolveSourceDateEpoch(),
  testPackage = false }) {
  const createSnapshot = (name, inputs) => createFlatpakSourceSnapshot({
    root, inputs: inputs.map((input) => typeof input === "string" ? { source: input } : input),
    outputPath: path.join(snapshotRoot, `${name}-snapshot.tar`), sourceDateEpoch,
  });
  const backendInputs = [...flatpakSourceSnapshotInputs.backend];
  if (existsSync(path.join(root, "packaging/demucs/drumsep-model.json"))) {
    backendInputs.push({ source: "packaging/demucs/drumsep-model.json", destination: "apps/backend/drumsep-model.json" });
  }
  const desktopInputs = flatpakDesktopSourceSnapshotInputs.map((source) => ({ source }));
  if (testPackage) {
    const baseConfig = JSON.parse(readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
    const testProfile = profilesFromConfig(baseConfig).test;
    const overlay = testTauriOverlay(baseConfig);
    mkdirSync(snapshotRoot, { recursive: true });
    writeFileSync(path.join(snapshotRoot, "test-tauri.conf.json"), `${JSON.stringify({
      ...baseConfig, ...overlay,
      app: { ...baseConfig.app, ...overlay.app },
      bundle: { ...baseConfig.bundle, ...overlay.bundle },
    }, null, 2)}\n`);
    // Cargo merges the test overlay through TAURI_CONFIG; keep the authoritative base ID.

    const desktopSource = readFileSync(path.join(root, "packaging/flatpak/com.tuneforge.desktop.desktop"), "utf8");
    const appStreamSource = readFileSync(path.join(root, "packaging/flatpak/com.tuneforge.desktop.metainfo.xml"), "utf8");
    const templateId = appStreamSource.match(/<id>([^<]+)<\/id>/)?.[1];
    if (!templateId) throw new Error("Flatpak AppStream template ID is missing.");
    const desktopEntry = desktopSource
      .replace("Name=TuneForge", `Name=${testProfile.name}`)
      .replace("Exec=tuneforge", `Exec=${testProfile.binary}`)
      .replaceAll(templateId, testProfile.id)
      .replace("StartupWMClass=Tuneforge", "StartupWMClass=Tuneforge-test");
    const appStream = appStreamSource
      .replace("<name>TuneForge</name>", `<name>${testProfile.name}</name>`)
      .replaceAll(templateId, testProfile.id);
    writeFileSync(path.join(snapshotRoot, "test.desktop"), desktopEntry);
    writeFileSync(path.join(snapshotRoot, "test.metainfo.xml"), appStream);
    const backendReplacements = new Map([
      ["packaging/flatpak/com.tuneforge.desktop.desktop", {
        source: path.relative(root, path.join(snapshotRoot, "test.desktop")),
        destination: `${testProfile.id}.desktop`,
      }],
      ["packaging/flatpak/com.tuneforge.desktop.metainfo.xml", {
        source: path.relative(root, path.join(snapshotRoot, "test.metainfo.xml")),
        destination: `${testProfile.id}.metainfo.xml`,
      }],
    ]);
    for (const size of ["32x32", "128x128", "512x512"]) {
      backendReplacements.set(`apps/desktop/src-tauri/icons/${size}.png`, {
        source: `apps/desktop/src-tauri/icons/test/${size}.png`, destination: `icons/${size}.png`,
      });
    }
    for (let index = 0; index < backendInputs.length; index += 1) {
      const input = backendInputs[index];
      const source = typeof input === "string" ? input : input.source;
      if (backendReplacements.has(source)) backendInputs[index] = backendReplacements.get(source);
    }
  }
  return [
    createSnapshot("frontend", flatpakSourceSnapshotInputs.frontend),
    createSnapshot("desktop", desktopInputs),
    createSnapshot("backend", backendInputs),
  ];
}
