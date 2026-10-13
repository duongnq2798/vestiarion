import dns from "node:dns";
import { z } from "zod";
import { currentConfig, currentOrgId, hasScope } from "../context";
import type { GitHubPullRequestRef } from "../github-verification";
import { pullRequestTokens } from "../github/tokens";
import { isPublicAddress, type LookupFn } from "../webhooks/safe-url";
import { checkTargetOf, NOT_CHECKED_WORDS, requestAllowed, storageHostOf, type CheckTarget } from "./allow-list";

/**
 * Whether an evidence link can be opened, checked before a page says "verified" or offers it
 * (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md E1 to E4).
 *
 * - **open**: GitHub shows the pull request or comment publicly, or in a private repository the workspace's own GitHub
 *   connection reads (its people open it there), or the workspace's storage serves the signed file.
 * - **cannot_open**: it was deleted, its repository is private and not the workspace's, access was refused, or a signed
 *   link expired; the reason is given where it is known. Never counted as verified, and never offered as a link.
 * - **not_checked**: anything not on the allow-list (`./allow-list`). No request is made for it; it is shown as typed.
 * - **no_answer**: the service did not answer just now, or its rate limit was reached. Not verified either.
 *
 * Requests go only to GitHub's API and the workspace's own Supabase storage, each address re-checked before it is sent,
 * its host resolved and refused unless every address is public, no redirect followed except to GitHub's API, five
 * seconds at most. The member's session goes nowhere: GitHub is asked with the workspace's own GitHub connection where
 * the repository is in it, else the deployment's token, and storage with the link's own signature only. A private
 * repository seen only through the deployment's token reads as not public, as a deleted one does, with the same words,
 * the same number of questions and the same time kept, and so does GitHub refusing that token: a check never says what
 * the deployment can see that the workspace cannot.
 *
 * Results are kept briefly, per workspace and link, in this server's memory: five minutes for a link that opens, two
 * for one that does not, thirty seconds for no answer. Nothing is stored, and no link with its token is logged.
 */

export type LinkAccess =
  | { state: "open" }
  | { state: "cannot_open"; reason: string }
  | { state: "not_checked"; reason: string }
  | { state: "no_answer"; reason: string };

