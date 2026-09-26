import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import {
  detectKeyRotation,
  ledgerKeyId,
  ledgerKeyring,
  ledgerPublicKeyFromConfig,
  ledgerReadKeys,
  ledgerSigningKey,
  ledgerSigningKeyFromConfig,
  type LocalLedgerKeyStore,
} from "@/lib/ledger-keys";

/**
 * Resolving the ledger's *public* key is a separate job from holding its
 * private one, and these tests exist because the two were tangled: reading the
 * public key ran `ensureKeypair()`, which generates a private key and writes it
 * to disk. On a read-only filesystem that threw, which is why `/audit` returned
 * 500 in production with `ENOENT: mkdir '/var/task/data'`.
 *
 * Verifying a hash chain is arithmetic over public material. Nothing here may
 * touch a filesystem or invent key material.
 */

function config(env: Record<string, string | undefined> = {}): VestiarionConfig {
  return configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://keys.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "keys-service-role",
    ...env,
  });
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * The only honest check that a resolved key is the one we meant: sign
 * something with the private half and see whether this key accepts it.
 * Comparing exported PEMs would pass even if both sides came from the same
 * wrong place.
 */
function accepts(publicKey: crypto.KeyObject, privateKey: crypto.KeyObject): boolean {
  const message = Buffer.from("ledger-key-resolution-probe");
  return crypto.verify(null, message, publicKey, crypto.sign(null, message, privateKey));
}

describe("ledgerPublicKeyFromConfig", () => {
  it("returns null when no key material is configured, instead of inventing a key", () => {
    expect(ledgerPublicKeyFromConfig(config())).toBeNull();
  });

  it("uses an explicitly configured public key", () => {
    const key = keypair();
    const resolved = ledgerPublicKeyFromConfig(config({ LEDGER_PUBLIC_KEY: key.publicPem }));

    expect(resolved).not.toBeNull();
    expect(accepts(resolved!, key.privateKey)).toBe(true);
  });

  it("derives the public half from a configured signing key", () => {
    const key = keypair();
    const resolved = ledgerPublicKeyFromConfig(config({ LEDGER_SIGNING_KEY: key.privatePem }));

    expect(resolved).not.toBeNull();
    expect(accepts(resolved!, key.privateKey)).toBe(true);
  });

  it("prefers the signing key's own identity when both are configured", () => {
    // A host that can sign is the authority on which key signs. An explicit
    // public key is for verify-only hosts that hold no signing key at all, so
    // a stale one must not silently mislabel what this process is writing.
    const signing = keypair();
    const stale = keypair();
    const resolved = ledgerPublicKeyFromConfig(
      config({ LEDGER_SIGNING_KEY: signing.privatePem, LEDGER_PUBLIC_KEY: stale.publicPem })
    );

    expect(accepts(resolved!, signing.privateKey)).toBe(true);
    expect(accepts(resolved!, stale.privateKey)).toBe(false);
  });

  it("accepts a PEM whose newlines arrived escaped, as a dashboard env var carries it", () => {
    const key = keypair();
    const resolved = ledgerPublicKeyFromConfig(
      config({ LEDGER_PUBLIC_KEY: key.publicPem.replace(/\n/g, "\\n") })
    );

    expect(resolved).not.toBeNull();
    expect(accepts(resolved!, key.privateKey)).toBe(true);
  });

  it("throws on malformed key material rather than reporting no key at all", () => {
    // Reporting null here would render as "authorship not checked", so a
    // typo'd env var would look like an unconfigured deployment forever.
    expect(() => ledgerPublicKeyFromConfig(config({ LEDGER_PUBLIC_KEY: "not a pem" }))).toThrow(
      /LEDGER_PUBLIC_KEY/
    );
  });

  it("rejects a private key handed to the public-key setting", () => {
    // Pasting the wrong half into a public setting puts a secret somewhere it
    // was never meant to be. Failing loudly is the only safe answer.
    const key = keypair();
    expect(() => ledgerPublicKeyFromConfig(config({ LEDGER_PUBLIC_KEY: key.privatePem }))).toThrow(
      /LEDGER_PUBLIC_KEY/
    );
  });
});

