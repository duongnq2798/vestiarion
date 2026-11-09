import crypto from "node:crypto";
import { cappedText, ISSUE_ID, JIRA_API_HOST, UUID } from "./http";
import { JIRA_EVENTS, type JiraEvent } from "./webhooks";

/**
 * Jira's webhook deliveries (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR15), at
 * `/api/integrations/jira/webhook`: one address for every connection's webhook, on every site.
 *
 * - **Checked first.** A delivery carries `Authorization: Bearer <JWT>`, signed with the app's client secret. Its
 *   header's `alg` must be HS256, HS384 or HS512, all keyed by that secret, so no other algorithm (`none`, RS*, ES*) can
 *   be passed off as one; its HMAC is compared in constant time; an `exp` may be at most 300 seconds past, and an `nbf`
 *   at most 300 seconds ahead. Atlassian documents neither the algorithm nor the claims, so no other claim is required,
 *   and the claims' names, never their values, are logged once. A failure answers 401, and the body is never read.
 * - **Only a nudge.** A signed delivery is answered exactly 200, and its work is deferred until after the answer. It is
 *   read for which webhooks it matched, which issue it names by its numeric id, the address Jira gave for that issue
 *   (`self`, to tell sites apart) and when Jira sent it. Nothing else in it is believed or kept: no status, no person,
 *   no list of what changed. The issue is read again through the API, in each workspace whose webhook it matched.
 * - **No time window.** Jira tries a delivery again 5 to 15 minutes later and never after a 401, so a delivery of any
 *   age is taken. A read is idempotent, and one that started at least 5 seconds after the delivery was sent is not made
 *   again; so a replay costs at most a read of a workspace's own linked issue.
 */

/** Vercel takes a request body of up to 4.5 MB; this endpoint takes up to 4,000,000 bytes. */
export const MAX_BODY_BYTES = 4_000_000;
/** How far past its `exp`, or before its `nbf`, a delivery's token is still taken, in seconds. */
export const EXP_LEEWAY_S = 300;
/** At most this many webhook ids are read of one delivery. */
export const MAX_WEBHOOK_IDS = 20;

const MAX_TOKEN_CHARS = 4096;
/** The HMAC algorithms a delivery's token may name, each keyed by the client secret. */
const HMAC = { HS256: "sha256", HS384: "sha384", HS512: "sha512" } as const;
const PART = /^[A-Za-z0-9_-]+$/;
const NAME = /^[A-Za-z0-9_:.-]{1,40}$/;

export type TokenRefusal = "missing" | "malformed" | "algorithm" | "signature" | "expired" | "not_yet_valid";
export type TokenCheck = { ok: true; claims: string[] } | { ok: false; reason: TokenRefusal; secondsPastExp?: number };

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Each set of claim names, and each algorithm refused, already logged: once a process, at most a few of each. */
const loggedClaims = new Set<string>();
const loggedAlgorithms = new Set<string>();

function logOnce(seen: Set<string>, value: string, log: () => void): void {
  if (seen.has(value) || seen.size >= 10) return;
  seen.add(value);
  log();
}

function decoded(part: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** Whether a delivery's `Authorization` is a token signed with the client secret, and in date (JR15). */
export function verifyJiraToken(secret: string, authorization: string | null, nowMs: number): TokenCheck {
  const given = /^Bearer +(\S+)$/i.exec((authorization ?? "").trim());
  if (!given) return { ok: false, reason: "missing" };
  const token = given[1];
  const parts = token.split(".");
  if (token.length > MAX_TOKEN_CHARS || parts.length !== 3 || !parts.every((part) => PART.test(part))) return { ok: false, reason: "malformed" };
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decoded(headerPart);
  if (!header) return { ok: false, reason: "malformed" };
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (!Object.hasOwn(HMAC, alg)) {
    const named = /^[A-Za-z0-9]{1,10}$/.test(alg) ? alg : "unreadable";
    logOnce(loggedAlgorithms, named, () => console.warn("jira webhook: a token with an algorithm that is not taken", named));
    return { ok: false, reason: "algorithm" };
  }
  if (secret.length === 0) return { ok: false, reason: "signature" };
  const expected = crypto.createHmac(HMAC[alg as keyof typeof HMAC], secret).update(`${headerPart}.${payloadPart}`, "utf8").digest();
  const actual = Buffer.from(signaturePart, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { ok: false, reason: "signature" };
  const payload = decoded(payloadPart);
  if (!payload) return { ok: false, reason: "malformed" };
  const nowS = nowMs / 1000;
  if ("exp" in payload) {
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { ok: false, reason: "malformed" };
    if (nowS - payload.exp > EXP_LEEWAY_S) return { ok: false, reason: "expired", secondsPastExp: Math.round(nowS - payload.exp) };
  }
  if ("nbf" in payload) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) return { ok: false, reason: "malformed" };
    if (payload.nbf - nowS > EXP_LEEWAY_S) return { ok: false, reason: "not_yet_valid" };
  }
  const claims = Object.keys(payload)
    .filter((name) => NAME.test(name))
    .slice(0, 20)
    .sort();
  logOnce(loggedClaims, claims.join(","), () => console.info("jira webhook: a delivery's token claims", claims.join(",")));
  return { ok: true, claims };
}

