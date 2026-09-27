import { safeNext } from "./routes";

/**
 * What an email sign-in link carries to /auth/confirm.
 *
 * The link used to point at <project>.supabase.co/auth/v1/verify: a random
 * third-party host in an email sent from vestiarion.xyz, which spam filters
 * read as phishing. It now points at this site with the token hash, and the
 * server verifies it with `verifyOtp` — no PKCE verifier cookie is needed, so
 * the link also works in a different browser or on another device. The
 * trade-off, accepted deliberately: the link is no longer bound to the browser
 * that requested it, as with any conventional magic link.
 */

export const CONFIRM_TYPES = ["email", "signup", "magiclink"] as const;
export type ConfirmType = (typeof CONFIRM_TYPES)[number];

export interface ConfirmParams {
  tokenHash: string;
  type: ConfirmType;
  next: string;
}

/** Token hashes are hex, optionally prefixed (e.g. `pkce_`). Anything else is not one. */
const TOKEN_HASH = /^[A-Za-z0-9_-]{8,256}$/;

export function parseConfirmParams(params: URLSearchParams): ConfirmParams | null {
  const tokenHash = params.get("token_hash")?.trim();
  const type = params.get("type");
  if (!tokenHash || !TOKEN_HASH.test(tokenHash)) return null;
  if (!type || !(CONFIRM_TYPES as readonly string[]).includes(type)) return null;
  return { tokenHash, type: type as ConfirmType, next: safeNext(params.get("next")) };
}
