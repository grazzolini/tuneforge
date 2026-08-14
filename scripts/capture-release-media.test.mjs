import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildManifest,
  captureAccounting,
  captureMotionPolicy,
  chordBackends,
  expectedCatalogEntries,
  manifestItemForCatalogEntry,
  parseOptions,
  releaseMediaCaptureCatalog,
  validateReleaseMediaCatalog,
} from "./capture-release-media.mjs";

test("settings fixture exposes the available default advanced chord backend", () => {
  const backends = chordBackends();
  const advanced = backends.find((backend) => backend.id === "crema-advanced");

  assert.equal(advanced?.available, true);
  assert.equal(advanced?.availability, "available");
  assert.equal(advanced?.label, "Advanced Chords");
  assert.equal(advanced?.unavailable_reason, null);
  assert.equal(advanced?.capabilities.supportsInversions, true);
});

test("capture motion policy freezes screenshots and preserves video movement", () => {
  assert.deepEqual(captureMotionPolicy("screenshot"), { animatePlayback: false });
  assert.deepEqual(captureMotionPolicy("video"), { animatePlayback: true });
  assert.throws(() => captureMotionPolicy("unknown"), /Unsupported capture kind unknown/);
});

test("release-media catalog has unique identifiers, files, and required callbacks", () => {
  assert.equal(validateReleaseMediaCatalog(releaseMediaCaptureCatalog), releaseMediaCaptureCatalog);
  assert.equal(releaseMediaCaptureCatalog.length, 9);
  assert.equal(releaseMediaCaptureCatalog.filter((entry) => entry.kind === "screenshot").length, 8);
  assert.equal(releaseMediaCaptureCatalog.filter((entry) => entry.kind === "video").length, 1);

  const ids = releaseMediaCaptureCatalog.map((entry) => entry.id);
  const files = releaseMediaCaptureCatalog.map((entry) => entry.fileName);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(files).size, files.length);

  for (const entry of releaseMediaCaptureCatalog) {
    assert.equal(entry.enabled, true);
    assert.ok(entry.title);
    assert.ok(entry.caption);
    assert.ok(entry.fixture);
    assert.ok(entry.route);
    if (entry.kind === "screenshot") {
      assert.ok(entry.alt);
      assert.equal(typeof entry.prepare, "function");
      assert.equal(typeof entry.ready, "function");
      assert.equal(typeof entry.capture, "function");
    } else {
      assert.ok(entry.posterId);
      assert.equal(typeof entry.record, "function");
    }
  }
});

test("Export readiness follows the selected file format in its preview", async () => {
  const exportWorkspace = releaseMediaCaptureCatalog.find((entry) => entry.id === "export-workspace");

  for (const fileFormat of ["wav", "flac", "mp3", "m4a"]) {
    let previewRequest;
    const waitFor = () => ({ waitFor: async () => {} });
    const page = {
      getByLabel: (label) => {
        assert.equal(label, "File format");
        return { inputValue: async () => fileFormat };
      },
      getByRole: () => waitFor(),
      getByText: () => waitFor(),
      locator: (selector) => {
        assert.equal(selector, ".export-preview");
        return {
          getByText: (text, options) => {
            previewRequest = { options, text };
            return waitFor();
          },
        };
      },
    };

    await exportWorkspace.ready({ page, timeoutMs: 1 });
    assert.deepEqual(previewRequest, {
      options: { exact: true },
      text: `Midnight Count-In - Practice Mix 1 - Vocals.${fileFormat}`,
    });
  }
});

test("mobile Playback is one deterministic compact screenshot fixture", () => {
  const mobileScreenshots = releaseMediaCaptureCatalog.filter(
    (entry) => entry.kind === "screenshot" && entry.runtime === "mobile",
  );

  assert.equal(mobileScreenshots.length, 1);
  assert.equal(mobileScreenshots[0].id, "mobile-playback");
  assert.equal(mobileScreenshots[0].fixture, "release-showcase-mobile-playback-v1");
  assert.deepEqual(mobileScreenshots[0].viewport, { width: 411, height: 891 });
  assert.equal(mobileScreenshots[0].route, "/projects/proj_release_showcase");
});

test("catalog validation rejects duplicate identifiers and output files", () => {
  const duplicateId = cloneCatalog();
  duplicateId[1].id = duplicateId[0].id;
  assert.throws(() => validateReleaseMediaCatalog(duplicateId), /duplicate id library/);

  const duplicateFile = cloneCatalog();
  duplicateFile[1].fileName = duplicateFile[0].fileName;
  assert.throws(() => validateReleaseMediaCatalog(duplicateFile), /duplicate file library\.png/);
});

