import { describe, expect, it } from "vitest";
import type { Connection } from "@/lib/connectors/connections";
import { crmChanges, crmChangeWords, crmDealReference, factsOf, plannable, type ExternalDeal, type StagedCrmDeal } from "@/lib/connectors/crm";
import { syncCrmConnection, type CrmSyncDb } from "@/lib/connectors/crm-sync";
import { NEW_CURSOR, type SyncCursor } from "@/lib/connectors/cursors";
import type { ProviderTokens } from "@/lib/connectors/provider";
import type { SyncFinish } from "@/lib/connectors/sync";
import { freshAccessToken, type StoredTokens, type TokenStore } from "@/lib/connectors/tokens";
import { pipedriveProvider } from "@/lib/pipedrive/provider";
import { NUDGE_SYNC } from "@/lib/pipedrive/webhooks";
import { API_DOMAIN, COMPANY_ID, fakePipedrive } from "./support/fake-pipedrive";

/**
 * Pipedrive through the core's CRM runner (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P5, P6,
 * P9, P10), against an in-memory Pipedrive and an in-memory database: tokens refreshed under the lease, with the rotated
 * refresh token kept however many runs race; the won deal "Spring campaign" ready to plan, the open one listed; and a
 * planned deal later marked lost, then deleted, in Pipedrive: flagged, its row and its link kept, nothing removed.
 */

const settings = { clientId: "b4d083d9216b7d0c", clientSecret: "client-secret-value" };
const HOST = new URL(API_DOMAIN).host;
const NOW = Date.parse("2026-10-14T09:00:00.000Z");

/** The token row of migration 0101 in memory: a lease with a holder, and a compare-and-set on the version. */
function leasedStore(initial: { accessToken: string; refreshToken: string; expiresAt: number }) {
  let row: StoredTokens = { id: "tok-1", version: 1, scopes: [], ...initial };
  let holder: string | null = null;
  const stored: ProviderTokens[] = [];
  const store: TokenStore = {
    read: async () => ({ ...row }),
    lease: async (who) => {
      await Promise.resolve();
      if (holder !== null && holder !== who) return null;
      holder = who;
      return { ...row };
    },
    store: async (who, version, tokens) => {
      if (holder !== who || version !== row.version) return false;
      row = { ...row, ...tokens, version: row.version + 1 };
      stored.push(tokens);
      holder = null;
      return true;
    },
    release: async (who) => {
      if (holder === who) holder = null;
    },
  };
  return { store, row: () => row, stored };
}

describe("token rotation under concurrency", () => {
  it("refreshes once for two runs at the same moment, keeps the rotated refresh token, and the next refresh uses it", async () => {
    const fake = fakePipedrive();
    const provider = pipedriveProvider(settings, { fetchImpl: fake.fetchImpl, now: () => NOW });
    const tokens = leasedStore({ accessToken: `pd1|${HOST}|v1u:access-a`, refreshToken: `pd1|${HOST}|1:1:refresh-a`, expiresAt: NOW - 1 });
    const sleep = async () => undefined;
    const [one, two] = await Promise.all([
      freshAccessToken({ store: tokens.store, refresh: provider.refresh, now: () => NOW, sleep }),
      freshAccessToken({ store: tokens.store, refresh: provider.refresh, now: () => NOW, sleep }),
    ]);
    expect(fake.refreshes()).toBe(1);
    expect(one).toEqual({ ok: true, accessToken: `pd1|${HOST}|v1u:access-b` });
    expect(two).toEqual({ ok: true, accessToken: `pd1|${HOST}|v1u:access-b` });
    expect(tokens.row().refreshToken).toBe(`pd1|${HOST}|1:1:refresh-b`);

    // Expired again: the stored, rotated refresh token is the one Pipedrive takes now. A lost one would be refused.
    const later = NOW + 4_000_000;
    const again = await freshAccessToken({ store: tokens.store, refresh: provider.refresh, now: () => later, sleep });
    expect(again).toEqual({ ok: true, accessToken: `pd1|${HOST}|v1u:access-c` });
    expect(tokens.row().refreshToken).toBe(`pd1|${HOST}|1:1:refresh-c`);
    expect(fake.refreshes()).toBe(2);
  });

  it("asks a person to reconnect when Pipedrive refuses the refresh token (the app uninstalled)", async () => {
    const fake = fakePipedrive();
    const provider = pipedriveProvider(settings, { fetchImpl: fake.fetchImpl, now: () => NOW });
    const tokens = leasedStore({ accessToken: `pd1|${HOST}|v1u:access-a`, refreshToken: `pd1|${HOST}|1:1:uninstalled`, expiresAt: NOW - 1 });
    expect(await freshAccessToken({ store: tokens.store, refresh: provider.refresh, now: () => NOW })).toEqual({ ok: false, reason: "reconnect" });
  });
});

