import crypto from "node:crypto";
import { membershipFor } from "../auth/membership";
import { isValidSlug } from "../auth/org-paths";
import { can } from "../auth/roles";
import { getSessionUser } from "../auth/session";
import { platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { exchangeCode } from "./api";
import { saveInstall } from "./installs";
import { slackRedirectUri, type SlackSettings } from "./settings";
import { newNonce, oauthState, readOAuthState } from "./state";

/**
 * Connecting a workspace to Slack (Slack design S3). Starting: an owner or admin, signed in, is sent to Slack with the
 * app's scopes and a signed state naming the workspace, the person, and a nonce also kept in an HttpOnly cookie in
 * their browser. Finishing: the state must be Vestiarion's, at most ten minutes old, carry the browser's own nonce, and
 * name the person signed in now, whose role is read again; only then is the code exchanged and the install saved, in
 * the workspace's scope. Every way back lands on Settings with the outcome in `?slack=`.
 */

export const OAUTH_COOKIE = "vx_slack_oauth";
/** Answering /vestiarion, posting to the channel picked, and reading a file someone chooses with Add invoice (S15). */
export const SLACK_SCOPES = "commands,incoming-webhook,files:read";

export interface OAuthDeps {
  settings: SlackSettings;
  origin: string;
  fetchImpl?: typeof fetch;
  keys?: MasterKey[];
  now?: () => number;
}

const settingsUrl = (origin: string, slug: string, outcome: string) => `${origin}/o/${slug}/settings?slack=${outcome}#slack`;

function redirect(url: string, cookie?: string): Response {
  return new Response(null, { status: 302, headers: { location: url, ...(cookie ? { "set-cookie": cookie } : {}) } });
}

function cookie(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OAUTH_COOKIE}=${value}; Path=/api/slack; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function sameNonce(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const EXPIRED = "This Slack connection link has expired or was not started from this browser. Start again from Settings in Vestiarion.";

export async function startInstall(request: Request, deps: OAuthDeps): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("org") ?? "";
  if (!isValidSlug(slug)) return Response.json({ error: "not_found" }, { status: 404 });
  const user = await getSessionUser();
  // Settings asks a signed-out person to sign in, and shows the button only to someone who may press it.
  if (!user) return redirect(`${deps.origin}/o/${slug}/settings`);
  const membership = await membershipFor(user.id, slug);
  if (!membership || !can(membership.role, "integrations.manage")) return redirect(settingsUrl(deps.origin, slug, "forbidden"));

  const nonce = newNonce();
  const state = oauthState({ org: membership.orgId, user: user.id, nonce }, deps.keys ?? masterKeysFromEnv(), deps.now?.());
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", deps.settings.clientId);
  url.searchParams.set("scope", SLACK_SCOPES);
  url.searchParams.set("redirect_uri", slackRedirectUri(deps.origin));
  url.searchParams.set("state", state);
  return redirect(url.toString(), cookie(nonce, 600));
}

export async function finishInstall(request: Request, deps: OAuthDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const keys = deps.keys ?? masterKeysFromEnv();
  const state = readOAuthState(params.get("state") ?? "", keys, deps.now?.());
  const nonce = cookieValue(request.headers.get("cookie"), OAUTH_COOKIE);
  if (!state || !nonce || !sameNonce(nonce, state.nonce)) {
    return new Response(EXPIRED, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const org = await platformDb().from("orgs").select("slug").eq("id", state.org).maybeSingle<{ slug: string }>();
  if (org.error) throw new Error(org.error.message);
  const slug = org.data?.slug;
  if (!slug) return new Response(EXPIRED, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });

  // The state is used: whatever happens next, its cookie goes.
  const spent = cookie("", 0);
  const user = await getSessionUser();
  if (!user || user.id !== state.user) return redirect(settingsUrl(deps.origin, slug, "forbidden"), spent);
  const membership = await membershipFor(user.id, slug);
  if (!membership || membership.orgId !== state.org || !can(membership.role, "integrations.manage")) {
    return redirect(settingsUrl(deps.origin, slug, "forbidden"), spent);
  }
  const code = params.get("code");
  if (params.get("error") || !code) return redirect(settingsUrl(deps.origin, slug, "cancelled"), spent);

  const exchanged = await exchangeCode(deps.settings, code, slackRedirectUri(deps.origin), deps.fetchImpl);
  if (!exchanged.ok) return redirect(settingsUrl(deps.origin, slug, exchanged.reason), spent);
  const saved = await withOrg(state.org, () => saveInstall({ orgId: state.org, installedBy: user.id, grant: exchanged.grant }, keys), {
    userId: user.id,
  });
  return redirect(settingsUrl(deps.origin, slug, saved.ok ? "connected" : saved.reason), spent);
}
