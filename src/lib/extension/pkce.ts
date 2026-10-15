import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Proof Key for Code Exchange, S256 only (RFC 7636; invoice capture design C12, C14). The extension keeps a random
 * verifier, sends its SHA-256 as the challenge with the authorization request, and the verifier itself with the code:
 * a code taken on its way back is worth nothing without it. `plain` is never accepted.
 */

/** A verifier: 43 to 128 unreserved characters (RFC 7636 §4.1). */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** A S256 challenge: a SHA-256 in base64url without padding, 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isVerifier(value: unknown): value is string {
  return typeof value === "string" && VERIFIER.test(value);
}

export function isChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE.test(value);
}

/** The S256 challenge of a verifier: BASE64URL(SHA256(ASCII(verifier))). */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Whether the verifier is the one the challenge was made from, compared in constant time. */
export function verifierMatches(verifier: unknown, challenge: string): boolean {
  if (!isVerifier(verifier) || !isChallenge(challenge)) return false;
  const made = Buffer.from(challengeOf(verifier));
  const expected = Buffer.from(challenge);
  return made.length === expected.length && timingSafeEqual(made, expected);
}
