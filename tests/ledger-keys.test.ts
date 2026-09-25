import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import {
  ledgerKeyId,
  ledgerPublicKeyFromConfig,
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
