import { extensionPreflight } from "@/lib/extension/http";
import { guardOAuthRequest, oauthError, oauthJson, readOAuthParams } from "@/lib/extension/oauth-http";
import { CaptureNotSetUpError, revokeExtensionToken } from "@/lib/extension/tokens";

export const dynamic = "force-dynamic";

/**
 * The extension's Disconnect (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C17; RFC 7009): its access
 * or refresh token ends its connection at once. An unknown token answers 200 too, so the answer says nothing about
 * which tokens exist.
 */
export function OPTIONS(request: Request) {
  return extensionPreflight(request, "POST");
}

export async function POST(request: Request) {
  const guard = guardOAuthRequest(request);
  if ("denied" in guard) return guard.denied;
  const params = await readOAuthParams(request);
  if (!params || !params.token) return oauthError(request, 400, "invalid_request", "token is required.");
  const clientId = params.client_id;
  if (!clientId || !guard.settings.ids.includes(clientId)) return oauthError(request, 401, "invalid_client", "This extension may not connect to Vestiarion.");
  try {
    await revokeExtensionToken({ token: params.token, clientId });
  } catch (error) {
    if (error instanceof CaptureNotSetUpError) return oauthError(request, 503, "temporarily_unavailable", error.message);
    console.error("[extension] revoke failed", error instanceof Error ? error.message : "unknown error");
    return oauthError(request, 503, "temporarily_unavailable", "The token could not be revoked. Try again in a moment.");
  }
  return oauthJson(request, {});
}
