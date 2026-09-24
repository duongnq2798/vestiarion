import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RESET_CONFIRMATION = "RESET_DEMO_DATA";
export const AGENT_SESSION_COOKIE = "vestiarion_agent_session";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compares fixed-length digests so token length is not exposed through an
 * early string comparison. Missing configuration always fails closed.
 */
export function secureTokenMatches(candidate: string | null | undefined, expected: string | null | undefined): boolean {
  if (!candidate || !expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

export function hasValidAgentBearer(authorization: string | null, expectedToken: string | undefined): boolean {
  return secureTokenMatches(bearerToken(authorization), expectedToken);
}

/** The cookie is a keyed proof, never the operator's bearer token. */
export function agentSessionProof(token: string): string {
  return createHmac("sha256", token).update("vestiarion-agent-control-session-v1", "utf8").digest("base64url");
}

export type ResetGuardResult =
  | { allowed: true }
  | { allowed: false; status: 400 | 401 | 403; error: "Unauthorized" | "Confirmation required" | "Reset disabled" };

export function evaluateResetGuard(input: {
  authorized: boolean;
  confirmation: unknown;
  isProduction: boolean;
  allowDestructiveReset: boolean;
}): ResetGuardResult {
  if (!input.authorized) return { allowed: false, status: 401, error: "Unauthorized" };
  if (input.confirmation !== RESET_CONFIRMATION) {
    return { allowed: false, status: 400, error: "Confirmation required" };
  }
  if (input.isProduction && !input.allowDestructiveReset) {
    return { allowed: false, status: 403, error: "Reset disabled" };
  }
  return { allowed: true };
}