/** The site a delivery's issue address names: its host (`https://<host>/rest/api/<n>/issue/<id>`) or its cloudId. */
export type SelfRef = { host: string } | { cloudId: string };

/** The address Jira gave for the issue, read for its site alone; null when it is neither of the two forms. */
export function selfOf(value: unknown): SelfRef | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host === JIRA_API_HOST) {
    const cloud = /^\/ex\/jira\/([^/]+)\//.exec(url.pathname)?.[1]?.toLowerCase();
    return cloud && UUID.test(cloud) ? { cloudId: cloud } : null;
  }
  return /^\/rest\/api\/[0-9]+\/issue\/[0-9]{1,18}$/.test(url.pathname) ? { host } : null;
}

/** What a signed delivery asks for: the one issue it names read again, in each workspace whose webhook it matched. */
export interface JiraDeliveryEvent {
  event: JiraEvent;
  webhookIds: number[];
  issueId: string;
  self: SelfRef | null;
  /** When Jira sent it, in epoch milliseconds; null when it did not say. */
  timestamp: number | null;
}

export type JiraDelivery = ({ kind: "issue" } & JiraDeliveryEvent) | { kind: "ignored" };

const IGNORED: JiraDelivery = { kind: "ignored" };

/** Which issue a delivery names, and which webhooks it matched: ids alone, each checked to be one. */
export function deliveryOf(body: Record<string, unknown>): JiraDelivery {
  const event = JIRA_EVENTS.find((name) => name === body.webhookEvent);
  if (!event) return IGNORED;
  const matched = body.matchedWebhookIds;
  if (!Array.isArray(matched) || matched.length === 0 || matched.length > MAX_WEBHOOK_IDS) return IGNORED;
  if (!matched.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) return IGNORED;
  const issue = record(body.issue);
  const issueId = typeof issue?.id === "string" && ISSUE_ID.test(issue.id) ? issue.id : null;
  if (!issueId) return IGNORED;
  const timestamp = typeof body.timestamp === "number" && Number.isSafeInteger(body.timestamp) && body.timestamp > 0 ? body.timestamp : null;
  return { kind: "issue", event, webhookIds: [...new Set(matched as number[])], issueId, self: selfOf(issue?.self), timestamp };
}

export interface JiraWebhookDeps {
  /** `JIRA_CLIENT_SECRET`, which Jira signs each delivery's token with. */
  secret: string;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  /** Reads the issue again in every workspace whose webhook the delivery matched. */
  reread: (event: JiraDeliveryEvent) => Promise<unknown>;
  now?: () => number;
}

const empty = (status: number) => new Response(null, { status });
/** A header Jira sets on a delivery, read only when it is one short word or number. */
const word = (request: Request, name: string) => {
  const value = request.headers.get(name)?.trim() ?? "";
  return /^[A-Za-z0-9-]{1,20}$/.test(value) ? value : null;
};

export async function handleJiraWebhook(request: Request, deps: JiraWebhookDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const check = verifyJiraToken(deps.secret, request.headers.get("authorization"), now);
  if (!check.ok) {
    // Whether Jira was trying again, and on which of its two flows: the token itself is never logged.
    console.warn("jira webhook: a delivery was refused", check.reason, {
      retry: word(request, "x-atlassian-webhook-retry"),
      flow: word(request, "x-atlassian-webhook-flow"),
      ...(check.secondsPastExp === undefined ? {} : { secondsPastExp: check.secondsPastExp }),
    });
    return empty(401);
  }
  const raw = await cappedText(request, MAX_BODY_BYTES);
  if (raw === null) return empty(413);
  let body: Record<string, unknown> | null;
  try {
    body = record(JSON.parse(raw));
  } catch {
    body = null;
  }
  if (!body) return empty(401);

  const delivery = deliveryOf(body);
  if (delivery.kind === "issue") {
    const event: JiraDeliveryEvent = { event: delivery.event, webhookIds: delivery.webhookIds, issueId: delivery.issueId, self: delivery.self, timestamp: delivery.timestamp };
    deps.defer(async () => {
      try {
        await deps.reread(event);
      } catch (error) {
        console.error("jira webhook: the issue was not read again", error instanceof Error ? error.name : "unknown");
      }
    });
  }
  return empty(200);
}
