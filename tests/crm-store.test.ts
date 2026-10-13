import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Connection } from "@/lib/connectors/connections";
import { amountText, crmStore } from "@/lib/connectors/crm-store";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The CRM runner's database (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H10, H12): a linked deal's
 * changes recorded once in the ledger, cleared when they go, never for a cancelled deal; a reference typed by hand linked
 * with HubSpot's facts as its baseline; a deletion said on the rows HubSpot no longer has.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { ledger: vi.fn() } }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a01";
const DEAL = "dddddddd-0000-4000-8000-0000000000a1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const connection = { id: "conn-1", provider: "hubspot", externalOrgId: "48291736" } as Connection;
const BASELINE = { amount: "12500", currency: "USD", closeOn: "2026-10-01", stage: "won", stageLabel: "Closed Won" };
const row = (fields: Record<string, unknown> = {}) => ({
  id: "row-1", connection_id: "conn-1", external_id: "30117482911", name: "Website rebuild", amount: 12500, currency: "USD", close_on: "2026-10-01",
  pipeline_label: "Sales Pipeline", stage_label: "Closed Won", stage_state: "won", company_external_id: "9100000001", company_name: "Northwind Labs",
  company_email: null, source_status: "present", deal_id: DEAL, baseline: BASELINE, flagged: null, external_updated_at: null, ...fields,
});

