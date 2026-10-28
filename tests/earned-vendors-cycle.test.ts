import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apHarness, invoiceWrites, LabChain, ledgerEntries, scriptModel, today } from "./support/ap-harness";

/**
 * Earned vendors at the AP stage (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL16, AL20): in shadow mode,
 * with bills to decide, the statuses are signed once as the stage starts; never outside shadow mode or with nothing to
 * decide. It grants nothing: a sync that signs, one that fails and none at all leave every decision, write and transfer
 * of the stage the same.
 */

const { decideMock, syncMock } = vi.hoisted(() => ({ decideMock: vi.fn(), syncMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/decide")>()), decide: decideMock }));
vi.mock("@/lib/earned-vendors-store", () => ({ syncEarnedVendors: syncMock }));

const { world } = apHarness();

const BILL_ID = "018f8ce0-1557-7b54-a931-4d777f6be001";
const PAYEE_ID = "018f8ce0-1557-7b54-a931-4d777f6be003";
const TODAY = "2026-10-28T09:00:00.000Z";

/** A matched 400 USDC bill due today, to a screened vendor with a confirmed address that was paid before. */
function bill() {
  return {
    id: BILL_ID, direction: "payable", status: "pending", amount: "400", currency: "USDC", memo: "Packaging", po_reference: "PO-7001", goods_received: true,
    due_date: "2026-10-28T12:00:00+00:00", counterparty_id: PAYEE_ID, agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    early_pay_discount_pct: null, discount_due_date: null, document_pay_to: null, project_id: null, created_at: "2026-10-27T09:00:00Z", recurring_payables: null,
    counterparties: {
      id: PAYEE_ID, name: "Northwind Packaging", role: "vendor", risk_level: "low", payment_limit: "1000", performance_score: null, performance_inputs: null,
      address: "0x1111111111111111111111111111111111111111", address_changed_at: null, address_confirmed_at: null, chain: null, purchase_order_required: true,
    },
  };
}

/** One stage over one bill, shadow mode on or off: what it decided, wrote and sent. */
async function stage(options: { shadow: boolean; book?: Array<Record<string, unknown>> }) {
  const chain = new LabChain();
  const book = options.book ?? [bill()];
  const run = world({
    book,
    chain,
    shadow: options.shadow ? "USD" : undefined,
    newPayee: { paidTo: new Map([[PAYEE_ID, new Set(["0x1111111111111111111111111111111111111111"])]]), entries: new Map([[PAYEE_ID, []]]) },
  });
  scriptModel(decideMock, () => ({ action: "pay", payOn: null, reasoning: "Matched and due today.", confidence: 0.9 }));
  today(TODAY);
  await run.stage();
  return {
    decisions: ledgerEntries(run.fake.requests).map((entry) => ({ action: entry.action, guardrailRule: entry.detail.guardrailRule, execution: entry.detail.execution })),
    writes: invoiceWrites(run.fake.requests, BILL_ID).map((write) => ({ status: write.status, tx_ref: write.tx_ref })),
    sent: chain.sent.map((transfer) => ({ to: transfer.toAddress, amount: transfer.amount })),
  };
}

beforeEach(() => {
  decideMock.mockReset();
  syncMock.mockReset().mockResolvedValue({ streak: 5, statuses: [], recorded: new Map(), signed: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("the AP stage and earned vendors (AL16, AL20)", () => {
  it("signs the statuses once as a shadow-mode stage starts, in the workspace's scope", async () => {
    const shadowed = await stage({ shadow: true });
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(expect.anything(), { trigger: "cycle" });
    // Shadow mode holds the payment for a verdict, as it always has: the sync changes nothing about it.
    expect(shadowed.sent).toEqual([]);
    expect(shadowed.decisions[0]).toMatchObject({ action: "ap_pay", execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } });
  });

  it("does not run outside shadow mode, or with nothing to decide", async () => {
    const live = await stage({ shadow: false });
    expect(syncMock).not.toHaveBeenCalled();
    expect(live.sent).toEqual([{ to: "0x1111111111111111111111111111111111111111", amount: 400 }]);
    await stage({ shadow: true, book: [] });
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("leaves every decision, write and transfer the same when the sync fails, and logs it", async () => {
    const signed = await stage({ shadow: true });
    syncMock.mockReset().mockRejectedValue(new Error("ledger signing key not readable"));
    const failed = await stage({ shadow: true });
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(failed).toEqual(signed);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("earned vendors"), expect.stringContaining("ledger signing key not readable"));
  });
});
