import crypto from "node:crypto";

/**
 * The check every webhook from Resend passes before its body is read (email invoices design E3). Resend signs through
 * Svix: `svix-signature` holds one or more `v1,<base64 HMAC-SHA256>` of `<svix-id>.<svix-timestamp>.<raw body>`, keyed
 * by the secret after `whsec_` (base64), several during a secret's rotation. A timestamp more than five minutes from
 * now is refused, which bounds how long a captured request could be replayed. Pure: no I/O, no logging.
 */

export const SVIX_TOLERANCE_S = 300;

const TIMESTAMP = /^\d{1,15}$/;

export interface SvixRequest {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
}

export function verifySvix(request: SvixRequest, secret: string, nowMs: number = Date.now()): boolean {
  const { id, timestamp, signature, body } = request;
  if (!id || id.length > 200 || !timestamp || !TIMESTAMP.test(timestamp) || !signature) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > SVIX_TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest();
  return signature.split(" ").some((part) => {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") return false;
    const given = Buffer.from(part.slice(comma + 1), "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/** The three headers and the raw body, from a route's request and the body it read as text. */
export function svixRequestOf(request: Request, body: string): SvixRequest {
  return {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    body,
  };
}
