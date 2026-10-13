import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { overwriteCrmReceipt, setCrmReceiptWrites } from "@/lib/commands/crm";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { conflictKey } from "@/lib/connectors/crm-receipts-run";
import type { FieldConflict } from "@/lib/connectors/crm-receipts";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Writing receipts to HubSpot, turned on or off, and Vestiarion's figures written over a conflict
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3, R5): an owner's or admin's, from the console; on only with
 * HubSpot's write scopes granted; an overwrite only over the conflict the page showed.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { ledger: vi.fn() } }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));
vi.mock("@/lib/crm-providers", () => ({
  crmProvider: (id: string) => (id === "hubspot" ? { receipts: { writeScopes: ["crm.objects.deals.write", "crm.schemas.deals.write"] } } : null),
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f11";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f3";
const DEAL = "dddddddd-0000-4000-8000-0000000000f2";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "admin", mode: "live", surface: { kind: "console" }, ...fields });

const WRITE_SCOPES = ["oauth", "crm.objects.deals.read", "crm.objects.deals.write", "crm.schemas.deals.write"];
const connectionRow = (scopes: string[], status = "connected") => ({
  id: "conn-1", org_id: ORG, provider: "hubspot", external_org_id: "48291736", external_org_name: "northstar.example", status, scopes,
  connected_by: USER, connected_at: "2026-10-12T08:00:00Z", consent_version: "hubspot-2026-10-13", consented_at: "2026-10-12T08:00:00Z", revoked_at: null,
  window_from: "2026-07-14", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
  payment_account: null, payment_account_at: null,
});
const CONFLICTS: FieldConflict[] = [{ field: "vestiarion_still_owed", ours: "3000", theirs: "0", next: "1000" }];
const conflictRow = {
  id: "write-1", connection_id: "conn-1", crm_deal_id: "crm-1", deal_id: DEAL, external_deal_id: "9001", fields: { vestiarion_still_owed: "1000.00" }, network: "arc-testnet",
  shadow: false, account_type: "DEVELOPER_TEST", account_test: true, state: "conflict", reason: "changed_in_crm", message: "Someone changed Still owed", attempts: 1,
  next_attempt_at: null, sending_until: null, conflicts: CONFLICTS, overwrite: null, overwrite_by: null, overwrite_at: null, read_back: null, sent_at: null,
  written_at: null, created_at: "2026-10-13T07:00:00Z",
};

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => respond(sent) ?? { body: [] });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

beforeEach(() => {
  mocks.ledger.mockReset();
});

describe("who may", () => {
  it("is an owner's or admin's, from the console only", async () => {
    expect(COMMAND_PERMISSIONS["crm.receipt_writes"]).toBe("integrations.manage");
    expect(COMMAND_PERMISSIONS["crm.receipt_overwrite"]).toBe("integrations.manage");
    for (const surface of ["telegram", "api", "slack", "github"] as const) {
      expect(SURFACE_COMMANDS[surface]).not.toContain("crm.receipt_writes");
      expect(SURFACE_COMMANDS[surface]).not.toContain("crm.receipt_overwrite");
    }
    const { run } = world();
    expect(await run(() => setCrmReceiptWrites(actor({ role: "approver" }), { provider: "hubspot", on: true }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => overwriteCrmReceipt(actor({ role: "viewer" }), { dealId: DEAL, seen: "x", label: "HubSpot" }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("setCrmReceiptWrites", () => {
  it("refuses to turn writing on before HubSpot granted the write scopes, and writes nothing", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET" ? { body: [connectionRow(["oauth", "crm.objects.deals.read"])] } : undefined));
    const outcome = await run(() => setCrmReceiptWrites(actor(), { provider: "hubspot", on: true }));
    expect(outcome).toMatchObject({ ok: false, code: "scope" });
    expect(outcome.message).toMatch(/Allow writing to HubSpot/);
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
  });

  it("turns writing on with the scopes, records who, and says when it starts", async () => {
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [connectionRow(WRITE_SCOPES)] };
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [{ id: "conn-1" }] };
      return undefined;
    });
    const outcome = await run(() => setCrmReceiptWrites(actor(), { provider: "hubspot", on: true }));
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.message).toMatch(/from the next sync/);
    const patch = fake.requests.find((sent) => sent.method === "PATCH");
    expect(patch?.body).toMatchObject({ writes_on: true, writes_by: USER });
    expect(patch?.params.get("status")).toBe("eq.connected");
    expect(mocks.ledger).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "crm_receipt_writes_changed", actor: "human", detail: expect.objectContaining({ on: true, by: USER }) }));
  });

  it("turns writing off whatever the scopes, and says what was written stays", async () => {
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [connectionRow([])] };
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [{ id: "conn-1" }] };
      return undefined;
    });
    const outcome = await run(() => setCrmReceiptWrites(actor(), { provider: "hubspot", on: false }));
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.message).toMatch(/What it wrote stays there/);
    expect(fake.requests.find((sent) => sent.method === "PATCH")?.body).toMatchObject({ writes_on: false });
  });

  it("says HubSpot is not connected when it is not", async () => {
    const { run } = world();
    expect(await run(() => setCrmReceiptWrites(actor(), { provider: "hubspot", on: true }))).toMatchObject({ ok: false, code: "not_connected" });
  });
});

describe("overwriteCrmReceipt", () => {
  it("refuses a conflict that changed since the page showed it, before anything is written", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/crm_receipt_writes" && sent.method === "GET" ? { body: [conflictRow] } : undefined));
    const outcome = await run(() => overwriteCrmReceipt(actor(), { dealId: DEAL, seen: "0".repeat(64), label: "HubSpot" }));
    expect(outcome).toMatchObject({ ok: false, code: "changed" });
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
  });

  it("queues the write again with what HubSpot held when the person chose, and records it", async () => {
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/crm_receipt_writes" && sent.method === "GET") return { body: [conflictRow] };
      if (sent.path === "/rest/v1/crm_receipt_writes" && sent.method === "PATCH") return { body: [{ ...conflictRow, state: "queued", overwrite: { vestiarion_still_owed: "0" } }] };
      return undefined;
    });
    const outcome = await run(() => overwriteCrmReceipt(actor(), { dealId: DEAL, seen: conflictKey(CONFLICTS), label: "HubSpot" }));
    expect(outcome).toMatchObject({ ok: true });
    const patch = fake.requests.find((sent) => sent.method === "PATCH");
    expect(patch?.body).toMatchObject({ state: "queued", overwrite: { vestiarion_still_owed: "0" }, overwrite_by: USER });
    expect(patch?.params.get("state")).toBe("in.(conflict)");
    expect(mocks.ledger).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "crm_receipt_overwrite_chosen", detail: expect.objectContaining({ seen: { vestiarion_still_owed: "0" } }) }));
  });

  it("says nothing waits when there is no conflict", async () => {
    const { run } = world();
    expect(await run(() => overwriteCrmReceipt(actor(), { dealId: DEAL, seen: conflictKey(CONFLICTS), label: "HubSpot" }))).toMatchObject({ ok: false, code: "not_found" });
  });
});
