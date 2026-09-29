import crypto from "node:crypto";

/**
 * Webhook signatures (docs/superpowers/specs/2026-09-29-webhooks-design.md,
 * W4). Each request carries
 *
 *   Vestiarion-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * keyed with the whole secret string, `whsec_` included. A receiver recomputes
 * the HMAC over the raw body it received, compares in constant time, and
 * rejects a timestamp more than `SIGNATURE_TOLERANCE_S` away from its clock,
 * which bounds how long a captured request can be replayed.
 *
 * Pure: no I/O, no logging. The secret never leaves these functions.
 */

export const SIGNATURE_TOLERANCE_S = 300;

const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;
const TIMESTAMP = /^\d{1,15}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** `whsec_` followed by 32 random bytes in base64url. `random` is injectable for tests. */
export function generateWebhookSecret(random: (n: number) => Buffer = crypto.randomBytes): string {
  return SECRET_PREFIX + random(SECRET_BYTES).toString("base64url");
}

function hmac(secret: string, body: string, t: number): Buffer {
  return crypto.createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest();
}

/** The `Vestiarion-Signature` header value for `body`, sent at unix second `t`. */
export function signWebhook(secret: string, body: string, t: number): string {
  if (!Number.isSafeInteger(t) || t < 0) {
    throw new TypeError("signWebhook: the timestamp must be a non-negative whole number of seconds");
  }
  return `t=${t},v1=${hmac(secret, body, t).toString("hex")}`;
}

/**
 * True when `header` carries a timestamp within `toleranceS` of `nowS` and a
 * `v1` signature of `"<t>.<body>"` under `secret`. Several `v1` values are
 * allowed (any one may match) and other schemes are ignored; anything
 * malformed is refused. Never throws.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowS: number,
  toleranceS: number = SIGNATURE_TOLERANCE_S
): boolean {
  if (typeof secret !== "string" || typeof body !== "string" || typeof header !== "string") return false;
  if (!Number.isFinite(nowS) || !Number.isFinite(toleranceS) || toleranceS < 0) return false;

  let t: number | null = null;
  const candidates: Buffer[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return false;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      if (t !== null || !TIMESTAMP.test(value)) return false;
      t = Number(value);
    } else if (key === "v1") {
      if (!HEX_SHA256.test(value)) return false;
      candidates.push(Buffer.from(value, "hex"));
    }
  }
  if (t === null || candidates.length === 0) return false;
  if (Math.abs(nowS - t) > toleranceS) return false;

  const expected = hmac(secret, body, t);
  let match = false;
  for (const candidate of candidates) {
    // Every candidate is compared, so the time taken does not reveal which matched.
    if (crypto.timingSafeEqual(candidate, expected)) match = true;
  }
  return match;
}
