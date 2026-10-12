import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { fillCrmEmail, keepCrmChange, planCrmDeal } from "@/lib/commands/crm";
import { changeDeal } from "@/lib/commands/deals";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import type { CrmChange } from "@/lib/connectors/crm";
import { changesKey } from "@/lib/connectors/crm-store";
import type { ChangeDraft, DealDraft } from "@/lib/deals/input";
import { DealError } from "@/lib/deals/write";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * What a person does with HubSpot's deals (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H3, H11, H12,
 * H13): planning a won deal reads its row again, forces HubSpot's deal id as the reference, confirms through the deal
 * path with the CRM's ids for its entry, and links the row and the company; keeping a change records it once; a billing
 * email is filled only while the customer has none. Who may: whoever adds deals, from the console.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { confirmDeal: vi.fn(), writeChange: vi.fn(), readDeal: vi.fn(), changeEmail: vi.fn(), ledger: vi.fn() } }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));
vi.mock("@/lib/deals/write", async (original) => ({ ...(await original<typeof import("@/lib/deals/write")>()), confirmDeal: mocks.confirmDeal, changeDeal: mocks.writeChange }));
vi.mock("@/lib/deals/read", async (original) => ({ ...(await original<typeof import("@/lib/deals/read")>()), readDeal: mocks.readDeal }));
vi.mock("@/lib/payment-notices", async (original) => ({ ...(await original<typeof import("@/lib/payment-notices")>()), changeCounterpartyNoticeEmail: mocks.changeEmail }));
const { NoticeEmailTaken } = await vi.importActual<typeof import("@/lib/payment-notices")>("@/lib/payment-notices");

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";
const ROW = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f2";
const DEAL = "dddddddd-0000-4000-8000-0000000000f1";
const CUSTOMER = "cccccccc-0000-4000-8000-0000000000f1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const orgs = signedOrgs();
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "admin", mode: "live", surface: { kind: "console" }, ...fields });

