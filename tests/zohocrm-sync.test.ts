import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/connectors/connections";
import { crmDealReference, plannable, type ExternalDeal, type StagedCrmDeal } from "@/lib/connectors/crm";
import { syncCrmConnection, type CrmSyncDb } from "@/lib/connectors/crm-sync";
import { NEW_CURSOR, type SyncCursor } from "@/lib/connectors/cursors";
import type { SyncFinish } from "@/lib/connectors/sync";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { zohoCrmProvider } from "@/lib/zohocrm/provider";

/**
 * Zoho CRM through the core's CRM runner (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C6, C7, C8,
 * C9, C10), against an in-memory Zoho CRM and an in-memory database: the deal won in a stage the pipeline calls Closed
 * Won ready to plan, the open one listed, the lost one never kept; and a linked deal Zoho CRM no longer has marked
 * deleted, its row kept.
 */

const SETTINGS = { clientId: "1000.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", clientSecret: "client-secret-value" };
const NOW = Date.parse("2026-10-16T09:00:00.000Z");

const connection: Connection = {
  id: "conn-zc", orgId: "org-1", provider: "zohocrm", externalOrgId: "71234567", externalOrgName: "Lumen Holdings", status: "connected",
  scopes: ["ZohoCRM.modules.deals.READ"], connectedBy: "user-1", connectedAt: "2026-10-16T07:00:00.000Z", consentVersion: "zohocrm-2026-10-16",
  consentedAt: "2026-10-16T07:00:00.000Z", revokedAt: null, windowFrom: "2026-07-18", lastSyncedAt: null, lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null,
  syncLeaseUntil: null, paymentAccount: null, paymentAccountAt: null,
};

const deal = (fields: Record<string, unknown>) => ({
  Deal_Name: "Deal",
  Amount: 100,
  Closing_Date: "2026-10-15",
  Stage: "Qualification",
  Pipeline: "Standard",
  Account_Name: { name: "Lumen Holdings", id: "acc-1" },
  Contact_Name: { name: "Ana Lima", id: "con-1" },
  Owner: { name: "Sam", id: "own-1" },
  Modified_Time: "2026-10-16T08:00:00+00:00",
  ...fields,
});

/** An in-memory Zoho CRM at the EU data center: its deals, its pipelines and its organization. */
function fakeZohoCrm(initial: Array<Record<string, unknown>>) {
  const deals = new Map(initial.map((raw) => [String(raw.id), raw]));
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://www.zohoapis.eu");
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/crm/v8/settings/layouts":
        return json({ layouts: [{ id: "L1" }] });
      case "/crm/v8/settings/pipeline":
        return json({ pipeline: [{ maps: [{ actual_value: "Signed", display_value: "Signed", forecast_type: "Closed Won" }, { actual_value: "Gone quiet", display_value: "Gone quiet", forecast_type: "Closed Lost" }] }] });
      case "/crm/v8/org":
        return json({ org: [{ id: "71234567", company_name: "Lumen Holdings", iso_code: "USD" }] });
      case "/crm/v8/Contacts":
        return json({ data: [{ id: "con-1", Email: "ana@lumen.example" }] });
      case "/crm/v8/Deals": {
        const ids = url.searchParams.get("ids");
        const found = ids ? ids.split(",").flatMap((id) => (deals.has(id) ? [deals.get(id)] : [])) : [...deals.values()];
        return found.length === 0 ? new Response(null, { status: 204 }) : json({ data: found, info: { more_records: false } });
      }
      default:
        return new Response(JSON.stringify({ code: "INVALID_URL_PATTERN" }), { status: 404 });
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, deals };
}

type Row = StagedCrmDeal & { deal: ExternalDeal };

