import type { SyncPairingPayloadSchema } from "../../lib/api";

export const PAIRING_CODE_PREFIX = "TFPAIR1";

const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const COMPACT_CODE_PATTERN = /^([A-Z0-9]+)\.(.*)$/;
const FINGERPRINT_VERSION = 1;
const FINGERPRINT_HEX_LENGTH = 16;
const SHA256_INITIAL_HASH = [
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
] as const;
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
] as const;

type PairingPayloadRecord = Record<string, unknown>;
type CompactPairingPayload = [
  syncGroupId: string,
  deviceId: string,
  displayName: string | null,
  publicKey: string,
  endpointHints: string[],
  protocolVersion: string,
  pairingOfferId: string,
  pairingSecret: string,
  expiresAt: string,
  signature: string,
];

export type PairingFingerprintSource = {
  device_id?: string | null;
  public_key?: string | null;
};

function asRecord(value: unknown): PairingPayloadRecord | null {
  return typeof value === "object" && value !== null ? value as PairingPayloadRecord : null;
}

function requiredPairingString(
  payloadRecord: PairingPayloadRecord,
  fieldName: keyof SyncPairingPayloadSchema,
): string {
  const value = payloadRecord[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Pairing payload is missing ${fieldName}.`);
  }
  return value;
}

function pairingEndpointHints(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((hint): hint is string => typeof hint === "string" && Boolean(hint.trim()))
  ) {
    throw new Error("Pairing payload endpoint_hints must be a list of strings.");
  }
  return value;
}

function parseJson(value: string, errorMessage: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(errorMessage);
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  if (!BASE64_URL_PATTERN.test(value)) {
    throw new Error("Pairing code payload must be base64url.");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new Error("Pairing code payload is malformed.");
  }
  const padded = normalized.padEnd(
    normalized.length + (remainder === 0 ? 0 : 4 - remainder),
    "=",
  );

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Pairing code payload is malformed.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Pairing code payload must be valid UTF-8.");
  }
}

function pairingPayloadRecord(parsed: unknown): PairingPayloadRecord {
  if (Array.isArray(parsed)) {
    return pairingPayloadRecordFromCompactArray(parsed);
  }
  const parsedRecord = asRecord(parsed);
  const pairingOfferRecord = asRecord(parsedRecord?.pairing_offer);
  const payloadRecord =
    asRecord(parsedRecord?.payload) ??
    asRecord(pairingOfferRecord?.payload) ??
    asRecord(parsedRecord?.pairing_response) ??
    parsedRecord;
  if (!payloadRecord) {
    throw new Error("Pairing payload must be a JSON object.");
  }
  return payloadRecord;
}

function pairingPayloadRecordFromCompactArray(value: unknown[]): PairingPayloadRecord {
  if (value.length !== 10) {
    throw new Error("Pairing code compact payload is malformed.");
  }
  const [
    syncGroupId,
    deviceId,
    displayName,
    publicKey,
    endpointHints,
    protocolVersion,
    pairingOfferId,
    pairingSecret,
    expiresAt,
    signature,
  ] = value;

  return {
    sync_group_id: syncGroupId,
    device_id: deviceId,
    display_name: displayName,
    public_key: publicKey,
    endpoint_hints: endpointHints,
    protocol_version: protocolVersion,
    pairing_offer_id: pairingOfferId,
    pairing_secret: pairingSecret,
    expires_at: expiresAt,
    signature,
  };
}

function validatePairingPayload(parsed: unknown): SyncPairingPayloadSchema {
  const payloadRecord = pairingPayloadRecord(parsed);
  const displayName = payloadRecord.display_name;
  if (displayName !== undefined && displayName !== null && typeof displayName !== "string") {
    throw new Error("Pairing payload display_name must be a string.");
  }
  const expiresAt = requiredPairingString(payloadRecord, "expires_at");
  if (Number.isNaN(new Date(expiresAt).getTime())) {
    throw new Error("Pairing payload expires_at must be a valid date.");
  }

  return {
    sync_group_id: requiredPairingString(payloadRecord, "sync_group_id"),
    device_id: requiredPairingString(payloadRecord, "device_id"),
    display_name: displayName ?? null,
    public_key: requiredPairingString(payloadRecord, "public_key"),
    endpoint_hints: pairingEndpointHints(payloadRecord.endpoint_hints),
    protocol_version: requiredPairingString(payloadRecord, "protocol_version"),
    pairing_offer_id: requiredPairingString(payloadRecord, "pairing_offer_id"),
    pairing_secret: requiredPairingString(payloadRecord, "pairing_secret"),
    expires_at: expiresAt,
    signature: requiredPairingString(payloadRecord, "signature"),
  };
}

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const words = new Uint32Array(64);
  const hash: number[] = [...SHA256_INITIAL_HASH];
  for (let chunkOffset = 0; chunkOffset < paddedLength; chunkOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(chunkOffset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const s1 =
        rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((part) => part.toString(16).padStart(8, "0")).join("");
}

function pairingFingerprintMaterial(payloadOrPeer: PairingFingerprintSource) {
  const publicKey = payloadOrPeer.public_key?.trim() ?? "";
  const deviceId = payloadOrPeer.device_id?.trim() ?? "";
  if (publicKey) {
    return JSON.stringify({
      version: FINGERPRINT_VERSION,
      public_key: publicKey,
      device_id: deviceId,
    });
  }
  if (deviceId) {
    return JSON.stringify({
      version: FINGERPRINT_VERSION,
      device_id: deviceId,
    });
  }
  return null;
}

export function encodePairingCode(payload: SyncPairingPayloadSchema): string {
  const compactPayload: CompactPairingPayload = [
    payload.sync_group_id,
    payload.device_id,
    payload.display_name ?? null,
    payload.public_key,
    payload.endpoint_hints ?? [],
    payload.protocol_version,
    payload.pairing_offer_id,
    payload.pairing_secret,
    payload.expires_at,
    payload.signature,
  ];
  return `${PAIRING_CODE_PREFIX}.${encodeBase64Url(JSON.stringify(compactPayload))}`;
}

export function decodePairingCode(raw: string): SyncPairingPayloadSchema {
  const trimmed = raw.trim();
  const compactMatch = COMPACT_CODE_PATTERN.exec(trimmed);
  if (compactMatch) {
    const [, prefix, encodedPayload] = compactMatch;
    if (prefix !== PAIRING_CODE_PREFIX) {
      throw new Error("Pairing code uses an unsupported prefix.");
    }
    if (!encodedPayload) {
      throw new Error("Pairing code payload is missing.");
    }
    return validatePairingPayload(
      parseJson(decodeBase64Url(encodedPayload), "Pairing code payload must be valid JSON."),
    );
  }

  return validatePairingPayload(parseJson(trimmed, "Pairing payload must be valid JSON."));
}

export function pairingFingerprint(payloadOrPeer: PairingFingerprintSource): string {
  const material = pairingFingerprintMaterial(payloadOrPeer);
  if (!material) {
    return "0000-0000-0000-0000";
  }

  const hex = sha256Hex(material).slice(0, FINGERPRINT_HEX_LENGTH).toUpperCase();
  return hex.match(/.{1,4}/g)?.join("-") ?? "0000-0000-0000-0000";
}

export function pairingCodeIsExpired(payload: SyncPairingPayloadSchema, now: Date = new Date()): boolean {
  const expiresAt = new Date(payload.expires_at).getTime();
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime();
}
