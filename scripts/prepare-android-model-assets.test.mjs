import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { cachedDemucsModel, demucsAndroidAsset, prepareAndroidModelAssets } from "./prepare-android-model-assets.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-android-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureSpec(bytes) {
  return {
    family: "beat-this",
    revision: "fixture-revision",
    fileName: "fixture.pte",
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    url: "https://invalid.example/fixture.pte",
  };
}

test("Android model bundle verifies and records a local model atomically", async (t) => {
  const root = temp(t);
  const bytes = Buffer.from("synthetic-model-fixture");
  const source = path.join(root, "source.pte");
  const destinationRoot = path.join(root, "assets/models");
  fs.writeFileSync(source, bytes);
  const spec = fixtureSpec(bytes);

  const [destination] = await prepareAndroidModelAssets({
    source, cremaSources: [], destinationRoot, specs: [spec],
  });
  assert.deepEqual(fs.readFileSync(destination), bytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(destinationRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.assets[0].sha256, spec.sha256);
  assert.equal(manifest.assets[0].relativePath, "models/beat-this/fixture.pte");
  assert.deepEqual(fs.readdirSync(path.dirname(destination)).sort(), ["fixture.pte"]);
});

test("Android model bundle rejects corrupt bytes without publishing", async (t) => {
  const root = temp(t);
  const source = path.join(root, "source.pte");
  const destinationRoot = path.join(root, "assets/models");
  fs.writeFileSync(source, "corrupt");
  const spec = fixtureSpec(Buffer.from("expected"));

  await assert.rejects(
    prepareAndroidModelAssets({ source, cremaSources: [], destinationRoot, specs: [spec] }),
    /failed size or SHA-256 verification/,
  );
  assert.equal(fs.existsSync(path.join(destinationRoot, "manifest.json")), false);
  assert.equal(fs.existsSync(destinationRoot), false);
});

test("Android model bundle publishes a Crema model and runtime state as one pair", async (t) => {
  const root = temp(t);
  const model = Buffer.from("synthetic-crema-model");
  const state = Buffer.from("synthetic-crema-state");
  const modelSource = path.join(root, "source.onnx");
  const stateSource = path.join(root, "source.json");
  fs.writeFileSync(modelSource, model);
  fs.writeFileSync(stateSource, state);
  const specs = [
    { ...fixtureSpec(model), family: "crema", fileName: "model.onnx" },
    { ...fixtureSpec(state), family: "crema", fileName: "state.json" },
  ];
  const destinationRoot = path.join(root, "assets/models");

  const destinations = await prepareAndroidModelAssets({
    source: modelSource,
    cremaSources: [stateSource],
    destinationRoot,
    specs,
  });

  assert.deepEqual(destinations.map((file) => fs.readFileSync(file)), [model, state]);
  const manifest = JSON.parse(fs.readFileSync(path.join(destinationRoot, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.assets.map((asset) => asset.fileName), ["model.onnx", "state.json"]);
});

test("failed Crema pair replacement preserves the previously published pair and manifest", async (t) => {
  const root = temp(t);
  const destinationRoot = path.join(root, "assets/models");
  fs.mkdirSync(path.join(destinationRoot, "crema"), { recursive: true });
  fs.writeFileSync(path.join(destinationRoot, "crema/model.onnx"), "old-model");
  fs.writeFileSync(path.join(destinationRoot, "crema/state.json"), "old-state");
  fs.writeFileSync(path.join(destinationRoot, "manifest.json"), "old-manifest");
  const model = Buffer.from("new-model");
  const modelSource = path.join(root, "source.onnx");
  const corruptStateSource = path.join(root, "source.json");
  fs.writeFileSync(modelSource, model);
  fs.writeFileSync(corruptStateSource, "corrupt-state");
  const specs = [
    { ...fixtureSpec(model), family: "crema", fileName: "model.onnx" },
    { ...fixtureSpec(Buffer.from("expected-state")), family: "crema", fileName: "state.json" },
  ];

  await assert.rejects(prepareAndroidModelAssets({
    source: modelSource,
    cremaSources: [corruptStateSource],
    destinationRoot,
    specs,
  }), /failed size or SHA-256 verification/);

  assert.equal(fs.readFileSync(path.join(destinationRoot, "crema/model.onnx"), "utf8"), "old-model");
  assert.equal(fs.readFileSync(path.join(destinationRoot, "crema/state.json"), "utf8"), "old-state");
  assert.equal(fs.readFileSync(path.join(destinationRoot, "manifest.json"), "utf8"), "old-manifest");
  assert.deepEqual(fs.readdirSync(path.dirname(destinationRoot)).sort(), ["models"]);
});

test("interrupted or ENOSPC downloads reject and leave no advertised assets", async (t) => {
  const root = temp(t);
  const bytes = Buffer.from("download-body");
  const spec = fixtureSpec(bytes);
  const interruptedRoot = path.join(root, "interrupted/models");
  const interrupted = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.error(new Error("connection interrupted"));
    },
  });
  await assert.rejects(prepareAndroidModelAssets({
    source: null,
    cremaSources: [],
    destinationRoot: interruptedRoot,
    specs: [spec],
    fetchImpl: async () => ({ ok: true, body: interrupted }),
  }), /connection interrupted/);
  assert.equal(fs.existsSync(interruptedRoot), false);

  const noSpaceRoot = path.join(root, "no-space/models");
  await assert.rejects(prepareAndroidModelAssets({
    source: null,
    cremaSources: [],
    destinationRoot: noSpaceRoot,
    specs: [spec],
    fetchImpl: async () => ({ ok: true, body: new Blob([bytes]).stream() }),
    createWriteStreamImpl: () => new Writable({
      write(_chunk, _encoding, callback) { callback(Object.assign(new Error("no space"), { code: "ENOSPC" })); },
    }),
  }), /no space/);
  assert.equal(fs.existsSync(noSpaceRoot), false);
});

