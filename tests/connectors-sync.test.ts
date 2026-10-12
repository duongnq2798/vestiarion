import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StagedBill } from "@/lib/connectors/bills";
import type { Connection } from "@/lib/connectors/connections";
import { NEW_CURSOR, type SyncCursor } from "@/lib/connectors/cursors";
import { ProviderError, type AccountingProvider, type ExternalBill, type ExternalContact, type Page, type PageRequest } from "@/lib/connectors/provider";
import { syncConnection, type ObjectType, type SyncDb, type SyncFinish } from "@/lib/connectors/sync";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { mapBillsPage, mapContactsPage } from "@/lib/xero/map";

/**
 * The sync runner (docs/superpowers/specs/2026-10-12-xero-connector-design.md X7, X8, X10, I13), against a provider
 * answering with recorded Xero pages and an in-memory database: a backfill across pages, the checkpoint kept when Xero
 * asks to slow down and resumed by the next run, a refused access token refreshed once, a connection taken away in
 * Xero, a bill paid there after it was added, and one run per connection at a time.
 */

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "xero", name), "utf8"));
const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const CONNECTION_ID = "conn-1";

const connection: Connection = {
  id: CONNECTION_ID, orgId: "org-1", provider: "xero", externalOrgId: "tenant-1", externalOrgName: "Demo Company (Global)", status: "connected",
  scopes: [], connectedBy: "user-1", connectedAt: "2026-10-12T07:00:00.000Z", consentVersion: "xero-2026-10-12", consentedAt: "2026-10-12T07:00:00.000Z",
  revokedAt: null, windowFrom: "2026-07-14", lastSyncedAt: null, lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null,
  syncLeaseUntil: null, paymentAccount: null, paymentAccountAt: null,
};

function memoryDb(initial: Partial<{ leased: boolean; bills: Map<string, StagedBill & { bill: ExternalBill }> }> = {}) {
  const cursors = new Map<ObjectType, SyncCursor>();
  const bills = initial.bills ?? new Map<string, StagedBill & { bill: ExternalBill }>();
  const contacts = new Map<string, ExternalContact>();
  const closed: ExternalBill[] = [];
  const finishes: SyncFinish[] = [];
  let leased = initial.leased ?? false;
  const db: SyncDb = {
    async claim() {
      if (leased) return null;
      leased = true;
      return connection;
    },
    async readCursor(_id, type) {
      return cursors.get(type) ?? NEW_CURSOR;
    },
    async writeCursor(_id, type, cursor) {
      cursors.set(type, cursor);
    },
    async stagedBills(_id, ids) {
      return new Map(ids.flatMap((id) => (bills.has(id) ? [[id, bills.get(id) as StagedBill]] : [])));
    },
    async insertBill(_c, bill) {
      bills.set(bill.externalId, { id: `row-${bill.externalId}`, externalVersion: bill.version, sourceStatus: bill.status, reviewState: "review", bill });
    },
    async updateBill(_c, staged, bill) {
      bills.set(bill.externalId, { ...staged, externalVersion: bill.version, sourceStatus: bill.status, bill });
    },
    async billClosed(_c, bill) {
      closed.push(bill);
    },
    async applyContacts(_c, page) {
      for (const contact of page) contacts.set(contact.externalId, contact);
    },
    async finish(_id, outcome) {
      leased = false;
      finishes.push(outcome);
    },
  };
  return { db, cursors, bills, contacts, closed, finishes };
}

function tokenStore(accessToken = "access-1"): TokenStore & { refreshed: number } {
  let row: StoredTokens = { id: "tok", version: 1, accessToken, refreshToken: "refresh-1", expiresAt: NOW + 1_800_000, scopes: [] };
  const store = {
    refreshed: 0,
    read: async () => row,
    lease: async () => row,
    store: async (_holder: string, _version: number, tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }) => {
      row = { ...row, ...tokens, version: row.version + 1 };
      store.refreshed += 1;
      return true;
    },
    release: async () => undefined,
  };
  return store;
}