const connection: Connection = {
  id: "conn-pd", orgId: "org-1", provider: "pipedrive", externalOrgId: String(COMPANY_ID), externalOrgName: "Cedar & Co", status: "connected",
  scopes: ["base", "deals:full", "contacts:read", "deal-fields:full"], connectedBy: "user-1", connectedAt: "2026-10-14T07:00:00.000Z", consentVersion: "pipedrive-2026-10-14",
  consentedAt: "2026-10-14T07:00:00.000Z", revokedAt: null, windowFrom: "2026-07-16", lastSyncedAt: null, lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null,
  syncLeaseUntil: null, paymentAccount: null, paymentAccountAt: null,
};

type Row = StagedCrmDeal & { deal: ExternalDeal; baseline: ExternalDeal | null };

function memoryDb() {
  let cursor: SyncCursor = NEW_CURSOR;
  const rows = new Map<string, Row>();
  const finishes: SyncFinish[] = [];
  const flagged: string[][] = [];
  const removed: string[] = [];
  const db: CrmSyncDb = {
    claim: async () => connection,
    readCursor: async () => cursor,
    writeCursor: async (_id, _type, next) => {
      cursor = next;
    },
    staged: async (_id, ids) => new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id) as StagedCrmDeal]] : []))),
    insertDeal: async (_c, read) => {
      rows.set(read.externalId, { id: `row-${read.externalId}`, externalVersion: read.version, sourceStatus: "present", dealId: null, deal: read, baseline: null });
    },
    updateDeal: async (_c, row, read) => {
      rows.set(read.externalId, { ...(row as Row), externalVersion: read.version, sourceStatus: "present", deal: read });
    },
    linkReferences: async () => undefined,
    recheckDeals: async () =>
      [...rows.values()].filter((row) => row.dealId !== null || (row.deal.stage === "won" && row.sourceStatus === "present")).map((row) => ({ externalId: row.deal.externalId, linked: row.dealId !== null })),
    markDeleted: async (_c, ids) => {
      let marked = 0;
      for (const id of ids) {
        const row = rows.get(id);
        if (row && row.sourceStatus === "present") {
          rows.set(id, { ...row, sourceStatus: "deleted" });
          marked += 1;
        }
      }
      return marked;
    },
    flagChanges: async (_c, ids) => {
      flagged.push([...ids]);
      return ids.length;
    },
    finish: async (_id, outcome) => {
      finishes.push(outcome);
    },
  };
  return { db, rows, finishes, flagged, removed, setCursor: (next: SyncCursor) => (cursor = next), cursor: () => cursor };
}

function run(fake: ReturnType<typeof fakePipedrive>, db: CrmSyncDb, now = NOW) {
  const tokens = leasedStore({ accessToken: `pd1|${HOST}|v1u:access-a`, refreshToken: `pd1|${HOST}|1:1:refresh-a`, expiresAt: now + 3_000_000 });
  return syncCrmConnection({ connectionId: connection.id, provider: pipedriveProvider(settings, { fetchImpl: fake.fetchImpl, now: () => now }), db, tokens: tokens.store, now: () => now, sleep: async () => undefined });
}

