import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { invoiceInputSchema } from "@/lib/intake-validation";
import { createInvoice } from "@/lib/invoices/create";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * `createInvoice`, the one way an invoice is added, whether a person types it into the form or taps Add on a draft the
 * Telegram bot read (Telegram bot design R10): the row, and the `create_invoice` entry that records who added it and
 * where it came from. Against a real supabase-js client whose network is a recorder, inside the organization's scope.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const API_KEY = "1a1a1a1a-0000-4000-8000-000000000001";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const orgs = signedOrgs();

function database(counterparties: Array<{ id: string; name: string }>) {
  return (sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    const wantsObject = sent.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (sent.path === "/rest/v1/counterparties") {
      const found = counterparties.filter((row) => sent.params.get("id") === `eq.${row.id}`);
      if (!wantsObject) return { body: found };
      if (found.length === 1) return { body: found[0] };
      return { status: 406, body: { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "Cannot coerce the result to a single JSON object" } };
    }
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    return { body: [] };
  };
}

const invoice = invoiceInputSchema.parse({
  direction: "payable",
  counterpartyId: COUNTERPARTY,
  amount: "10.50",
  currency: "USDC",
  memo: "Landing page design",
  poReference: "PO-7",
  goodsReceived: true,
  dueDate: "2026-10-31",
  earlyPayDiscountPct: "",
  discountDeadline: "",
});

const ledgerDetails = (requests: RecordedRequest[]) =>
  requests
    .filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")
    .map((sent) => sent.body as { p_action: string; p_detail: Record<string, unknown> });

async function run<T>(counterparties: Array<{ id: string; name: string }>, fn: () => Promise<T>) {
  const fake = fakeSupabase(database(counterparties));
  const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { result, requests: fake.requests };
}

describe("createInvoice", () => {
  it("adds the invoice in the workspace, made by the person, and records it as theirs", async () => {
    const { result, requests } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () =>
      createInvoice({ actorId: USER, invoice, document: null })
    );

    expect(result).toEqual({ id: INVOICE, counterpartyName: "Acme Supplies" });
    const insert = requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({
      org_id: ORG,
      direction: "payable",
      counterparty_id: COUNTERPARTY,
      amount: "10.50",
      currency: "USDC",
      po_reference: "PO-7",
      goods_received: true,
      due_date: "2026-10-31T12:00:00.000Z",
      created_by: USER,
    });
    const [entry] = ledgerDetails(requests);
    expect(entry.p_action).toBe("create_invoice");
    expect(entry.p_detail).toEqual({
      by: USER,
      invoiceId: INVOICE,
      counterpartyId: COUNTERPARTY,
      counterpartyName: "Acme Supplies",
      amount: "10.50",
      currency: "USDC",
      dueDate: "2026-10-31",
      poReference: "PO-7",
      goodsReceived: true,
    });
  });

  it("records that it came through Telegram, and the document it was read from, when told", async () => {
    const document = { kind: "pdf" as const, sha256: "a".repeat(64), reader: "deepseek" as const, changed: [] };
    const { requests } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () =>
      createInvoice({ actorId: USER, invoice, document, via: "telegram" })
    );

    const [entry] = ledgerDetails(requests);
    expect(entry.p_detail).toMatchObject({ via: "telegram", document });
  });

  it("records the vendor's own invoice number when one was given, and none otherwise (receipts v2 RV1)", async () => {
    const typed = { direction: "payable", counterpartyId: COUNTERPARTY, amount: "10.50", currency: "USDC", memo: "", poReference: "", goodsReceived: false, dueDate: "2026-10-31", earlyPayDiscountPct: "", discountDeadline: "" };
    const numbered = invoiceInputSchema.parse({ ...typed, invoiceNumber: " INV-2207 " });
    const { requests } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () => createInvoice({ actorId: USER, invoice: numbered, document: null }));
    expect(ledgerDetails(requests)[0].p_detail).toMatchObject({ invoiceNumber: "INV-2207" });

    const { requests: none } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () => createInvoice({ actorId: USER, invoice, document: null }));
    expect(ledgerDetails(none)[0].p_detail).not.toHaveProperty("invoiceNumber");
    // A captured draft's number stands unless the person kept or typed another in the form.
    const draft = { invoiceDraftId: "1a1a1a1a-0000-4000-8000-0000000000d1", invoiceNumber: "CAP-1" };
    const { requests: captured } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () => createInvoice({ actorId: USER, invoice, document: null, captured: draft }));
    expect(ledgerDetails(captured)[0].p_detail).toMatchObject({ invoiceNumber: "CAP-1", invoiceDraftId: draft.invoiceDraftId });
    const { requests: retyped } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () => createInvoice({ actorId: USER, invoice: numbered, document: null, captured: draft }));
    expect(ledgerDetails(retyped)[0].p_detail).toMatchObject({ invoiceNumber: "INV-2207" });
    // Blank is none, and a number past 100 characters is refused, as the form says.
    expect(invoiceInputSchema.parse({ ...typed, invoiceNumber: "  " }).invoiceNumber).toBeNull();
    expect(invoiceInputSchema.safeParse({ ...typed, invoiceNumber: "x".repeat(101) }).success).toBe(false);
  });

  it("records that it came from Slack, and the member's link it came through (Slack design S15)", async () => {
    const document = { kind: "pdf" as const, sha256: "b".repeat(64), reader: "heuristic" as const, changed: [] };
    const { requests } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () =>
      createInvoice({ actorId: USER, invoice, document, via: "slack", linkId: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d2" })
    );

    const [entry] = ledgerDetails(requests);
    expect(entry.p_detail).toMatchObject({ by: USER, via: "slack", linkId: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d2", document });
  });

  it("records that it came through the API and with which key, and adds it as nobody's once the key's issuer is gone (write API R4)", async () => {
    const { requests } = await run([{ id: COUNTERPARTY, name: "Acme Supplies" }], () =>
      createInvoice({ actorId: null, invoice, document: null, via: "api", apiKeyId: API_KEY })
    );

    const insert = requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ created_by: null });
    const [entry] = ledgerDetails(requests);
    expect(entry.p_detail).toMatchObject({ by: null, via: "api", apiKeyId: API_KEY });
  });

  it("adds nothing for a counterparty the workspace does not hold", async () => {
    const { result, requests } = await run([], () => createInvoice({ actorId: USER, invoice, document: null, via: "telegram" }));

    expect(result).toBeNull();
    expect(requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
    expect(ledgerDetails(requests)).toEqual([]);
  });
});

