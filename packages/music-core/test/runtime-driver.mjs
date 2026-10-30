import { readFileSync } from "node:fs";
import { callMusicCoreJson, initializeMusicCore } from "../bindings/wasm/index.mjs";
await initializeMusicCore();
for (const line of readFileSync(0, "utf8").trimEnd().split("\n")) {
  const response = JSON.parse(callMusicCoreJson('{"apiVersion":1,"schemaVersion":1,' + line.trim().slice(1)), (key, value, context) =>
    typeof value === "number" && !Number.isSafeInteger(value) && /^-?[0-9]+$/.test(context.source) ? JSON.rawJSON(context.source) : value);
  console.log(JSON.stringify(response.result));
}