describe("won deals in from Pipedrive", () => {
  it("brings the won deal in, ready to plan, and the open deal listed", async () => {
    const fake = fakePipedrive();
    fake.addDeal({ id: 42, title: "Spring campaign", value: 200, currency: "USD", status: "won", stage_id: 4, local_won_date: "2026-10-14", update_time: "2026-10-14T08:00:00Z" });
    fake.addDeal({ id: 43, title: "Summer launch", value: 900, status: "open", update_time: "2026-10-14T08:05:00Z" });
    const memory = memoryDb();
    const result = await run(fake, memory.db);
    expect(result).toMatchObject({ outcome: "synced", newDeals: 2 });
    const won = memory.rows.get("42")?.deal as ExternalDeal;
    expect(won).toMatchObject({ name: "Spring campaign", amount: "200", currency: "USD", closeOn: "2026-10-14", stage: "won", company: { name: "Cedar & Co", email: "rosa@cedarandco.example" } });
    expect(plannable({ stage: won.stage, sourceStatus: "present", dealId: null, amount: won.amount, companyExternalId: won.company?.externalId ?? null }, "Pipedrive")).toEqual({ ok: true });
    expect(memory.rows.get("43")?.deal.stage).toBe("open");
    // The reference the planned deal carries: never a bare number someone might type.
    expect(crmDealReference("pipedrive", won.externalId)).toBe("pipedrive-42");
    expect(crmDealReference("hubspot", "353738230485")).toBe("353738230485");
    // A won deal without an organization says so in Pipedrive's word.
    expect(plannable({ stage: "won", sourceStatus: "present", dealId: null, amount: "200", companyExternalId: null }, "Pipedrive")).toEqual({ ok: false, reason: "No organization in Pipedrive" });
    expect(plannable({ stage: "won", sourceStatus: "present", dealId: null, amount: "200", companyExternalId: null }, "HubSpot")).toEqual({ ok: false, reason: "No company in HubSpot" });
  });

  it("flags a planned deal marked lost, then deleted, in Pipedrive; keeps its row and its link, and removes nothing", async () => {
    const fake = fakePipedrive();
    fake.addDeal({ id: 42, title: "Spring campaign", value: 200, status: "won", stage_id: 4, local_won_date: "2026-10-14", update_time: "2026-10-14T08:00:00Z" });
    const memory = memoryDb();
    await run(fake, memory.db);
    // A person planned it: the row is linked, with Pipedrive's facts then as its baseline.
    const planned = memory.rows.get("42") as Row;
    memory.rows.set("42", { ...planned, dealId: "deal-1", baseline: planned.deal });

    // Marked lost in Pipedrive.
    fake.deals.set(42, { ...fake.deals.get(42)!, status: "lost", lost_reason: "Budget cut", update_time: "2026-10-14T09:30:00Z" });
    const later = Date.parse("2026-10-14T09:45:00.000Z");
    const lost = await run(fake, memory.db, later);
    expect(lost.outcome).toBe("synced");
    const row = memory.rows.get("42") as Row;
    expect(row).toMatchObject({ dealId: "deal-1", sourceStatus: "present", deal: { stage: "lost", stageLabel: "Budget cut" } });
    const changes = crmChanges(factsOf(row.baseline as ExternalDeal), { ...factsOf(row.deal), deleted: false }, "active");
    expect(changes).toContainEqual({ what: "stage", from: "won", to: "lost", label: "Budget cut" });
    expect(changes.map((change) => crmChangeWords(change, "Pipedrive"))).toContain("Marked lost in Pipedrive (Budget cut). Nothing is cancelled: cancel the deal if it is off.");
    expect(memory.flagged.flat()).toContain("42");

    // Deleted in Pipedrive: marked deleted, still linked; nothing is ever removed.
    fake.deals.set(42, { ...fake.deals.get(42)!, status: "deleted", update_time: "2026-10-14T10:00:00Z" });
    const deleted = await run(fake, memory.db, Date.parse("2026-10-14T10:15:00.000Z"));
    expect(deleted.deleted).toBe(1);
    expect(memory.rows.get("42")).toMatchObject({ dealId: "deal-1", sourceStatus: "deleted" });
    expect(crmChanges(factsOf(row.baseline as ExternalDeal), { ...factsOf(row.deal), deleted: true }, "active")).toEqual([{ what: "deleted" }]);
    expect(memory.removed).toEqual([]);
  });

  it("finds a deleted deal no search returns by reading it by id, and a changed amount as a change", async () => {
    const fake = fakePipedrive();
    fake.addDeal({ id: 42, title: "Spring campaign", value: 200, status: "won", local_won_date: "2026-10-14", update_time: "2026-10-14T08:00:00Z" });
    const memory = memoryDb();
    await run(fake, memory.db);
    const planned = memory.rows.get("42") as Row;
    memory.rows.set("42", { ...planned, dealId: "deal-1", baseline: planned.deal });
    // The amount changed, and later the deal is gone even from Pipedrive's 30 days of deleted ones.
    fake.deals.set(42, { ...fake.deals.get(42)!, value: 250, update_time: "2026-10-14T09:30:00Z" });
    await run(fake, memory.db, Date.parse("2026-10-14T09:45:00.000Z"));
    const changed = memory.rows.get("42") as Row;
    expect(crmChanges(factsOf(changed.baseline as ExternalDeal), { ...factsOf(changed.deal), deleted: false }, "active")).toEqual([
      { what: "amount", from: { amount: "200", currency: "USD" }, to: { amount: "250", currency: "USD" } },
    ]);
    fake.deals.delete(42);
    const gone = await run(fake, memory.db, Date.parse("2026-10-14T10:15:00.000Z"));
    expect(gone.deleted).toBe(1);
    expect(memory.rows.get("42")).toMatchObject({ dealId: "deal-1", sourceStatus: "deleted" });
  });

  it("waits out a short rate limit once, and ends the run with its checkpoint on a long one", async () => {
    const fake = fakePipedrive();
    fake.addDeal({ id: 42, status: "won", local_won_date: "2026-10-14" });
    fake.state.fail.set("GET /api/v2/deals", [{ status: 429, headers: { "x-ratelimit-reset": "2" } }]);
    expect((await run(fake, memoryDb().db)).outcome).toBe("synced");
    const slow = fakePipedrive();
    slow.addDeal({ id: 42, status: "won", local_won_date: "2026-10-14" });
    slow.state.fail.set("GET /api/v2/deals", [{ status: 429, headers: { "retry-after": "120" } }]);
    const memory = memoryDb();
    expect((await run(slow, memory.db)).outcome).toBe("rate_limited");
    expect(memory.finishes.at(-1)).toMatchObject({ kind: "failed", error: expect.stringContaining("Pipedrive asked Vestiarion to slow down") });
  });
});

