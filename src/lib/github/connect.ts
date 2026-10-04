import crypto from "node:crypto";
import { membershipFor } from "../auth/membership";
import { isValidSlug } from "../auth/org-paths";
import { can } from "../auth/roles";
import { getSessionUser } from "../auth/session";
import { platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { exchangeUserCode, userInstallations } from "./app";
import { saveInstallation } from "./installs";
import { githubCallbackUri, type GitHubAppSettings } from "./settings";
import { installState, newNonce, readInstallState } from "./state";

/**
 * Connecting a workspace to GitHub (docs/superpowers/specs/2026-10-04-github-app-design.md G2).
 *
 * Starting: an owner or admin, signed in, is sent to install the app, with a signed state naming the workspace, the
 * person and a nonce also kept in an HttpOnly cookie in their browser. Finishing: the state must be Vestiarion's, at
 * most ten minutes old, carry the browser's own nonce, and name the person signed in now, whose role is read again.
 * Only then is GitHub's code exchanged for that person's own token, and the installation counts only if GitHub lists it
 * among the ones they can reach: GitHub's advice is never to trust `installation_id` alone. The token is used for that
 * check and kept nowhere. Every way back lands on Settings with the outcome in `?github=`.
 */

export const GITHUB_COOKIE = "vx_github_install";

export interface ConnectDeps {
  settings: GitHubAppSettings;
  origin: string;
  fetchImpl?: typeof fetch;
  keys?: MasterKey[];
  now?: () => number;
}

const settingsUrl = (origin: string, slug: string, outcome: string) => `${origin}/o/${slug}/settings?github=${outcome}#github`;

function redirect(url: string, cookie?: string): Response {
  return new Response(null, { status: 302, headers: { location: url, ...(cookie ? { "set-cookie": cookie } : {}) } });
}

function cookie(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GITHUB_COOKIE}=${value}; Path=/api/github; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
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

const EXPIRED = "This GitHub connection link has expired or was not started from this browser. Start again from Settings in Vestiarion.";
const expired = () => new Response(EXPIRED, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function startConnect(request: Request, deps: ConnectDeps): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("org") ?? "";
  if (!isValidSlug(slug)) return Response.json({ error: "not_found" }, { status: 404 });
  const user = await getSessionUser();
  // Settings asks a signed-out person to sign in, and shows the button only to someone who may press it.
  if (!user) return redirect(`${deps.origin}/o/${slug}/settings`);
  const membership = await membershipFor(user.id, slug);
  if (!membership || !can(membership.role, "integrations.manage")) return redirect(settingsUrl(deps.origin, slug, "forbidden"));

  const nonce = newNonce();
  const state = installState({ org: membership.orgId, user: user.id, nonce }, deps.keys ?? masterKeysFromEnv(), deps.now?.());
  const url = new URL(`https://github.com/apps/${deps.settings.slug}/installations/new`);
  url.searchParams.set("state", state);
  return redirect(url.toString(), cookie(nonce, 600));
}

export async function finishConnect(request: Request, deps: ConnectDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const keys = deps.keys ?? masterKeysFromEnv();
  const state = readInstallState(params.get("state") ?? "", keys, deps.now?.());
  const nonce = cookieValue(request.headers.get("cookie"), GITHUB_COOKIE);
  if (!state || !nonce || !sameNonce(nonce, state.nonce)) return expired();
  const org = await platformDb().from("orgs").select("slug").eq("id", state.org).maybeSingle<{ slug: string }>();
  if (org.error) throw new Error(org.error.message);
  const slug = org.data?.slug;
  if (!slug) return expired();

  // The state is used: whatever happens next, its cookie goes.
  const spent = cookie("", 0);
  const back = (outcome: string) => redirect(settingsUrl(deps.origin, slug, outcome), spent);
  const user = await getSessionUser();
  if (!user || user.id !== state.user) return back("forbidden");
  const membership = await membershipFor(user.id, slug);
  if (!membership || membership.orgId !== state.org || !can(membership.role, "integrations.manage")) return back("forbidden");

  // A member of an organization who may not install apps there asks its owners instead: nothing is installed yet.
  if (params.get("setup_action") === "request") return back("requested");
  const code = params.get("code");
  const installationId = Number(params.get("installation_id"));
  if (!code || !Number.isSafeInteger(installationId) || installationId <= 0) return back("cancelled");

  try {
    const token = await exchangeUserCode(deps.settings, code, githubCallbackUri(deps.origin), { fetchImpl: deps.fetchImpl });
    if (!token) return back("failed");
    const installation = (await userInstallations(token, { fetchImpl: deps.fetchImpl })).find((candidate) => candidate.id === installationId);
    if (!installation) return back("not_yours");
    await withOrg(state.org, () => saveInstallation({ orgId: state.org, connectedBy: user.id, installation }), { userId: user.id });
  } catch (error) {
    // The message names GitHub's status and the call, never a token.
    console.error("github: connecting failed", error instanceof Error ? error.message : "unknown error");
    return back("failed");
  }
  return back("connected");
}