function memoryDb() {
  let cursor: SyncCursor = NEW_CURSOR;
  const rows = new Map<string, Row>();
  const finishes: SyncFinish[] = [];
  const db: CrmSyncDb = {
    claim: async () => connection,
    readCursor: async () => cursor,
    writeCursor: async (_id, _type, next) => {
      cursor = next;
    },
    staged: async (_id, ids) => new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id) as StagedCrmDeal]] : []))),
    insertDeal: async (_c, read) => {
      rows.set(read.externalId, { id: `row-${read.externalId}`, externalVersion: read.version, sourceStatus: "present", dealId: null, deal: read });
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
    flagChanges: async (_c, ids) => ids.length,
    finish: async (_id, outcome) => {
      finishes.push(outcome);
    },
  };
  return { db, rows, finishes };
}

function tokenStore(): TokenStore {
  let row: StoredTokens = { id: "tok-1", version: 1, scopes: [], accessToken: "eu|1000.access", refreshToken: "eu|1000.refresh", expiresAt: NOW + 3_000_000 };
  return {
    read: async () => ({ ...row }),
    lease: async () => ({ ...row }),
    store: async (_who, _version, tokens) => {
      row = { ...row, ...tokens, version: row.version + 1 };
      return true;
    },
    release: async () => undefined,
  };
}

const run = (fake: ReturnType<typeof fakeZohoCrm>, db: CrmSyncDb) =>
  syncCrmConnection({
    connectionId: connection.id,
    provider: zohoCrmProvider(SETTINGS, { fetchImpl: fake.fetchImpl, now: () => NOW }),
    db,
    tokens: tokenStore(),
    now: () => NOW,
    sleep: async () => undefined,
  });

describe("won deals in from Zoho CRM", () => {
  it("brings the deal won in a Closed Won stage in, ready to plan; lists the open one; never keeps the lost one", async () => {
    const fake = fakeZohoCrm([
      deal({ id: "5001", Deal_Name: "Website rebuild", Amount: 4800.5, Stage: "Signed" }),
      deal({ id: "5002", Deal_Name: "Brand refresh", Stage: "Proposal/Price Quote" }),
      deal({ id: "5003", Deal_Name: "Old retainer", Stage: "Gone quiet" }),
    ]);
    const memory = memoryDb();
    const result = await run(fake, memory.db);
    expect(result).toMatchObject({ outcome: "synced", newDeals: 2 });
    const won = memory.rows.get("5001")?.deal as ExternalDeal;
    expect(won).toMatchObject({ name: "Website rebuild", amount: "4800.5", currency: "USD", closeOn: "2026-10-15", stage: "won", company: { name: "Lumen Holdings", email: "ana@lumen.example" } });
    expect(plannable({ stage: won.stage, sourceStatus: "present", dealId: null, amount: won.amount, companyExternalId: won.company?.externalId ?? null }, "Zoho CRM")).toEqual({ ok: true });
    expect(memory.rows.get("5002")?.deal.stage).toBe("open");
    expect(memory.rows.has("5003")).toBe(false);
    expect(crmDealReference("zohocrm", won.externalId)).toBe("zohocrm-5001");
    // A won deal without an account says so in Zoho CRM's word.
    expect(plannable({ stage: "won", sourceStatus: "present", dealId: null, amount: "200", companyExternalId: null }, "Zoho CRM")).toEqual({ ok: false, reason: "No account in Zoho CRM" });
    expect(plannable({ stage: "won", sourceStatus: "present", dealId: null, amount: null, companyExternalId: "acc-1" }, "Zoho CRM")).toEqual({ ok: false, reason: "No amount in Zoho CRM" });
  });

  it("marks a linked deal Zoho CRM no longer has deleted at the next run, its row kept", async () => {
    const fake = fakeZohoCrm([deal({ id: "5001", Stage: "Closed Won" })]);
    const memory = memoryDb();
    await run(fake, memory.db);
    const row = memory.rows.get("5001") as Row;
    memory.rows.set("5001", { ...row, dealId: "deal-1" });
    fake.deals.delete("5001");
    const again = await run(fake, memory.db);
    expect(again.outcome).toBe("synced");
    expect(memory.rows.get("5001")).toMatchObject({ sourceStatus: "deleted", dealId: "deal-1" });
  });
});
