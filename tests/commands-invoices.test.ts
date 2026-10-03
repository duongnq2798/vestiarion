import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { addInvoice } from "@/lib/commands/invoices";
import type { InvoiceInput } from "@/lib/invoices/create";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Adding an invoice as a command (integrations design §9): the gate first, then the one `createInvoice` the invoice
 * form uses, naming the bot as it always has; a payable starts the agent's cycle, a receivable does not.
 * `createInvoice` itself is tested with the form and the bot; here it is a stand-in.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { createInvoice: vi.fn(), runCycleSoon: vi.fn() } }));
vi.mock("@/lib/invoices/create", () => ({ createInvoice: mocks.createInvoice }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c41";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const owner = (fields: Partial<Actor> = {}): Actor => ({
  orgId: ORG, userId: USER, role: "owner", mode: "sandbox", surface: { kind: "telegram", linkId: "l-1" }, ...fields,
});

const invoice = (direction: "payable" | "receivable"): InvoiceInput =>
  ({
    direction, counterpartyId: "c-1", amount: "200.00", currency: "USDC", memo: null, poReference: "PO-1", goodsReceived: true,
    dueDate: "2026-10-31", earlyPayDiscountPct: null, discountDeadline: null,
  }) as unknown as InvoiceInput;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("addInvoice", () => {
  it("adds a payable from Telegram as the bot always has, and starts the agent", async () => {
    mocks.createInvoice.mockResolvedValueOnce({ id: "inv-1", counterpartyName: "Northwind Hosting" });
    const outcome = await run(() => addInvoice(owner(), { invoice: invoice("payable"), document: null }));
    expect(outcome).toEqual({ ok: true, message: "Invoice added for Northwind Hosting.", invoiceId: "inv-1", counterpartyName: "Northwind Hosting" });
    expect(mocks.createInvoice).toHaveBeenCalledWith({ actorId: USER, invoice: invoice("payable"), document: null, via: "telegram" });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: true, kind: "invoice_added" });
  });

  it("names no surface from the console, and starts nothing for a receivable", async () => {
    mocks.createInvoice.mockResolvedValueOnce({ id: "inv-2", counterpartyName: "Acme" });
    await run(() => addInvoice(owner({ surface: { kind: "console" } }), { invoice: invoice("receivable"), document: null }));
    expect(mocks.createInvoice).toHaveBeenCalledWith({ actorId: USER, invoice: invoice("receivable"), document: null });
    expect(Object.keys(mocks.createInvoice.mock.calls[0][0])).not.toContain("via");
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
  });

  it("refuses a counterparty the workspace does not hold, and an approver", async () => {
    mocks.createInvoice.mockResolvedValueOnce(null);
    expect(await run(() => addInvoice(owner(), { invoice: invoice("payable"), document: null }))).toEqual({
      ok: false, code: "counterparty_not_found", message: "Counterparty not found.",
    });
    expect(await run(() => addInvoice(owner({ role: "approver" }), { invoice: invoice("payable"), document: null }))).toMatchObject({
      ok: false, code: "forbidden",
    });
    expect(mocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
  });

  it("logs and answers in general words when adding fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createInvoice.mockRejectedValueOnce(new Error("insert failed"));
    expect(await run(() => addInvoice(owner(), { invoice: invoice("payable"), document: null }))).toEqual({
      ok: false, code: "failed", message: "The invoice could not be added. Try again in a moment.",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
