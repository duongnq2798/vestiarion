import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/connectors/connections";
import type { CrmPage, CrmPageRequest, CrmProvider, ExternalDeal, StagedCrmDeal } from "@/lib/connectors/crm";
import { syncCrmConnection, type CrmSyncDb } from "@/lib/connectors/crm-sync";
import { CLOCK_MARGIN_MS, NEW_CURSOR, type SyncCursor } from "@/lib/connectors/cursors";
import { ProviderError } from "@/lib/connectors/provider";
import type { SyncFinish } from "@/lib/connectors/sync";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";

/**
 * The CRM runner (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H6, H7, H8, H10, H12), against a
 * provider answering with HubSpot-shaped deals and an in-memory database: a backfill across pages, the checkpoint kept
 * when HubSpot asks to slow down and resumed by the next run, a refused access token refreshed once, access taken away,
 * the 10,000-result cap, and the linked deals read again by id: one changed, one deleted.
 */

const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const connection: Connection = {
  id: "conn-1", orgId: "org-1", provider: "hubspot", externalOrgId: "48291736", externalOrgName: "northstar-studio.example", status: "connected",
  scopes: [], connectedBy: "user-1", connectedAt: "2026-10-12T07:00:00.000Z", consentVersion: "hubspot-2026-10-12", consentedAt: "2026-10-12T07:00:00.000Z",
  revokedAt: null, windowFrom: "2026-07-14", lastSyncedAt: null, lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null,
  syncLeaseUntil: null, paymentAccount: null, paymentAccountAt: null,
};

const deal = (id: string, fields: Partial<ExternalDeal> = {}): ExternalDeal => ({
  externalId: id,
  version: "2026-10-01T02:00:00.000Z",
  updatedAt: "2026-10-01T02:00:00.000Z",
  name: `Deal ${id}`,
  amount: "1000",
  currency: "USD",
  closeOn: "2026-10-01",
  pipelineId: "default",
  pipelineLabel: "Sales Pipeline",
  stageId: "closedwon",
  stageLabel: "Closed Won",
  stage: "won",
  company: { externalId: "c1", name: "Northwind Labs", email: null },
  ...fields,
});

type Row = StagedCrmDeal & { deal: ExternalDeal };

function memoryDb(initial: { leased?: boolean; rows?: Row[] } = {}) {
  let cursor: SyncCursor = NEW_CURSOR;
  const rows = new Map((initial.rows ?? []).map((row) => [row.deal.externalId, row]));
  const finishes: SyncFinish[] = [];
  const flagged: string[][] = [];
  const referenced: string[][] = [];
  let leased = initial.leased ?? false;
  const db: CrmSyncDb = {
    async claim() {
      if (leased) return null;
      leased = true;
      return connection;
    },
    async readCursor() {
      return cursor;
    },
    async writeCursor(_id, _type, next) {
      cursor = next;
    },
    async staged(_id, ids) {
      return new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id) as StagedCrmDeal]] : [])));
    },
    async insertDeal(_c, read) {
      rows.set(read.externalId, { id: `row-${read.externalId}`, externalVersion: read.version, sourceStatus: "present", dealId: null, deal: read });
    },
    async updateDeal(_c, row, read) {
      rows.set(read.externalId, { ...(row as Row), externalVersion: read.version, sourceStatus: "present", deal: read });
    },
    async linkReferences(_c, ids) {
      referenced.push([...ids]);
    },
    async recheckDeals() {
      return [...rows.values()].filter((row) => row.dealId !== null || row.deal.stage === "won").map((row) => ({ externalId: row.deal.externalId, linked: row.dealId !== null }));
    },
    async markDeleted(_c, ids) {
      for (const id of ids) {
        const row = rows.get(id);
        if (row) rows.set(id, { ...row, sourceStatus: "deleted" });
      }
      return ids.length;
    },
    async flagChanges(_c, ids) {
      flagged.push([...ids]);
      return ids.length;
    },
    async finish(_id, outcome) {
      leased = false;
      finishes.push(outcome);
    },
  };
  return { db, rows, finishes, flagged, referenced, cursor: () => cursor, setCursor: (next: SyncCursor) => (cursor = next) };
}

function tokenStore(): TokenStore {
  let row: StoredTokens = { id: "tok", version: 1, accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 1_800_000, scopes: [] };
  return {
    read: async () => row,
    lease: async () => row,
    store: async (_holder, _version, tokens) => {
      row = { ...row, ...tokens, version: row.version + 1 };
      return true;
    },
    release: async () => undefined,
  };
}

