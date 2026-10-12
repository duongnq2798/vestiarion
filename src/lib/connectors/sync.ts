import { failureDelayMs, waitInRun } from "./backoff";
import { planBill, type StagedBill } from "./bills";
import type { Connection } from "./connections";
import { nextRequest, pageOutcome, type SyncCursor } from "./cursors";
import { PROVIDER_LABELS, ProviderError, type AccountingProvider, type ExternalBill, type ExternalContact, type Page, type PageRequest } from "./provider";
import { syncErrorWords, type SyncErrorKind } from "./status";
import { freshAccessToken, type AccessOutcome, type TokenStore } from "./tokens";

/**
 * One sync of one connection (docs/superpowers/specs/2026-10-12-xero-connector-design.md X7, X8, X10, I13): suppliers,
 * then bills, a page at a time. Each page is read from the provider, then written, then the cursor moves past it: no
 * call to the provider happens inside a write, and a run stopped anywhere resumes at its last page. A short rate limit
 * is waited out once in the run; a longer one, an outage or an unreadable answer ends the run and sets when the next
 * may start; a refused access token is refreshed once; a refused refresh, or an organisation that took the app's
 * access away, asks a person to reconnect. One run per connection at a time, under its sync lease. The database is
 * injected (`sync-store.ts` is the real one), so the runner is tested whole without one.
 */

export type ObjectType = "contact" | "bill";

export type SyncFinish =
  | { kind: "synced"; at: string }
  /** The page budget ran out: the cursor holds the next page, and the next run goes on. */
  | { kind: "partial"; at: string }
  /** Nothing read: another holder was refreshing the tokens. The lease goes, and nothing else changes. */
  | { kind: "released"; at: string }
  | { kind: "failed"; at: string; error: string; failures: number; nextSyncAfter: string }
  | { kind: "reconnect"; at: string; error: string };

export interface SyncDb {
  /** Takes the connection's sync lease until `untilIso`: the connection as it is, or null when it is held, or not connected. */
  claim(connectionId: string, nowIso: string, untilIso: string): Promise<Connection | null>;
  readCursor(connectionId: string, type: ObjectType): Promise<SyncCursor>;
  writeCursor(connectionId: string, type: ObjectType, cursor: SyncCursor): Promise<void>;
  stagedBills(connectionId: string, externalIds: string[]): Promise<Map<string, StagedBill>>;
  insertBill(connection: Connection, bill: ExternalBill): Promise<void>;
  updateBill(connection: Connection, staged: StagedBill, bill: ExternalBill): Promise<void>;
  /** A bill already added was paid, voided or deleted in the provider: recorded, and said in the ledger, once. */
  billClosed(connection: Connection, bill: ExternalBill): Promise<void>;
  applyContacts(connection: Connection, contacts: ExternalContact[]): Promise<void>;
  /** Records how the run ended and lets the sync lease go. */
  finish(connectionId: string, outcome: SyncFinish): Promise<void>;
}

export interface SyncResult {
  outcome: "synced" | "partial" | "rate_limited" | "unavailable" | "failed" | "reconnect" | "busy";
  /** Bills new in the review list. */
  newBills: number;
  /** Bills already added that the provider says were closed since. */
  closed: number;
  pages: number;
}

/** A run holds its connection this long at most; the sweeper's own run ends well before. */
export const SYNC_LEASE_MS = 5 * 60_000;
/** Pages read per object type in one run; the rest waits for the next. */
export const MAX_PAGES = 20;

