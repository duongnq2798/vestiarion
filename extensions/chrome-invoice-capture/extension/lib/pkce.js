/**
 * PKCE with S256 (RFC 7636): a random verifier the extension keeps, and its SHA-256 sent as the challenge when it asks
 * to connect. Vestiarion gives tokens for the one-time code only with the verifier, so a code seen on its way back is
 * worth nothing to anyone else. Web Crypto only.
 */

export function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 32 random bytes in base64url: a 43-character verifier. */
export function newVerifier() {
  return base64url(randomBytes(32));
}

/** BASE64URL(SHA256(verifier)). */
export async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The state sent with the request and checked on the way back. */
export function newState() {
  return base64url(randomBytes(16));
}

/** One capture's Idempotency-Key, kept until the capture is answered, so a retry makes no second draft. */
export function newIdempotencyKey() {
  return crypto.randomUUID();
}
