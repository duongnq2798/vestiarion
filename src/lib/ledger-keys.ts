import crypto from "node:crypto";
import type { VestiarionConfig } from "./config";

/**
 * Resolving the key a ledger entry is *checked* against.
 *
 * Verification is arithmetic over public material, so this never needs a
 * private key, a filesystem, or the authority to create key material. Keeping
 * it that way is the point: reading the public key used to run through
 * `ensureKeypair()`, which generates a keypair and writes it under `data/`, so
 * the read-only audit page died on a read-only filesystem.
 *
 * Returning `null` means "this deployment declares no ledger key", which is a
 * different statement from "the signatures do not check out". Only the caller
 * can decide how to say that, and `verifyChain` keeps the two apart.
 */

/**
 * A short, stable name for a key, derived from the key itself.
 *
 * Taken from the public half so that a verifier holding only that half computes
 * the same id as the signer holding the private one. No registry has to agree
 * on anything: the id travels with the key material.
 */
export function ledgerKeyId(key: crypto.KeyObject): string {
  const publicKey = key.type === "private" ? crypto.createPublicKey(key) : key;
  const spki = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spki).digest("hex").slice(0, 16);
}

/** Dashboard env vars carry a PEM's newlines escaped about as often as not. */
function readablePem(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

function isPrivatePem(pem: string): boolean {
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(pem);
}

export function ledgerPublicKeyFromConfig(config: VestiarionConfig): crypto.KeyObject | null {
  // A host that can sign is the authority on which key signs. `ledgerPublicKey`
  // exists for verify-only hosts, so a stale one must never relabel what this
  // process is actually writing into the chain.
  if (config.ledgerSigningKey) {
    try {
      return crypto.createPublicKey(crypto.createPrivateKey(readablePem(config.ledgerSigningKey)));
    } catch (err) {
      throw new Error(`LEDGER_SIGNING_KEY is not a readable private key: ${(err as Error).message}`);
    }
  }

  if (config.ledgerPublicKey) {
    const pem = readablePem(config.ledgerPublicKey);
    // `createPublicKey` accepts a private PEM and quietly derives from it, so a
    // secret pasted into the public setting would be accepted without a word.
    if (isPrivatePem(pem)) {
      throw new Error("LEDGER_PUBLIC_KEY holds a private key; it takes the public half only");
    }
    try {
      return crypto.createPublicKey(pem);
    } catch (err) {
      throw new Error(`LEDGER_PUBLIC_KEY is not a readable public key: ${(err as Error).message}`);
    }
  }

  return null;
}

/**
 * The private key this deployment signs with, straight from configuration and
 * held only in memory.
 *
 * The old path wrote a configured key to disk before using it, which is why the
 * environment variable could not help the serverless case it was added for.
 */
export function ledgerSigningKeyFromConfig(config: VestiarionConfig): crypto.KeyObject | null {
  if (!config.ledgerSigningKey) return null;
  try {
    return crypto.createPrivateKey(readablePem(config.ledgerSigningKey));
  } catch (err) {
    throw new Error(`LEDGER_SIGNING_KEY is not a readable private key: ${(err as Error).message}`);
  }
}

/**
 * Where a development checkout keeps its throwaway key. Injected so the policy
 * below can be decided without a filesystem — and so a test can assert which
 * calls it does *not* make.
 */
export interface LocalLedgerKeyStore {
  read(): crypto.KeyObject | null;
  create(): crypto.KeyObject;
}

/** Signing has no fallback: either a key is available or nothing may be appended. */
export class LedgerSigningKeyError extends Error {}

/**
 * Which key signs, in one place.
 *
 * Configuration wins outright, and the local store is not consulted at all when
 * it does. That ordering is the fix for the defect this replaces:
 * `ensureKeypair()` returned early whenever key files already existed, so a
 * configured key was silently ignored on any host that had run once — including
 * the single-tenant case of setting the variable after a first local run.
 */
export function ledgerSigningKey(
  config: VestiarionConfig,
  local: LocalLedgerKeyStore
): crypto.KeyObject {
  const configured = ledgerSigningKeyFromConfig(config);
  if (configured) return configured;

  const existing = local.read();
  if (existing) return existing;

  if (!config.allowGeneratedLedgerKey) {
    throw new LedgerSigningKeyError(
      "This deployment has no ledger signing key and may not generate one. Set LEDGER_SIGNING_KEY " +
        "to a PKCS8 Ed25519 PEM — the same key that signed the existing entries, or the chain " +
        "stops verifying from here on. A key invented now would sign entries nobody could check " +
        "afterwards and would be lost when this instance is replaced."
    );
  }

  return local.create();
}
