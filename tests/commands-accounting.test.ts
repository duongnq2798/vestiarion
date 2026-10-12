import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { addAccountingBills, dismissAccountingBills } from "@/lib/commands/accounting";
import { placeholderId } from "@/lib/connectors/review";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Adding the bills Xero brought in (docs/superpowers/specs/2026-10-12-xero-connector-design.md X3, X11): only a role that
 * adds records; every bill checked again from its kept row through the bill list's check; claimed before it is added
 * and put back if it cannot be; a new supplier added as a counterparty with the bill; each invoice's signed entry naming
 * Xero's ids; links kept so the next bill from the same supplier finds it.
 */

const { ORG, USER, mocks } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f11",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f12",
  mocks: { ledger: vi.fn(), rate: vi.fn(), runCycleSoon: vi.fn(), screen: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));
vi.mock("@/lib/compliance", () => ({ screenCounterparty: mocks.screen }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: mocks.ledger }));
vi.mock("@/lib/fx/usd-rates", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/fx/usd-rates")>()), usdRate: mocks.rate }));

const CONNECTION = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f13";
const LINKED_BILL = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f14";
const NEW_BILL = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f15";
const POWER = { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000f16", name: "PowerDirect Ltd" };
const NEW_CP = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f17";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const CONNECTION_ROW = {
  id: CONNECTION, org_id: ORG, provider: "xero", external_org_id: "tenant-1", external_org_name: "Demo Company (Global)", status: "connected", scopes: [],
  connected_by: USER, connected_at: "2026-10-12T07:00:00Z", consent_version: "xero-2026-10-12", consented_at: "2026-10-12T07:00:00Z", revoked_at: null,
  window_from: "2026-07-14", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
  payment_account: null, payment_account_at: null,
};
const billRow = (id: string, fields: Record<string, unknown>) => ({
  id, connection_id: CONNECTION, external_id: `x-${id.slice(-2)}`, contact_external_id: "contact-1", contact_name: "PowerDirect", number: "PD-4471", reference: null,
  currency: "USD", total: 1250, amount_due: 1250, issued_on: "2026-10-03", due_on: "2026-10-28", source_status: "open", review_state: "review",
  first_seen_at: "2026-10-12T08:00:00Z", ...fields,
});
const BILLS = [
  billRow(LINKED_BILL, {}),
  billRow(NEW_BILL, { contact_external_id: "contact-9", contact_name: "Akiba Parts K.K.", number: "AK-77", amount_due: 300, total: 300 }),
];

const actor = (role: Actor["role"] = "owner"): Actor => ({ orgId: ORG, userId: USER, role, mode: "sandbox", surface: { kind: "console" } });

function world(options: { claim?: boolean; connection?: FakeReply } = {}) {
  const respond = (sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/orgs") return { body: { id: ORG, slug: "acme", name: "Acme", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    if (sent.path === "/rest/v1/accounting_connections") return options.connection ?? { body: [CONNECTION_ROW] };
    if (sent.path === "/rest/v1/shadow_modes") return { body: [{ currency: "USD", started_at: "2026-10-07T00:00:00Z", started_by: USER }] };
    if (sent.path === "/rest/v1/accounting_bills" && sent.method === "GET") {
      const ids = sent.params.get("id")?.replace(/^in\.\(|\)$/g, "").split(",") ?? null;
      return { body: BILLS.filter((bill) => !ids || ids.includes(bill.id)) };
    }
    if (sent.path === "/rest/v1/accounting_bills" && sent.method === "PATCH") {
      const id = sent.params.get("id")?.replace(/^eq\./, "");
      return { body: options.claim === false ? [] : [{ id, external_id: "x" }] };
    }
    if (sent.path === "/rest/v1/external_links" && sent.method === "GET") return { body: [{ external_id: "contact-1", local_id: POWER.id }] };
    if (sent.path === "/rest/v1/counterparties" && sent.method === "POST") return { body: { id: NEW_CP, name: "Akiba Parts K.K." } };
    if (sent.path === "/rest/v1/counterparties") {
      const id = sent.params.get("id");
      const all = [POWER, { id: NEW_CP, name: "Akiba Parts K.K." }];
      return { body: id ? all.filter((row) => id === `eq.${row.id}`) : [POWER] };
    }
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: `inv-${(sent.body as { amount: string }).amount}` } };
    return { body: [] };
  };
  const fake = fakeSupabase(respond);
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { fake, run };
}

const sent = (fake: ReturnType<typeof fakeSupabase>, path: string, method: string) => fake.requests.filter((request) => request.path === path && request.method === method);
const entries = () => mocks.ledger.mock.calls.map(([entry]) => entry as { action: string; detail: Record<string, unknown> });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.ledger.mockResolvedValue(undefined);
  mocks.screen.mockResolvedValue({ riskLevel: "clear" });
  mocks.rate.mockImplementation(async (currency: string) => ({ currency, perUsd: 1, source: "ExchangeRate-API", at: "2026-10-12T00:02:31.000Z" }));
});

