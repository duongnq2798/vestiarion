import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apHarness, invoiceWrites, LabChain, ledgerEntries, scriptModel, today, type ApWorldOptions } from "./support/ap-harness";

/**
 * Earned vendors paid on their own, at the AP stage (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL22,
 * AL23, AL25, AL27): in shadow mode, a payment to a vendor the stage's gate grants, which passed every check, is carried
 * out as a live workspace carries it out: one transfer, to the address on file, for the bill's amount, counted against
 * the agent's spending limit, and its entry says so, until 3 of the vendor's payments made that way wait for a verdict
 * (AL26), counting the ones it makes in the stage. Any other vendor's payment waits for a verdict as before, beside one
 * the gate grants, and a decision that breaks a vendor's status takes it away for the rest of the stage, its loss signed
 * once.
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/decide")>()), decide: decideMock }));

const { world } = apHarness();

const NORTHWIND = "018f8ce0-1557-7b54-a931-4d777f6bf003";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";
const FIRST = "018f8ce0-1557-7b54-a931-4d777f6bf001";
const SECOND = "018f8ce0-1557-7b54-a931-4d777f6bf002";
const THIRD = "018f8ce0-1557-7b54-a931-4d777f6bf004";
const LUMEN = "018f8ce0-1557-7b54-a931-4d777f6bf005";
const LUMEN_ADDRESS = "0x3333333333333333333333333333333333333333";
const TODAY = "2026-10-28T09:00:00.000Z";

/** A matched 400 USDC bill due today from Northwind Packaging, a screened vendor paid at this address before. */
function bill(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id, direction: "payable", status: "pending", amount: "400", currency: "USDC", memo: "Packaging", po_reference: `PO-${id.slice(-3)}`, goods_received: true,
    due_date: "2026-10-28T12:00:00+00:00", counterparty_id: NORTHWIND, agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    early_pay_discount_pct: null, discount_due_date: null, document_pay_to: null, project_id: null, created_at: createdAt, recurring_payables: null,
    counterparties: {
      id: NORTHWIND, name: "Northwind Packaging", role: "vendor", risk_level: "low", payment_limit: "1000", performance_score: null, performance_inputs: null,
      address: ADDRESS, address_changed_at: null, address_confirmed_at: null, chain: null, purchase_order_required: true,
    },
    ...extra,
  };
}

/** The same bill from Lumen Print Co., another screened vendor paid at its address before. */
function lumenBill(id: string, createdAt: string) {
  const northwind = bill(id, createdAt);
  return { ...northwind, counterparty_id: LUMEN, counterparties: { ...northwind.counterparties, id: LUMEN, name: "Lumen Print Co.", address: LUMEN_ADDRESS } };
}

/** One stage in shadow mode over these bills, with the gate given: what it decided, wrote, sent and said. */
async function stage(options: Partial<ApWorldOptions> & { book?: Array<Record<string, unknown>> }) {
  const chain = new LabChain();
  const book = options.book ?? [bill(FIRST, "2026-10-27T09:00:00Z")];
  const run = world({
    shadow: "USD",
    newPayee: { paidTo: new Map([[NORTHWIND, new Set([ADDRESS])]]), entries: new Map([[NORTHWIND, []]]) },
    ...options,
    book,
    chain,
  });
  scriptModel(decideMock, () => ({ action: "pay", payOn: null, reasoning: "Matched and due today.", confidence: 0.9 }));
  today(TODAY);
  await run.stage();
  const entries = ledgerEntries(run.fake.requests);
  return {
    decisions: entries.filter((entry) => entry.action.startsWith("ap_")),
    losses: entries.filter((entry) => entry.action === "vendor_earned_lost"),
    sent: chain.sent.map((transfer) => ({ to: transfer.toAddress, amount: transfer.amount })),
    statusOf: (id: string) => invoiceWrites(run.fake.requests, id).at(-1)?.status,
    reasoningOf: (id: string) => String(invoiceWrites(run.fake.requests, id).at(-1)?.agent_reasoning ?? ""),
    lines: run.lines.map((line) => line.message),
  };
}