const CONNECTION = {
  id: "conn-1", org_id: ORG, provider: "hubspot", external_org_id: "48291736", external_org_name: "northstar-studio.example", status: "connected", scopes: [],
  connected_by: USER, connected_at: "2026-10-12T08:00:00Z", consent_version: "hubspot-2026-10-12", consented_at: "2026-10-12T08:00:00Z", revoked_at: null,
  window_from: "2026-07-14", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
  payment_account: null, payment_account_at: null,
};
const crmRow = (fields: Record<string, unknown> = {}) => ({
  id: ROW, connection_id: "conn-1", external_id: "30117482911", name: "Website rebuild", amount: 12500, currency: "USD", close_on: "2026-10-01",
  pipeline_label: "Sales Pipeline", stage_label: "Closed Won", stage_state: "won", company_external_id: "9100000001", company_name: "Northwind Labs",
  company_email: "jane.ito@northwind.example", source_status: "present", deal_id: null, baseline: null, flagged: null, external_updated_at: "2026-10-01T02:04:11.733Z",
  ...fields,
});
const draft = { title: "Website rebuild", externalRef: "typed-by-the-person", customer: { name: "Northwind Labs" } } as unknown as DealDraft;

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined, row = crmRow()) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/crm_deals" && sent.method === "GET") return { body: [row] };
    if (sent.path === "/rest/v1/crm_deals" && sent.method === "PATCH") return { body: [{ id: ROW }] };
    if (sent.path === "/rest/v1/accounting_connections") return { body: [CONNECTION] };
    if (sent.path === "/rest/v1/external_links" && sent.method === "POST") return { body: [{ id: "link-1" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.confirmDeal.mockResolvedValue({ dealId: DEAL, created: true, title: "Website rebuild", customerName: "Northwind Labs", customerId: CUSTOMER });
});

describe("who may act on HubSpot's deals", () => {
  it("is who adds deals, from the console only, and an approver or viewer is refused before anything is read", async () => {
    for (const command of ["crm.plan_deal", "crm.keep_change", "crm.fill_email"] as const) {
      expect(COMMAND_PERMISSIONS[command]).toBe(COMMAND_PERMISSIONS["deal.create"]);
      for (const surface of ["telegram", "slack", "api", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(command);
    }
    const { fake, run } = world();
    for (const role of ["approver", "viewer"] as const) {
      expect(await run(() => planCrmDeal(actor({ role }), { rowId: ROW, draft }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => keepCrmChange(actor({ role }), { dealId: DEAL, seen: "" }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await run(() => fillCrmEmail(actor({ role }), { counterpartyId: CUSTOMER, email: "" }))).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("planCrmDeal", () => {
  it("confirms the person's form with HubSpot's deal id as its reference and the CRM's ids, then links the row and the company", async () => {
    const { fake, run } = world();
    const result = await run(() => planCrmDeal(actor(), { rowId: ROW, draft }));
    expect(result).toMatchObject({ ok: true, dealId: DEAL, created: true, message: "Deal confirmed with Northwind Labs: Website rebuild, from HubSpot. Release each line when it is time to invoice it." });
    expect(mocks.confirmDeal).toHaveBeenCalledWith({
      actorId: USER,
      draft: { ...draft, externalRef: "30117482911" },
      source: { provider: "hubspot", ids: { hubId: "48291736", dealId: "30117482911", companyId: "9100000001" } },
    });
    const link = fake.requests.find((sent) => sent.path === "/rest/v1/crm_deals" && sent.method === "PATCH");
    expect(link?.params.get("id")).toBe(`eq.${ROW}`);
    expect(link?.body).toMatchObject({ deal_id: DEAL, baseline: { amount: "12500", currency: "USD", closeOn: "2026-10-01", stage: "won", stageLabel: "Closed Won" }, flagged: null });
    const company = fake.requests.find((sent) => sent.path === "/rest/v1/external_links" && sent.method === "POST");
    expect(company?.body).toMatchObject({ connection_id: "conn-1", provider: "hubspot", external_org_id: "48291736", object_type: "company", external_id: "9100000001", local_id: CUSTOMER, label: "Northwind Labs" });
  });

  it("refuses a deal that is not won, was deleted, or has no amount or company, before confirming anything", async () => {
    for (const [fields, words] of [
      [{ stage_state: "open" }, "not won yet"],
      [{ source_status: "deleted" }, "deleted in hubspot"],
      [{ amount: null }, "no amount in hubspot"],
      [{ company_external_id: null }, "no company in hubspot"],
    ] as const) {
      const { run } = world(undefined, crmRow(fields));
      expect(await run(() => planCrmDeal(actor(), { rowId: ROW, draft }))).toEqual({ ok: false, code: "not_plannable", message: `Website rebuild cannot be planned: ${words}.` });
    }
    expect(mocks.confirmDeal).not.toHaveBeenCalled();
  });

  it("says planned already for a second plan of the same HubSpot deal, and keeps a company already linked", async () => {
    mocks.confirmDeal.mockRejectedValue(new DealError("external_ref_taken"));
    const { run } = world(undefined, crmRow({ deal_id: DEAL }));
    expect(await run(() => planCrmDeal(actor(), { rowId: ROW, draft }))).toMatchObject({ ok: false, code: "planned" });

    mocks.confirmDeal.mockResolvedValue({ dealId: DEAL, created: false, title: "Website rebuild", customerName: "Northwind Labs", customerId: CUSTOMER });
    const linked = world((sent) => (sent.path === "/rest/v1/external_links" && sent.method === "GET" ? { body: [{ id: "link-0", local_id: "someone-else" }] } : undefined), crmRow({ deal_id: DEAL }));
    expect(await linked.run(() => planCrmDeal(actor(), { rowId: ROW, draft }))).toMatchObject({ ok: true, created: false, message: "This deal was confirmed already: Website rebuild." });
    expect(linked.fake.requests.some((sent) => sent.path === "/rest/v1/external_links" && sent.method !== "GET")).toBe(false);
  });

  it("says the list moved on for a row that is not there, and not set up before migration 0105", async () => {
    const gone = world((sent) => (sent.path === "/rest/v1/crm_deals" ? { body: [] } : undefined));
    expect(await gone.run(() => planCrmDeal(actor(), { rowId: ROW, draft }))).toMatchObject({ ok: false, code: "not_found" });
    const early = world((sent) => (sent.path === "/rest/v1/crm_deals" ? { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.crm_deals'" } } : undefined));
    expect(await early.run(() => planCrmDeal(actor(), { rowId: ROW, draft }))).toMatchObject({ ok: false, code: "not_ready" });
  });
});

const AMOUNT_TO_15000: CrmChange = { what: "amount", from: { amount: "12500", currency: "USD" }, to: { amount: "15000", currency: "USD" } };

describe("keepCrmChange", () => {
  const deal = { available: true, deal: { title: "Website rebuild", facts: { id: DEAL, status: "active" } } };

  it("marks HubSpot's changes as seen, with a signed entry naming them", async () => {
    mocks.readDeal.mockResolvedValue(deal);
    const changed = crmRow({ deal_id: DEAL, amount: 15000, baseline: { amount: "12500", currency: "USD", closeOn: "2026-10-01", stage: "won", stageLabel: "Closed Won" } });
    const { fake, run } = world(undefined, changed);
    expect(await run(() => keepCrmChange(actor(), { dealId: DEAL, seen: changesKey([AMOUNT_TO_15000]) }))).toEqual({
      ok: true,
      message: "Website rebuild stays as it is. HubSpot's changes are marked as seen.",
    });
    const reviewed = fake.requests.find((sent) => sent.path === "/rest/v1/crm_deals" && sent.method === "PATCH");
    expect(reviewed?.body).toMatchObject({ baseline: { amount: "15000" }, flagged: null, reviewed_by: USER });
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
    const [orgId, entry] = mocks.ledger.mock.calls[0] as [string, { action: string; actor: string; domain: string; detail: Record<string, unknown> }];
    expect(orgId).toBe(ORG);
    expect(entry).toMatchObject({ action: "crm_deal_change_kept", actor: "human", domain: "ar" });
    expect(entry.detail).toMatchObject({ by: USER, provider: "hubspot", crmDealId: "30117482911", dealId: DEAL });
    expect(entry.detail.changes).toEqual([{ what: "amount", from: { amount: "12500", currency: "USD" }, to: { amount: "15000", currency: "USD" } }]);
  });

  it("writes nothing when nothing changed", async () => {
    mocks.readDeal.mockResolvedValue(deal);
    const same = crmRow({ deal_id: DEAL, baseline: { amount: "12500", currency: "USD", closeOn: "2026-10-01", stage: "won", stageLabel: "Closed Won" } });
    const { fake, run } = world(undefined, same);
    expect(await run(() => keepCrmChange(actor(), { dealId: DEAL, seen: changesKey([AMOUNT_TO_15000]) }))).toEqual({ ok: true, message: "Nothing changed in HubSpot since." });
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("keeps only the changes the page showed: HubSpot changed the deal again since, so nothing is marked as seen", async () => {
    mocks.readDeal.mockResolvedValue(deal);
    // The page said 12,500 to 15,000; HubSpot has 17,000 now, which no one was shown.
    const again = crmRow({ deal_id: DEAL, amount: 17000, baseline: { amount: "12500", currency: "USD", closeOn: "2026-10-01", stage: "won", stageLabel: "Closed Won" } });
    const { fake, run } = world(undefined, again);
    expect(await run(() => keepCrmChange(actor(), { dealId: DEAL, seen: changesKey([AMOUNT_TO_15000]) }))).toMatchObject({ ok: false, code: "changed", changed: true });
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
});

describe("changeDeal from HubSpot's changes", () => {
  const change = { dealId: DEAL, kind: "revised", baseVersion: 1, totalMinor: 1_500_000, lines: [], reason: "From HubSpot", idempotencyKey: "change-key-1" } as unknown as ChangeDraft;
  const changed = (amount: number) =>
    crmRow({ deal_id: DEAL, amount, baseline: { amount: "12500", currency: "USD", closeOn: "2026-10-01", stage: "won", stageLabel: "Closed Won" } });

  it("saves the version from the changes the page showed, says it came from HubSpot, and marks them as seen", async () => {
    mocks.writeChange.mockResolvedValue({ version: 2, created: true, title: "Website rebuild", kind: "revised" });
    const { fake, run } = world(undefined, changed(15000));
    expect(await run(() => changeDeal(actor(), { change, fromCrm: { seen: changesKey([AMOUNT_TO_15000]) } }))).toMatchObject({ ok: true, version: 2 });
    expect(mocks.writeChange).toHaveBeenCalledWith({
      actorId: USER,
      change,
      source: { provider: "hubspot", ids: { hubId: "48291736", dealId: "30117482911", companyId: "9100000001" } },
    });
    const reviewed = fake.requests.find((sent) => sent.path === "/rest/v1/crm_deals" && sent.method === "PATCH");
    expect(reviewed?.body).toMatchObject({ baseline: { amount: "15000" }, flagged: null, reviewed_by: USER });
  });

  it("saves nothing when HubSpot changed the deal again since the form was filled in from it", async () => {
    const { fake, run } = world(undefined, changed(17000));
    expect(await run(() => changeDeal(actor(), { change, fromCrm: { seen: changesKey([AMOUNT_TO_15000]) } }))).toMatchObject({ ok: false, code: "changed", changed: true });
    expect(mocks.writeChange).not.toHaveBeenCalled();
    expect(fake.requests.some((sent) => sent.method === "PATCH")).toBe(false);
  });
});

describe("fillCrmEmail", () => {
  it("fills an empty billing email from the company's main contact, saying it came from HubSpot", async () => {
    mocks.changeEmail.mockResolvedValue({ name: "Northwind Labs", email: "jane.ito@northwind.example", role: "client" });
    const { run } = world((sent) => {
      if (sent.path === "/rest/v1/counterparties") return { body: [{ id: CUSTOMER, name: "Northwind Labs", notice_email: null }] };
      if (sent.path === "/rest/v1/external_links") return { body: [{ connection_id: "conn-1", external_id: "9100000001" }] };
      if (sent.path === "/rest/v1/crm_deals") return { body: [{ company_email: "jane.ito@northwind.example" }] };
      return undefined;
    });
    expect(await run(() => fillCrmEmail(actor(), { counterpartyId: CUSTOMER, email: "jane.ito@northwind.example" }))).toMatchObject({ ok: true });
    expect(mocks.changeEmail).toHaveBeenCalledWith({
      actorId: USER,
      counterpartyId: CUSTOMER,
      email: "jane.ito@northwind.example",
      source: { provider: "hubspot", ids: { hubId: "48291736", companyId: "9100000001" } },
      onlyIfEmpty: true,
    });
  });

  it("fills only the email the person was shown: HubSpot's is another one now, so nothing is written", async () => {
    const { run } = world((sent) => {
      if (sent.path === "/rest/v1/counterparties") return { body: [{ id: CUSTOMER, name: "Northwind Labs", notice_email: null }] };
      if (sent.path === "/rest/v1/external_links") return { body: [{ connection_id: "conn-1", external_id: "9100000001" }] };
      if (sent.path === "/rest/v1/crm_deals") return { body: [{ company_email: "billing@northwind.example" }] };
      return undefined;
    });
    expect(await run(() => fillCrmEmail(actor(), { counterpartyId: CUSTOMER, email: "jane.ito@northwind.example" }))).toMatchObject({ ok: false, changed: true });
    expect(mocks.changeEmail).not.toHaveBeenCalled();
  });

  it("says the customer has a billing email when one was set while the person looked", async () => {
    mocks.changeEmail.mockRejectedValue(new NoticeEmailTaken());
    const { run } = world((sent) => {
      if (sent.path === "/rest/v1/counterparties") return { body: [{ id: CUSTOMER, name: "Northwind Labs", notice_email: null }] };
      if (sent.path === "/rest/v1/external_links") return { body: [{ connection_id: "conn-1", external_id: "9100000001" }] };
      if (sent.path === "/rest/v1/crm_deals") return { body: [{ company_email: "jane.ito@northwind.example" }] };
      return undefined;
    });
    expect(await run(() => fillCrmEmail(actor(), { counterpartyId: CUSTOMER, email: "jane.ito@northwind.example" }))).toMatchObject({ ok: false, code: "taken", changed: true });
  });

  it("never replaces a billing email the customer has", async () => {
    const { run } = world((sent) => (sent.path === "/rest/v1/counterparties" ? { body: [{ id: CUSTOMER, name: "Northwind Labs", notice_email: "ap@northwind.example" }] } : undefined));
    expect(await run(() => fillCrmEmail(actor(), { counterpartyId: CUSTOMER, email: "jane.ito@northwind.example" }))).toMatchObject({ ok: false, code: "not_found" });
    expect(mocks.changeEmail).not.toHaveBeenCalled();
  });
});
