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

  it("adds nothing for a counterparty the workspace does not hold", async () => {
    const { result, requests } = await run([], () => createInvoice({ actorId: USER, invoice, document: null, via: "telegram" }));

    expect(result).toBeNull();
    expect(requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
    expect(ledgerDetails(requests)).toEqual([]);
  });
});
