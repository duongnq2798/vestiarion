import crypto from "node:crypto";

/**
 * A supplier's payment status link (docs/superpowers/specs/2026-10-18-supplier-status-design.md V1): `vxv_` and 43
 * base64url characters (32 random bytes). Only the SHA-256 of the secret is stored (0131), as for a customer's statement
 * link; the link is shown once, when it is made.
 */

const TOKEN = /^vxv_([A-Za-z0-9_-]{43})$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export function generateSupplierStatusToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxv_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed link; null for anything else, which is never looked up. */
export function supplierStatusTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}
