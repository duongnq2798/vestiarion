import crypto from "node:crypto";

/**
 * A receipt link (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P3): `vxr_` and 43
 * base64url characters (32 random bytes). Only the SHA-256 of the secret is stored, as for payee links;
 * the link is shown once, when it is made.
 */

const TOKEN = /^vxr_([A-Za-z0-9_-]{43})$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export function generateReceiptToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxr_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed token; null for anything else, which is never looked up. */
export function receiptTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}
