import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  callMusicCore,
  configureMusicCore,
  initializeMusicCore,
} from "../packages/music-core/bindings/wasm/index.mjs";

const labels = ["C", "Dm", "Em", "F", "G", "Am", "Bdim"];
const savedIds = {
  guitar: "guitar-1:15-2:17-3:17-4:17-5:15-6:-1-capo-0",
  accordion: "accordion-c-rh-second-inversion-octave-3-79-84-88",
  piano: "piano-c-first-inversion-64-67-72",
};
const scenarios = [
  { workload: "dictionary", preference: "absent", calls: 10 },
  { workload: "dictionary", preference: "valid", calls: 10 },
  { workload: "dictionary", preference: "stale", calls: 10 },
  { workload: "dictionary", preference: "absent", calls: 20 },
  { workload: "historical-raw-labels", preference: "absent", calls: 10 },
];
function requests({ workload, preference, calls }) {
  const historical = workload === "historical-raw-labels";
  const profile = historical ? null : callMusicCore({ operation: "profiles" }).guitar;
  const guitarContext = {
    canCapo: profile?.canCapo,
    capoFret: 0,
    sourceKey: null,
    transposeSemitones: 0,
    useCapoShapes: false,
  };
  const spell = historical ? null : new Map(labels.map(label => [
    label, callMusicCore({ operation: "spell", input: label, options: {} }),
  ]));
  const request = (label, operation, role) => {
    const id = role === "selected" ? savedIds[operation] : undefined;
    const preferredVoicingIds = id === undefined ? undefined : {
      absent: [], valid: [id], stale: ["stale-generated-voicing-id"],
    }[preference];
    const dto = historical ? { operation, input: label } : {
      operation,
      input: spell.get(label),
      ...(operation === "guitar" ? { profile, context: guitarContext } : { context: null }),
      options: {},
      preferredVoicingIds,
    };
    return { name: `${role} ${operation} ${label}`, dto, savedId: preference === "valid" ? id : undefined };
  };
  const batch = [
    ...labels.map(label => request(label, "guitar", "common")),
    ...Object.keys(savedIds).map(operation => request("C", operation, "selected")),
  ];
  return calls === 20 ? batch.concat(batch) : batch;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: samples.length, p50: percentile(0.5), p95: percentile(0.95), samples };
}

async function measure(options) {
  const scenario = scenarios[options.worker];
  const initializationStart = performance.now();
  configureMusicCore(pathToFileURL(options.module), pathToFileURL(options.wasm));
  await initializeMusicCore();
  const initializationMs = performance.now() - initializationStart;
  const batch = requests(scenario);
  const verify = batch.map(({ dto, savedId, name }) => result => {
    assert.ok(result.length > 0, `${name}: no voicings`);
    if (savedId) {
      assert.equal(result.at(-1).id, savedId, `${name}: saved voicing was not retained after the shortlist`);
      if (dto.operation === "guitar") assert.equal(result.at(-1).rank, 27);
    }
  });
  function opening() {
    const callMs = [], values = [];
    const start = performance.now();
    for (const { dto } of batch) {
      const before = performance.now();
      const value = callMusicCore(dto);
      callMs.push(performance.now() - before);
      values.push(value);
    }
    const openingMs = performance.now() - start;
    for (let index = 0; index < values.length; index++) verify[index](values[index]);
    return { openingMs, callMs };
  }
  const cold = opening();
  const warm = [];
  if (options.workerRun === "warm") {
    for (let index = 0; index < options.warmups; index++) opening();
    for (let index = 0; index < options.openings; index++) warm.push(opening());
  }
  return { initializationMs, cold, warm, peakRssKiB: process.resourceUsage().maxRSS };
}

const { values: args } = parseArgs({ options: {
  wasm: { type: "string" },
  module: { type: "string" },
  variant: { type: "string" },
  openings: { type: "string", default: "50" },
  warmups: { type: "string", default: "10" },
  "cold-processes": { type: "string", default: "15" },
  worker: { type: "string" },
  "worker-run": { type: "string" },
} });
assert.ok(args.wasm && args.variant, "Usage: node scripts/benchmark-chord-dictionary.mjs --wasm PATH --variant NAME");
const wasm = resolve(args.wasm);
const module = args.module ? resolve(args.module) : fileURLToPath(new URL("music-core.mjs", pathToFileURL(wasm)));
const openings = Number(args.openings), warmups = Number(args.warmups), coldProcesses = Number(args["cold-processes"]);
for (const [name, count] of Object.entries({ openings, warmups, coldProcesses }))
  assert.ok(Number.isSafeInteger(count) && count > 0, `Expected a positive integer for ${name}`);
const options = { wasm, module, openings, warmups, worker: args.worker, workerRun: args["worker-run"] };

if (args.worker !== undefined) {
  console.log(JSON.stringify(await measure(options)));
} else {
  const run = (scenario, kind) => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(import.meta.url),
      "--wasm", wasm, "--module", module, "--variant", args.variant,
      "--openings", String(openings), "--warmups", String(warmups),
      "--worker", String(scenario), "--worker-run", kind,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout);
  };
  const rows = scenarios.map((scenario, index) => {
    const { warm, ...measurements } = run(index, "warm");
    const cold = [measurements];
    // Controls are warm comparisons. Collect the cold distribution for the app workload.
    if (scenario.workload === "dictionary" && scenario.calls === 10) {
      for (let sample = 1; sample < coldProcesses; sample++) cold.push(run(index, "cold"));
    }
    const names = [
      ...labels.map(label => `common guitar ${label}`),
      ...Object.keys(savedIds).map(operation => `selected ${operation} C`),
    ];
    return {
      ...scenario,
      initializationMs: stats(cold.map(sample => sample.initializationMs)),
      coldOpeningMs: stats(cold.map(sample => sample.cold.openingMs)),
      warmOpeningMs: stats(warm.map(sample => sample.openingMs)),
      warmCallMs: Array.from({ length: scenario.calls }, (_, call) => ({
        name: names[call % names.length],
        ...stats(warm.map(sample => sample.callMs[call])),
      })),
      peakRssKiB: Math.max(...cold.map(sample => sample.peakRssKiB)),
      warmProcessPeakRssKiB: measurements.peakRssKiB,
    };
  });
  const fingerprint = path => {
    const bytes = readFileSync(path);
    return { file: basename(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  console.log(JSON.stringify({
    variant: args.variant,
    environment: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model, node: process.version },
    artifacts: [fingerprint(module), fingerprint(wasm)],
    openings, warmups, coldProcesses, rows,
  }, null, 2));
}