type Answer = (request: CrmPageRequest) => CrmPage | ProviderError;

function provider(answers: { deals: Answer; byId?: (ids: readonly string[]) => { deals: ExternalDeal[]; missing: string[] } | ProviderError; refresh?: CrmProvider["refresh"] }) {
  const asked: CrmPageRequest[] = [];
  const byIdAsked: string[][] = [];
  const p: CrmProvider = {
    id: "hubspot",
    label: "HubSpot",
    kind: "crm",
    scopes: [],
    authorizeUrl: () => "",
    exchangeCode: vi.fn(),
    organisations: vi.fn(),
    refresh: answers.refresh ?? (async () => ({ ok: true, tokens: { accessToken: "access-2", refreshToken: "refresh-1", expiresAt: NOW + 1_800_000, scopes: [] } })),
    revoke: vi.fn(),
    deals: async (request) => {
      asked.push(request);
      const answer = answers.deals(request);
      if (answer instanceof ProviderError) throw answer;
      return answer;
    },
    dealsById: async ({ ids }) => {
      byIdAsked.push([...ids]);
      const answer = answers.byId ? answers.byId(ids) : { deals: [], missing: [] };
      if (answer instanceof ProviderError) throw answer;
      return answer;
    },
  };
  return { provider: p, asked, byIdAsked };
}

const run = (p: CrmProvider, db: CrmSyncDb, extra: { maxPages?: number; sleep?: (ms: number) => Promise<void> } = {}) =>
  syncCrmConnection({ connectionId: "conn-1", provider: p, db, tokens: tokenStore(), now: () => NOW, sleep: extra.sleep ?? (async () => undefined), maxPages: extra.maxPages });

