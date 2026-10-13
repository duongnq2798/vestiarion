import crypto from "node:crypto";

/**
 * A customer's statement link (docs/superpowers/specs/2026-10-13-customer-portal-design.md P2): `vxc_` and 43 base64url
 * characters (32 random bytes). Only the SHA-256 of the secret is stored (0109), as for a shared report's link; the link
 * is shown once, when it is made.
 */

const TOKEN = /^vxc_([A-Za-z0-9_-]{43})$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export function generateCustomerPortalToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxc_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed link; null for anything else, which is never looked up. */
export function customerPortalTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}