type Answer<T> = (request: PageRequest) => Page<T> | ProviderError;

function provider(answers: { bills?: Answer<ExternalBill>; contacts?: Answer<ExternalContact>; refresh?: AccountingProvider["refresh"] }) {
  const calls: Array<{ kind: string; request: PageRequest }> = [];
  const answer = <T,>(kind: string, fn: Answer<T> | undefined) => async (request: PageRequest) => {
    calls.push({ kind, request });
    const result = fn ? fn(request) : { items: [], page: request.page, last: true };
    if (result instanceof ProviderError) throw result;
    return result;
  };
  const p: AccountingProvider = {
    id: "xero",
    label: "Xero",
    scopes: [],
    authorizeUrl: () => "",
    exchangeCode: vi.fn(),
    organisations: vi.fn(),
    refresh: answers.refresh ?? (async () => ({ ok: true, tokens: { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: NOW + 1_800_000, scopes: [] } })),
    revoke: vi.fn(),
    bills: answer("bills", answers.bills),
    contacts: answer("contacts", answers.contacts),
    accounts: vi.fn(),
  };
  return { provider: p, calls };
}

const backfill: Answer<ExternalBill> = (request) =>
  request.page === 1 ? mapBillsPage(fixture("invoices-backfill-page-1.json"), 1, 100) : mapBillsPage(fixture("invoices-backfill-page-2.json"), 2, 100);
const run = (db: SyncDb, p: AccountingProvider, tokens: TokenStore = tokenStore(), extra: Partial<Parameters<typeof syncConnection>[0]> = {}) =>
  syncConnection({ connectionId: CONNECTION_ID, provider: p, db, tokens, now: () => NOW, sleep: async () => undefined, ...extra });

