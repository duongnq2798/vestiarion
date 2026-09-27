import crypto from "node:crypto";

/**
 * Per-organization secrets at rest: Circle credentials and the ledger signing
 * key, encrypted under a platform master key.
 *
 * AES-256-GCM with a fresh 96-bit IV per secret. The additional authenticated
 * data binds each ciphertext to its organization and column, so a ciphertext
 * copied into another tenant's row — or into another column of the same row —
 * fails to decrypt instead of quietly decrypting to someone else's secret.
 *
 * `VESTIARION_MASTER_KEYS` lists `id:base64` entries. The first encrypts; any
 * decrypts. Rotation: prepend a new key, re-encrypt, drop the old one.
 */

export interface MasterKey {
  id: string;
  key: Buffer;
}

export interface SecretEnvelope {
  /** Id of the master key that encrypted it. */
  k: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface SecretContext {
  orgId: string;
  column: string;
}

export function parseMasterKeys(raw: string | undefined): MasterKey[] {
  if (!raw || !raw.trim()) throw new Error("VESTIARION_MASTER_KEYS is not set");
  const keys = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const separator = part.indexOf(":");
      if (separator <= 0) {
        throw new Error(`VESTIARION_MASTER_KEYS entry ${index + 1} is not id:base64`);
      }
      const id = part.slice(0, separator);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        throw new Error(`VESTIARION_MASTER_KEYS entry ${index + 1} has an invalid id`);
      }
      const key = Buffer.from(part.slice(separator + 1), "base64");
      if (key.length !== 32) {
        throw new Error(`VESTIARION_MASTER_KEYS entry ${id} must decode to 32 bytes, not ${key.length}`);
      }
      return { id, key };
    });
  const ids = new Set<string>();
  for (const { id } of keys) {
    if (ids.has(id)) throw new Error(`VESTIARION_MASTER_KEYS has a duplicate id: ${id}`);
    ids.add(id);
  }
  return keys;
}

/**
 * A platform secret, read here deliberately: it protects every organization's
 * secrets and belongs to no organization's configuration.
 */
export function masterKeysFromEnv(): MasterKey[] {
  return parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
}

function aad(context: SecretContext): Buffer {
  return Buffer.from(`${context.orgId}:${context.column}`, "utf8");
}

export function encryptSecret(plaintext: string, context: SecretContext, keys: MasterKey[]): SecretEnvelope {
  const current = keys[0];
  if (!current) throw new Error("no master key to encrypt with");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(aad(context));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    k: current.id,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptSecret(envelope: SecretEnvelope, context: SecretContext, keys: MasterKey[]): string {
  const master = keys.find((candidate) => candidate.id === envelope.k);
  if (!master) {
    throw new Error(`no master key with id ${envelope.k} for ${context.column} of organization ${context.orgId}`);
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", master.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      `could not decrypt ${context.column} of organization ${context.orgId}: wrong master key, or the ciphertext was altered or moved`
    );
  }
}