/**
 * A fake key store that records what the policy asked of it. The interesting
 * assertions are about what it was *not* asked: a configured key must make the
 * local store irrelevant, and a deployment forbidden to generate must never
 * reach the creating call at all.
 */
function localStore(existing: crypto.KeyObject | null) {
  const calls = { read: 0, create: 0 };
  const created = crypto.generateKeyPairSync("ed25519").privateKey;
  const store: LocalLedgerKeyStore = {
    read: () => {
      calls.read += 1;
      return existing;
    },
    create: () => {
      calls.create += 1;
      return created;
    },
  };
  return { store, calls, created };
}

function signsAs(privateKey: crypto.KeyObject, publicKey: crypto.KeyObject): boolean {
  const message = Buffer.from("ledger-signing-key-probe");
  return crypto.verify(null, message, publicKey, crypto.sign(null, message, privateKey));
}

describe("ledgerSigningKeyFromConfig", () => {
  it("returns null when no signing key is configured", () => {
    expect(ledgerSigningKeyFromConfig(config())).toBeNull();
  });

  it("returns the configured private key", () => {
    const key = keypair();
    const resolved = ledgerSigningKeyFromConfig(config({ LEDGER_SIGNING_KEY: key.privatePem }));

    expect(resolved).not.toBeNull();
    expect(signsAs(resolved!, key.publicKey)).toBe(true);
  });

  it("accepts a PEM whose newlines arrived escaped", () => {
    const key = keypair();
    const resolved = ledgerSigningKeyFromConfig(
      config({ LEDGER_SIGNING_KEY: key.privatePem.replace(/\n/g, "\n") })
    );

    expect(signsAs(resolved!, key.publicKey)).toBe(true);
  });

  it("throws on malformed key material", () => {
    expect(() => ledgerSigningKeyFromConfig(config({ LEDGER_SIGNING_KEY: "not a pem" }))).toThrow(
      /LEDGER_SIGNING_KEY/
    );
  });

  it("throws when handed a public key, which cannot sign anything", () => {
    const key = keypair();
    expect(() =>
      ledgerSigningKeyFromConfig(config({ LEDGER_SIGNING_KEY: key.publicPem }))
    ).toThrow(/LEDGER_SIGNING_KEY/);
  });
});

describe("ledgerSigningKey — which key actually signs", () => {
  it("uses the configured key and never consults local storage", () => {
    // The defect this replaces: ensureKeypair() returned early whenever key
    // files existed, so a configured LEDGER_SIGNING_KEY was silently ignored on
    // any host that had ever run once. Configuration has to win outright, and
    // reaching for the disk at all is what used to go wrong.
    const configured = keypair();
    const onDisk = crypto.generateKeyPairSync("ed25519").privateKey;
    const { store, calls } = localStore(onDisk);

    const key = ledgerSigningKey(config({ LEDGER_SIGNING_KEY: configured.privatePem }), store);

    expect(signsAs(key, configured.publicKey)).toBe(true);
    expect(calls.read).toBe(0);
    expect(calls.create).toBe(0);
  });

  it("falls back to an existing local key when nothing is configured", () => {
    const onDisk = crypto.generateKeyPairSync("ed25519");
    const { store, calls } = localStore(onDisk.privateKey);

    const key = ledgerSigningKey(config(), store);

    expect(signsAs(key, onDisk.publicKey)).toBe(true);
    expect(calls.create).toBe(0);
  });

  it("generates a key only where a generated key is allowed to exist", () => {
    const { store, calls, created } = localStore(null);

    const key = ledgerSigningKey(config({ NODE_ENV: "development" }), store);

    expect(key).toBe(created);
    expect(calls.create).toBe(1);
  });

  it("refuses to invent a key in production, naming the setting that fixes it", () => {
    // A key invented here would sign entries nobody can verify afterwards and
    // would vanish with the instance. Failing loudly is the only safe answer,
    // and the message has to say what to set.
    const { store, calls } = localStore(null);

    expect(() => ledgerSigningKey(config({ NODE_ENV: "production" }), store)).toThrow(
      /LEDGER_SIGNING_KEY/
    );
    expect(calls.create).toBe(0);
  });
});