describe("syncConnection", () => {
  it("backfills suppliers, then bills across pages, keeping the open ones in the window for review", async () => {
    const memory = memoryDb();
    const { provider: p, calls } = provider({ contacts: () => mapContactsPage(fixture("contacts-page.json"), 1, 100), bills: backfill });
    expect(await run(memory.db, p)).toEqual({ outcome: "synced", newBills: 3, closed: 0, pages: 3 });
    expect(calls.map((call) => [call.kind, call.request.page, call.request.phase])).toEqual([
      ["contacts", 1, "backfill"],
      ["bills", 1, "backfill"],
      ["bills", 2, "backfill"],
    ]);
    expect(calls[1].request).toMatchObject({ accessToken: "access-1", externalOrgId: "tenant-1", since: null });
    expect([...memory.bills.values()].map((row) => [row.bill.number, row.reviewState, row.sourceStatus])).toEqual([
      ["PD-4471", "review", "open"],
      ["SMC-0902", "review", "open"],
      ["AK-77", "review", "open"],
    ]);
    expect([...memory.contacts.keys()]).toHaveLength(2);
    expect(memory.cursors.get("bill")).toMatchObject({ phase: "incremental", since: "2026-10-12T09:55:00.000Z", page: null });
    expect(memory.finishes).toEqual([{ kind: "synced", at: "2026-10-12T10:00:00.000Z" }]);
  });

  it("follows changes on the next run: a bill paid in Xero leaves the list, and one already added is told once", async () => {
    const memory = memoryDb();
    const first = provider({ bills: backfill });
    await run(memory.db, first.provider);
    // A person added PD-4471.
    const added = memory.bills.get("0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0001");
    memory.bills.set("0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0001", { ...(added as StagedBill & { bill: ExternalBill }), reviewState: "added" });
    const later = provider({ bills: () => mapBillsPage(fixture("invoices-modified.json"), 1, 100) });
    expect(await run(memory.db, later.provider)).toMatchObject({ outcome: "synced", newBills: 0, closed: 1 });
    expect(later.calls.find((call) => call.kind === "bills")?.request).toMatchObject({ phase: "incremental", since: "2026-10-12T09:55:00.000Z" });
    expect(memory.closed.map((bill) => bill.number)).toEqual(["PD-4471"]);
    expect(memory.bills.get("0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0001")).toMatchObject({ reviewState: "added", sourceStatus: "paid" });
    // Closed and drafted bills Vestiarion never had are not kept.
    expect(memory.bills.has("0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0005")).toBe(false);
    expect(memory.bills.has("0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0006")).toBe(false);
    // Reading the same page again changes nothing and tells nothing twice.
    expect(await run(memory.db, later.provider)).toMatchObject({ newBills: 0, closed: 0 });
    expect(memory.closed).toHaveLength(1);
  });

  it("waits out a short rate limit inside the run, once", async () => {
    const memory = memoryDb();
    const sleep = vi.fn(async () => undefined);
    let limited = false;
    const { provider: p } = provider({
      bills: (request) => {
        if (request.page === 2 && !limited) {
          limited = true;
          return new ProviderError("rate_limited", "Xero invoices: 429", 2_000);
        }
        return backfill(request);
      },
    });
    expect((await run(memory.db, p, tokenStore(), { sleep })).outcome).toBe("synced");
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("stops on a long rate limit, keeps the page it reached, and the next run resumes there", async () => {
    const memory = memoryDb();
    const limited = provider({ bills: (request) => (request.page === 2 ? new ProviderError("rate_limited", "Xero invoices: 429", 90_000) : backfill(request)) });
    expect(await run(memory.db, limited.provider)).toEqual({ outcome: "rate_limited", newBills: 3, closed: 0, pages: 2 });
    expect(memory.cursors.get("bill")).toMatchObject({ phase: "backfill", page: 2 });
    expect(memory.finishes[0]).toEqual({
      kind: "failed",
      at: "2026-10-12T10:00:00.000Z",
      failures: 1,
      nextSyncAfter: "2026-10-12T10:01:30.000Z",
      error: "Xero asked Vestiarion to slow down. Syncing again at 10:01 UTC.",
    });
    const resumed = provider({ bills: backfill });
    expect((await run(memory.db, resumed.provider)).outcome).toBe("synced");
    expect(resumed.calls.filter((call) => call.kind === "bills").map((call) => call.request.page)).toEqual([2]);
  });

  it("backs off longer after each failure in a row, keeping the checkpoint", async () => {
    const memory = memoryDb();
    const down = provider({ bills: () => new ProviderError("unavailable", "Xero invoices: 503") });
    const failing = { ...memory.db, claim: async () => ({ ...connection, failures: 2 }) };
    expect((await run(failing, down.provider)).outcome).toBe("unavailable");
    expect(memory.finishes[0]).toMatchObject({ kind: "failed", failures: 3, nextSyncAfter: "2026-10-12T10:04:00.000Z", error: "Xero did not answer. Vestiarion tries again at 10:04 UTC." });
  });

  it("refreshes a token Xero refused, once, and goes on", async () => {
    const memory = memoryDb();
    const tokens = tokenStore();
    const { provider: p, calls } = provider({ bills: (request) => (request.accessToken === "access-1" ? new ProviderError("unauthorized", "Xero invoices: 401") : backfill(request)) });
    expect((await run(memory.db, p, tokens)).outcome).toBe("synced");
    expect(tokens.refreshed).toBe(1);
    expect(calls.filter((call) => call.kind === "bills").map((call) => call.request.accessToken)).toEqual(["access-1", "access-2", "access-2"]);
  });

  it("asks for a reconnect when Xero refuses the refresh, or the organisation took the app's access away", async () => {
    const refused = memoryDb();
    const noRefresh = provider({
      bills: () => new ProviderError("unauthorized", "Xero invoices: 401"),
      refresh: async () => ({ ok: false, reason: "reconnect" }),
    });
    expect((await run(refused.db, noRefresh.provider)).outcome).toBe("reconnect");
    expect(refused.finishes[0]).toMatchObject({ kind: "reconnect", error: expect.stringContaining("Reconnect Xero") });

    const forbidden = memoryDb();
    const gone = provider({ contacts: () => new ProviderError("forbidden", "Xero contacts: 403") });
    expect((await run(forbidden.db, gone.provider)).outcome).toBe("reconnect");
  });

  it("asks for a reconnect when the connection has no tokens", async () => {
    const memory = memoryDb();
    const empty: TokenStore = { read: async () => null, lease: async () => null, store: async () => false, release: async () => undefined };
    expect((await run(memory.db, provider({}).provider, empty)).outcome).toBe("reconnect");
  });

  it("lets the connection go, recording nothing, when another holder keeps refreshing its tokens", async () => {
    const memory = memoryDb();
    const busy: TokenStore = {
      read: async () => ({ id: "tok", version: 1, accessToken: "a", refreshToken: "r", expiresAt: NOW, scopes: [] }),
      lease: async () => null,
      store: async () => false,
      release: async () => undefined,
    };
    const { provider: p, calls } = provider({ bills: backfill });
    expect((await run(memory.db, p, busy)).outcome).toBe("busy");
    expect(calls).toEqual([]);
    expect(memory.finishes).toEqual([{ kind: "released", at: "2026-10-12T10:00:00.000Z" }]);
  });

  it("reads nothing while another run holds the connection", async () => {
    const memory = memoryDb({ leased: true });
    const { provider: p, calls } = provider({ bills: backfill });
    expect(await run(memory.db, p)).toEqual({ outcome: "busy", newBills: 0, closed: 0, pages: 0 });
    expect(calls).toEqual([]);
    expect(memory.finishes).toEqual([]);
  });

  it("stops at its page budget and leaves the rest to the next run", async () => {
    const memory = memoryDb();
    const { provider: p } = provider({ bills: backfill });
    expect(await run(memory.db, p, tokenStore(), { maxPages: 1 })).toMatchObject({ outcome: "partial", pages: 2 });
    expect(memory.cursors.get("bill")).toMatchObject({ page: 2 });
    expect(memory.finishes).toEqual([{ kind: "partial", at: "2026-10-12T10:00:00.000Z" }]);
  });

  it("reads a run of several pages again from page 1 when a bill changed during it, and moves on once nothing did", async () => {
    const memory = memoryDb();
    const changing: Answer<ExternalBill> = (request) => {
      const page = backfill(request) as Page<ExternalBill>;
      // A bill on page 2 was edited in Xero a minute into the run.
      return request.page === 2 ? { ...page, items: page.items.map((bill) => ({ ...bill, version: "2026-10-12T10:01:00.000Z", updatedAt: "2026-10-12T10:01:00.000Z" })) } : page;
    };
    const first = provider({ bills: changing });
    expect(await run(memory.db, first.provider, tokenStore(), { maxPages: 3 })).toMatchObject({ outcome: "partial" });
    expect(first.calls.filter((call) => call.kind === "bills").map((call) => call.request.page)).toEqual([1, 2, 1]);
    // Later, with nothing changing during the run, it reads to the end and moves on.
    const later = provider({ bills: changing });
    expect((await run(memory.db, later.provider, tokenStore(), { now: () => NOW + 3_600_000 })).outcome).toBe("synced");
    expect(memory.cursors.get("bill")).toMatchObject({ phase: "incremental", page: null });
  });

  it("records an unexpected error as a failed sync and keeps going for the next run", async () => {
    const memory = memoryDb();
    const broken = { ...memory.db, insertBill: async () => Promise.reject(new Error("database down")) };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await run(broken, provider({ bills: backfill }).provider)).outcome).toBe("failed");
    expect(memory.finishes[0]).toMatchObject({ kind: "failed", error: "The sync stopped on an error. Vestiarion tries again at 10:01 UTC." });
    expect(error.mock.calls.flat().join(" ")).not.toContain("access-1");
    error.mockRestore();
  });
});
