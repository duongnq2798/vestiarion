import crypto from "node:crypto";

/**
 * A document request's one-time link (docs/superpowers/specs/2026-10-23-document-requests-design.md ER4): `vxu_` and 32
 * random bytes, base64url. Only the SHA-256 of the secret is kept; a token is checked against its shape before any
 * lookup, and looked up by that hash alone, so no token is ever compared in code.
 */

const TOKEN = /^vxu_([A-Za-z0-9_-]{43})$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** A new link's token and the hash kept of it. */
export function generateDocumentToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; tokenHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxu_${secret}`, tokenHash: sha256hex(secret) };
}

/** The hash a token is looked up by, or null for anything that is not one. */
export function documentTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}

/** Where the vendor opens it: a public page, outside every workspace. */
export function documentRequestUrl(origin: string, token: string): string {
  return `${origin}/documents/${token}`;
}
