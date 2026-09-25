import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { ledgerPublicKeyFromConfig } from "@/lib/ledger-keys";

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
