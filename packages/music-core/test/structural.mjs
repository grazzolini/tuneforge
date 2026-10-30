import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyPolicyParity } from "./parity.mjs";
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
const inputs = "guitar C7 0 -1\nguitar Bm 0 -1\n";
const search = variant => spawnSync(root + `build/music_core_structural_${variant}`, [], { input: inputs, encoding: "utf8" });
const upstream = search("upstream"), extended = search("policy");
assert.equal(upstream.status, 0); assert.equal(extended.status, 0);
assert.equal(extended.stdout, upstream.stdout);
console.log(JSON.stringify({ policy, abi, normalization, upstreamSearchUnchanged: true }, null, 2));
