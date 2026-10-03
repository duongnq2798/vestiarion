import { after, NextResponse } from "next/server";
import { withOrg } from "../dal/scope";
import { authenticateApiKey, touchApiKeyUsed, type ApiKeyScope, type AuthenticatedKey } from "../platform/api-keys";
import { takeAgentCycleToken, takeApiWriteToken } from "../rate-limit";
import { STATUS_FOR, type ApiError, type ApiErrorCode } from "./contract";

/**
 * The single gate every `/api/v1` route passes through.
 *
 * Reads are authenticated, not public. The dashboard is server-rendered and
 * never exposed a table to a browser; an HTTP read API would hand the same
 * invoices, counterparties and ledger to anyone who learns the URL. A
 * treasury's records are the thing being protected, and they are no less
 * sensitive for being fetched with GET.
 *
 * A request authenticates with a workspace API key
 * (docs/superpowers/specs/2026-09-29-api-keys-design.md), and is served that
 * workspace's data and no other. Each route declares the scope it needs, so
 * issuing a key for more than `read` later is a change to the key, not an
 * audit of every route.
 */
export type ApiScope = ApiKeyScope;

export function apiError(code: ApiErrorCode, message: string, headers?: HeadersInit) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status: STATUS_FOR[code], headers });
}

const INTERNAL_MESSAGE = "The request could not be completed.";

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export interface GuardOptions {
  scope: ApiScope;
  /**
   * Reads are cheap; a cycle costs LLM calls and on-chain fees.
   *
   * No `/api/v1` route sets this today. `takeAgentCycleToken` (`../rate-limit`)
   * keys its bucket by IP, and this call passes the same `clientIp(request)`
   * key that `/api/agent/tick` does — the two endpoints would share one
   * bucket. Re-key it per API key before any v1 route turns this on, or one
   * caller's reads would spend another caller's cycle-endpoint budget.
   */
  rateLimited?: boolean;
}

/**
 * Either the response to send back, or the key the request authenticated
 * with, whose workspace `handleApiRequest` then enters.
 *
 * A missing, malformed, unknown or revoked key answers the same 401, with
 * no detail about which (spec §6). A database error while looking the key up
 * is not a verdict on the key, so it answers 500 rather than 401 — telling a
 * caller holding a valid key that it is invalid would have it discard the key.
 *
 * The key's last use is recorded after the response is sent (`after`), so it
 * never delays one; the platform keeps the function alive for it rather than
 * freezing it mid-update. `touchApiKeyUsed` never throws.
 */
export async function guardApiRequest(
  request: Request,
  { scope, rateLimited = false }: GuardOptions
): Promise<{ denied: NextResponse } | { key: AuthenticatedKey }> {
  let key: AuthenticatedKey | null;
  try {
    key = await authenticateApiKey(request.headers.get("authorization"));
  } catch (error) {
    console.error("[api] API key authentication failed", error);
    return { denied: apiError("internal", INTERNAL_MESSAGE) };
  }
  if (!key) return { denied: apiError("unauthorized", "A valid API key is required.") };

  if (!key.scopes.includes(scope)) {
    return { denied: apiError("forbidden", "This key cannot do that.") };
  }

  // Writes are counted per key (write API R6): reads are not limited, as the docs say.
  if (scope === "write" && !takeApiWriteToken(key.keyId)) {
    return { denied: apiError("rate_limited", "Too many writes from this key. Try again in a minute.", { "Retry-After": "60" }) };
  }

  if (rateLimited && !takeAgentCycleToken(clientIp(request))) {
    return { denied: apiError("rate_limited", "Too many requests.", { "Retry-After": "60" }) };
  }

  const keyId = key.keyId;
  try {
    after(() => touchApiKeyUsed(keyId));
  } catch {
    // `after` throws when this runtime provides no `waitUntil` (Next's `after`
    // docs). Touch directly rather than lose the update; the request is still
    // served either way, since `touchApiKeyUsed` never throws.
    void touchApiKeyUsed(keyId);
  }
  return { key };
}

/**
 * Runs a handler inside the workspace of the key that called, and wraps it so
 * an unexpected throw becomes a coded error instead of a framework stack
 * trace. The message is logged in full and never returned: a database error
 * can name a table, a column, or a connection string.
 *
 * A handler that settles on a coded error inside that scope, such as a lookup
 * by id that finds nothing, returns the `apiError` response, and it is sent
 * as it is.
 */
export async function handleApiRequest<T>(
  label: string,
  key: AuthenticatedKey,
  handler: () => Promise<T | NextResponse>
): Promise<NextResponse> {
  try {
    const result = await withOrg(key.orgId, handler);
    return result instanceof NextResponse ? result : NextResponse.json(result);
  } catch (error) {
    console.error(`[api] ${label} failed`, error);
    return apiError("internal", INTERNAL_MESSAGE);
  }
}
