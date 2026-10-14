import crypto from "node:crypto";
import { NotSetUpError, type ExternalMatch } from "../connectors/connections";
import type { MasterKey } from "../secrets";
import { apiCall, failureOf, type PipedriveHttp } from "./http";
import { idOf, mapList } from "./map";
import { pipedriveWebhookUrl } from "./settings";

/**
 * Pipedrive's webhooks and its uninstall notice (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P7):
 * they only nudge. An event is authenticated by the HTTP Basic auth Vestiarion set when it registered the webhook (the
 * company's id, and a password derived from the master key for this purpose alone, never stored), compared in constant
 * time before the body is read; the body is never trusted, not its deal, not its amounts. An authenticated event starts
 * one sync of the company's connections after the answer, which reads the deals from Pipedrive itself. The uninstall
 * notice is authenticated by the app's own client id and secret, and nudges the same way: the refresh then fails, and the
 * card asks for a reconnect. The sweeper still syncs every 15 minutes, so a lost or refused webhook costs that wait.
 */

const PURPOSE = "pipedrive-webhook";
const COMPANY = /^[1-9]\d{0,19}$/;
/** Pipedrive's webhook body is one event; an uninstall notice a few fields. Anything larger is refused unread. */
export const MAX_BODY_BYTES = 256_000;
/** The syncs a nudge starts stop starting after this long; the sweeper takes the rest within 15 minutes. */
export const NUDGE_BUDGET_MS = 60_000;

/** The webhook's password for a company, under one master key: an HMAC of the company id, keyed by HKDF for this purpose. */
export function webhookPassword(companyId: string, master: MasterKey): string {
  const key = Buffer.from(crypto.hkdfSync("sha256", master.key, Buffer.alloc(0), `vestiarion/${PURPOSE}/v1`, 32));
  return crypto.createHmac("sha256", key).update(`${PURPOSE}.${companyId}`, "utf8").digest("base64url");
}

/** A Basic auth header's user and password; null when it is not one. */
export function basicAuth(header: string | null): { user: string; password: string } | null {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec((header ?? "").trim());
  if (!match || match[1].length > 1024) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const same = (a: string, b: string) => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * The company a webhook's Basic auth is for, when its password is the one Vestiarion set under any master key (the
 * current one, or one before a rotation); null otherwise. Compared in constant time.
 */
export function verifyWebhookAuth(header: string | null, keys: readonly MasterKey[]): string | null {
  const given = basicAuth(header);
  if (!given || !COMPANY.test(given.user)) return null;
  let valid = false;
  for (const key of keys) if (same(given.password, webhookPassword(given.user, key))) valid = true;
  return valid ? given.user : null;
}

/** Whether an uninstall notice carries the app's own client id and secret, compared in constant time. */
export function verifyClientAuth(header: string | null, settings: { clientId: string; clientSecret: string }): boolean {
  const given = basicAuth(header);
  if (!given) return false;
  // Both compared, whatever the first answers.
  const id = same(given.user, settings.clientId);
  const secret = same(given.password, settings.clientSecret);
  return id && secret;
}

/** Whether this deployment can be reached by Pipedrive: an https origin, never a local one. */
export function reachable(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export type WebhookOutcome = "registered" | "present" | "skipped" | "refused";

/**
 * Makes sure Pipedrive has one webhook for the company's deals to this deployment (P7): one already there, for this
 * company, is kept; others of Vestiarion's to the same address are removed; none is made from a deployment Pipedrive
 * cannot reach. A refusal (a user who may not add webhooks) is said, never thrown: the sweeper reads every 15 minutes
 * anyway. A rate limit or an outage throws, as every call does.
 */
export async function ensureWebhook(input: { credential: string; companyId: string; origin: string; keys: readonly MasterKey[] }, deps: PipedriveHttp = {}): Promise<WebhookOutcome> {
  if (!reachable(input.origin) || !COMPANY.test(input.companyId) || input.keys.length === 0) return "skipped";
  const url = pipedriveWebhookUrl(input.origin);
  const now = deps.now ?? Date.now;
  const listed = await apiCall(input.credential, "/api/v1/webhooks", {}, "webhooks", deps);
  if (listed.status === 403) return "refused";
  if (!listed.ok) throw failureOf(listed, "webhooks", now());
  const hooks = mapList(await listed.json().catch(() => ({})), "webhooks").items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const hook = item as Record<string, unknown>;
    const id = idOf(hook.id);
    return id && hook.subscription_url === url ? [{ id, object: hook.event_object, user: hook.http_auth_user, active: hook.is_active !== false && hook.is_active !== 0 }] : [];
  });
  const keep = hooks.find((hook) => hook.object === "deal" && hook.user === input.companyId && hook.active);
  for (const hook of hooks) {
    if (hook === keep) continue;
    const removed = await apiCall(input.credential, `/api/v1/webhooks/${hook.id}`, { method: "DELETE" }, "webhook removal", deps);
    if (!removed.ok && removed.status !== 404 && removed.status !== 403) throw failureOf(removed, "webhook removal", now());
  }
  if (keep) return "present";
  const made = await apiCall(
    input.credential,
    "/api/v1/webhooks",
    {
      method: "POST",
      body: {
        subscription_url: url,
        event_action: "*",
        event_object: "deal",
        name: "Vestiarion",
        version: "2.0",
        http_auth_user: input.companyId,
        http_auth_password: webhookPassword(input.companyId, input.keys[0]),
      },
    },
    "webhook",
    deps
  );
  if (made.ok) return "registered";
  if (made.status === 400 || made.status === 403) return "refused";
  throw failureOf(made, "webhook", now());
}

