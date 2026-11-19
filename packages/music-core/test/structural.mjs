import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyPolicyParity, voicingDigest } from "./parity.mjs";
import { verifyNormalization } from "./normalization.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
function run(program, args) {
  const result = spawnSync(program, args, { stdio: "inherit" });
  assert.equal(result.status, 0, String(result.error ?? program));
}
run("cmake", ["-S", root, "-B", root + "build", "-DCMAKE_BUILD_TYPE=Release"]);
run("cmake", ["--build", root + "build", "--parallel", "4"]);
const policy = verifyPolicyParity(root + "build/music_core_policy_contract");
const abi = verifyPolicyParity(root + "build/music_core_abi_contract");
const normalization = verifyNormalization(root + "build/music_core_normalization_contract");
run(root + "build/music_core_abi_boundary", []);
run(root + "build/music_core_abi_header", []);
// The additive slash hook preserves upstream search/pruning/ranking for ordinary chords.
function search(variant, requests) {
  const run = spawnSync(root + `build/music_core_structural_${variant}`, [], {
    input: requests.join("\n") + "\n", encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  const results = run.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(results.length, requests.length);
  return results;
}
const order = JSON.parse(readFileSync(new URL("fixtures/voicing-order-v1.json", import.meta.url), "utf8"));
const upstream = search("upstream", order.upstreamDefaults);
const extended = search("policy", order.upstreamDefaults);
for (const [index, input] of order.upstreamDefaults.entries()) {
  assert.ok(upstream[index].shapes.length > 0, input);
  assert.deepEqual(extended[index], upstream[index], `upstream default order changed: ${input}`);
}
const policyShapes = search("policy", order.policyCandidates.map(({ input }) => input));
for (const [index, { input, count, sha256 }] of order.policyCandidates.entries()) {
  const result = policyShapes[index];
  assert.equal(result.shapes.length, count, input);
  assert.equal(voicingDigest(result), sha256, `complete guitar candidate order changed: ${input}`);
}
// Out-of-range values are unsatisfiable. In particular, shifts by ±32
// must never alias to the C pitch class.
const invalidRequirements = [-32, -1, 12, 32].map(
  pitch => `guitar-policy CM 0 -1 64 59 55 50 45 40 24 ${pitch} 4 7`,
);
const rejected = search("policy", invalidRequirements);
for (const [index, input] of invalidRequirements.entries()) {
  assert.deepEqual(rejected[index], { error: "no-guitar-candidates", exception: "invalid_argument" }, input);
}
console.log(JSON.stringify({
  policy, abi, normalization,
  upstreamSearches: order.upstreamDefaults.length, frozenCandidateSearches: order.policyCandidates.length,
  invalidRequiredPitchSearches: invalidRequirements.length,
}, null, 2));
