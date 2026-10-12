import { failureDelayMs, waitInRun } from "./backoff";
import type { Connection } from "./connections";
import { planCrmDeal, type CrmPage, type CrmPageRequest, type CrmProvider, type ExternalDeal, type StagedCrmDeal } from "./crm";
import { nextRequest, pageOutcome, type SyncCursor } from "./cursors";
import { PROVIDER_LABELS, ProviderError } from "./provider";
import { syncErrorWords, type SyncErrorKind } from "./status";
import { SYNC_LEASE_MS, MAX_PAGES, type SyncFinish } from "./sync";
import { freshAccessToken, type AccessOutcome, type TokenStore } from "./tokens";

/**
 * One sync of one CRM connection (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H6, H7, H8, H10, H12),
 * on the accounting runner's terms (docs/superpowers/specs/2026-10-12-xero-connector-design.md X7, X8): the deals a page
 * at a time, each read, then written, then the cursor moved past it; then the deals linked to Vestiarion deals, read by
 * id, since a deleted one never comes back in a search; then the changes of linked deals recorded once. Under the
 * connection's sync lease; a short rate limit waited out once, a longer one, an outage or an unreadable answer ending
 * the run with its checkpoint; a refused token refreshed once; a refused refresh asking a person to reconnect. The
 * database is injected (`crm-store.ts` is the real one).
 */

export interface CrmSyncDb {
  claim(connectionId: string, nowIso: string, untilIso: string): Promise<Connection | null>;
  readCursor(connectionId: string, type: "deal"): Promise<SyncCursor>;
  writeCursor(connectionId: string, type: "deal", cursor: SyncCursor): Promise<void>;
  staged(connectionId: string, externalIds: readonly string[]): Promise<Map<string, StagedCrmDeal>>;
  insertDeal(connection: Connection, deal: ExternalDeal): Promise<void>;
  updateDeal(connection: Connection, row: StagedCrmDeal, deal: ExternalDeal): Promise<void>;
  /** Links the rows of these deals to the Vestiarion deals whose reference names them, where none is linked yet (H10). */
  linkReferences(connection: Connection, externalIds: readonly string[]): Promise<void>;
  /**
   * The deals to read again by id, at most `limit`: those linked to Vestiarion deals, and the won ones still offered to
   * plan, since a deal deleted in the CRM never comes back in a search.
   */
  recheckDeals(connectionId: string, limit: number): Promise<Array<{ externalId: string; linked: boolean }>>;
  /** Deals the CRM no longer has: their rows say so. */
  markDeleted(connection: Connection, externalIds: readonly string[]): Promise<number>;
  /** Records the changes of these linked deals once per new set (H12); the number recorded. */
  flagChanges(connection: Connection, externalIds: readonly string[]): Promise<number>;
  finish(connectionId: string, outcome: SyncFinish): Promise<void>;
}

export interface CrmSyncResult {
  outcome: "synced" | "partial" | "rate_limited" | "unavailable" | "failed" | "reconnect" | "busy";
  /** Deals new to the connection. */
  newDeals: number;
  /** Linked deals whose changes were recorded. */
  changed: number;
  /** Deals read again by id that the CRM no longer has. */
  deleted: number;
  pages: number;
}

/** Deals read again by id in one run, a hundred at a time. */
export const MAX_RECHECK = 500;
const BATCH = 100;