test("ordinary APK stages only the canonical Demucs descriptor and does not acquire weights", async (t) => {
  const destinationRoot = temp(t);
  const acquired = await prepareAndroidModelAssets({ destinationRoot, bundle: false,
    fetchImpl: () => assert.fail("An ordinary APK must not download model weights") });
  assert.deepEqual(acquired, []);
  assert.deepEqual(fs.readdirSync(destinationRoot), ["manifest.json"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(destinationRoot, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.assets, [{ ...demucsAndroidAsset, bundled: false,
    relativePath: `models/demucs/${demucsAndroidAsset.fileName}` }]);
  assert.match(demucsAndroidAsset.url, /^https:\/\/huggingface\.co\/adefossez\/HTDemucs-6s\/resolve\/[a-f0-9]{40}\//);
});

test("explicit Demucs bundle reuses a verified prewarm cache and repairs a corrupt input by downloading", async (t) => {
  const root = temp(t);
  const cache = path.join(root, "hub");
  const prewarmed = cachedDemucsModel({ HF_HUB_CACHE: cache, HF_HOME: "ignored" }, "ignored");
  assert.ok(prewarmed.startsWith(cache + path.sep + "models--adefossez--HTDemucs-6s"));
  fs.mkdirSync(path.dirname(prewarmed), { recursive: true });
  const bytes = Buffer.from("verified prewarmed bytes");
  fs.writeFileSync(prewarmed, bytes);
  const spec = { ...fixtureSpec(bytes), family: "demucs" };
  const destinationRoot = path.join(root, "assets");
  const [first] = await prepareAndroidModelAssets({ destinationRoot, specs: [spec], demucsSource: prewarmed,
    fetchImpl: () => assert.fail("Verified prewarm cache should avoid a download") });
  assert.deepEqual(fs.readFileSync(first), bytes);
  fs.writeFileSync(prewarmed, "corrupt");
  const [repaired] = await prepareAndroidModelAssets({ destinationRoot, specs: [spec], demucsSource: prewarmed,
    fetchImpl: async (url) => {
      assert.equal(url, spec.url);
      return new Response(bytes);
    },
  });
  assert.deepEqual(fs.readFileSync(repaired), bytes);
  assert.equal(fs.readFileSync(prewarmed, "utf8"), "corrupt");
});
