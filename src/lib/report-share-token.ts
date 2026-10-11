import crypto from "node:crypto";

/**
 * A shared report's link (docs/superpowers/specs/2026-10-10-shared-report-design.md S2): `vxs_` and 43 base64url
 * characters (32 random bytes). Only the SHA-256 of the secret is stored, as for a receipt link (0046); the link is
 * shown once, when it is made.
 */

const TOKEN = /^vxs_([A-Za-z0-9_-]{43})$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export function generateReportShareToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxs_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed link; null for anything else, which is never looked up. */
export function reportShareTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}
