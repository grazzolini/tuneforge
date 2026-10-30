import type { Operation, Request, Result } from "../typescript/contracts.js";
export function configureMusicCore(url: string | URL, wasm?: string | URL): void;
export function initializeMusicCore(): Promise<void>;
export function callMusicCore<O extends Operation>(request: Request<O> & { operation: O }): Result<O>;
export function callMusicCoreJson(requestJson: string): string;
