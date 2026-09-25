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