describe("addAccountingBills", () => {
  it("is refused to a role that does not add records, before anything is read", async () => {
    const { fake, run } = world();
    expect(await run(() => addAccountingBills(actor("approver"), { connectionId: CONNECTION, billIds: [LINKED_BILL], goodsReceived: false }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.requests.filter((request) => request.path !== "/rest/v1/orgs")).toEqual([]);
  });

  it("adds a bill from its linked supplier at its USDC amount, through addInvoice, naming Xero's ids, and links it", async () => {
    const { fake, run } = world();
    const outcome = await run(() => addAccountingBills(actor(), { connectionId: CONNECTION, billIds: [LINKED_BILL], goodsReceived: true }));
    expect(outcome).toMatchObject({ ok: true, message: "Added 1 bill from Xero.", counts: { added: 1, duplicate: 0, error: 0 } });
    const [invoice] = sent(fake, "/rest/v1/invoices", "POST");
    expect(invoice.body).toMatchObject({
      org_id: ORG, direction: "payable", counterparty_id: POWER.id, amount: "1250", currency: "USDC", goods_received: true, memo: "Invoice PD-4471",
      original_currency: "USD", original_amount: 1250,
    });
    const created = entries().find((entry) => entry.action === "create_invoice");
    expect(created?.detail).toMatchObject({ via: "xero", xero: { tenantId: "tenant-1", billId: "x-14", contactId: "contact-1", invoiceNumber: "PD-4471" } });
    const claim = sent(fake, "/rest/v1/accounting_bills", "PATCH")[0];
    expect(claim.body).toMatchObject({ review_state: "added", decided_by: USER });
    expect(claim.params.get("review_state")).toBe("eq.review");
    const links = sent(fake, "/rest/v1/external_links", "POST").map((request) => request.body as Record<string, unknown>);
    expect(links).toEqual([expect.objectContaining({ object_type: "bill", external_id: "x-14", local_id: "inv-1250", org_id: ORG })]);
    expect(mocks.runCycleSoon).toHaveBeenCalled();
  });

  it("adds a new supplier once, as a vendor with no address and a limit of its largest bill here, and links its contact", async () => {
    const { fake, run } = world();
    const outcome = await run(() => addAccountingBills(actor(), { connectionId: CONNECTION, billIds: [NEW_BILL], goodsReceived: false }));
    expect(outcome).toMatchObject({ ok: true, counts: { added: 1 } });
    const [counterparty] = sent(fake, "/rest/v1/counterparties", "POST");
    expect(counterparty.body).toMatchObject({ name: "Akiba Parts K.K.", role: "vendor", address: null, baseline_payment_limit: "300.00" });
    const created = entries().find((entry) => entry.action === "create_counterparty");
    expect(created?.detail).toMatchObject({ via: "xero", xero: { tenantId: "tenant-1", contactId: "contact-9" } });
    expect(sent(fake, "/rest/v1/invoices", "POST")[0].body).toMatchObject({ counterparty_id: NEW_CP });
    const contactLink = sent(fake, "/rest/v1/external_links", "POST").map((request) => request.body as Record<string, unknown>).find((body) => body.object_type === "contact");
    expect(contactLink).toMatchObject({ external_id: "contact-9", local_id: NEW_CP, label: "Akiba Parts K.K." });
    expect(JSON.stringify(sent(fake, "/rest/v1/invoices", "POST"))).not.toContain(placeholderId("Akiba Parts K.K."));
  });

  it("adds nothing for a bill someone else took first", async () => {
    const { fake, run } = world({ claim: false });
    const outcome = await run(() => addAccountingBills(actor(), { connectionId: CONNECTION, billIds: [LINKED_BILL], goodsReceived: false }));
    expect(outcome).toMatchObject({ ok: true, counts: { added: 0, error: 1 }, bills: [{ status: "error", reason: "Someone else added or dismissed this bill a moment ago." }] });
    expect(sent(fake, "/rest/v1/invoices", "POST")).toEqual([]);
  });

  it("says Xero is not set up yet before migration 0101 has run, and refuses a disconnected connection", async () => {
    const missing = world({ connection: { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.accounting_connections'" } } });
    expect(await missing.run(() => addAccountingBills(actor(), { connectionId: CONNECTION, billIds: [LINKED_BILL], goodsReceived: false }))).toMatchObject({ ok: false, code: "not_set_up" });
    const revoked = world({ connection: { body: [{ ...CONNECTION_ROW, status: "revoked", revoked_at: "2026-10-12T09:00:00Z" }] } });
    expect(await revoked.run(() => addAccountingBills(actor(), { connectionId: CONNECTION, billIds: [LINKED_BILL], goodsReceived: false }))).toMatchObject({ ok: false, code: "not_connected" });
  });

  it("asks for bills to add, and ignores ids that are not ids", async () => {
    const { run } = world();
    expect(await run(() => addAccountingBills(actor(), { connectionId: CONNECTION, billIds: ["not-an-id"], goodsReceived: false }))).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("dismissAccountingBills", () => {
  it("dismisses the bills still in review and records it with Xero's ids", async () => {
    const { fake, run } = world();
    const outcome = await run(() => dismissAccountingBills(actor(), { connectionId: CONNECTION, billIds: [LINKED_BILL] }));
    expect(outcome).toMatchObject({ ok: true, message: "Dismissed 1 bill. It stays in Xero.", dismissed: 1 });
    const patch = sent(fake, "/rest/v1/accounting_bills", "PATCH")[0];
    expect(patch.body).toMatchObject({ review_state: "dismissed", decided_by: USER });
    expect(patch.params.get("connection_id")).toBe(`eq.${CONNECTION}`);
    expect(entries().find((entry) => entry.action === "accounting_bills_dismissed")?.detail).toEqual({ by: USER, provider: "xero", connectionId: CONNECTION, billIds: ["x"] });
  });

  it("is refused to a viewer", async () => {
    const { run } = world();
    expect(await run(() => dismissAccountingBills(actor("viewer"), { connectionId: CONNECTION, billIds: [LINKED_BILL] }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});