function world(rows: unknown[], dealStatus = "active", respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/crm_deals" && sent.method === "GET") return { body: rows };
    if (sent.path === "/rest/v1/crm_deals" && sent.method === "PATCH") return { body: [{ id: "row-1" }] };
    if (sent.path === "/rest/v1/deals") return { body: [{ id: DEAL, title: "Website rebuild", status: dealStatus, external_ref: "30117482911" }] };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

beforeEach(() => mocks.ledger.mockReset());

describe("amountText", () => {
  it("reads a numeric column as an exact decimal", () => {
    expect(amountText(12500)).toBe("12500");
    expect(amountText("4800.500000")).toBe("4800.5");
    expect(amountText(null)).toBeNull();
    expect(amountText("x")).toBeNull();
  });
});

describe("flagChanges", () => {
  it("records an amount changed once, as crm_deal_changed, and keeps the set on the row", async () => {
    const { fake, run } = world([row({ amount: 15000 })]);
    expect(await run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(1);
    const changes = [{ what: "amount", from: { amount: "12500", currency: "USD" }, to: { amount: "15000", currency: "USD" } }];
    expect(fake.requests.find((sent) => sent.method === "PATCH")?.body).toEqual({ flagged: changes });
    const [orgId, entry] = mocks.ledger.mock.calls[0] as [string, { action: string; actor: string; domain: string; summary: string; detail: Record<string, unknown> }];
    expect(orgId).toBe(ORG);
    expect(entry).toMatchObject({ action: "crm_deal_changed", actor: "system", domain: "ar" });
    expect(entry.summary).toBe("HubSpot changed the deal Website rebuild after it was planned: amount. Nothing in Vestiarion changed");
    expect(entry.detail).toEqual({ provider: "hubspot", connectionId: "conn-1", externalOrgId: "48291736", crmDealId: "30117482911", dealId: DEAL, changes });

    // The same changes, read again, are not recorded twice.
    mocks.ledger.mockReset();
    const again = world([row({ amount: 15000, flagged: changes })]);
    expect(await again.run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(0);
    expect(again.fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("records the same changes once when the row hands them back in jsonb's own key order", async () => {
    // Postgres keeps a jsonb object's keys in its own order (shorter first), so `flagged` comes back reordered.
    const changes = [
      { what: "amount", from: { amount: "12500", currency: "USD" }, to: { amount: "15000", currency: "USD" } },
      { what: "stage", from: "won", to: "lost", label: "Closed Lost" },
    ];
    const pg = new PGlite();
    const stored = (await pg.query<{ v: unknown }>("select $1::jsonb as v", [JSON.stringify(changes)])).rows[0].v;
    await pg.close();
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(changes));
    const { fake, run } = world([row({ amount: 15000, stage_state: "lost", stage_label: "Closed Lost", flagged: stored })]);
    expect(await run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(0);
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
    expect(mocks.ledger).not.toHaveBeenCalled();
    // A database started for one query: slower than the rest when the suite runs in parallel.
  }, 60_000);

  it("records a won deal moved to lost and a deal deleted, and nothing for a cancelled deal or an unchanged one", async () => {
    const lost = world([row({ stage_state: "lost", stage_label: "Closed Lost" })]);
    expect(await lost.run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(1);
    const deleted = world([row({ source_status: "deleted" })]);
    expect(await deleted.run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(1);
    expect((mocks.ledger.mock.calls[1][1] as { detail: { changes: unknown } }).detail.changes).toEqual([{ what: "deleted" }]);
    mocks.ledger.mockReset();
    const cancelled = world([row({ stage_state: "lost" })], "cancelled");
    expect(await cancelled.run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(0);
    const unchanged = world([row()]);
    expect(await unchanged.run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(0);
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("clears the record without an entry once the changes are gone", async () => {
    const { fake, run } = world([row({ flagged: [{ what: "deleted" }] })]);
    expect(await run(() => crmStore.flagChanges(connection, ["30117482911"]))).toBe(0);
    expect(fake.requests.find((sent) => sent.method === "PATCH")?.body).toEqual({ flagged: null });
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
});

describe("linkReferences", () => {
  it("links a row to the deal whose reference was typed as HubSpot's deal id, with HubSpot's facts now as its baseline", async () => {
    const { fake, run } = world([row({ deal_id: null, baseline: null })]);
    await run(() => crmStore.linkReferences(connection, ["30117482911"]));
    const link = fake.requests.find((sent) => sent.method === "PATCH");
    expect(link?.params.get("deal_id")).toBe("is.null");
    expect(link?.body).toMatchObject({ deal_id: DEAL, baseline: BASELINE, flagged: null });
  });
});

describe("markDeleted", () => {
  it("says deleted on the rows HubSpot no longer has, once", async () => {
    const { fake, run } = world([]);
    expect(await run(() => crmStore.markDeleted(connection, ["30117400000"]))).toBe(1);
    const update = fake.requests.find((sent) => sent.method === "PATCH");
    expect(update?.params.get("source_status")).toBe("eq.present");
    expect(update?.body).toMatchObject({ source_status: "deleted" });
  });
});

describe("the deal's owner (collections context C5)", () => {
  const deal = {
    externalId: "30117482911",
    version: "2026-10-01T02:04:11.733Z",
    updatedAt: "2026-10-01T02:04:11.733Z",
    name: "Website rebuild",
    amount: "12500",
    currency: "USD",
    closeOn: "2026-10-01",
    pipelineId: "default",
    pipelineLabel: "Sales Pipeline",
    stageId: "closedwon",
    stageLabel: "Closed Won",
    stage: "won" as const,
    company: null,
    ownerId: "77001",
  };

  it("is written beside the deal's facts, on a new row and an updated one", async () => {
    const { fake, run } = world([], "active", (sent) => (sent.path === "/rest/v1/crm_deals" && sent.method === "POST" ? { body: [{ id: "row-new" }] } : undefined));
    await run(() => crmStore.insertDeal(connection, deal));
    const owner = fake.requests.find((sent) => sent.method === "PATCH" && (sent.body as Record<string, unknown>).owner_external_id !== undefined);
    expect(owner?.body).toEqual({ owner_external_id: "77001" });
    expect(owner?.params.get("id")).toBe("eq.row-new");
    // The facts themselves never carry it, so they still write where the column is not there yet.
    const insert = fake.requests.find((sent) => sent.method === "POST");
    expect(insert?.body).not.toHaveProperty("owner_external_id");

    const again = world([]);
    await again.run(() => crmStore.updateDeal(connection, { id: "row-1", externalVersion: null, sourceStatus: "present", dealId: DEAL }, { ...deal, ownerId: null }));
    expect(again.fake.requests.filter((sent) => sent.method === "PATCH").map((sent) => sent.body)).toContainEqual({ owner_external_id: null });
  });

  it("is left out before migration 0110 adds its column, and the deal still syncs", async () => {
    const { run } = world([], "active", (sent) => {
      if (sent.method === "PATCH" && (sent.body as Record<string, unknown>).owner_external_id !== undefined) {
        return { status: 400, body: { code: "PGRST204", message: "Could not find the 'owner_external_id' column of 'crm_deals' in the schema cache" } };
      }
      return undefined;
    });
    await expect(run(() => crmStore.updateDeal(connection, { id: "row-1", externalVersion: null, sourceStatus: "present", dealId: DEAL }, deal))).resolves.toBeUndefined();
  });
});