export const LINK_WORDS = {
  notPublic: "GitHub does not show it publicly: it was deleted, or its repository is private.",
  notFoundConnected: "GitHub could not find it: it was deleted, or the workspace's GitHub connection no longer reaches its repository.",
  refused: "GitHub refused access to it.",
  expired: (at: number) => `The signed link expired on ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
  storageGone: "The file is not in storage any more: it was deleted or moved.",
  storageRefused: "Storage refused the link: it expired, or its signature is no longer valid.",
  githubSilent: "GitHub did not answer just now.",
  githubLimited: "GitHub's rate limit was reached; it is checked again in a minute.",
  storageSilent: "Storage did not answer just now.",
  redirected: "It was sent on to an address Vestiarion does not open.",
  tooMany: "Vestiarion checks at most 25 links on a page at a time.",
} as const;

export interface LinkCheckOptions {
  fetch?: typeof fetch;
  /** Resolves a host to every address it has: each must be public before anything is sent there. */
  resolve?: LookupFn;
  /** The workspace's own GitHub connection's token for a repository, where it has one (`pullRequestTokens`). */
  tokenFor?: (ref: GitHubPullRequestRef) => Promise<string | undefined>;
  /** The deployment's own GitHub token; the configured one when absent. */
  fallbackToken?: string | null;
  /** The workspace's Supabase address, whose storage's signed links are checked; the configured one when absent. */
  storageUrl?: string | null;
  now?: () => number;
  /** At most this many distinct links are checked in one call (25). */
  max?: number;
}

const TTL_MS = { open: 5 * 60_000, cannot_open: 2 * 60_000, no_answer: 30_000 } as const;
const CACHE_MAX = 500;
const TIMEOUT_MS = 5_000;
const MAX_LINKS = 25;
const GITHUB_API_VERSION = "2026-03-10";

const cache = new Map<string, { access: LinkAccess; until: number }>();
const inFlight = new Map<string, Promise<LinkAccess>>();

/** Clears what was checked: for tests, and for nothing else. */
export function forgetLinkChecks(): void {
  cache.clear();
  inFlight.clear();
}

const defaultResolve: LookupFn = async (host) => dns.promises.lookup(host, { all: true, verbatim: true });

function remember(key: string, access: LinkAccess, now: number): void {
  if (access.state === "not_checked") return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { access, until: now + TTL_MS[access.state] });
}

/** Every address the host has is public, or the request is never sent (DNS rebinding and private targets alike). */
async function hostIsPublic(url: string, resolve: LookupFn): Promise<boolean> {
  try {
    const addresses = await resolve(new URL(url).hostname);
    return addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address));
  } catch {
    return false;
  }
}

type Sent = { response: Response } | { refused: LinkAccess };

/**
 * One request to an allowed address, and at most one redirect, to GitHub's API only. The address is checked again here,
 * whatever built it, and its host resolved; credentials go to GitHub's API and nowhere else.
 */
async function send(url: string, init: { headers: Record<string, string>; storageHost: string | null }, options: Required<Pick<LinkCheckOptions, "fetch" | "resolve">>): Promise<Sent> {
  let next = url;
  for (let hop = 0; hop < 2; hop += 1) {
    if (!requestAllowed(next, { storageHost: init.storageHost })) return { refused: { state: "not_checked", reason: hop === 0 ? NOT_CHECKED_WORDS.host : LINK_WORDS.redirected } };
    if (!(await hostIsPublic(next, options.resolve))) return { refused: { state: "not_checked", reason: NOT_CHECKED_WORDS.address } };
    const toGitHub = new URL(next).hostname === "api.github.com";
    const headers = toGitHub ? init.headers : Object.fromEntries(Object.entries(init.headers).filter(([name]) => name.toLowerCase() !== "authorization"));
    const response = await options.fetch(next, { method: "GET", headers, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response };
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (!location) return { refused: { state: "not_checked", reason: LINK_WORDS.redirected } };
    try {
      next = new URL(location, next).href;
    } catch {
      return { refused: { state: "not_checked", reason: LINK_WORDS.redirected } };
    }
    // Only GitHub's API may send the check on, and only to itself (a renamed repository).
    if (!toGitHub) return { refused: { state: "not_checked", reason: LINK_WORDS.redirected } };
  }
  return { refused: { state: "not_checked", reason: LINK_WORDS.redirected } };
}

const pullSchema = z.object({ base: z.object({ repo: z.object({ private: z.boolean() }) }) });
const repoSchema = z.object({ private: z.boolean() });

async function askGitHub(
  target: Extract<CheckTarget, { kind: "github_pull" | "github_comment" }>,
  options: Required<Pick<LinkCheckOptions, "fetch" | "resolve">> & { tokenFor?: LinkCheckOptions["tokenFor"]; fallbackToken: string | null }
): Promise<LinkAccess> {
  const ref: GitHubPullRequestRef = {
    owner: target.owner,
    repo: target.repo,
    number: target.kind === "github_pull" ? target.number : 1,
    url: `https://github.com/${target.owner}/${target.repo}`,
  };
  const installation = (await options.tokenFor?.(ref).catch(() => undefined)) ?? undefined;
  const token = installation ?? options.fallbackToken ?? undefined;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "vestiarion-evidence-check" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const notFound = installation ? LINK_WORDS.notFoundConnected : LINK_WORDS.notPublic;

  const read = async (url: string): Promise<{ json: unknown } | { access: LinkAccess }> => {
    const sent = await send(url, { headers, storageHost: null }, options);
    if ("refused" in sent) return { access: sent.refused };
    const { response } = sent;
    if (response.ok) return { json: await response.json().catch(() => null) };
    await response.body?.cancel().catch(() => {});
    if (response.status === 404 || response.status === 410) return { access: { state: "cannot_open", reason: notFound } };
    if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
      return { access: { state: "no_answer", reason: LINK_WORDS.githubLimited } };
    }
    // GitHub refuses only what exists (an organization's single sign-on, a token kept out of it): to the deployment's
    // token, a refusal reads as a deleted link does, or it would say what that token alone can see.
    if (response.status === 403) return { access: { state: "cannot_open", reason: installation ? LINK_WORDS.refused : LINK_WORDS.notPublic } };
    return { access: { state: "no_answer", reason: LINK_WORDS.githubSilent } };
  };
  const silent: LinkAccess = { state: "no_answer", reason: LINK_WORDS.githubSilent };
  // A private repository the workspace's own connection reads is the workspace's: its people open it on GitHub, and a
  // merged pull request in it stays verified. One only the deployment's token reads is answered as GitHub answers the
  // public, as a deleted one is, so the check discloses nothing more.
  const hidden = (isPrivate: boolean): LinkAccess | null => (isPrivate && !installation ? { state: "cannot_open", reason: LINK_WORDS.notPublic } : null);

  if (target.kind === "github_pull") {
    const pull = await read(target.request);
    if ("access" in pull) return pull.access;
    const parsed = pullSchema.safeParse(pull.json);
    if (!parsed.success) return silent;
    return hidden(parsed.data.base.repo.private) ?? { state: "open" };
  }
  // A comment: its repository first, so one in a private repository only the deployment's token reads is answered after
  // one question, as one in a deleted repository is.
  const repository = await read(target.repository);
  if ("access" in repository) return repository.access;
  const parsed = repoSchema.safeParse(repository.json);
  if (!parsed.success) return silent;
  const notShown = hidden(parsed.data.private);
  if (notShown) return notShown;
  const comment = await read(target.request);
  return "access" in comment ? comment.access : { state: "open" };
}