describe("createInvoice with a late fee (late fees LF1, LF3)", () => {
  const withFee = invoiceInputSchema.parse({
    direction: "payable",
    counterpartyId: COUNTERPARTY,
    amount: "100",
    currency: "USDC",
    memo: "",
    poReference: "",
    goodsReceived: true,
    dueDate: "2026-10-31",
    earlyPayDiscountPct: "",
    discountDeadline: "",
    lateFee: { kind: "percent_month", value: "1.5" },
  });
  const document = { kind: "pdf" as const, sha256: "c".repeat(64), reader: "deepseek" as const, changed: [], payTo: "0x1111111111111111111111111111111111111111" };

  /** A database without the columns `missing` names: an insert naming one is refused as PostgREST refuses it. */
  async function add(missing: string[], input = withFee) {
    const bodies: Array<Record<string, unknown>> = [];
    const fake = fakeSupabase((sent: RecordedRequest) => {
      if (sent.path === "/rest/v1/invoices" && sent.method === "POST") {
        const body = sent.body as Record<string, unknown>;
        bodies.push(body);
        const absent = missing.find((column) => column in body);
        if (absent) return { status: 400, body: { code: "PGRST204", details: null, hint: null, message: `Could not find the '${absent}' column of 'invoices' in the schema cache` } };
      }
      return database([{ id: COUNTERPARTY, name: "Acme Supplies" }])(sent);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => createInvoice({ actorId: USER, invoice: input, document }), { userId: USER }));
    return { result, bodies, entry: ledgerDetails(fake.requests)[0] };
  }

  it("keeps the term on the invoice, starting the day after the due date, and signs it on the entry", async () => {
    const { result, bodies, entry } = await add([]);
    expect(result).toEqual({ id: INVOICE, counterpartyName: "Acme Supplies" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ late_fee_kind: "percent_month", late_fee_value: "1.5", late_fee_starts_on: "2026-11-01", document_pay_to: document.payTo });
    expect(entry.p_detail.lateFee).toEqual({ kind: "percent_month", value: "1.5", startsOn: "2026-11-01" });
  });

  it("names no late fee on a bill without one", async () => {
    const { bodies, entry } = await add([], invoice);
    expect(Object.keys(bodies[0]).filter((key) => key.startsWith("late_fee"))).toEqual([]);
    expect(entry.p_detail).not.toHaveProperty("lateFee");
  });

  it("adds the invoice without the term before migration 0141, and signs none it did not keep", async () => {
    const { result, bodies, entry } = await add(["late_fee_kind", "late_fee_value", "late_fee_starts_on"]);
    expect(result).toEqual({ id: INVOICE, counterpartyName: "Acme Supplies" });
    expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[1]).filter((key) => key.startsWith("late_fee"))).toEqual([]);
    expect(bodies[1]).toMatchObject({ document_pay_to: document.payTo });
    expect(entry.p_detail).not.toHaveProperty("lateFee");
  });

  it("drops each column the database lacks, before both 0136 and 0141, and keeps the rest", async () => {
    const { result, bodies } = await add(["document_pay_to", "late_fee_starts_on"]);
    expect(result).toEqual({ id: INVOICE, counterpartyName: "Acme Supplies" });
    expect(bodies).toHaveLength(3);
    const last = bodies[2];
    expect(last).not.toHaveProperty("document_pay_to");
    expect(Object.keys(last).filter((key) => key.startsWith("late_fee"))).toEqual([]);
    expect(last).toMatchObject({ amount: "100", due_date: "2026-10-31T12:00:00.000Z" });
  });

  it("still fails on a column it cannot leave out", async () => {
    const fake = fakeSupabase((sent: RecordedRequest) => {
      if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { status: 400, body: { code: "PGRST204", details: null, hint: null, message: "Could not find the 'memo' column of 'invoices' in the schema cache" } };
      return database([{ id: COUNTERPARTY, name: "Acme Supplies" }])(sent);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => createInvoice({ actorId: USER, invoice, document: null }), { userId: USER }))).rejects.toThrow(/memo/);
    expect(fake.requests.filter((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST")).toHaveLength(1);
  });
});
