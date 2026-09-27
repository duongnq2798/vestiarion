import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  parseMasterKeys,
  type MasterKey,
  type SecretEnvelope,
} from "@/lib/secrets";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "11111111-1111-4111-8111-111111111111";
const LEDGER = { orgId: ORG_A, column: "ledger_signing_key_enc" };

function masterKey(id: string): MasterKey {
  return { id, key: crypto.randomBytes(32) };
}
function entry(k: MasterKey): string {
  return `${k.id}:${k.key.toString("base64")}`;
}

describe("parseMasterKeys", () => {
  it("reads id:base64 entries in order, the first being the one that encrypts", () => {
    const v2 = masterKey("v2");
    const v1 = masterKey("v1");
    const keys = parseMasterKeys(`${entry(v2)}, ${entry(v1)}`);
    expect(keys.map((k) => k.id)).toEqual(["v2", "v1"]);
    expect(keys[0].key.equals(v2.key)).toBe(true);
  });

  it("refuses a key that does not decode to 32 bytes", () => {
    expect(() => parseMasterKeys(`v1:${crypto.randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/);
  });

  it("refuses an entry without an id", () => {
    expect(() => parseMasterKeys(crypto.randomBytes(32).toString("base64"))).toThrow(/id:base64/);
  });

  it("refuses duplicate ids", () => {
    const a = masterKey("v1");
    const b = masterKey("v1");
    expect(() => parseMasterKeys(`${entry(a)},${entry(b)}`)).toThrow(/duplicate/);
  });

  it("refuses an empty setting, naming it", () => {
    expect(() => parseMasterKeys(undefined)).toThrow(/VESTIARION_MASTER_KEYS/);
    expect(() => parseMasterKeys("  ")).toThrow(/VESTIARION_MASTER_KEYS/);
  });
});

describe("encryptSecret / decryptSecret", () => {
  const keys = [masterKey("v1")];

  it("round-trips", () => {
    const envelope = encryptSecret("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", LEDGER, keys);
    expect(envelope.k).toBe("v1");
    expect(decryptSecret(envelope, LEDGER, keys)).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  it("uses a fresh IV every time, so equal secrets never share a ciphertext", () => {
    const a = encryptSecret("same", LEDGER, keys);
    const b = encryptSecret("same", LEDGER, keys);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects a ciphertext with one byte flipped", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    const ct = Buffer.from(envelope.ct, "base64");
    ct[0] ^= 0x01;
    const tampered: SecretEnvelope = { ...envelope, ct: ct.toString("base64") };
    expect(() => decryptSecret(tampered, LEDGER, keys)).toThrow(/could not decrypt/);
  });

  it("rejects the right key id carrying the wrong key bytes", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    expect(() => decryptSecret(envelope, LEDGER, [masterKey("v1")])).toThrow(/could not decrypt/);
  });

  it("rejects a ciphertext copied into another organization's row", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    expect(() => decryptSecret(envelope, { ...LEDGER, orgId: ORG_B }, keys)).toThrow(/could not decrypt/);
  });

  it("rejects a ciphertext copied into another column", () => {
    const envelope = encryptSecret("secret", LEDGER, keys);
    expect(() => decryptSecret(envelope, { ...LEDGER, column: "circle_api_key_enc" }, keys)).toThrow(/could not decrypt/);
  });

  it("still decrypts under a retired key after rotation, and encrypts under the new one", () => {
    const old = masterKey("v1");
    const fresh = masterKey("v2");
    const before = encryptSecret("secret", LEDGER, [old]);
    const rotated = [fresh, old];

    expect(decryptSecret(before, LEDGER, rotated)).toBe("secret");
    expect(encryptSecret("secret", LEDGER, rotated).k).toBe("v2");
  });

  it("names the key id it could not find", () => {
    const envelope = encryptSecret("secret", LEDGER, [masterKey("k9")]);
    expect(() => decryptSecret(envelope, LEDGER, keys)).toThrow(/k9/);
  });
});