describe("syncCrmConnection", () => {
  it("reads a backfill across pages, keeps open and won deals, and moves on to changes since it started", async () => {
    const memory = memoryDb();
    const { provider: p, asked } = provider({
      deals: (request) =>
        request.page === 1
          ? { items: [deal("1"), deal("2", { stage: "open", stageLabel: "Contract Sent" })], page: 1, last: false, total: 3 }
          : { items: [deal("3", { stage: "lost" })], page: 2, last: true, total: 3 },
    });
    const result = await run(p, memory.db);
    expect(result).toMatchObject({ outcome: "synced", newDeals: 2, pages: 2 });
    expect(asked.map((request) => [request.phase, request.page, request.windowFrom, request.externalOrgId])).toEqual([
      ["backfill", 1, "2026-07-14", "48291736"],
      ["backfill", 2, "2026-07-14", "48291736"],
    ]);
    expect([...memory.rows.keys()]).toEqual(["1", "2"]);
    expect(memory.referenced).toEqual([["1", "2"], ["3"]]);
    expect(memory.cursor()).toMatchObject({ phase: "incremental", page: null, since: "2026-10-12T09:55:00.000Z" });
    expect(memory.finishes).toEqual([{ kind: "synced", at: "2026-10-12T10:00:00.000Z" }]);
  });

  it("keeps the checkpoint when HubSpot asks for a long wait, and the next run resumes on the page after", async () => {
    const memory = memoryDb();
    let limited = true;
    const { provider: p, asked } = provider({
      deals: (request) => {
        if (request.page === 2 && limited) return new ProviderError("rate_limited", "HubSpot deal search: 429 (TEN_SECONDLY_ROLLING)", 10_000);
        return request.page === 1 ? { items: [deal("1")], page: 1, last: false } : { items: [deal("2")], page: 2, last: true };
      },
    });
    expect(await run(p, memory.db)).toMatchObject({ outcome: "rate_limited", pages: 1 });
    expect(memory.cursor()).toMatchObject({ phase: "backfill", page: 2 });
    expect(memory.finishes[0]).toEqual({
      kind: "failed",
      at: "2026-10-12T10:00:00.000Z",
      failures: 1,
      nextSyncAfter: "2026-10-12T10:00:10.000Z",
      error: "HubSpot asked Vestiarion to slow down. Syncing again at 10:00 UTC.",
    });
    limited = false;
    expect(await run(p, memory.db)).toMatchObject({ outcome: "synced" });
    expect(asked.map((request) => request.page)).toEqual([1, 2, 2]);
  });

  it("waits out a short rate limit once inside the run", async () => {
    const memory = memoryDb();
    let first = true;
    const sleep = vi.fn(async () => undefined);
    const { provider: p } = provider({
      deals: () => {
        if (first) {
          first = false;
          return new ProviderError("rate_limited", "HubSpot deal search: 429 (SECONDLY)", 1_000);
        }
        return { items: [deal("1")], page: 1, last: true };
      },
    });
    expect(await run(p, memory.db, { sleep })).toMatchObject({ outcome: "synced", newDeals: 1 });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("refreshes a refused access token once, and asks a person to reconnect when the refresh is refused or access was removed", async () => {
    let refused = true;
    const once = provider({
      deals: (request) => {
        if (request.accessToken === "access-1" && refused) {
          refused = false;
          return new ProviderError("unauthorized", "HubSpot deal search: 401");
        }
        return { items: [], page: 1, last: true };
      },
    });
    expect(await run(once.provider, memoryDb().db)).toMatchObject({ outcome: "synced" });
    expect(once.asked.map((request) => request.accessToken)).toEqual(["access-1", "access-2"]);

    const memory = memoryDb();
    const gone = provider({ deals: () => new ProviderError("unauthorized", "401"), refresh: async () => ({ ok: false, reason: "reconnect" }) });
    expect(await run(gone.provider, memory.db)).toMatchObject({ outcome: "reconnect" });
    expect(memory.finishes[0]).toMatchObject({ kind: "reconnect", error: expect.stringContaining("Reconnect HubSpot to go on bringing its deals in") });

    const removed = memoryDb();
    expect(await run(provider({ deals: () => new ProviderError("forbidden", "403") }).provider, removed.db)).toMatchObject({ outcome: "reconnect" });
  });

  it("ends a run at HubSpot's cap without starting over", async () => {
    const memory = memoryDb();
    memory.setCursor({ ...NEW_CURSOR, phase: "incremental", since: "2026-10-01T00:00:00.000Z", backfillStartedAt: "2026-10-11T00:00:00.000Z", completedAt: "2026-10-11T00:00:00.000Z" });
    const { provider: p } = provider({
      deals: (request) =>
        request.page === 1
          ? { items: [deal("1", { version: "2026-10-12T09:59:00.000Z", updatedAt: "2026-10-12T09:59:00.000Z" })], page: 1, last: false, total: 12840 }
          : { items: [deal("2", { version: "2026-10-12T09:59:30.000Z", updatedAt: "2026-10-12T09:59:30.000Z" })], page: 2, last: true, capped: true, total: 12840 },
    });
    expect(await run(p, memory.db)).toMatchObject({ outcome: "synced", pages: 2 });
    // HubSpot is asked from five minutes before `since`: the next run starts at the latest change read itself.
    expect(memory.cursor()).toMatchObject({ phase: "incremental", page: null, since: "2026-10-12T10:04:30.000Z" });
  });

  /**
   * A search as HubSpot's answers one (`src/lib/hubspot/api.ts` searchBody): an incremental run asks for every deal
   * changed since five minutes before `since`, in the order of the last change, `size` a page, and no further than `cap`.
   */
  function capped(all: ExternalDeal[], cap: number, size: number): Answer {
    return (request) => {
      const from = request.phase === "incremental" && request.since ? Date.parse(request.since) - CLOCK_MARGIN_MS : Number.NEGATIVE_INFINITY;
      const matching = all
        .filter((one) => Date.parse(one.updatedAt) >= from)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.externalId.localeCompare(b.externalId));
      const start = (request.page - 1) * size;
      const end = start + size;
      const reachesCap = end >= cap && matching.length > end;
      return { items: matching.slice(start, end), page: request.page, last: end >= matching.length || reachesCap, capped: reachesCap, total: matching.length };
    };
  }
  const at = (id: string, iso: string) => deal(id, { stage: "open", version: iso, updatedAt: iso });
  const incremental = { ...NEW_CURSOR, phase: "incremental" as const, since: "2026-10-10T00:00:00.000Z", backfillStartedAt: "2026-10-09T00:00:00.000Z", completedAt: "2026-10-09T00:00:00.000Z" };

  it("goes past HubSpot's cap when more deals than it holds changed within the search's margin", async () => {
    // A bulk edit: six deals changed within a minute, then one more later; the search holds four.
    const all = ["00", "10", "20", "30", "40", "50"].map((second, index) => at(`b${index + 1}`, `2026-10-11T00:00:${second}.000Z`));
    all.push(at("later", "2026-10-11T06:00:00.000Z"));
    const memory = memoryDb();
    memory.setCursor(incremental);
    const { provider: p } = provider({ deals: capped(all, 4, 2) });
    for (let runs = 0; runs < 3; runs += 1) await run(p, memory.db);
    expect([...memory.rows.keys()].sort()).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "later"]);
  });

  it("goes past HubSpot's cap when more deals than it holds share one last change", async () => {
    // An import: six deals changed at the same instant; a search sorted by that instant cannot reach the last two, but
    // the sync must not read the same four for ever and miss every change after them.
    const all = ["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => at(id, "2026-10-11T00:00:00.000Z"));
    all.push(at("later", "2026-10-11T06:00:00.000Z"));
    const memory = memoryDb();
    memory.setCursor(incremental);
    const { provider: p } = provider({ deals: capped(all, 4, 2) });
    for (let runs = 0; runs < 3; runs += 1) await run(p, memory.db);
    expect(memory.rows.has("later")).toBe(true);
  });

  it("reads the linked deals and the won ones still offered again by id: a change is written and flagged, a deletion said", async () => {
    const linked: Row = { id: "row-1", externalVersion: "2026-10-01T02:00:00.000Z", sourceStatus: "present", dealId: "deal-1", deal: deal("1") };
    const offered: Row = { id: "row-2", externalVersion: "2026-10-01T02:00:00.000Z", sourceStatus: "present", dealId: null, deal: deal("2") };
    const open: Row = { id: "row-3", externalVersion: "2026-10-01T02:00:00.000Z", sourceStatus: "present", dealId: null, deal: deal("3", { stage: "open" }) };
    const memory = memoryDb({ rows: [linked, offered, open] });
    const { provider: p, byIdAsked } = provider({
      deals: () => ({ items: [], page: 1, last: true }),
      byId: () => ({ deals: [deal("1", { amount: "1500", version: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" })], missing: ["2"] }),
    });
    const result = await run(p, memory.db);
    expect(byIdAsked).toEqual([["1", "2"]]);
    expect(result).toMatchObject({ outcome: "synced", deleted: 1, changed: 1 });
    expect(memory.rows.get("1")?.deal.amount).toBe("1500");
    expect(memory.rows.get("2")?.sourceStatus).toBe("deleted");
    expect(memory.flagged).toEqual([["1"]]);
  });

  it("brings a linked deal HubSpot gives back after a deletion in again, at the version it had", async () => {
    const back: Row = { id: "row-1", externalVersion: "2026-10-01T02:00:00.000Z", sourceStatus: "deleted", dealId: "deal-1", deal: deal("1") };
    const memory = memoryDb({ rows: [back] });
    await run(provider({ deals: () => ({ items: [], page: 1, last: true }), byId: () => ({ deals: [deal("1")], missing: [] }) }).provider, memory.db);
    expect(memory.rows.get("1")?.sourceStatus).toBe("present");
  });

  it("stops at its page budget with a checkpoint, and does nothing while another run holds the connection", async () => {
    const memory = memoryDb();
    const { provider: p } = provider({ deals: (request) => ({ items: [deal(String(request.page))], page: request.page, last: false }) });
    expect(await run(p, memory.db, { maxPages: 2 })).toMatchObject({ outcome: "partial", pages: 2 });
    expect(memory.cursor()).toMatchObject({ page: 3 });
    expect(memory.finishes.at(-1)).toMatchObject({ kind: "partial" });
    expect(await run(p, memoryDb({ leased: true }).db)).toMatchObject({ outcome: "busy", pages: 0 });
  });

  it("backs off on an outage and on an answer that does not read", async () => {
    const memory = memoryDb();
    expect(await run(provider({ deals: () => new ProviderError("unavailable", "HubSpot deal search: 502") }).provider, memory.db)).toMatchObject({ outcome: "unavailable" });
    expect(memory.finishes[0]).toMatchObject({ kind: "failed", nextSyncAfter: "2026-10-12T10:01:00.000Z", error: "HubSpot did not answer. Vestiarion tries again at 10:01 UTC." });
    const unreadable = memoryDb();
    expect(await run(provider({ deals: () => new ProviderError("bad_response", "x") }).provider, unreadable.db)).toMatchObject({ outcome: "unavailable" });
    expect(unreadable.finishes[0]).toMatchObject({ error: "HubSpot's answer could not be read. Vestiarion tries again at 10:01 UTC." });
  });
});