test("catalog validation rejects invalid screenshot runtimes and viewports", () => {
  const invalidRuntime = cloneCatalog();
  invalidRuntime.find((entry) => entry.id === "mobile-playback").runtime = "tablet";
  assert.throws(
    () => validateReleaseMediaCatalog(invalidRuntime),
    /unsupported runtime tablet/,
  );

  const invalidViewport = cloneCatalog();
  invalidViewport.find((entry) => entry.id === "mobile-playback").viewport = {
    width: 311,
    height: 891,
  };
  assert.throws(
    () => validateReleaseMediaCatalog(invalidViewport),
    /requires a viewport of at least 320x320/,
  );
});

test("video poster references resolve to enabled screenshots", () => {
  const video = releaseMediaCaptureCatalog.find((entry) => entry.kind === "video");
  const poster = releaseMediaCaptureCatalog.find((entry) => entry.id === video.posterId);
  assert.equal(poster.kind, "screenshot");
  assert.equal(poster.enabled, true);
  assert.equal(
    manifestItemForCatalogEntry(video).poster,
    `media/generated/${poster.fileName}`,
  );

  const invalidPoster = cloneCatalog();
  invalidPoster.find((entry) => entry.kind === "video").posterId = "missing-poster";
  assert.throws(
    () => validateReleaseMediaCatalog(invalidPoster),
    /requires an enabled screenshot poster/,
  );
});

test("capture accounting requires every enabled item unless video is intentionally disabled", () => {
  const screenshots = expectedCatalogEntries(releaseMediaCaptureCatalog, { recordVideo: false });
  const screenshotItems = screenshots.map((entry) => manifestItemForCatalogEntry(entry));

  assert.deepEqual(captureAccounting(releaseMediaCaptureCatalog, screenshotItems, {
    recordVideo: false,
  }), {
    expectedIds: screenshots.map((entry) => entry.id),
    missingIds: [],
    status: "captured",
  });

  const videoEnabled = captureAccounting(releaseMediaCaptureCatalog, screenshotItems, {
    recordVideo: true,
  });
  assert.deepEqual(videoEnabled.missingIds, ["overview-video"]);
  assert.equal(videoEnabled.status, "partial");

  const oneDisabled = cloneCatalog();
  oneDisabled.find((entry) => entry.id === "library").enabled = false;
  assert.equal(
    expectedCatalogEntries(oneDisabled, { recordVideo: false })
      .some((entry) => entry.id === "library"),
    false,
  );

  const allItems = releaseMediaCaptureCatalog.map((entry) => manifestItemForCatalogEntry(entry));
  assert.deepEqual(
    captureAccounting(releaseMediaCaptureCatalog, allItems, { recordVideo: true }).missingIds,
    [],
  );
  assert.equal(
    captureAccounting(releaseMediaCaptureCatalog, [], { recordVideo: true }).status,
    "pending",
  );
});

test("catalog entries map to the existing manifest version 1 wire format", () => {
  const screenshot = releaseMediaCaptureCatalog.find((entry) => entry.id === "library");
  const video = releaseMediaCaptureCatalog.find((entry) => entry.id === "overview-video");
  assert.deepEqual(manifestItemForCatalogEntry(screenshot), {
    id: screenshot.id,
    title: screenshot.title,
    kind: "screenshot",
    src: "media/generated/library.png",
    alt: screenshot.alt,
    caption: screenshot.caption,
    label: "screenshot",
  });
  assert.deepEqual(manifestItemForCatalogEntry(video), {
    id: video.id,
    title: video.title,
    kind: "video",
    src: "media/generated/overview.webm",
    poster: "media/generated/library.png",
    caption: video.caption,
    label: "video",
  });

  const manifest = buildManifest({
    status: "captured",
    items: [manifestItemForCatalogEntry(screenshot), manifestItemForCatalogEntry(video)],
    notes: ["Synthetic fixture."],
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.status, "captured");
  assert.equal(manifest.fixtureTimestamp, "2026-04-18T13:16:00.000Z");
  assert.equal(manifest.items.length, 2);
});

test("capture flags distinguish partial acceptance from intentional screenshot-only mode", () => {
  const options = parseOptions(["--run", "--allow-partial", "--no-video"]);
  assert.equal(options.run, true);
  assert.equal(options.allowPartial, true);
  assert.equal(options.recordVideo, false);
});

test("importing capture script has no capture or console side effects", () => {
  const scriptUrl = new URL("./capture-release-media.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(scriptUrl.href)})`],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

function cloneCatalog() {
  return releaseMediaCaptureCatalog.map((entry) => ({
    ...entry,
    viewport: entry.viewport ? { ...entry.viewport } : undefined,
    recordingItemIds: entry.recordingItemIds ? [...entry.recordingItemIds] : undefined,
  }));
}