async function askStorage(target: Extract<CheckTarget, { kind: "signed_storage" }>, options: Required<Pick<LinkCheckOptions, "fetch" | "resolve">>, now: number): Promise<LinkAccess> {
  if (target.expiresAt !== null && target.expiresAt <= now) return { state: "cannot_open", reason: LINK_WORDS.expired(target.expiresAt) };
  // The link's own signature is its only credential: no key of Vestiarion's, and no session, is sent with it.
  const sent = await send(target.request, { headers: { Range: "bytes=0-0" }, storageHost: target.host }, options);
  if ("refused" in sent) return sent.refused;
  const { response } = sent;
  await response.body?.cancel().catch(() => {});
  if (response.ok) return { state: "open" };
  if (response.status === 400 || response.status === 404) return { state: "cannot_open", reason: LINK_WORDS.storageGone };
  if (response.status === 401 || response.status === 403) return { state: "cannot_open", reason: LINK_WORDS.storageRefused };
  return { state: "no_answer", reason: LINK_WORDS.storageSilent };
}

/**
 * Whether each link can be opened, by its text as given. In a workspace's scope, GitHub is asked with that workspace's
 * connection and results are kept for that workspace only.
 */
export async function checkEvidenceLinks(hrefs: readonly string[], options: LinkCheckOptions = {}): Promise<Map<string, LinkAccess>> {
  const out = new Map<string, LinkAccess>();
  const unique = [...new Set(hrefs.filter((href): href is string => typeof href === "string" && href.length > 0))];
  if (unique.length === 0) return out;
  const scoped = hasScope();
  const scope = scoped ? currentOrgId() : "-";
  const config = currentConfig();
  const storageHost = storageHostOf(options.storageUrl !== undefined ? options.storageUrl : config.database.url);
  const fallbackToken = options.fallbackToken !== undefined ? options.fallbackToken : (config.githubToken ?? null);
  const now = (options.now ?? Date.now)();
  const max = options.max ?? MAX_LINKS;
  const io = { fetch: options.fetch ?? fetch, resolve: options.resolve ?? defaultResolve };
  // The workspace's own GitHub connection, looked up once, and only when a GitHub link is asked about.
  let tokens: Promise<LinkCheckOptions["tokenFor"]> | undefined;
  const tokenFor = (): Promise<LinkCheckOptions["tokenFor"]> =>
    options.tokenFor ? Promise.resolve(options.tokenFor) : scoped ? (tokens ??= workspaceTokens()) : Promise.resolve(undefined);
  let asked = 0;

  await Promise.all(
    unique.map(async (href) => {
      const decided = checkTargetOf(href, { storageHost });
      if ("notChecked" in decided) {
        out.set(href, { state: "not_checked", reason: NOT_CHECKED_WORDS[decided.notChecked] });
        return;
      }
      const key = `${scope}\u0000${decided.target.href}`;
      const held = cache.get(key);
      if (held && held.until > now) {
        out.set(href, held.access);
        return;
      }
      if (asked >= max) {
        out.set(href, { state: "not_checked", reason: LINK_WORDS.tooMany });
        return;
      }
      asked += 1;
      let pending = inFlight.get(key);
      if (!pending) {
        const target = decided.target;
        pending = (async (): Promise<LinkAccess> => {
          try {
            if (target.kind === "signed_storage") return await askStorage(target, io, now);
            return await askGitHub(target, { ...io, tokenFor: await tokenFor(), fallbackToken });
          } catch (error) {
            // The host and the error's name only: a signed link carries its token, and is never logged.
            console.error("evidence link: check failed", new URL(target.request).hostname, error instanceof Error ? error.name : "unknown");
            return { state: "no_answer", reason: target.kind === "signed_storage" ? LINK_WORDS.storageSilent : LINK_WORDS.githubSilent };
          }
        })().then((access) => {
          remember(key, access, now);
          return access;
        });
        inFlight.set(key, pending);
        void pending.finally(() => inFlight.delete(key));
      }
      out.set(href, await pending);
    })
  );
  return out;
}

/** The workspace's own GitHub connection (GitHub App design G5); none when it cannot be read. */
async function workspaceTokens(): Promise<LinkCheckOptions["tokenFor"]> {
  try {
    return await pullRequestTokens();
  } catch (error) {
    console.error("evidence link: the workspace's GitHub connection not read", error instanceof Error ? error.name : "unknown");
    return undefined;
  }
}
