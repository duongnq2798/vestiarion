import crypto from "node:crypto";
import type { GitHubPullRequestRef } from "../github-verification";
import type { GitHubAppSettings } from "./settings";

/**
 * What the GitHub App asks GitHub (docs/superpowers/specs/2026-10-04-github-app-design.md G2, G4, G5): its own JWT, an
 * installation's token, a repository's installation, a person's token and the installations they can reach, and a
 * comment on a pull request. Every call takes the fetch to use. A refusal throws a `GitHubError` that names the status
 * and never a token.
 */

const API = "https://api.github.com";
const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "vestiarion-agent",
};

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    what: string
  ) {
    super(`GitHub answered HTTP ${status} to ${what}`);
    this.name = "GitHubError";
  }
}

interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The app's JWT: RS256, issued a minute back for clock drift, good for nine minutes of GitHub's ten. */
export function appJwt(settings: GitHubAppSettings, nowMs: number = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: settings.appId }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), settings.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function call(url: string, init: RequestInit, what: string, deps: Deps, allow: number[] = []): Promise<{ status: number; body: unknown }> {
  const response = await (deps.fetchImpl ?? fetch)(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok && !allow.includes(response.status)) throw new GitHubError(response.status, what);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** A token for one installation, good for an hour; kept in memory for one run at most (G7). */
export async function installationToken(settings: GitHubAppSettings, installationId: number, deps: Deps = {}): Promise<string> {
  const { body } = await call(
    `${API}/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: { ...API_HEADERS, Authorization: `Bearer ${appJwt(settings, deps.now?.())}` } },
    "an installation token request",
    deps
  );
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || !token) throw new GitHubError(200, "an installation token request without a token");
  return token;
}

/** The installation of the app on a repository, or null when the app is not installed there. */
export async function repositoryInstallationId(settings: GitHubAppSettings, owner: string, repo: string, deps: Deps = {}): Promise<number | null> {
  const { status, body } = await call(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    { method: "GET", headers: { ...API_HEADERS, Authorization: `Bearer ${appJwt(settings, deps.now?.())}` } },
    "a repository installation lookup",
    deps,
    [404]
  );
  if (status === 404) return null;
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The person's own token for a code GitHub gave the callback, or null when GitHub refuses the code. */
export async function exchangeUserCode(settings: GitHubAppSettings, code: string, redirectUri: string, deps: Deps = {}): Promise<string | null> {
  const { body } = await call(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": API_HEADERS["User-Agent"] },
      body: JSON.stringify({ client_id: settings.clientId, client_secret: settings.clientSecret, code, redirect_uri: redirectUri }),
    },
    "a code exchange",
    deps
  );
  const token = (body as { access_token?: unknown } | null)?.access_token;
  return typeof token === "string" && token ? token : null;
}

export interface UserInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
}

/** The app's installations the person behind a user token can reach: GitHub's own answer to "is this one theirs?". */
export async function userInstallations(userToken: string, deps: Deps = {}): Promise<UserInstallation[]> {
  const { body } = await call(
    `${API}/user/installations?per_page=100`,
    { method: "GET", headers: { ...API_HEADERS, Authorization: `Bearer ${userToken}` } },
    "an installations list",
    deps
  );
  const installations = (body as { installations?: unknown } | null)?.installations;
  if (!Array.isArray(installations)) return [];
  return installations.flatMap((item: unknown) => {
    const row = item as { id?: unknown; account?: { login?: unknown; type?: unknown }; repository_selection?: unknown };
    if (typeof row.id !== "number" || typeof row.account?.login !== "string") return [];
    return [
      {
        id: row.id,
        accountLogin: row.account.login,
        accountType: typeof row.account.type === "string" ? row.account.type : "User",
        repositorySelection: row.repository_selection === "all" ? ("all" as const) : ("selected" as const),
      },
    ];
  });
}

/** A comment on a pull request, as the installation: GitHub keeps a pull request's conversation as its issue's. */
export async function createPullRequestComment(
  token: string,
  ref: GitHubPullRequestRef,
  body: string,
  deps: Deps = {}
): Promise<{ id: number; url: string }> {
  const answer = await call(
    `${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}/comments`,
    { method: "POST", headers: { ...API_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ body }) },
    "a pull request comment",
    deps
  );
  const comment = answer.body as { id?: unknown; html_url?: unknown } | null;
  if (typeof comment?.id !== "number" || typeof comment.html_url !== "string") throw new GitHubError(answer.status, "a pull request comment without its link");
  return { id: comment.id, url: comment.html_url };
}
