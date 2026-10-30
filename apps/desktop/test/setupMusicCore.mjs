import { configureMusicCore, initializeMusicCore } from "@tuneforge/music-core";
import process from "node:process";
import { URL } from "node:url";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const module = pathToFileURL(resolve(process.cwd(), "../../packages/music-core/build/artifacts/wasm/music-core.mjs"));
const wasm = new URL("music-core.wasm", module);
configureMusicCore(module, wasm);
await initializeMusicCore();