class TokenFailure extends Error {
  constructor(readonly outcome: Exclude<AccessOutcome, { ok: true }>) {
    super(`token: ${outcome.reason}`);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function syncConnection(input: {
  connectionId: string;
  provider: AccountingProvider;
  db: SyncDb;
  tokens: TokenStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
}): Promise<SyncResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { db, provider, tokens } = input;
  const result: SyncResult = { outcome: "synced", newBills: 0, closed: 0, pages: 0 };

  const connection = await db.claim(input.connectionId, iso(now()), iso(now() + SYNC_LEASE_MS));
  if (!connection) return { ...result, outcome: "busy" };
  const label = PROVIDER_LABELS[connection.provider];

  const fail = async (kind: Exclude<SyncErrorKind, "reconnect">, retryAfterMs: number | null): Promise<SyncResult> => {
    const failures = connection.failures + 1;
    const next = iso(now() + (retryAfterMs ?? failureDelayMs(failures)));
    await db.finish(connection.id, { kind: "failed", at: iso(now()), failures, nextSyncAfter: next, error: syncErrorWords(kind, label, next, now()) });
    const outcome = kind === "rate_limited" ? "rate_limited" : kind === "failed" ? "failed" : "unavailable";
    return { ...result, outcome };
  };
  const reconnect = async (): Promise<SyncResult> => {
    await db.finish(connection.id, { kind: "reconnect", at: iso(now()), error: syncErrorWords("reconnect", label, null) });
    return { ...result, outcome: "reconnect" };
  };

  try {
    const first = await freshAccessToken({ store: tokens, refresh: provider.refresh, now, sleep });
    if (!first.ok) throw new TokenFailure(first);
    let accessToken = first.accessToken;

    /** A page, waiting out one short rate limit and refreshing one refused token. */
    async function readPage<T>(read: (request: PageRequest) => Promise<Page<T>>, asked: Omit<PageRequest, "accessToken" | "externalOrgId">): Promise<Page<T>> {
      let waited = false;
      let refreshed = false;
      for (;;) {
        try {
          return await read({ ...asked, accessToken, externalOrgId: connection!.externalOrgId });
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

    let complete = true;
    for (const type of ["contact", "bill"] as const) {
      let cursor = await db.readCursor(connection.id, type);
      for (let pages = 0; ; pages += 1) {
        if (pages >= (input.maxPages ?? MAX_PAGES)) {
          complete = false;
          break;
        }
        const started = nextRequest(cursor, iso(now()));
        cursor = started.cursor;
        let updatedAts: string[];
        let page: Page<unknown>;
        if (type === "contact") {
          const read = await readPage(provider.contacts, started.request);
          if (read.items.length > 0) await db.applyContacts(connection, read.items);
          updatedAts = read.items.map((contact) => contact.updatedAt);
          page = read;
        } else {
          const read = await readPage(provider.bills, started.request);
          await applyBills(db, connection, read.items, result);
          updatedAts = read.items.map((bill) => bill.updatedAt);
          page = read;
        }
        result.pages += 1;
        const outcome = pageOutcome(cursor, { page: page.page, last: page.last, updatedAts, total: page.total ?? null }, iso(now()));
        cursor = outcome.cursor;
        await db.writeCursor(connection.id, type, cursor);
        // A restart reads from page 1 again, within the same page budget.
        if (outcome.run === "done") break;
      }
    }
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
    // Never the error's detail beyond its message: it can carry a request, never a token, but the log keeps to ids.
    console.error("connector: a sync failed", connection.id, error instanceof Error ? error.message : "unknown error");
    return fail("failed", null);
  }
}

async function applyBills(db: SyncDb, connection: Connection, bills: ExternalBill[], result: SyncResult): Promise<void> {
  if (bills.length === 0) return;
  const staged = await db.stagedBills(connection.id, bills.map((bill) => bill.externalId));
  for (const bill of bills) {
    const row = staged.get(bill.externalId) ?? null;
    const plan = planBill(row, bill, connection.windowFrom);
    if (plan.kind === "insert") {
      await db.insertBill(connection, bill);
      staged.set(bill.externalId, { id: "", externalVersion: bill.version, sourceStatus: bill.status, reviewState: "review" });
      result.newBills += 1;
    } else if (plan.kind === "update" && row) {
      await db.updateBill(connection, row, bill);
      staged.set(bill.externalId, { ...row, externalVersion: bill.version, sourceStatus: bill.status });
      if (plan.closedAfterAdded) {
        await db.billClosed(connection, bill);
        result.closed += 1;
      }
    }
  }
}
