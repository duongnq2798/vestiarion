import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Connection } from "@/lib/connectors/connections";
import { NEW_CURSOR } from "@/lib/connectors/cursors";
import type { ExternalBill } from "@/lib/connectors/provider";
import { syncStore } from "@/lib/connectors/sync-store";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The sync runner's database (docs/superpowers/specs/2026-10-12-xero-connector-design.md X2, X7, X10), as the requests
 * PostgREST would receive in the workspace's scope: the lease only when free, the cursor kept per type, a bill kept
 * once, a supplier's link never given a local row by a sync, how a run ended, and the entry for a bill closed after it
 * was added.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b01";
const CONNECTION = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b02";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const ROW = {
  id: CONNECTION, org_id: ORG, provider: "xero", external_org_id: "tenant-1", external_org_name: "Demo Company (Global)", status: "connected",
  scopes: ["offline_access"], connected_by: "u", connected_at: "2026-10-12T07:00:00Z", consent_version: "xero-2026-10-12", consented_at: "2026-10-12T07:00:00Z",
  revoked_at: null, window_from: "2026-07-14", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null,
  sync_lease_until: "2026-10-12T08:05:00Z", payment_account: null, payment_account_at: null,
};
const connection = { id: CONNECTION, orgId: ORG, provider: "xero", externalOrgId: "tenant-1", windowFrom: "2026-07-14" } as Connection;
const BILL: ExternalBill = {
  externalId: "bill-1", version: "2026-10-12T07:15:22.093Z", updatedAt: "2026-10-12T07:15:22.093Z", contactExternalId: "contact-1", contactName: "PowerDirect",
  number: "PD-4471", reference: null, currency: "USD", total: "1250", amountDue: "1250", issuedOn: "2026-10-03", dueOn: "2026-10-28", status: "paid",
};

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn));
  return { fake, run };
}

