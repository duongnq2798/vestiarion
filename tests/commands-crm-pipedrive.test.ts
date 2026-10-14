import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { planCrmDeal, setCrmReceiptWrites } from "@/lib/commands/crm";
import type { DealDraft } from "@/lib/deals/input";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * What a person does with Pipedrive's deals and receipts (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md
 * P1, P9, P11, P12, P19): planning a won deal forces `pipedrive-<id>` as its reference, with Pipedrive's ids for its
 * entries; writing receipts to Pipedrive is turned on only for a workspace whose payments are real (Arc mainnet, no shadow
 * mode), since Pipedrive names no test company.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { confirmDeal: vi.fn(), ledger: vi.fn() } }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));
vi.mock("@/lib/deals/write", async (original) => ({ ...(await original<typeof import("@/lib/deals/write")>()), confirmDeal: mocks.confirmDeal }));
vi.mock("@/lib/crm-providers", () => ({
  crmProvider: (id: string) => (id === "pipedrive" ? { receipts: { writeScopes: ["deals:full", "deal-fields:full"], testAccounts: false } } : null),
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f21";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f4";
const ROW = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f5";
const DEAL = "dddddddd-0000-4000-8000-0000000000f5";
const CUSTOMER = "cccccccc-0000-4000-8000-0000000000f5";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const orgs = signedOrgs();
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

const CONNECTION = {
  id: "conn-pd", org_id: ORG, provider: "pipedrive", external_org_id: "13013937", external_org_name: "Cedar & Co", status: "connected",
  scopes: ["base", "deals:full", "contacts:read", "deal-fields:full", "users:read", "recents:read", "webhooks:full"], connected_by: USER, connected_at: "2026-10-14T08:00:00Z",
  consent_version: "pipedrive-2026-10-14", consented_at: "2026-10-14T08:00:00Z", revoked_at: null, window_from: "2026-07-16", last_synced_at: null, last_error: null,
  last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};
const ROW_FACTS = {
  id: ROW, connection_id: "conn-pd", external_id: "42", name: "Spring campaign", amount: 200, currency: "USD", close_on: "2026-10-14", pipeline_label: "Sales",
  stage_label: "Negotiation", stage_state: "won", company_external_id: "501", company_name: "Cedar & Co", company_email: "rosa@cedarandco.example", source_status: "present",
  deal_id: null, baseline: null, flagged: null, external_updated_at: "2026-10-14T08:00:00.000Z",
};
const draft = { title: "Spring campaign", externalRef: "typed", customer: { name: "Cedar & Co" } } as unknown as DealDraft;

function world(options: { network?: "arc-testnet" | "arc-mainnet"; shadow?: boolean; respond?: (sent: RecordedRequest) => FakeReply | undefined } = {}) {
  const fake = fakeSupabase((sent) => {
    const reply = options.respond?.(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/crm_deals" && sent.method === "GET") return { body: [ROW_FACTS] };
    if (sent.path === "/rest/v1/crm_deals" && sent.method === "PATCH") return { body: [{ id: ROW }] };
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [CONNECTION] };
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [{ id: "conn-pd" }] };
    if (sent.path === "/rest/v1/shadow_modes") return { body: options.shadow ? [{ org_id: ORG }] : [] };
    if (sent.path === "/rest/v1/external_links" && sent.method === "POST") return { body: [{ id: "link-1" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    return { body: [] };
  });
  const config: VestiarionConfig = { ...base, network: options.network ?? "arc-testnet" };
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.confirmDeal.mockResolvedValue({ dealId: DEAL, created: true, title: "Spring campaign", customerName: "Cedar & Co", customerId: CUSTOMER });
});

describe("planning a won Pipedrive deal", () => {
  it("forces pipedrive-<id> as the reference, carries Pipedrive's ids, and links the organization to the customer", async () => {
    const { fake, run } = world();
    const result = await run(() => planCrmDeal(actor(), { rowId: ROW, draft }));
    expect(result).toMatchObject({ ok: true, dealId: DEAL, message: "Deal confirmed with Cedar & Co: Spring campaign, from Pipedrive. Release each line when it is time to invoice it." });
    expect(mocks.confirmDeal).toHaveBeenCalledWith({
      actorId: USER,
      draft: { ...draft, externalRef: "pipedrive-42" },
      source: { provider: "pipedrive", ids: { companyId: "13013937", dealId: "42", organizationId: "501" } },
    });
    const company = fake.requests.find((sent) => sent.path === "/rest/v1/external_links" && sent.method === "POST");
    expect(company?.body).toMatchObject({ provider: "pipedrive", external_org_id: "13013937", object_type: "company", external_id: "501", local_id: CUSTOMER });
  });

  it("refuses a won deal with no organization in Pipedrive's word", async () => {
    const { run } = world({ respond: (sent) => (sent.path === "/rest/v1/crm_deals" && sent.method === "GET" ? { body: [{ ...ROW_FACTS, company_external_id: null }] } : undefined) });
    const result = await run(() => planCrmDeal(actor(), { rowId: ROW, draft }));
    expect(result).toMatchObject({ ok: false, code: "not_plannable", message: "Spring campaign cannot be planned: no organization in pipedrive." });
    expect(mocks.confirmDeal).not.toHaveBeenCalled();
  });
});

describe("writing receipts to Pipedrive", () => {
  it("stays off for a workspace on Arc testnet, and says why, writing nothing", async () => {
    const { fake, run } = world({ network: "arc-testnet" });
    const outcome = await run(() => setCrmReceiptWrites(actor(), { provider: "pipedrive", on: true }));
    expect(outcome).toMatchObject({ ok: false, code: "reality" });
    expect(outcome.message).toContain("Writing to Pipedrive stays off.");
    expect(outcome.message).toContain("Pipedrive does not say which of its companies are developer sandboxes");
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
  });

  it("stays off for a workspace on Arc mainnet in shadow mode", async () => {
    const { fake, run } = world({ network: "arc-mainnet", shadow: true });
    const outcome = await run(() => setCrmReceiptWrites(actor(), { provider: "pipedrive", on: true }));
    expect(outcome).toMatchObject({ ok: false, code: "reality" });
    expect(outcome.message).toContain("This workspace is in shadow mode");
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
  });

  it("turns on for a workspace on Arc mainnet outside shadow mode, and off again anywhere", async () => {
    const { fake, run } = world({ network: "arc-mainnet" });
    expect(await run(() => setCrmReceiptWrites(actor(), { provider: "pipedrive", on: true }))).toMatchObject({ ok: true });
    expect(fake.requests.find((sent) => sent.method === "PATCH")?.body).toMatchObject({ writes_on: true, writes_by: USER });
    expect(mocks.ledger).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "crm_receipt_writes_changed", detail: expect.objectContaining({ provider: "pipedrive", on: true }) }));
    const testnet = world({ network: "arc-testnet" });
    expect(await testnet.run(() => setCrmReceiptWrites(actor(), { provider: "pipedrive", on: false }))).toMatchObject({ ok: true });
  });

  it("is an owner's or admin's", async () => {
    const { run } = world({ network: "arc-mainnet" });
    expect(await run(() => setCrmReceiptWrites(actor({ role: "approver" }), { provider: "pipedrive", on: true }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});
