import { NextResponse } from "next/server";
import { takeExtensionTokenRequest } from "../rate-limit";
import { clientAddress, corsHeaders, NOT_SET_UP, originRefused, readCappedText } from "./http";
import { extensionSettingsFromEnv, type ExtensionSettings } from "./settings";
import type { OAuthErrorCode } from "./tokens";

/**
 * What the token and revoke endpoints share (invoice capture design C14, C15, C17, C18, C21): their errors in OAuth's
 * own shape (`{ error, error_description }`, RFC 6749 §5.2), their parameters as a form or JSON, and their gate:
 * invoice capture set up, an allowed origin, and ten requests a minute per address.
 */

/** The largest token or revoke request read. */
const MAX_PARAMS_BYTES = 8_000;

export function oauthError(request: Request, status: number, error: OAuthErrorCode | "server_error" | "slow_down", description: string, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { ...corsHeaders(extensionSettingsFromEnv(), request), Pragma: "no-cache", ...headers } }
  );
}

export function oauthJson(request: Request, body: unknown): NextResponse {
  return NextResponse.json(body, { status: 200, headers: { ...corsHeaders(extensionSettingsFromEnv(), request), Pragma: "no-cache" } });
}

/** The gate both endpoints pass first: set up, an allowed origin, within the address's limit. */
export function guardOAuthRequest(request: Request): { denied: NextResponse } | { settings: ExtensionSettings } {
  const settings = extensionSettingsFromEnv();
  if (!settings) return { denied: oauthError(request, 503, "temporarily_unavailable", NOT_SET_UP) };
  if (originRefused(settings, request)) return { denied: oauthError(request, 403, "invalid_client", "This origin may not ask for tokens.") };
  if (!takeExtensionTokenRequest(clientAddress(request))) {
    return { denied: oauthError(request, 429, "slow_down", "Too many requests. Try again in a minute.", { "Retry-After": "60" }) };
  }
  return { settings };
}

/** The request's parameters, sent as a form (as OAuth sends them) or as a JSON object; null when neither can be read. */
export async function readOAuthParams(request: Request): Promise<Record<string, string> | null> {
  // Read no further than the limit, whether or not the request declared its length.
  const raw = await readCappedText(request, MAX_PARAMS_BYTES);
  if (raw === null) return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const params: Record<string, string> = {};
  if (type.includes("application/json")) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    for (const [key, field] of Object.entries(value)) if (typeof field === "string") params[key] = field;
    return params;
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    for (const [key, field] of new URLSearchParams(raw)) params[key] = field;
    return params;
  }
  return null;
}