beforeEach(() => {
  decideMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("an earned vendor in shadow mode (AL22, AL27)", () => {
  it("is paid on its own: one transfer to the address on file for the bill's amount, its entry marked earned and shadow, held for nothing", async () => {
    const run = await stage({ earned: [NORTHWIND], budget: { daily_usdc: "2000", weekly_usdc: null } });
    expect(run.sent).toEqual([{ to: ADDRESS, amount: 400 }]);
    expect(run.statusOf(FIRST)).toBe("paid");
    const detail = run.decisions[0].detail as { earned?: unknown; shadow?: boolean; guardrailBlocked: boolean; outflowBudget?: unknown; execution: Record<string, unknown> };
    expect(run.decisions[0].action).toBe("ap_pay");
    expect(detail.earned).toEqual({ recordSeq: 900, streak: 5, agreed: 5 });
    expect(detail.shadow).toBe(true);
    expect(detail.guardrailBlocked).toBe(false);
    expect(detail.execution.resultingStatus).toBe("paid");
    expect(detail.execution).not.toHaveProperty("heldBecause");
    // Weighed against the agent's spending limit, as a live workspace's payment is.
    expect(detail.outflowBudget).toMatchObject({ dailyUsdc: 2000 });
    expect(run.reasoningOf(FIRST)).toContain("[an earned vendor under the owner's rule: paid without waiting for a verdict; give yours after]");
    expect(run.lines).toContain("Northwind Packaging: paid on its own, an earned vendor (400 USDC)");
  });

  it("counts each payment against the agent's spending limit: the next one past it is held by the limit", async () => {
    const run = await stage({
      earned: [NORTHWIND],
      budget: { daily_usdc: "500", weekly_usdc: null },
      book: [bill(FIRST, "2026-10-27T09:00:00Z"), bill(SECOND, "2026-10-27T10:00:00Z")],
    });
    expect(run.sent).toEqual([{ to: ADDRESS, amount: 400 }]);
    expect(run.statusOf(FIRST)).toBe("paid");
    expect(run.statusOf(SECOND)).toBe("held");
    expect(run.decisions[1].detail).toMatchObject({ guardrailBlocked: true, guardrailRule: "workspace.outflow_budget" });
  });
});

describe("at most 3 waiting (AL26)", () => {
  it("pays on its own only until 3 of the vendor's payments made that way wait, counting the ones paid in the stage", async () => {
    const book = [FIRST, SECOND, THIRD].map((id, index) => bill(id, `2026-10-27T0${index + 1}:00:00Z`, { amount: String(100 + 10 * index) }));
    // One payment made on its own already waits for a verdict: two more may be made this way, not three.
    const run = await stage({ earned: [{ vendorId: NORTHWIND, waiting: 1 }], budget: { daily_usdc: "2000", weekly_usdc: null }, book });
    expect(run.sent).toEqual([
      { to: ADDRESS, amount: 100 },
      { to: ADDRESS, amount: 110 },
    ]);
    expect([FIRST, SECOND, THIRD].map(run.statusOf)).toEqual(["paid", "paid", "held"]);
    expect(run.decisions[2].detail).toMatchObject({ guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } });
    expect(run.decisions[2].detail).not.toHaveProperty("earned");
    // The pause signs nothing: the vendor stays earned.
    expect(run.losses).toEqual([]);
  });
});

describe("any other vendor in shadow mode (AL22, AL24)", () => {
  it("waits for a verdict beside a vendor the gate grants, which alone is paid on its own", async () => {
    const run = await stage({
      earned: [NORTHWIND],
      budget: { daily_usdc: "2000", weekly_usdc: null },
      newPayee: { paidTo: new Map([[NORTHWIND, new Set([ADDRESS])], [LUMEN, new Set([LUMEN_ADDRESS])]]), entries: new Map([[NORTHWIND, []], [LUMEN, []]]) },
      book: [lumenBill(SECOND, "2026-10-27T09:00:00Z"), bill(FIRST, "2026-10-27T10:00:00Z")],
    });
    expect(run.sent).toEqual([{ to: ADDRESS, amount: 400 }]);
    expect(run.statusOf(SECOND)).toBe("held");
    const lumen = run.decisions.find((decision) => decision.detail.invoiceId === SECOND)!;
    expect(lumen.detail).toMatchObject({ shadow: true, guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } });
    expect(lumen.detail).not.toHaveProperty("earned");
    expect(run.statusOf(FIRST)).toBe("paid");
    expect(run.decisions.find((decision) => decision.detail.invoiceId === FIRST)!.detail).toHaveProperty("earned");
  });


  it("waits for a verdict when the gate grants it nothing, as every payment in shadow mode does", async () => {
    const run = await stage({ earned: [], budget: { daily_usdc: "2000", weekly_usdc: null } });
    expect(run.sent).toEqual([]);
    expect(run.statusOf(FIRST)).toBe("held");
    expect(run.decisions[0].detail).toMatchObject({ shadow: true, execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } });
    expect(run.decisions[0].detail).not.toHaveProperty("earned");
  });

  it("waits for a verdict in a workspace with no rule and no switch, the gate built from the workspace", async () => {
    const run = await stage({ budget: { daily_usdc: "2000", weekly_usdc: null } });
    expect(run.sent).toEqual([]);
    expect(run.decisions[0].detail).toMatchObject({ execution: { heldBecause: "shadow_verdict" } });
  });

  it("is never paid outside shadow mode by a grant: a live workspace pays as it always did, unmarked", async () => {
    const run = await stage({ shadow: undefined, earned: [NORTHWIND], budget: { daily_usdc: "2000", weekly_usdc: null } });
    expect(run.sent).toEqual([{ to: ADDRESS, amount: 400 }]);
    expect(run.decisions[0].detail).not.toHaveProperty("earned");
    expect(run.decisions[0].detail).not.toHaveProperty("shadow");
  });
});

describe("lost in the stage (AL25)", () => {
  it("holds the vendor's next bill for a verdict once a check in code stopped one, and signs one vendor_earned_lost", async () => {
    const run = await stage({
      earned: [NORTHWIND],
      budget: { daily_usdc: "2000", weekly_usdc: null },
      book: [bill(FIRST, "2026-10-27T09:00:00Z", { document_pay_to: OTHER_ADDRESS }), bill(SECOND, "2026-10-27T10:00:00Z")],
    });
    expect(run.sent).toEqual([]);
    expect(run.decisions[0].detail).toMatchObject({ guardrailBlocked: true, guardrailRule: "invoice.pay_to_differs" });
    expect(run.decisions[1].detail).toMatchObject({ guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } });
    expect(run.losses).toHaveLength(1);
    expect(run.losses[0].detail).toMatchObject({ counterpartyId: NORTHWIND, because: "code_stop", rule: "invoice.pay_to_differs", trigger: "cycle" });
    expect(typeof run.losses[0].detail.decisionSeq).toBe("number");
  });

  it("signs nothing for a stop that says nothing about the vendor, such as two approvals", async () => {
    const run = await stage({ earned: [NORTHWIND], budget: { daily_usdc: "2000", weekly_usdc: null }, twoApprovals: 300 });
    expect(run.decisions[0].detail).toMatchObject({ guardrailRule: "workspace.two_approvals" });
    expect(run.losses).toEqual([]);
  });
});
