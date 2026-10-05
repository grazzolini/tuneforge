import fs from "node:fs";
import path from "node:path";

const baseConfig = JSON.parse(fs.readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));

export function profilesFromConfig(config) {
  const production = { id: config.identifier, name: config.productName, binary: config.mainBinaryName ?? "tuneforge" };
  return { production, test: { id: production.id + ".test", name: production.name + " Test", binary: production.binary + "-test" } };
}

const profiles = profilesFromConfig(baseConfig);
export const PRODUCTION_PACKAGE = Object.freeze(profiles.production);
export const TEST_PACKAGE = Object.freeze(profiles.test);

export function packageProfile(testPackage) {
  return testPackage ? TEST_PACKAGE : PRODUCTION_PACKAGE;
}

export function testTauriOverlay(config = baseConfig) {
  const testProfile = profilesFromConfig(config).test;
  return {
    ...devTauriOverlay(config),
    productName: testProfile.name,
    identifier: testProfile.id,
    mainBinaryName: testProfile.binary,
  };
}

export function devTauriOverlay(config = baseConfig) {
  return {
    app: { windows: [{ ...config.app.windows[0], title: profilesFromConfig(config).test.name }] },
    bundle: {
      icon: ["icons/test/32x32.png", "icons/test/128x128.png",
        "icons/test/128x128@2x.png", "icons/test/icon.icns", "icons/test/icon.ico"],
    },
  };
}

export function writeTestTauriOverlay(tauriRoot) {
  const output = path.join(tauriRoot, "target", "test-package", "tauri.test.conf.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(testTauriOverlay(), null, 2)}\n`);
  return output;
}

export function writeDevTauriOverlay(tauriRoot) {
  const output = path.join(tauriRoot, "target", "dev-profile", "tauri.dev.conf.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(devTauriOverlay()) + "\n");
  return output;
}
