import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { createInvoice } from "@/lib/invoices/create";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * An invoice added from a bill in the business's own currency, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-
 * mode-design.md S6): the row keeps the bill's own figure and rate beside its USDC amount, and the signed entry says
 * both.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000001b1b";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const ORIGINAL = { currency: "VND", amount: 2_500_000, perUsd: 25_935.897512, source: "ExchangeRate-API", at: "2026-10-07T00:02:32.000Z" };

describe("createInvoice with the bill's own figure", () => {
  it("records the bill and its rate beside the USDC amount, in the row and the signed entry", async () => {
    ledgerMock.mockReset().mockResolvedValue(undefined);
    const fake = fakeSupabase((r) => {
      if (r.path === "/rest/v1/counterparties") return { body: { id: COUNTERPARTY, name: "Dien luc" } };
      if (r.path === "/rest/v1/invoices" && r.method === "POST") return { body: { id: "inv-1" } };
      return { body: [] };
    });
    const invoice = {
      direction: "payable" as const,
      counterpartyId: COUNTERPARTY,
      amount: "96.39",
      currency: "USDC" as const,
      memo: "Electricity, September",
      poReference: null,
      goodsReceived: true,
      dueDate: "2026-10-20",
      earlyPayDiscountPct: null,
      discountDeadline: null,
    };
    const created = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: "u1" }), () =>
      createInvoice({ actorId: "u1", invoice, document: null, original: ORIGINAL })
    );

    expect(created).toEqual({ id: "inv-1", counterpartyName: "Dien luc" });
    expect(fake.requests.find((r) => r.path === "/rest/v1/invoices" && r.method === "POST")?.body).toMatchObject({
      amount: "96.39",
      currency: "USDC",
      original_currency: "VND",
      original_amount: 2_500_000,
      fx_rate: 25_935.897512,
      fx_source: "ExchangeRate-API",
      fx_at: "2026-10-07T00:02:32.000Z",
    });
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create_invoice",
        summary: "Added payable invoice for Dien luc: 96.39 USDC (2500000 VND)",
        detail: expect.objectContaining({ amount: "96.39", currency: "USDC", bill: ORIGINAL }),
      })
    );
  });

  it("writes no bill where there is none", async () => {
    ledgerMock.mockReset().mockResolvedValue(undefined);
    const fake = fakeSupabase((r) => {
      if (r.path === "/rest/v1/counterparties") return { body: { id: COUNTERPARTY, name: "Acme" } };
      if (r.path === "/rest/v1/invoices" && r.method === "POST") return { body: { id: "inv-2" } };
      return { body: [] };
    });
    await runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: "u1" }), () =>
      createInvoice({
        actorId: "u1",
        invoice: { direction: "payable", counterpartyId: COUNTERPARTY, amount: "10", currency: "USDC", memo: null, poReference: null, goodsReceived: true, dueDate: "2026-10-20", earlyPayDiscountPct: null, discountDeadline: null },
        document: null,
      })
    );
    const insert = fake.requests.find((r) => r.path === "/rest/v1/invoices" && r.method === "POST")?.body as Record<string, unknown>;
    expect(insert).not.toHaveProperty("original_currency");
    expect((ledgerMock.mock.calls[0][0] as { detail: Record<string, unknown> }).detail).not.toHaveProperty("bill");
  });

  it("names the list a row was imported from, its row and its invoice number, in the signed entry (import design B12)", async () => {
    ledgerMock.mockReset().mockResolvedValue(undefined);
    const fake = fakeSupabase((r) => {
      if (r.path === "/rest/v1/counterparties") return { body: { id: COUNTERPARTY, name: "Kanto Paper" } };
      if (r.path === "/rest/v1/invoices" && r.method === "POST") return { body: { id: "inv-3" } };
      return { body: [] };
    });
    const file = "c0ffee".padEnd(64, "0");
    await runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: "u1" }), () =>
      createInvoice({
        actorId: "u1",
        invoice: { direction: "payable", counterpartyId: COUNTERPARTY, amount: "10", currency: "USDC", memo: "Invoice KP-1001", poReference: null, goodsReceived: false, dueDate: "2026-10-20", earlyPayDiscountPct: null, discountDeadline: null },
        document: null,
        via: "import",
        imported: { file, row: 12, invoiceNumber: "KP-1001" },
      })
    );
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create_invoice",
        detail: expect.objectContaining({ by: "u1", invoiceId: "inv-3", via: "import", importFile: file, importRow: 12, invoiceNumber: "KP-1001" }),
      })
    );
  });
});
