import crypto from "node:crypto";
import { NotSetUpError, type ExternalMatch } from "../connectors/connections";

/**
 * QuickBooks Online's webhook (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q11). A notification is
 * signed by Intuit (`intuit-signature`: the base64 HMAC-SHA256 of the raw body under the app's verifier token), and
 * names companies and records, never their fields. So it is checked before anything is read, and then it only nudges:
 * the connections of the companies whose bills, bill payments or vendors changed each run one sync after the answer,
 * which reads the canonical records itself. Unknown companies, other entities, replays and duplicates change nothing a
 * sync would not. The answer goes at once: Intuit asks for one within three seconds.
 */

/** Intuit sets no limit on a notification's size; this endpoint takes up to 1 MB, thousands of events. */
export const MAX_BODY_BYTES = 1_000_000;
/** The entities whose changes bear on the bills brought in: the bill, a payment of it, its vendor. */
export const NUDGING_ENTITIES: ReadonlySet<string> = new Set(["bill", "billpayment", "vendor"]);
/** The syncs a notification starts stop starting after this long; the sweeper takes the rest within 15 minutes. */
export const NUDGE_BUDGET_MS = 60_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Whether `intuit-signature` is Intuit's HMAC-SHA256 of this exact body under the verifier token, compared in constant time. */
export function verifyIntuitSignature(verifierToken: string, rawBody: string, header: string | null): boolean {
  const given = header?.trim() ?? "";
  if (!BASE64.test(given)) return false;
  const expected = crypto.createHmac("sha256", verifierToken).update(rawBody, "utf8").digest();
  const actual = Buffer.from(given, "base64");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** One CloudEvent, as much of it as is used: which company, and which kind of record. */
export interface WebhookEvent {
  realmId: string;
  /** `bill`, `billpayment`, `vendor`, `customer`… from `type` (`qbo.bill.created.v1`). */
  entity: string;
}

const TYPE = /^qbo\.([a-z]+)\.[a-z]+\.v\d+$/i;
const REALM = /^\d{1,32}$/;

/**
 * The events of a CloudEvents notification: a JSON array (one object is read as an array of one). An event without a
 * readable type or company is left out; the record's id, the time and `data` are not kept. Null when the body is not
 * JSON at all.
 */
export function readEvents(rawBody: string): WebhookEvent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? [parsed] : [];
  return list.flatMap((raw): WebhookEvent[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const { type, intuitaccountid } = raw as Record<string, unknown>;
    const entity = typeof type === "string" ? TYPE.exec(type.trim())?.[1]?.toLowerCase() : undefined;
    const realmId = typeof intuitaccountid === "string" ? intuitaccountid.trim() : typeof intuitaccountid === "number" ? String(intuitaccountid) : "";
    return entity && REALM.test(realmId) ? [{ realmId, entity }] : [];
  });
}

/** The companies, each once, whose bills, bill payments or vendors changed. */
export function realmsToNudge(events: readonly WebhookEvent[]): string[] {
  return [...new Set(events.filter((event) => NUDGING_ENTITIES.has(event.entity)).map((event) => event.realmId))];
}

/** A connection a notification may nudge: connected, and not waiting out a rate limit or an outage. */
export function nudgeable(match: ExternalMatch, nowMs: number): boolean {
  return match.status === "connected" && (match.nextSyncAfter === null || Date.parse(match.nextSyncAfter) <= nowMs);
}

export interface WebhookDeps {
  verifierToken: string;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  /** The connections, not revoked, of these companies, in every workspace (`connectionsByExternal`). */
  findConnections: (realmIds: string[]) => Promise<ExternalMatch[]>;
  /** One sync of one connection, in its own workspace's scope. */
  nudge: (match: ExternalMatch) => Promise<unknown>;
  now?: () => number;
  budgetMs?: number;
}

const answer = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

export async function handleQuickBooksWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return answer({ error: "too_large" }, 413);
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return answer({ error: "too_large" }, 413);
  if (!verifyIntuitSignature(deps.verifierToken, raw, request.headers.get("intuit-signature"))) return answer({ error: "invalid_signature" }, 401);
  const events = readEvents(raw);
  if (events === null) return answer({ error: "invalid_json" }, 400);
  const realms = realmsToNudge(events);
  if (realms.length > 0) {
    deps.defer(async () => {
      const now = deps.now ?? Date.now;
      const started = now();
      let matches: ExternalMatch[];
      try {
        matches = await deps.findConnections(realms);
      } catch (error) {
        // Before migration 0102 there is nothing to nudge; the sweeper has nothing either.
        if (!(error instanceof NotSetUpError)) console.error("quickbooks webhook: connections not read", error instanceof Error ? error.message : "unknown error");
        return;
      }
      let nudged = 0;
      for (const match of matches.filter((candidate) => nudgeable(candidate, now()))) {
        if (now() - started > (deps.budgetMs ?? NUDGE_BUDGET_MS)) break;
        try {
          await deps.nudge(match);
          nudged += 1;
        } catch (error) {
          console.error("quickbooks webhook: a sync failed", match.connectionId, error instanceof Error ? error.message : "unknown error");
        }
      }
      // Counts only: never a company's records.
      console.info("quickbooks webhook", { events: events.length, companies: realms.length, connections: matches.length, nudged });
    });
  }
  return answer({ received: events.length });
}
