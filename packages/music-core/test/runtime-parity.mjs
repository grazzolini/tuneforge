import { fileURLToPath } from "node:url";
import { verifyPolicyParity } from "./parity.mjs";
import { verifyNormalization } from "./normalization.mjs";
const args = process.argv.slice(2);
const driver = args.length ? args : [process.execPath, fileURLToPath(new URL("runtime-driver.mjs", import.meta.url))];
console.log(JSON.stringify({ policy: verifyPolicyParity(driver), normalization: verifyNormalization(driver) }, null, 2));
