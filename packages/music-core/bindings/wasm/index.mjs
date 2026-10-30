let initialized;
let client;
let moduleUrl = new URL("../../build/artifacts/wasm/music-core.mjs", import.meta.url);
let wasmUrl;

/** Configure bundled assets before starting asynchronous initialization. */
export function configureMusicCore(url, wasm) {
  if (initialized) throw new Error("Music core initialization already started");
  moduleUrl = new URL(url, import.meta.url);
  wasmUrl = wasm ? new URL(wasm, import.meta.url).href : undefined;
}
export function initializeMusicCore() {
  initialized ??= import(/* @vite-ignore */ moduleUrl.href).then(async ({ default: create }) => {
    const engine = await create(wasmUrl ? { locateFile: path => path.endsWith(".wasm") ? wasmUrl : path } : {});
    client = createMusicCoreClient(engine);
  });
  return initialized;
}
/** Typed named-operation DTOs use the same versioned C ABI in every runtime. */
export function createMusicCoreClient(engine) {
  for (const name of ["api", "abi", "schema", "corpus"]) {
    if (engine[`_tf_music_core_${name}_version`]() !== 1) throw new Error("Incompatible music core contract");
  }
  function callJson(requestJson) {
    const bytes = new TextEncoder().encode(requestJson);
    const input = engine._malloc(bytes.length || 1);
    const output = engine._malloc(8);
    if (!input || !output) {
      if (input) engine._free(input);
      if (output) engine._free(output);
      throw new Error("Music core allocation failure");
    }
    try {
      // Allocations and the core call may grow memory: reacquire views at every access.
      engine.HEAPU8.set(bytes, input);
      engine.HEAPU32[output >>> 2] = 0;
      engine.HEAPU32[(output >>> 2) + 1] = 0;
      const status = engine._tf_music_core_call(input, bytes.length, output);
      const pointer = engine.HEAPU32[output >>> 2];
      const length = engine.HEAPU32[(output >>> 2) + 1];
      const text = pointer ? new TextDecoder("utf-8", { fatal: true }).decode(engine.HEAPU8.subarray(pointer, pointer + length)) : "";
      if (status !== 0) throw new Error(text || "Music core operation failed");
      return text;
    } finally {
      engine._tf_music_core_buffer_free(output);
      engine._free(output);
      engine._free(input);
    }
  }
  function call(request) {
    const response = JSON.parse(callJson(JSON.stringify({ apiVersion: 1, schemaVersion: 1, ...request })));
    if (response.apiVersion !== 1 || response.schemaVersion !== 1 || response.operation !== request.operation) throw new Error("Incompatible music core response");
    return response.result;
  }
  return { call, callJson };
}
/** Calls stay synchronous after initialization; this adapter contains no musical policy. */
export function callMusicCore(request) {
  if (!client) throw new Error("Music core has not initialized");
  return client.call(request);
}
export function callMusicCoreJson(requestJson) {
  if (!client) throw new Error("Music core has not initialized");
  return client.callJson(requestJson);
}