describe("syncStore", () => {
  it("takes the sync lease only for a connected connection whose lease is free or over", async () => {
    const { fake, run } = world((sent) => (sent.method === "PATCH" ? { body: [ROW] } : undefined));
    const claimed = await run(() => syncStore.claim(CONNECTION, "2026-10-12T08:00:00.000Z", "2026-10-12T08:05:00.000Z"));
    expect(claimed).toMatchObject({ id: CONNECTION, externalOrgId: "tenant-1", windowFrom: "2026-07-14", status: "connected" });
    const patch = fake.requests.find((sent) => sent.method === "PATCH");
    expect(patch?.body).toEqual({ sync_lease_until: "2026-10-12T08:05:00.000Z" });
    expect(patch?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(patch?.params.get("status")).toBe("eq.connected");
    expect(patch?.params.get("or")).toBe("(sync_lease_until.is.null,sync_lease_until.lte.2026-10-12T08:00:00.000Z)");
    const { run: held } = world((sent) => (sent.method === "PATCH" ? { body: [] } : undefined));
    expect(await held(() => syncStore.claim(CONNECTION, "2026-10-12T08:00:00.000Z", "2026-10-12T08:05:00.000Z"))).toBeNull();
  });

  it("reads a cursor, or a new one, and keeps one per connection and type", async () => {
    const { fake, run } = world((sent) =>
      sent.path === "/rest/v1/accounting_sync_cursors" && sent.method === "GET"
        ? { body: [{ phase: "incremental", since: "2026-10-12T06:55:00+00:00", page: 2, high_water: null, run_started_at: "2026-10-12T07:00:00+00:00", changed_in_run: false, backfill_started_at: "2026-10-12T07:00:00+00:00", completed_at: null }] }
        : undefined
    );
    expect(await run(() => syncStore.readCursor(CONNECTION, "bill"))).toMatchObject({ phase: "incremental", since: "2026-10-12T06:55:00.000Z", page: 2 });
    await run(() => syncStore.writeCursor(CONNECTION, "contact", { ...NEW_CURSOR, page: 3 }));
    const upsert = fake.requests.find((sent) => sent.method === "POST" && sent.path === "/rest/v1/accounting_sync_cursors");
    expect(upsert?.params.get("on_conflict")).toBe("org_id,connection_id,object_type");
    expect(upsert?.body).toMatchObject({ org_id: ORG, connection_id: CONNECTION, object_type: "contact", phase: "backfill", page: 3, changed_in_run: false });
    const { run: none } = world();
    expect(await none(() => syncStore.readCursor(CONNECTION, "bill"))).toEqual(NEW_CURSOR);
  });

  it("keeps a new bill once, with its facts", async () => {
    const { fake, run } = world();
    await run(() => syncStore.insertBill(connection, { ...BILL, status: "open" }));
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_bills" && sent.method === "POST");
    expect(insert?.params.get("on_conflict")).toBe("org_id,connection_id,external_id");
    expect(insert?.headers.get("prefer")).toContain("resolution=ignore-duplicates");
    expect(insert?.body).toMatchObject({
      org_id: ORG, connection_id: CONNECTION, external_id: "bill-1", contact_external_id: "contact-1", contact_name: "PowerDirect", number: "PD-4471",
      currency: "USD", total: "1250", amount_due: "1250", issued_on: "2026-10-03", due_on: "2026-10-28", source_status: "open",
      external_version: "2026-10-12T07:15:22.093Z",
    });
  });

  it("records a supplier's newer version as a link without a local row, and leaves an older one alone", async () => {
    const { fake, run } = world((sent) =>
      sent.path === "/rest/v1/external_links" && sent.method === "GET" ? { body: [{ external_id: "contact-old", external_version: "2026-10-12T09:00:00.000Z" }] } : undefined
    );
    const contact = (externalId: string) => ({ externalId, version: "2026-10-12T08:00:00.000Z", updatedAt: "2026-10-12T08:00:00.000Z", name: "PowerDirect", isSupplier: true, archived: false });
    await run(() => syncStore.applyContacts(connection, [contact("contact-old"), contact("contact-new")]));
    const upsert = fake.requests.find((sent) => sent.path === "/rest/v1/external_links" && sent.method === "POST");
    expect(upsert?.params.get("on_conflict")).toBe("org_id,provider,external_org_id,object_type,external_id");
    expect(upsert?.body).toEqual([
      expect.objectContaining({ org_id: ORG, external_id: "contact-new", object_type: "contact", label: "PowerDirect", provider: "xero", external_org_id: "tenant-1" }),
    ]);
    expect(JSON.stringify(upsert?.body)).not.toContain("local_id");
  });

  it("says in the ledger, with ids, that a bill already added was paid in the source", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/external_links" ? { body: [{ local_id: "invoice-7" }] } : undefined));
    await run(() => syncStore.billClosed(connection, BILL));
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(entry).toMatchObject({ p_org_id: ORG, p_actor: "system", p_domain: "system", p_action: "accounting_bill_closed" });
    expect(entry.p_summary).toBe("Xero says bill PD-4471 from PowerDirect was paid there, after it was added");
    expect(entry.p_detail).toEqual({
      provider: "xero", connectionId: CONNECTION, externalOrgId: "tenant-1", billId: "bill-1", invoiceId: "invoice-7", invoiceNumber: "PD-4471", sourceStatus: "paid",
      at: "2026-10-12T07:15:22.093Z",
    });
  });

  it("records how a run ended and lets the lease go", async () => {
    const ended = async (outcome: Parameters<typeof syncStore.finish>[1]) => {
      const { fake, run } = world();
      await run(() => syncStore.finish(CONNECTION, outcome));
      return fake.requests.find((sent) => sent.method === "PATCH")?.body;
    };
    expect(await ended({ kind: "synced", at: "2026-10-12T08:00:00.000Z" })).toEqual({
      sync_lease_until: null, last_synced_at: "2026-10-12T08:00:00.000Z", last_error: null, last_error_at: null, failures: 0, next_sync_after: null,
    });
    expect(await ended({ kind: "failed", at: "2026-10-12T08:00:00.000Z", error: "Xero did not answer.", failures: 2, nextSyncAfter: "2026-10-12T08:02:00.000Z" })).toEqual({
      sync_lease_until: null, last_error: "Xero did not answer.", last_error_at: "2026-10-12T08:00:00.000Z", failures: 2, next_sync_after: "2026-10-12T08:02:00.000Z",
    });
    expect(await ended({ kind: "reconnect", at: "2026-10-12T08:00:00.000Z", error: "Reconnect Xero." })).toMatchObject({ status: "needs_reconnect", sync_lease_until: null });
    expect(await ended({ kind: "partial", at: "2026-10-12T08:00:00.000Z" })).not.toHaveProperty("last_synced_at");
    expect(await ended({ kind: "released", at: "2026-10-12T08:00:00.000Z" })).toEqual({ sync_lease_until: null });
  });
});
