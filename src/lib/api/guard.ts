import { NextResponse } from "next/server";
import { hasValidAgentBearer } from "../agent-security";
import { takeAgentCycleToken } from "../rate-limit";
import { STATUS_FOR, type ApiError, type ApiErrorCode } from "./contract";

/**
 * The single gate every `/api/v1` route passes through.
 *
 * Reads are authenticated, not public. The dashboard is server-rendered by a
 * service-role client and never exposed a table to a browser; an HTTP read API
 * would hand the same invoices, counterparties and ledger to anyone who learns
 * the URL. A treasury's records are the thing being protected, and they are no
 * less sensitive for being fetched with GET.
 *
 * `scope` is carried even though both values currently check the same token.
 * It is the seam a deployment will need in order to issue a key that can read
 * but not spend, and a call site that has already declared its intent is what
 * makes adding that a configuration change rather than an audit of every route.
 */
export type ApiScope = "read" | "write";

export function apiError(code: ApiErrorCode, message: string, headers?: HeadersInit) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status: STATUS_FOR[code], headers });
}

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export interface GuardOptions {
  scope: ApiScope;
  /** Reads are cheap; a cycle costs LLM calls and on-chain fees. */
  rateLimited?: boolean;
}

/**
 * Returns a `Response` to send back, or `null` when the request may proceed.
 *
 * Failing closed on missing configuration is deliberate: with no
 * `AGENT_API_TOKEN` set, `hasValidAgentBearer` rejects everything rather than
 * letting an unconfigured deployment serve its ledger to the internet.
 */
export function guardApiRequest(
  request: Request,
  { scope, rateLimited = false }: GuardOptions
): NextResponse | null {
  if (!hasValidAgentBearer(request.headers.get("authorization"), process.env.AGENT_API_TOKEN)) {
    // No detail about which half was wrong, and none about whether a token is
    // configured at all.
    return apiError("unauthorized", "A valid bearer token is required.");
  }

  if (rateLimited && !takeAgentCycleToken(clientIp(request))) {
    return apiError("rate_limited", "Too many requests.", { "Retry-After": "60" });
  }

  void scope;
  return null;
}

/**
 * Wraps a handler so an unexpected throw becomes a coded error instead of a
 * framework stack trace. The message is logged in full and never returned:
 * a database error can name a table, a column, or a connection string.
 */
export async function handleApiRequest<T>(
  label: string,
  handler: () => Promise<T>
): Promise<NextResponse> {
  try {
    return NextResponse.json(await handler());
  } catch (error) {
    console.error(`[api] ${label} failed`, error);
    return apiError("internal", "The request could not be completed.");
  }
}
