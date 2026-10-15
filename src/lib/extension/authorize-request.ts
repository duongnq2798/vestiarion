import { isChallenge } from "./pkce";
import { allowedClient, parseScopes, type ExtensionScope, type ExtensionSettings } from "./settings";

/**
 * Reading `/extension/authorize`'s request (invoice capture design C12). Pure. A client that is not an allowed
 * extension, or a redirect address that is not exactly its own, is refused on the page and never redirected to: a
 * code or an error sent to an address the request chose would make this page an open redirect. Anything else wrong is
 * sent back to the extension as OAuth says, with its `state`.
 */

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: ExtensionScope[];
}

export type AuthorizeCheck =
  | { kind: "bad_client" }
  | { kind: "redirect_error"; redirectTo: string }
  | { kind: "ok"; request: AuthorizeRequest };

/** The state the extension sent, as it is: printable, at most 500 characters. */
const STATE = /^[\x20-\x7e]{1,500}$/;

/** An address with these parameters added to its query. */
export function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** The first value of a query parameter. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function checkAuthorizeRequest(settings: ExtensionSettings, params: AuthorizeParams): AuthorizeCheck {
  const { client_id: clientId, redirect_uri: redirectUri } = params;
  if (!allowedClient(settings, clientId, redirectUri)) return { kind: "bad_client" };
  const state = params.state ?? "";
  const back = (error: string, description: string): AuthorizeCheck => ({
    kind: "redirect_error",
    redirectTo: redirectWith(redirectUri as string, { error, error_description: description, ...(STATE.test(state) ? { state } : {}) }),
  });
  if (params.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (!STATE.test(state)) return back("invalid_request", "A state of 1 to 500 printable characters is required.");
  if (params.code_challenge_method !== "S256" || !isChallenge(params.code_challenge)) {
    return back("invalid_request", "A PKCE code_challenge with code_challenge_method=S256 is required.");
  }
  const scopes = parseScopes(params.scope);
  if (!scopes) return back("invalid_scope", "Only invoice_draft:create and invoice_draft:read can be granted.");
  return { kind: "ok", request: { clientId: clientId as string, redirectUri: redirectUri as string, codeChallenge: params.code_challenge as string, state, scopes } };
}
