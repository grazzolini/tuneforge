import assert from "node:assert/strict";
import create from "../build/artifacts/wasm/music-core.mjs";
import { createMusicCoreClient } from "../bindings/wasm/index.mjs";
const engine = await create();
const client = createMusicCoreClient(engine);
const request = { operation: "formatPitchClass", input: 1 };
assert.equal(client.call(request), "C#");
const before = engine.HEAPU8.buffer;
const allocation = engine._malloc(before.byteLength + 65536);
assert.ok(allocation);
assert.notEqual(engine.HEAPU8.buffer, before, "Allocation did not exercise memory growth");
assert.equal(client.call(request), "C#", "Binding retained a detached heap view");
engine._free(allocation);
assert.equal(engine._malloc(0xfffffff0), 0, "Oversized allocation must return null, not abort");
for (const input of ["{", '{"apiVersion":1,"schemaVersion":1,"operation":"normalizeNoteName","input":"\\uD800"}', '{"apiVersion":2,"schemaVersion":1,"operation":"constants"}']) {
  assert.throws(() => client.callJson(input));
}
const profile = client.call({ operation: "profiles" }).guitar;
profile.tuning[0].string = 0;
assert.throws(() => client.call({ operation: "guitar", input: "C", profile }), /invalid-music-operation/);
for (let i = 0; i < 1000; i++) assert.equal(client.call(request), "C#");
const original = engine._malloc;
let allocations = 0;
engine._malloc = size => ++allocations === 2 ? 0 : original(size);
assert.throws(() => client.call(request), /allocation failure/);
engine._malloc = original;
assert.equal(client.call(request), "C#");
console.log(JSON.stringify({ heapGrowth: true, nullMalloc: true, malformedProtocol: 3, exceptionsContained: true, repeatedCalls: 1000, adapterAllocationFailure: true }));