class TokenFailure extends Error {
  constructor(readonly outcome: Exclude<AccessOutcome, { ok: true }>) {
    super(`token: ${outcome.reason}`);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function syncCrmConnection(input: {
  connectionId: string;
  provider: CrmProvider;
  db: CrmSyncDb;
  tokens: TokenStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
}): Promise<CrmSyncResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { db, provider, tokens } = input;
  const result: CrmSyncResult = { outcome: "synced", newDeals: 0, changed: 0, deleted: 0, pages: 0 };

  const connection = await db.claim(input.connectionId, iso(now()), iso(now() + SYNC_LEASE_MS));
  if (!connection) return { ...result, outcome: "busy" };
  const label = PROVIDER_LABELS[connection.provider];

  const fail = async (kind: Exclude<SyncErrorKind, "reconnect">, retryAfterMs: number | null): Promise<CrmSyncResult> => {
    const failures = connection.failures + 1;
    const next = iso(now() + (retryAfterMs ?? failureDelayMs(failures)));
    await db.finish(connection.id, { kind: "failed", at: iso(now()), failures, nextSyncAfter: next, error: syncErrorWords(kind, label, next, now()) });
    return { ...result, outcome: kind === "rate_limited" ? "rate_limited" : kind === "failed" ? "failed" : "unavailable" };
  };
  const reconnect = async (): Promise<CrmSyncResult> => {
    await db.finish(connection.id, { kind: "reconnect", at: iso(now()), error: syncErrorWords("reconnect", label, null) });
    return { ...result, outcome: "reconnect" };
  };

  try {
    const first = await freshAccessToken({ store: tokens, refresh: provider.refresh, now, sleep });
    if (!first.ok) throw new TokenFailure(first);
    let accessToken = first.accessToken;

    /** A call, waiting out one short rate limit and refreshing one refused token. */
    async function call<T>(read: (accessToken: string) => Promise<T>): Promise<T> {
      let waited = false;
      let refreshed = false;
      for (;;) {
        try {
          return await read(accessToken);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (error.failure === "rate_limited" && !waited && waitInRun(error.retryAfterMs)) {
            waited = true;
            await sleep(error.retryAfterMs ?? 0);
            continue;
          }
          if (error.failure === "unauthorized" && !refreshed) {
            refreshed = true;
            const again = await freshAccessToken({ store: tokens, refresh: provider.refresh, now, sleep, refused: accessToken });
            if (!again.ok) throw new TokenFailure(again);
            accessToken = again.accessToken;
            continue;
          }
          throw error;
        }
      }
    }

    /** Writes the deals read; the linked ones among them, for their changes. */
    async function apply(deals: readonly ExternalDeal[], options: { present?: boolean } = {}): Promise<string[]> {
      if (deals.length === 0) return [];
      const staged = await db.staged(connection!.id, deals.map((deal) => deal.externalId));
      const linked: string[] = [];
      for (const deal of deals) {
        const row = staged.get(deal.externalId) ?? null;
        const plan = planCrmDeal(row, deal, connection!.windowFrom);
        if (plan.kind === "insert") {
          await db.insertDeal(connection!, deal);
          result.newDeals += 1;
        } else if (row && (plan.kind === "update" || (options.present && row.sourceStatus === "deleted"))) {
          // A deal read by id after a deletion is back, even at the version it had.
          await db.updateDeal(connection!, row, deal);
        }
        if (row?.dealId) linked.push(deal.externalId);
      }
      await db.linkReferences(connection!, deals.map((deal) => deal.externalId));
      return linked;
    }

    let complete = true;
    let cursor = await db.readCursor(connection.id, "deal");
    for (let pages = 0; ; pages += 1) {
      if (pages >= (input.maxPages ?? MAX_PAGES)) {
        complete = false;
        break;
      }
      const started = nextRequest(cursor, iso(now()));
      cursor = started.cursor;
      const asked: Omit<CrmPageRequest, "accessToken"> = { ...started.request, externalOrgId: connection.externalOrgId, windowFrom: connection.windowFrom };
      const page: CrmPage = await call((token) => provider.deals({ ...asked, accessToken: token }));
      const touched = await apply(page.items);
      if (touched.length > 0) result.changed += await db.flagChanges(connection, touched);
      result.pages += 1;
      const outcome = pageOutcome(
        cursor,
        { page: page.page, last: page.last, updatedAts: page.items.map((deal) => deal.updatedAt), total: page.total ?? null, capped: page.capped === true },
        iso(now())
      );
      cursor = outcome.cursor;
      await db.writeCursor(connection.id, "deal", cursor);
      if (outcome.run === "done") break;
    }

    // Deleted deals never come back in a search: the linked ones, and the won ones still offered, are read by id (H6).
    const recheck = await db.recheckDeals(connection.id, MAX_RECHECK);
    for (let at = 0; at < recheck.length; at += BATCH) {
      const ids = recheck.slice(at, at + BATCH).map((deal) => deal.externalId);
      const read = await call((token) => provider.dealsById({ accessToken: token, externalOrgId: connection.externalOrgId, ids }));
      await apply(read.deals, { present: true });
      if (read.missing.length > 0) result.deleted += await db.markDeleted(connection, read.missing);
    }
    const linked = recheck.filter((deal) => deal.linked).map((deal) => deal.externalId);
    if (linked.length > 0) result.changed += await db.flagChanges(connection, linked);

    if (!complete) {
      await db.finish(connection.id, { kind: "partial", at: iso(now()) });
      return { ...result, outcome: "partial" };
    }
    await db.finish(connection.id, { kind: "synced", at: iso(now()) });
    return result;
  } catch (error) {
    if (error instanceof TokenFailure) {
      const outcome = error.outcome;
      if (outcome.reason === "reconnect" || outcome.reason === "missing") return reconnect();
      if (outcome.reason === "busy") {
        await db.finish(connection.id, { kind: "released", at: iso(now()) });
        return { ...result, outcome: "busy" };
      }
      return fail("unavailable", outcome.reason === "unavailable" ? outcome.retryAfterMs : null);
    }
    if (error instanceof ProviderError) {
      if (error.failure === "forbidden" || error.failure === "unauthorized") return reconnect();
      if (error.failure === "rate_limited") return fail("rate_limited", error.retryAfterMs ?? 60_000);
      return fail(error.failure === "bad_response" ? "bad_response" : "unavailable", null);
    }
    console.error("connector: a CRM sync failed", connection.id, error instanceof Error ? error.message : "unknown error");
    return fail("failed", null);
  }
}
