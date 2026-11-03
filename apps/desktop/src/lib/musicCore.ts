export { callMusicCore } from "@tuneforge/music-core";
import { configureMusicCore, initializeMusicCore } from "@tuneforge/music-core";
import moduleUrl from "@tuneforge/music-core/wasm-module?url";
import wasmUrl from "@tuneforge/music-core/wasm-binary?url";

export function initializeBundledMusicCore(): Promise<void> {
  configureMusicCore(new URL(moduleUrl, window.location.href), new URL(wasmUrl, window.location.href));
  return initializeMusicCore();
}
