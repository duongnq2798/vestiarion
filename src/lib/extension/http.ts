import { after, NextResponse } from "next/server";
import { can } from "../auth/roles";
import { memberActor, type Actor } from "../commands/actor";
import { withOrg } from "../dal/scope";
import { takeExtensionApiToken } from "../rate-limit";
import { allowedOrigin, EXTENSION_AUDIENCE, extensionSettingsFromEnv, type ExtensionScope, type ExtensionSettings } from "./settings";
import { authenticateExtensionToken, CaptureNotSetUpError, touchConnection, type ExtensionPrincipal } from "./tokens";

/**
 * The gate and the answers of every `/api/extension/v1` route (invoice capture design C16-C22). Not the public API:
 * no API key reaches it, and no extension token reaches `/api/v1`. CORS answers only the origins of the extensions in
 * `CHROME_EXTENSION_IDS`; a request from any other browser origin is refused, and one without an origin is judged by
 * its token alone. Every answer is `Cache-Control: no-store`.
 */

export type ExtensionErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "not_editable"
  | "unreadable"
  | "payload_too_large"
  | "length_required"
  | "unsupported_media_type"
  | "rate_limited"
  | "not_set_up"
  | "internal";

const STATUS: Record<ExtensionErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  not_editable: 409,
  unreadable: 422,
  payload_too_large: 413,
  length_required: 411,
  unsupported_media_type: 415,
  rate_limited: 429,
  not_set_up: 503,
  internal: 500,
};

export const NOT_SET_UP = "Invoice capture is not set up on this deployment yet.";
export const INTERNAL = "The request could not be completed. Try again in a moment.";

/** The headers every answer carries, with the CORS headers when the origin is an allowed extension's (C21). */
export function corsHeaders(settings: ExtensionSettings | null, request: Request): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin" };
  const origin = request.headers.get("origin");
  if (settings && origin && allowedOrigin(settings, origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Expose-Headers"] = "Idempotent-Replayed, Retry-After, WWW-Authenticate";
  }
  return headers;
}

/** A browser page that is not an allowed extension: refused before anything is read (C21). */
export function originRefused(settings: ExtensionSettings, request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && !allowedOrigin(settings, origin);
}

export function extensionJson(request: Request, body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): NextResponse {
  return NextResponse.json(body, { status: init.status ?? 200, headers: { ...corsHeaders(extensionSettingsFromEnv(), request), ...init.headers } });
}

export function extensionError(request: Request, code: ExtensionErrorCode, message: string, headers: Record<string, string> = {}): NextResponse {
  return extensionJson(request, { error: { code, message } }, { status: STATUS[code], headers });
}

/** The answer to a preflight (C21): the methods and headers an allowed extension may send; 403 to any other origin. */
export function extensionPreflight(request: Request, methods: string): Response {
  const settings = extensionSettingsFromEnv();
  const origin = request.headers.get("origin");
  if (!settings || !origin || !allowedOrigin(settings, origin)) {
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store", Vary: "Origin" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(settings, request),
      "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
      "Access-Control-Max-Age": "600",
    },
  });
}

/**
 * The gate of every draft route (C16, C18, C21, C22): invoice capture set up, an allowed origin, an access token of
 * an allowed extension with the extension's audience and the scope the route needs, within the connection's limit,
 * for a person who is still a member and may still add bills, read now on the `chrome` surface. A missing, unknown,
 * expired or revoked token answers the same 401.
 */
export async function guardExtensionRequest(request: Request, scope: ExtensionScope): Promise<{ denied: NextResponse } | { principal: ExtensionPrincipal; actor: Actor }> {
  const settings = extensionSettingsFromEnv();
  if (!settings) return { denied: extensionError(request, "not_set_up", NOT_SET_UP) };
  if (originRefused(settings, request)) return { denied: extensionError(request, "forbidden", "This origin may not call the extension API.") };

  let principal: ExtensionPrincipal | null;
  try {
    principal = await authenticateExtensionToken(request.headers.get("authorization"));
  } catch (error) {
    if (error instanceof CaptureNotSetUpError) return { denied: extensionError(request, "not_set_up", NOT_SET_UP) };
    console.error("[extension] token authentication failed", error instanceof Error ? error.message : "unknown error");
    return { denied: extensionError(request, "internal", INTERNAL) };
  }
  const unauthorized = () =>
    extensionError(request, "unauthorized", "Connect the extension to Vestiarion again.", { "WWW-Authenticate": 'Bearer realm="vestiarion-chrome", error="invalid_token"' });
  if (!principal || !settings.ids.includes(principal.clientId)) return { denied: unauthorized() };
  if (principal.audience !== EXTENSION_AUDIENCE || !principal.scopes.includes(scope)) {
    return {
      denied: extensionError(request, "forbidden", "This connection cannot do that.", {
        "WWW-Authenticate": `Bearer realm="vestiarion-chrome", error="insufficient_scope", scope="${scope}"`,
      }),
    };
  }
  if (!takeExtensionApiToken(principal.connectionId)) {
    return { denied: extensionError(request, "rate_limited", "Too many requests from this connection. Try again in a minute.", { "Retry-After": "60" }) };
  }

  let actor: Actor | null;
  try {
    actor = await memberActor(principal.orgId, principal.userId, { kind: "chrome", connectionId: principal.connectionId });
  } catch (error) {
    console.error("[extension] the connection's member could not be read", error instanceof Error ? error.message : "unknown error");
    return { denied: extensionError(request, "internal", INTERNAL) };
  }
  if (!actor) return { denied: unauthorized() };
  if (!can(actor.role, "records.write")) {
    return { denied: extensionError(request, "forbidden", "You can no longer add bills in this workspace. Ask an owner or admin.") };
  }

  const touched = principal;
  try {
    after(() => touchConnection(touched));
  } catch {
    // `after` throws where this runtime has no `waitUntil`; record it now instead. `touchConnection` never throws.
    void touchConnection(touched);
  }
  return { principal, actor };
}

/**
 * Runs a route inside the connection's workspace, as its person. Before migration 0121 a draft read or write throws
 * `CaptureNotSetUpError`, answered 503; anything else unexpected is logged by its label and answered 500, its message
 * never returned.
 */
export async function inExtensionScope(request: Request, principal: ExtensionPrincipal, label: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await withOrg(principal.orgId, handler, { userId: principal.userId });
  } catch (error) {
    if (error instanceof CaptureNotSetUpError) return extensionError(request, "not_set_up", NOT_SET_UP);
    console.error(`[extension] ${label} failed`, error instanceof Error ? error.message : "unknown error");
    return extensionError(request, "internal", INTERNAL);
  }
}

/** The client's address, for limits that are not per connection. */
export function clientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * A JSON object body of at most `maxBytes` (C20): too large is 413 before it is parsed; another content type, 415;
 * anything but one object, 400.
 */
export async function readExtensionJson(request: Request, maxBytes: number): Promise<{ value: Record<string, unknown> } | { denied: NextResponse }> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return { denied: extensionError(request, "unsupported_media_type", "Send the body as JSON.") };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  const tooLarge = () => extensionError(request, "payload_too_large", `The body is larger than ${Math.round(maxBytes / 1000)} KB.`);
  if (Number.isFinite(declared) && declared > maxBytes) return { denied: tooLarge() };
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return { denied: tooLarge() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { denied: extensionError(request, "invalid_request", "The body must be JSON.") };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { denied: extensionError(request, "invalid_request", "The body must be a JSON object.") };
  }
  return { value: value as Record<string, unknown> };
}