/** A connection a notice may nudge: connected, and not waiting out a rate limit or an outage. */
export function nudgeable(match: ExternalMatch, nowMs: number): boolean {
  return match.status === "connected" && (match.nextSyncAfter === null || Date.parse(match.nextSyncAfter) <= nowMs);
}

export interface NudgeDeps {
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  /** The connections, not revoked, of these companies, in every workspace (`connectionsByExternal`). */
  findConnections: (companyIds: string[]) => Promise<ExternalMatch[]>;
  /** One sync of one connection, in its own workspace's scope. */
  nudge: (match: ExternalMatch) => Promise<unknown>;
  now?: () => number;
  budgetMs?: number;
}

const answer = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

function nudgeLater(companyId: string, deps: NudgeDeps, what: string): void {
  deps.defer(async () => {
    const now = deps.now ?? Date.now;
    const started = now();
    let matches: ExternalMatch[];
    try {
      matches = await deps.findConnections([companyId]);
    } catch (error) {
      // Before migration 0116 there is nothing to nudge; the sweeper has nothing either.
      if (!(error instanceof NotSetUpError)) console.error(`pipedrive ${what}: connections not read`, error instanceof Error ? error.message : "unknown error");
      return;
    }
    let nudged = 0;
    for (const match of matches.filter((candidate) => nudgeable(candidate, now()))) {
      if (now() - started > (deps.budgetMs ?? NUDGE_BUDGET_MS)) break;
      try {
        await deps.nudge(match);
        nudged += 1;
      } catch (error) {
        console.error(`pipedrive ${what}: a sync failed`, match.connectionId, error instanceof Error ? error.message : "unknown error");
      }
    }
    // Counts only: never a company's records.
    console.info(`pipedrive ${what}`, { connections: matches.length, nudged });
  });
}

function tooLarge(request: Request): boolean {
  const declared = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

/** `POST /api/integrations/pipedrive/webhook`: authenticated first, then a nudge; the body is never read. */
export async function handlePipedriveWebhook(request: Request, deps: NudgeDeps & { keys: readonly MasterKey[] }): Promise<Response> {
  if (tooLarge(request)) return answer({ error: "too_large" }, 413);
  const companyId = verifyWebhookAuth(request.headers.get("authorization"), deps.keys);
  if (!companyId) return answer({ error: "unauthorized" }, 401);
  nudgeLater(companyId, deps, "webhook");
  return answer({ received: true });
}

/**
 * `DELETE /api/integrations/pipedrive/callback`: Pipedrive's notice that the app was uninstalled from a company, with
 * the app's client credentials as Basic auth. Its `company_id` only says which connections to read again.
 */
export async function handlePipedriveUninstall(request: Request, deps: NudgeDeps & { settings: { clientId: string; clientSecret: string } }): Promise<Response> {
  if (tooLarge(request)) return answer({ error: "too_large" }, 413);
  if (!verifyClientAuth(request.headers.get("authorization"), deps.settings)) return answer({ error: "unauthorized" }, 401);
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return answer({ error: "too_large" }, 413);
  let companyId: string | null = null;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    companyId = idOf(body.company_id);
  } catch {
    return answer({ error: "invalid_json" }, 400);
  }
  if (!companyId) return answer({ error: "no_company" }, 400);
  nudgeLater(companyId, deps, "uninstall");
  return answer({ received: true });
}

