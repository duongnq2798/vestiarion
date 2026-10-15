import { extensionPreflight } from "@/lib/extension/http";
import { guardOAuthRequest, oauthError, oauthJson, readOAuthParams } from "@/lib/extension/oauth-http";
import { EXTENSION_AUDIENCE, parseScopes } from "@/lib/extension/settings";
import { CaptureNotSetUpError, exchangeAuthorizationCode, refreshExtensionTokens, type TokenOutcome } from "@/lib/extension/tokens";

export const dynamic = "force-dynamic";

/**
 * The Chrome extension's token endpoint (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C14, C15):
 * `authorization_code` with PKCE, or `refresh_token`. Tokens have the audience `vestiarion-chrome` and the draft
 * scopes only; asking for any other is refused. Every answer is `no-store`.
 */
export function OPTIONS(request: Request) {
  return extensionPreflight(request, "POST");
}

export async function POST(request: Request) {
  const guard = guardOAuthRequest(request);
  if ("denied" in guard) return guard.denied;
  const params = await readOAuthParams(request);
  if (!params) return oauthError(request, 400, "invalid_request", "Send the parameters as a form or a JSON object of at most 8 KB.");

  const clientId = params.client_id;
  if (!clientId || !guard.settings.ids.includes(clientId)) return oauthError(request, 401, "invalid_client", "This extension may not connect to Vestiarion.");
  // The audience, as RFC 8707's `resource` or as `audience`: only the extension's own.
  for (const target of [params.resource, params.audience]) {
    if (target !== undefined && target !== EXTENSION_AUDIENCE) {
      return oauthError(request, 400, "invalid_target", `Tokens are only issued for ${EXTENSION_AUDIENCE}.`);
    }
  }
  if (params.scope !== undefined && parseScopes(params.scope) === null) {
    return oauthError(request, 400, "invalid_scope", "Only invoice_draft:create and invoice_draft:read can be granted.");
  }

  let outcome: TokenOutcome;
  try {
    if (params.grant_type === "authorization_code") {
      if (!params.code || !params.code_verifier || !params.redirect_uri) {
        return oauthError(request, 400, "invalid_request", "code, code_verifier and redirect_uri are required.");
      }
      outcome = await exchangeAuthorizationCode({ code: params.code, verifier: params.code_verifier, clientId, redirectUri: params.redirect_uri });
    } else if (params.grant_type === "refresh_token") {
      if (!params.refresh_token) return oauthError(request, 400, "invalid_request", "refresh_token is required.");
      outcome = await refreshExtensionTokens({ refreshToken: params.refresh_token, clientId });
    } else {
      return oauthError(request, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
    }
  } catch (error) {
    if (error instanceof CaptureNotSetUpError) return oauthError(request, 503, "temporarily_unavailable", error.message);
    console.error("[extension] token request failed", error instanceof Error ? error.message : "unknown error");
    return oauthError(request, 500, "server_error", "The request could not be completed. Try again in a moment.");
  }
  if (!outcome.ok) return oauthError(request, 400, outcome.error, outcome.description);
  return oauthJson(request, outcome.tokens);
}