describe("ledgerKeyId", () => {
  it("identifies a key the same way from either half", () => {
    // The id has to be derivable by a verifier that holds only the public key
    // and by a signer that holds only the private one, or the label on an entry
    // could never be matched against the key that checks it.
    const key = keypair();
    expect(ledgerKeyId(key.privateKey)).toBe(ledgerKeyId(key.publicKey));
  });

  it("gives different keys different ids", () => {
    expect(ledgerKeyId(keypair().publicKey)).not.toBe(ledgerKeyId(keypair().publicKey));
  });

  it("is 16 lowercase hex characters", () => {
    expect(ledgerKeyId(keypair().publicKey)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("ledgerKeyring", () => {
  it("is empty when no key material is configured", () => {
    expect(ledgerKeyring(config())).toEqual({ active: null, retired: [] });
  });

  it("puts the deployment's own key in the active slot", () => {
    const key = keypair();
    const ring = ledgerKeyring(config({ LEDGER_PUBLIC_KEY: key.publicPem }));

    expect(ring.active).not.toBeNull();
    expect(accepts(ring.active!, key.privateKey)).toBe(true);
    expect(ring.retired).toEqual([]);
  });

  it("reads several retired public keys from one concatenated PEM bundle", () => {
    // The same shape as a CA bundle: PEM blocks are self-delimiting, so one
    // variable can carry every key that has ever signed without inventing a
    // separator that a dashboard would then mangle.
    const active = keypair();
    const older = keypair();
    const oldest = keypair();
    const ring = ledgerKeyring(
      config({
        LEDGER_PUBLIC_KEY: active.publicPem,
        LEDGER_RETIRED_PUBLIC_KEYS: older.publicPem + oldest.publicPem,
      })
    );

    expect(ring.retired).toHaveLength(2);
    expect(accepts(ring.retired[0], older.privateKey)).toBe(true);
    expect(accepts(ring.retired[1], oldest.privateKey)).toBe(true);
  });

  it("accepts a retired bundle whose newlines arrived escaped", () => {
    const older = keypair();
    const ring = ledgerKeyring(
      config({ LEDGER_RETIRED_PUBLIC_KEYS: older.publicPem.replace(/\n/g, "\\n") })
    );

    expect(ring.retired).toHaveLength(1);
    expect(accepts(ring.retired[0], older.privateKey)).toBe(true);
  });

  it("rejects a private key in the retired bundle", () => {
    // A retired *private* key has no reason to exist anywhere near a running
    // deployment. Its presence is a mistake worth stopping on.
    const older = keypair();
    expect(() => ledgerKeyring(config({ LEDGER_RETIRED_PUBLIC_KEYS: older.privatePem }))).toThrow(
      /LEDGER_RETIRED_PUBLIC_KEYS/
    );
  });

  it("rejects a bundle containing no PEM block at all", () => {
    expect(() => ledgerKeyring(config({ LEDGER_RETIRED_PUBLIC_KEYS: "not a pem" }))).toThrow(
      /LEDGER_RETIRED_PUBLIC_KEYS/
    );
  });
});

/** The head of a ledger as rotation detection sees it: a signed body, maybe labelled. */
function signedHead(privateKey: crypto.KeyObject, label: string | null) {
  const bodyHash = crypto.createHash("sha256").update("head-body").digest("hex");
  return {
    signing_key_id: label,
    body_hash: bodyHash,
    signature: crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex"),
  };
}

describe("detectKeyRotation", () => {
  const old = keypair();
  const current = keypair();
  const ring = { active: current.publicKey, retired: [old.publicKey] };
  const oldId = ledgerKeyId(old.publicKey);
  const currentId = ledgerKeyId(current.publicKey);

  it("finds nothing to rotate from on an empty ledger", () => {
    expect(detectKeyRotation(null, ring)).toBeNull();
  });

  it("finds no rotation when the head already carries the active key", () => {
    expect(detectKeyRotation(signedHead(current.privateKey, currentId), ring)).toBeNull();
  });

  it("reports a rotation when the head is labelled with a retired key", () => {
    expect(detectKeyRotation(signedHead(old.privateKey, oldId), ring)).toEqual({ from: oldId, to: currentId });
  });

  it("recognises an unlabelled head signed by a retired key", () => {
    // Every pre-identity row is unlabelled, so the first rotation after the
    // migration has to be found by trying signatures, not by reading a label.
    expect(detectKeyRotation(signedHead(old.privateKey, null), ring)).toEqual({ from: oldId, to: currentId });
  });

  it("finds no rotation for an unlabelled head signed by the active key", () => {
    expect(detectKeyRotation(signedHead(current.privateKey, null), ring)).toBeNull();
  });

  it("does not attest a rotation from a key it does not know", () => {
    // A head signed by a key outside the keyring is not something this
    // deployment can vouch about. Verification will say so; rotation must not
    // write an entry claiming a lineage it cannot check.
    const stranger = keypair();
    expect(detectKeyRotation(signedHead(stranger.privateKey, ledgerKeyId(stranger.publicKey)), ring)).toBeNull();
    expect(detectKeyRotation(signedHead(stranger.privateKey, null), ring)).toBeNull();
  });

  it("reports nothing when there is no active key to rotate to", () => {
    expect(detectKeyRotation(signedHead(old.privateKey, oldId), { active: null, retired: [old.publicKey] })).toBeNull();
  });
});

describe("ledgerReadKeys — the read path never throws over a bad key", () => {
  // Observed on production 2026-09-26: a signing key pasted with its newlines
  // lost took /audit down with a 500, although a perfectly good LEDGER_PUBLIC_KEY
  // was configured beside it. Reading needs no secret; a broken secret must
  // be reported, not fatal.

  it("falls back to the public key when the signing key is unreadable, and says so", () => {
    const good = keypair();
    const keys = ledgerReadKeys(config({ LEDGER_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----", LEDGER_PUBLIC_KEY: good.publicPem }));

    expect(keys.active).not.toBeNull();
    expect(accepts(keys.active!, good.privateKey)).toBe(true);
    expect(keys.warnings).toHaveLength(1);
    expect(keys.warnings[0]).toMatch(/LEDGER_SIGNING_KEY/);
  });

  it("reports an unreadable signing key even when nothing else is configured", () => {
    const keys = ledgerReadKeys(config({ LEDGER_SIGNING_KEY: "not a pem" }));

    expect(keys.active).toBeNull();
    expect(keys.warnings.join(" ")).toMatch(/LEDGER_SIGNING_KEY/);
  });

  it("reports an unreadable public key instead of throwing", () => {
    const keys = ledgerReadKeys(config({ LEDGER_PUBLIC_KEY: "not a pem" }));

    expect(keys.active).toBeNull();
    expect(keys.warnings.join(" ")).toMatch(/LEDGER_PUBLIC_KEY/);
  });

  it("drops an unreadable retired bundle with a warning and keeps the active key", () => {
    const good = keypair();
    const keys = ledgerReadKeys(config({ LEDGER_PUBLIC_KEY: good.publicPem, LEDGER_RETIRED_PUBLIC_KEYS: "garbage" }));

    expect(accepts(keys.active!, good.privateKey)).toBe(true);
    expect(keys.retired).toEqual([]);
    expect(keys.warnings.join(" ")).toMatch(/LEDGER_RETIRED_PUBLIC_KEYS/);
  });

  it("has no warnings when everything reads", () => {
    const active = keypair();
    const old = keypair();
    const keys = ledgerReadKeys(config({ LEDGER_SIGNING_KEY: active.privatePem, LEDGER_RETIRED_PUBLIC_KEYS: old.publicPem }));

    expect(keys.warnings).toEqual([]);
    expect(accepts(keys.active!, active.privateKey)).toBe(true);
    expect(keys.retired).toHaveLength(1);
  });
});
