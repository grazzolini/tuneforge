import { describe, expect, it } from "vitest";
import type { SyncPairingPayloadSchema } from "../../lib/api";
import {
  decodePairingCode,
  encodePairingCode,
  PAIRING_CODE_PREFIX,
  pairingCodeIsExpired,
  pairingFingerprint,
} from "./syncPairingCode";

const pairingPayload: SyncPairingPayloadSchema = {
  sync_group_id: "sync_group_1",
  device_id: "device_peer_1",
  display_name: "Peer Phone",
  public_key: "public-key-peer-1",
  endpoint_hints: ["tuneforge-sync+iroh://device_peer_1"],
  protocol_version: "1",
  pairing_offer_id: "pairing_offer_1",
  pairing_secret: "pairing-secret-peer-1",
  expires_at: "2026-05-22T12:00:00.000Z",
  signature: "pairing-signature",
};

describe("sync pairing code helpers", () => {
  it("roundtrips compact pairing codes", () => {
    const encoded = encodePairingCode(pairingPayload);
    const legacyCompactCode = `${PAIRING_CODE_PREFIX}.${btoa(JSON.stringify(pairingPayload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")}`;

    expect(encoded.startsWith(`${PAIRING_CODE_PREFIX}.`)).toBe(true);
    expect(encoded).not.toContain(pairingPayload.pairing_secret);
    expect(encoded.length).toBeLessThan(legacyCompactCode.length);
    expect(decodePairingCode(encoded)).toEqual(pairingPayload);
    expect(decodePairingCode(legacyCompactCode)).toEqual(pairingPayload);
  });

  it("decodes legacy JSON payloads", () => {
    expect(decodePairingCode(JSON.stringify(pairingPayload))).toEqual(pairingPayload);
  });

  it("decodes legacy wrapped JSON payloads", () => {
    expect(decodePairingCode(JSON.stringify({ payload: pairingPayload }))).toEqual(pairingPayload);
  });

  it("rejects compact codes with an unsupported prefix", () => {
    expect(() => decodePairingCode("TFPAIR2.invalid")).toThrow("unsupported prefix");
  });

  it("rejects payloads missing required signed fields", () => {
    const missingSignature: Partial<SyncPairingPayloadSchema> = { ...pairingPayload };
    delete missingSignature.signature;

    expect(() => decodePairingCode(JSON.stringify(missingSignature))).toThrow("signature");
  });

  it("checks expiration relative to the provided time", () => {
    expect(pairingCodeIsExpired(pairingPayload, new Date("2026-05-22T11:59:59.999Z"))).toBe(false);
    expect(pairingCodeIsExpired(pairingPayload, new Date("2026-05-22T12:00:00.000Z"))).toBe(true);
  });

  it("creates stable fingerprints without using pairing secrets", () => {
    const rotatedSecretPayload: SyncPairingPayloadSchema = {
      ...pairingPayload,
      pairing_secret: "different-secret",
    };
    const fingerprint = pairingFingerprint(pairingPayload);

    expect(fingerprint).toBe("FAC0-7B9E-6D8E-FC91");
    expect(fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(pairingFingerprint(pairingPayload)).toBe(fingerprint);
    expect(pairingFingerprint(rotatedSecretPayload)).toBe(fingerprint);
    expect(pairingFingerprint({ ...pairingPayload, public_key: "different-public-key" })).not.toBe(fingerprint);
    expect(pairingFingerprint({ ...pairingPayload, device_id: "different-device-id" })).not.toBe(fingerprint);
  });

  it("falls back to device id for fingerprints when public key is missing", () => {
    expect(pairingFingerprint({ device_id: "device_peer_1" })).toBe(
      pairingFingerprint({ device_id: "device_peer_1", public_key: " " }),
    );
    expect(pairingFingerprint({})).toBe("0000-0000-0000-0000");
  });
});