describe("a sync a webhook starts", () => {
  /** A company with 250 won deals kept, one of them planned, as the sweeper and webhooks find it. */
  async function company() {
    const fake = fakePipedrive();
    for (let id = 1; id <= 250; id += 1) fake.addDeal({ id, title: `Deal ${id}`, value: 100, status: "won", local_won_date: "2026-10-14", update_time: "2026-10-14T08:00:00Z" });
    const memory = memoryDb();
    await run(fake, memory.db);
    const planned = memory.rows.get("7") as Row;
    memory.rows.set("7", { ...planned, dealId: "deal-7", baseline: planned.deal });
    return { fake, memory };
  }
  const byId = (fake: ReturnType<typeof fakePipedrive>, since: number) =>
    fake.requests.slice(since).filter((request) => request.path.startsWith("/api/v2/deals") && request.query.has("ids"));

  it("reads only what changed, never every kept deal again by id: one notice is one small read, not hundreds", async () => {
    const { fake, memory } = await company();
    fake.deals.set(7, { ...fake.deals.get(7)!, value: 150, update_time: "2026-10-14T09:30:00Z" });
    const before = fake.requests.length;
    const later = Date.parse("2026-10-14T09:31:00.000Z");
    const tokens = leasedStore({ accessToken: `pd1|${HOST}|v1u:access-a`, refreshToken: `pd1|${HOST}|1:1:refresh-a`, expiresAt: later + 3_000_000 });
    const nudged = await syncCrmConnection({
      connectionId: connection.id,
      provider: pipedriveProvider(settings, { fetchImpl: fake.fetchImpl, now: () => later }),
      db: memory.db,
      tokens: tokens.store,
      now: () => later,
      sleep: async () => undefined,
      ...NUDGE_SYNC,
    });
    expect(nudged.outcome).toBe("synced");
    // The planned deal's change is still found, from the changes since the last run.
    expect(memory.flagged.flat()).toContain("7");
    expect((memory.rows.get("7") as Row).deal.amount).toBe("150");
    expect(byId(fake, before)).toHaveLength(0);
    expect(fake.requests.length - before).toBeLessThanOrEqual(6);
  });

  it("leaves the read by id of every kept deal to the sweeper's run, which still does it", async () => {
    const { fake, memory } = await company();
    const before = fake.requests.length;
    await run(fake, memory.db, Date.parse("2026-10-14T09:31:00.000Z"));
    expect(byId(fake, before).length).toBeGreaterThanOrEqual(3);
  });
});
