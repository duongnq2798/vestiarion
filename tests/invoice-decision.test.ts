import { describe, expect, it } from "vitest";
import { invoiceDecision } from "@/components/vx/map";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow } from "@/lib/queries";

/**
 * `invoiceDecision` (src/components/vx/map.ts) turns an invoice row into the
 * `Decision` a `DecisionCard` renders. Payment timing (2026-09-30) adds: a
 * scheduled invoice's outcome names the date, and only a scheduled one reads
 * "Scheduled" — a pending one has not been decided and a matched one is being
 * paid; its terms show as evidence when it carries an early-payment discount;
 * and a paid invoice that took the discount shows what it actually paid.
 */

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    direction: "payable",
    counterparty_id: "cp-1",
    counterparty_name: "Northwind Supply",
    amount: 400,
    memo: "Annual support plan",
    po_reference: "PO-9",
    goods_received: true,
    due_date: "2026-10-30T12:00:00.000Z",
    status: "pending",
    agent_reasoning: null,
    tx_ref: null,
    scheduled_for: null,
    early_pay_discount_pct: null,
    discount_due_date: null,
    paid_amount: null,
    ...overrides,
  };
}

describe("invoiceDecision: scheduled outcome", () => {
  it("reads Scheduled for <date>, with the agent's reasoning", () => {
    const decision = invoiceDecision(
      invoice({
        status: "scheduled",
        scheduled_for: "2026-10-10T00:00:00.000Z",
        agent_reasoning: "A 2% early-payment discount (8 USDC) is worth more; paying on the discount deadline, Oct 10, 2026.",
      }),
      undefined,
      [], { network: "arc-testnet" });
    expect(decision.outcome).toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Scheduled for Oct 10, 2026");
    expect(decision.reasoning).toContain("discount deadline, Oct 10, 2026");
  });

  it("reads Not yet decided for a pending invoice, which has no scheduled day", () => {
    const decision = invoiceDecision(invoice({ status: "pending" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcome).toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Not yet decided");
  });

  it("reads Payment in flight for a matched invoice, whose transfer has been submitted", () => {
    const decision = invoiceDecision(invoice({ status: "matched", tx_ref: "circle-tx-1" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcome).toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Payment in flight");
  });

  it("reads Being decided by a person for an invoice claimed on Approvals", () => {
    const decision = invoiceDecision(invoice({ status: "processing" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcomeLabel).toBe("Being decided by a person");
  });

  it.each(["pending", "matched", "processing"])("never reads Scheduled for a %s invoice, even with a stale scheduled day", (status) => {
    const decision = invoiceDecision(invoice({ status, scheduled_for: "2026-10-10T00:00:00.000Z" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcomeLabel).toBeDefined();
    expect(decision.outcomeLabel).not.toMatch(/Scheduled/);
  });

  it("reads Awaiting payment for a pending receivable, since the agent never decides receivables", () => {
    const decision = invoiceDecision(invoice({ direction: "receivable", status: "pending" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcomeLabel).toBe("Awaiting payment");
  });

  it("still reads Not yet decided for a pending payable", () => {
    const decision = invoiceDecision(invoice({ direction: "payable", status: "pending" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcomeLabel).toBe("Not yet decided");
  });

  it("reads as paid, never Scheduled, for a paid invoice whose tx_ref is missing (the sample data's paid history row)", () => {
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: null }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcome).not.toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Paid");
  });

  it("reads as paid, never Scheduled, for a paid invoice whose tx_ref is in a form the badge doesn't recognise", () => {
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: "circle-tx-1" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcome).not.toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Paid");
  });

  it("still reads Settled on Arc / Simulated (its own outcome word, not Paid) for a paid invoice with a recognised tx_ref", () => {
    const onChain = invoiceDecision(invoice({ status: "paid", tx_ref: "0xabc" }), undefined, [], { network: "arc-testnet" });
    expect(onChain.outcome).toBe("settled");
    expect(onChain.outcomeLabel).toBeUndefined();

    const simulated = invoiceDecision(invoice({ status: "paid", tx_ref: "sim_1" }), undefined, [], { network: "arc-testnet" });
    expect(simulated.outcome).toBe("simulated");
    expect(simulated.outcomeLabel).toBeUndefined();
  });
});

describe("invoiceDecision: terms evidence", () => {
  it("shows the discount's terms when the invoice carries one", () => {
    const decision = invoiceDecision(
      invoice({ early_pay_discount_pct: "2.00", discount_due_date: "2026-10-10T12:00:00.000Z" }),
      undefined,
      [], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Terms", value: "2% off if paid by Oct 10, 2026", state: "neutral" });
  });

  it("omits it without a discount", () => {
    const decision = invoiceDecision(invoice(), undefined, [], { network: "arc-testnet" });
    expect(decision.evidence.find((item) => item.label === "Terms")).toBeUndefined();
  });
});

describe("invoiceDecision: status evidence", () => {
  it("does not repeat a scheduled invoice's date as evidence: the outcome already reads Scheduled for <date>", () => {
    const decision = invoiceDecision(invoice({ status: "scheduled", scheduled_for: "2026-10-10T00:00:00.000Z" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcomeLabel).toBe("Scheduled for Oct 10, 2026");
    expect(decision.evidence.find((item) => item.label === "Status")).toBeUndefined();
    expect(decision.evidence.some((item) => item.value.includes("Oct 10, 2026"))).toBe(false);
  });

  it("omits it for a pending invoice", () => {
    const decision = invoiceDecision(invoice({ status: "pending" }), undefined, [], { network: "arc-testnet" });
    expect(decision.evidence.find((item) => item.label === "Status")).toBeUndefined();
  });
});

describe("invoiceDecision: duplicate evidence", () => {
  const entry = (otherInvoiceStatus: string): LedgerEntry =>
    ({
      seq: 7,
      id: "e7",
      ts: "2026-10-01T09:00:00.000Z",
      actor: "agent",
      domain: "ap",
      action: "ap_flag_fraud",
      summary: "",
      detail: {
        invoiceId: "inv-1",
        guardrailBlocked: true,
        observed: { duplicateCheck: { candidatesConsidered: 3, matches: [{ otherInvoiceId: "inv-0", otherInvoiceStatus, confidence: 0.95 }] } },
      },
    }) as unknown as LedgerEntry;

  it.each([
    ["paid", "1 match at 95% against an invoice already paid"],
    ["received", "1 match at 95% against an invoice already paid"],
    ["matched", "1 match at 95% against an invoice already being paid"],
    ["scheduled", "1 match at 95% against an invoice already scheduled"],
    ["processing", "1 match at 95% against an invoice already being decided by a person"],
    ["pending", "1 match at 95%"],
  ])("says what the matched invoice's money is doing when it is %s", (status, value) => {
    const decision = invoiceDecision(invoice({ status: "flagged" }), undefined, [entry(status)], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Duplicate check", value, state: "missing" });
  });
});

describe("invoiceDecision: what a discounted payment actually paid", () => {
  it("shows the paid amount and the discount, when paid_amount is less than the full amount", () => {
    const decision = invoiceDecision(
      invoice({ status: "paid", amount: 400, paid_amount: 392, early_pay_discount_pct: "2.00", tx_ref: "sim_1" }),
      undefined,
      [], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Paid", value: "392.00 USDC (2% discount)", state: "ok" });
  });

  it("omits it when the full amount was paid", () => {
    const decision = invoiceDecision(invoice({ status: "paid", amount: 400, paid_amount: 400, tx_ref: "sim_1" }), undefined, [], { network: "arc-testnet" });
    expect(decision.evidence.find((item) => item.label === "Paid")).toBeUndefined();
  });

  it("omits it when nothing has been paid yet", () => {
    const decision = invoiceDecision(invoice({ status: "pending", paid_amount: null }), undefined, [], { network: "arc-testnet" });
    expect(decision.evidence.find((item) => item.label === "Paid")).toBeUndefined();
  });
});

describe("invoiceDecision: a EURC invoice (EURC invoices design E6)", () => {
  const decided = (detail: Record<string, unknown>, action = "ap_pay"): LedgerEntry =>
    ({ seq: 9, id: "e9", ts: "2026-10-01T09:00:00.000Z", actor: "agent", domain: "ap", action, summary: "", detail: { invoiceId: "inv-1", ...detail } }) as unknown as LedgerEntry;

  it("shows its amount in EURC, and the USDC value it was weighed at", () => {
    const decision = invoiceDecision(
      invoice({ currency: "EURC", amount: 100, status: "paid", tx_ref: "0xabc" }),
      undefined,
      [decided({ currency: "EURC", usdcValue: 117, fx: { rate: 1.17, source: "circle-stablecoin-quote", quotedAt: "2026-10-01T09:00:00.000Z" } })], { network: "arc-testnet" });
    expect(decision.token).toBe("EURC");
    expect(decision.amount).toBe(100);
    expect(decision.evidence).toContainEqual({ label: "USDC value", value: "117.00 USDC at 1.17", state: "neutral" });
  });

  it("says there was no rate when Circle gave none, and names that rule in the band", () => {
    const decision = invoiceDecision(
      invoice({ currency: "EURC", amount: 100, status: "held" }),
      undefined,
      [decided({ currency: "EURC", usdcValue: null, fx: null, guardrailBlocked: true, guardrailRule: "fx.rate_unavailable", observed: { paymentLimit: 200 } })], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "USDC value", value: "no rate", state: "missing" });
    expect(decision.guardrail).toMatchObject({ rule: "fx.rate_unavailable", attempted: 100, attemptedToken: "EURC", limit: 200, limitToken: "USDC" });
  });

  it("sets what it would send against the wallet's EURC when that was short", () => {
    const decision = invoiceDecision(
      invoice({ currency: "EURC", amount: 100, status: "held" }),
      undefined,
      [decided({ currency: "EURC", usdcValue: 117, eurcBalance: 40, guardrailBlocked: true, guardrailRule: "treasury.insufficient_eurc", observed: { paymentLimit: 200 } })], { network: "arc-testnet" });
    expect(decision.guardrail).toMatchObject({ rule: "treasury.insufficient_eurc", attempted: 100, attemptedToken: "EURC", limit: 40, limitToken: "EURC" });
  });

  it("says what a discounted EURC payment paid in EURC", () => {
    const decision = invoiceDecision(invoice({ currency: "EURC", amount: 100, status: "paid", paid_amount: 98, early_pay_discount_pct: "2.00" }), undefined, [], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Paid", value: "98.00 EURC (2% discount)", state: "ok" });
  });

  it("weighs the limit evidence on the USDC value, not on the face value", () => {
    const decision = invoiceDecision(
      invoice({ currency: "EURC", amount: 100, status: "held" }),
      { payment_limit: 110 } as never,
      [decided({ currency: "EURC", usdcValue: 117, guardrailBlocked: true, guardrailRule: "counterparty.payment_limit", observed: { paymentLimit: 110 } })], { network: "arc-testnet" });
    expect(decision.evidence.find((item) => item.label === "Limit")?.state).toBe("missing");
    expect(decision.guardrail).toMatchObject({ rule: "counterparty.payment_limit", attempted: 117, attemptedToken: "USDC", limit: 110, limitToken: "USDC" });
  });
});

describe("invoiceDecision: a payee on another chain (CCTP payouts X11)", () => {
  const reconciled = { seq: 12, id: "e12", ts: "2026-10-01T09:01:00.000Z", actor: "agent", domain: "ap", action: "ap_reconcile", summary: "",
    detail: { invoiceId: "inv-1", reconciled: true, execution: { txRef: "0xburn", destinationChain: "BASE-SEPOLIA", mintTxHash: "0xmint" } } } as unknown as LedgerEntry;

  it("links the mint on the payee's chain next to the burn on Arc, and says how it was paid", () => {
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: "0xburn" }), { payment_limit: 10, chain: "BASE-SEPOLIA" } as never, [reconciled], { network: "arc-testnet" });
    expect(decision.txHash).toBe("0xburn");
    expect(decision.mint).toEqual({ chainLabel: "Base Sepolia", txHash: "0xmint", href: "https://sepolia.basescan.org/tx/0xmint" });
    expect(decision.evidence).toContainEqual({ label: "Payee's chain", value: "Base Sepolia, through CCTP", state: "neutral" });
  });

  it("has no mint for a payee on Arc", () => {
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: "0xabc" }), { payment_limit: 10, chain: "ARC-TESTNET" } as never, [], { network: "arc-testnet" });
    expect(decision.mint ?? null).toBeNull();
    expect(decision.evidence.find((item) => item.label === "Payee's chain")).toBeUndefined();
  });
});

describe("invoiceDecision: a rule that is not a limit names itself (2026-10-07)", () => {
  const held = (rule: string, observed: Record<string, unknown> = {}) =>
    ({ seq: 14, id: "e14", ts: "2026-10-07T08:50:18.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", currency: "USDC", guardrailBlocked: true, guardrailRule: rule, observed: { paymentLimit: 1, riskLevel: "clear", ...observed } } }) as unknown as LedgerEntry;
  const guardrail = (rule: string, observed?: Record<string, unknown>) =>
    invoiceDecision(invoice({ amount: 0.1, status: "held" }), { payment_limit: 1, chain: "ARC" } as never, [held(rule, observed)], { network: "arc-mainnet" }).guardrail;

  it("names the new payee rule and why, not the payment limit the amount is within", () => {
    // The first payable on Arc mainnet: 0.10 USDC against a 1 USDC limit, held because one person alone stood behind
    // the address. The card said counterparty.payment_limit, "amount above screened limit", and offered Edit limit.
    expect(guardrail("counterparty.new_payee")).toEqual({
      rule: "counterparty.new_payee",
      attempted: 0.1,
      reason: "the first payment to this address, and only one person stands behind it",
    });
  });

  it.each([
    ["counterparty.address_unconfirmed", "the payee's address changed, and no one has confirmed it"],
    ["invoice.match_incomplete", "the three-way match is not complete"],
    ["invoice.duplicate_of_settled", "it repeats an invoice already paid, being paid or scheduled"],
    ["counterparty.client_payable", "the counterparty is a client: it pays this business"],
  ])("names %s and why", (rule, reason) => {
    expect(guardrail(rule)).toEqual({ rule, attempted: 0.1, reason });
  });

  it("sets an amount that needs two approvals against that figure", () => {
    expect(guardrail("workspace.two_approvals", { twoApprovalsAbove: 0.05 })).toEqual({
      rule: "workspace.two_approvals",
      attempted: 0.1,
      limit: 0.05,
      note: "above it, two people approve",
    });
  });

  it("still names the payment limit where that is the rule", () => {
    expect(guardrail("counterparty.payment_limit")).toMatchObject({ rule: "counterparty.payment_limit", attempted: 0.1, limit: 1 });
  });
});

describe("invoiceDecision: a payout code held (review I1, M3, M14)", () => {
  const held = (rule: string, payout: Record<string, unknown>) =>
    ({ seq: 13, id: "e13", ts: "2026-10-01T09:00:00.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", currency: "USDC", guardrailBlocked: true, guardrailRule: rule, payout, observed: { paymentLimit: 50, riskLevel: "clear" } } }) as unknown as LedgerEntry;

  it("names the fee rule, and sets the fee against what 10% of the invoice allows", () => {
    const decision = invoiceDecision(invoice({ amount: 2, status: "held" }), { payment_limit: 50, chain: "ETH-SEPOLIA" } as never, [
      held("bridge.fee_above_cap", { chain: "ETH-SEPOLIA", route: "cctp", domain: 0, feeUsdc: 1.854162 }),
    ], { network: "arc-testnet" });
    expect(decision.guardrail).toEqual({ rule: "bridge.fee_above_cap", attempted: 1.854162, limit: 0.2, note: "CCTP fee, against 10% of the invoice" });
  });

  it("names a payout held for want of a fee by its rule", () => {
    const decision = invoiceDecision(invoice({ amount: 2, status: "held" }), { payment_limit: 50, chain: "BASE-SEPOLIA" } as never, [
      held("bridge.fee_unavailable", { chain: "BASE-SEPOLIA", route: "cctp", domain: 6, feeUsdc: null }),
    ], { network: "arc-testnet" });
    expect(decision.guardrail).toMatchObject({ rule: "bridge.fee_unavailable", note: "no CCTP fee from Circle" });
  });

  it("names a payout held because the Gateway balance no longer covers the route its first attempt took (Gateway review I3)", () => {
    const decision = invoiceDecision(invoice({ amount: 1.5, status: "held" }), { payment_limit: 50, chain: "BASE-SEPOLIA" } as never, [
      held("bridge.gateway_balance_short", { chain: "BASE-SEPOLIA", route: "gateway", domain: 6, feeUsdc: 0.0505, gatewayBalanceUsdc: 1 }),
    ], { network: "arc-testnet" });
    expect(decision.guardrail).toEqual({ rule: "bridge.gateway_balance_short", attempted: 1.5505, limit: 1, note: "the Gateway balance, which an earlier attempt's route requires" });
  });

  it("calls the payee's chain what it is, paid or not", () => {
    const decision = invoiceDecision(invoice({ status: "held" }), { payment_limit: 50, chain: "BASE-SEPOLIA" } as never, [], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Payee's chain", value: "Base Sepolia, through CCTP", state: "neutral" });
  });

  // Entries come newest first: a reconcile that recorded the mint carries no payout of its own (Gateway review I4).
  it("keeps the card on the payment's decision when a receipt entry for the invoice is newer (receipts review #1)", () => {
    const decision = { seq: 580, id: "e580", ts: "2026-10-01T08:28:28.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", decisionMode: "heuristic", observed: { paymentLimit: 5, riskLevel: "clear" } } } as unknown as LedgerEntry;
    const renewed = { seq: 700, id: "e700", ts: "2026-10-01T09:30:00.000Z", actor: "human", domain: "ap", action: "receipt_link_renewed", summary: "",
      detail: { by: "user-1", invoiceId: "inv-1", receiptId: "rcpt-1" } } as unknown as LedgerEntry;
    const card = invoiceDecision(invoice({ status: "paid", tx_ref: `0x${"1".repeat(64)}` }), { payment_limit: 50, chain: "ARC-TESTNET" } as never, [renewed, decision], { network: "arc-testnet" });
    expect(card).toMatchObject({ auditSeq: 580, at: "2026-10-01T08:28:28.000Z", decisionMode: "heuristic" });
  });

  it("keeps the card on the payment's decision when a payment_stuck alert is newer (final review M7)", () => {
    const decision = { seq: 580, id: "e580", ts: "2026-10-01T08:28:28.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", decisionMode: "heuristic", observed: { paymentLimit: 5, riskLevel: "clear" } } } as unknown as LedgerEntry;
    const stuck = { seq: 701, id: "e701", ts: "2026-10-01T08:45:00.000Z", actor: "agent", domain: "ap", action: "payment_stuck", summary: "",
      detail: { invoiceId: "inv-1", minutes: 16, circleAsked: true, sendAnswered: true, providerState: "STUCK" } } as unknown as LedgerEntry;
    const card = invoiceDecision(invoice({ status: "matched", tx_ref: `0x${"1".repeat(64)}` }), { payment_limit: 50, chain: "ARC-TESTNET" } as never, [stuck, decision], { network: "arc-testnet" });
    expect(card).toMatchObject({ auditSeq: 580, at: "2026-10-01T08:28:28.000Z", decisionMode: "heuristic" });
  });

  const decided = (route: string) =>
    ({ seq: 20, id: "e20", ts: "2026-10-01T09:00:00.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", payout: { chain: "BASE-SEPOLIA", route, domain: 6, feeUsdc: 0.05 } } }) as unknown as LedgerEntry;
  const reconciled = { seq: 21, id: "e21", ts: "2026-10-01T09:05:00.000Z", actor: "agent", domain: "ap", action: "ap_reconcile", summary: "",
    detail: { invoiceId: "inv-1", reconciled: true, execution: { destinationChain: "BASE-SEPOLIA", mintTxHash: "0xmint" } } } as unknown as LedgerEntry;

  it("names the route a payout took from whichever entry recorded it, and never links its mint to Arc's explorer (Gateway review I4)", () => {
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: "0xmint" }), { payment_limit: 50, chain: "BASE-SEPOLIA" } as never, [reconciled, decided("gateway")], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Payee's chain", value: "Base Sepolia, through Gateway", state: "neutral" });
    expect(decision.txHash).toBeNull();
    expect(decision.mint).toEqual({ chainLabel: "Base Sepolia", txHash: "0xmint", href: "https://sepolia.basescan.org/tx/0xmint" });
  });

  it("links a CCTP payout's burn on Arc, but never a transaction that is its mint (Gateway review I4)", () => {
    const burn = invoiceDecision(invoice({ status: "paid", tx_ref: "0xburn" }), { payment_limit: 50, chain: "BASE-SEPOLIA" } as never, [reconciled, decided("cctp")], { network: "arc-testnet" });
    expect(burn.evidence).toContainEqual({ label: "Payee's chain", value: "Base Sepolia, through CCTP", state: "neutral" });
    expect(burn.txHash).toBe("0xburn");
    const mint = invoiceDecision(invoice({ status: "paid", tx_ref: "0xmint" }), { payment_limit: 50, chain: "BASE-SEPOLIA" } as never, [reconciled, decided("cctp")], { network: "arc-testnet" });
    expect(mint.txHash).toBeNull();
  });

  it("sets the route's fee against the other route's, when the decision recorded both (route evidence)", () => {
    const quoted = { seq: 22, id: "e22", ts: "2026-10-01T09:00:00.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", payout: { chain: "ARB-SEPOLIA", route: "gateway", domain: 3, feeUsdc: 0.107811, quotes: { cctpFeeUsdc: 0.135342, gatewayFeeUsdc: 0.107811 } } } } as unknown as LedgerEntry;
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: "0xmint" }), { payment_limit: 50, chain: "ARB-SEPOLIA" } as never, [quoted], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Payee's chain", value: "Arbitrum Sepolia, through Gateway at 0.107811 USDC, against 0.135342 USDC through CCTP", state: "neutral" });
    // A route with no quote to set it against reads as before.
    const alone = { ...quoted, detail: { ...quoted.detail, payout: { chain: "ARB-SEPOLIA", route: "cctp", domain: 3, feeUsdc: 0.135342, quotes: { cctpFeeUsdc: 0.135342, gatewayFeeUsdc: null } } } } as unknown as LedgerEntry;
    expect(invoiceDecision(invoice({ status: "paid", tx_ref: "0xburn" }), { payment_limit: 50, chain: "ARB-SEPOLIA" } as never, [alone], { network: "arc-testnet" }).evidence).toContainEqual({
      label: "Payee's chain",
      value: "Arbitrum Sepolia, through CCTP",
      state: "neutral",
    });
  });

  it("links no simulated mint", () => {
    const simulated = { seq: 14, id: "e14", ts: "2026-10-01T09:00:00.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", execution: { destinationChain: "BASE-SEPOLIA", mintTxHash: "sim_mint_1" } } } as unknown as LedgerEntry;
    expect(invoiceDecision(invoice({ status: "paid", tx_ref: "sim_1" }), undefined, [simulated], { network: "arc-testnet" }).mint ?? null).toBeNull();
  });
});

describe("invoiceDecision: a EURC invoice paid from USDC by a swap (EURC swap spec S9)", () => {
  const decided = (detail: Record<string, unknown>): LedgerEntry =>
    ({ seq: 9, id: "e9", ts: "2026-10-01T09:00:00.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "", detail: { invoiceId: "inv-1", currency: "EURC", usdcValue: 2.43, ...detail } }) as unknown as LedgerEntry;
  const SWAP_TX = `0x${"5a".repeat(32)}`;

  it("shows the swap that funded it, linked to its transaction on Arc testnet", () => {
    const decision = invoiceDecision(
      invoice({ currency: "EURC", amount: 2, status: "paid", tx_ref: "0xabc" }),
      undefined,
      [decided({ swap: { swapId: "s-1", state: "confirmed", usdcIn: 2.507384, eurcReceived: 2.063076, swapTxHash: SWAP_TX, reason: null } })], { network: "arc-testnet" });
    expect(decision.evidence).toContainEqual({ label: "Funded by swap", value: "2.507384 USDC → 2.063076 EURC", href: `https://explorer.testnet.arc.io/tx/${SWAP_TX}`, state: "ok" });
  });

  it("says a swap failed, or is in flight", () => {
    const failed = invoiceDecision(invoice({ currency: "EURC", amount: 2, status: "held" }), undefined, [
      decided({ swap: { swapId: "s-1", state: "failed", usdcIn: 2.507384, eurcReceived: null, swapTxHash: null, reason: "Circle did not complete the swap (FAILED)." } }),
    ], { network: "arc-testnet" });
    expect(failed.evidence).toContainEqual({ label: "Swap", value: "failed", state: "missing" });
    const inFlight = invoiceDecision(invoice({ currency: "EURC", amount: 2, status: "held" }), undefined, [
      decided({ swap: { swapId: "s-1", state: "pending", usdcIn: 2.507384, eurcReceived: null, swapTxHash: null, reason: "in flight" } }),
    ], { network: "arc-testnet" });
    expect(inFlight.evidence).toContainEqual({ label: "Swap", value: "in flight", state: "neutral" });
  });

  it("shows no swap row for a EURC payment the wallet's EURC covered", () => {
    const decision = invoiceDecision(invoice({ currency: "EURC", amount: 2, status: "paid", tx_ref: "0xabc" }), undefined, [decided({ swap: null })], { network: "arc-testnet" });
    expect(decision.evidence.map((item) => item.label)).not.toContain("Funded by swap");
    expect(decision.evidence.map((item) => item.label)).not.toContain("Swap");
  });

  it("sets a swap held for its cost against the cap", () => {
    const decision = invoiceDecision(invoice({ currency: "EURC", amount: 2, status: "held" }), undefined, [
      decided({ guardrailBlocked: true, guardrailRule: "fx.swap_cost_above_cap", swapOffer: { usdcIn: 2.6, costPercent: 3.2 }, observed: { paymentLimit: 200 } }),
    ], { network: "arc-testnet" });
    expect(decision.guardrail).toEqual({ rule: "fx.swap_cost_above_cap", attempted: 3.2, attemptedToken: "%", limit: 3, limitToken: "%", note: "the swap's cost above the quoted rate" });
  });

  it("sets a swap held for the USDC it would leave against what falls due", () => {
    const decision = invoiceDecision(invoice({ currency: "EURC", amount: 2, status: "held" }), undefined, [
      decided({ guardrailBlocked: true, guardrailRule: "fx.swap_usdc_short", swapOffer: { usdcIn: 2.507384 }, observed: { paymentLimit: 200, operatingBalance: 7 }, usdcDueWithin7Days: 5 }),
    ], { network: "arc-testnet" });
    expect(decision.guardrail).toEqual({ rule: "fx.swap_usdc_short", attempted: 4.492616, attemptedToken: "USDC", limit: 5, limitToken: "USDC", note: "USDC left after the swap, against what falls due within 7 days" });
  });
});

describe("invoiceDecision: the purchase order of a counterparty paid without them (three-way match design M2)", () => {
  const counterparty = (purchaseOrderRequired: boolean) =>
    ({ id: "cp-1", name: "Northwind Supply", role: "vendor", risk_level: "clear", payment_limit: 1000, purchase_order_required: purchaseOrderRequired }) as unknown as Parameters<typeof invoiceDecision>[1];
  const po = (purchaseOrderRequired: boolean) =>
    invoiceDecision(invoice({ po_reference: null }), counterparty(purchaseOrderRequired), [], { network: "arc-testnet" }).evidence.find((item) => item.label === "PO");

  it("shows no purchase order as not needed, not as missing", () => {
    expect(po(false)).toEqual({ label: "PO", value: "not needed", state: "neutral" });
  });

  it("shows it missing for a counterparty that needs one", () => {
    expect(po(true)).toEqual({ label: "PO", value: "none", state: "missing" });
  });
});

describe("invoiceDecision: a receivable (receivables on Arc)", () => {
  // A receivable is money a client owes the business. Its card must not read like a payable's (PO, goods
  // received, payment limit, the payee's chain) nor say the agent never evaluated it once a transfer settled it
  // (the partner's test, 2026-10-02: "Recorded", "The agent has not evaluated this invoice yet.").
  const receivable = (overrides: Partial<InvoiceRow> = {}) =>
    invoice({ direction: "receivable", counterparty_name: "CME", amount: 1.25, memo: "Rec", po_reference: "PO-111", ...overrides });
  const received = {
    seq: 653,
    ts: "2026-10-01T17:21:00.000Z",
    actor: "agent",
    domain: "ar",
    action: "ar_received",
    summary: "Received 1.25 USDC from CME on Arc testnet",
    detail: {
      invoiceId: "inv-1",
      counterpartyId: "cp-1",
      amount: 1.25,
      currency: "USDC",
      txHash: `0x4bdd${"0".repeat(56)}8c81`,
      from: "0x351d50ac54274fbda179dee81c94d7378df06833",
      circleTxId: "circle-1",
      matchedBy: "amount",
      receivedAt: "2026-10-01T17:03:08.000Z",
    },
  } as unknown as LedgerEntry;

  it("reads Received on Arc with its transaction, and says how the transfer was matched", () => {
    const decision = invoiceDecision(receivable({ status: "received", tx_ref: `0x4bdd${"0".repeat(56)}8c81` }), undefined, [received], { network: "arc-testnet" });
    expect(decision.domain).toBe("ar");
    expect(decision.outcome).toBe("settled");
    expect(decision.outcomeLabel).toBe("Received on Arc");
    expect(decision.txHash).toBe(`0x4bdd${"0".repeat(56)}8c81`);
    expect(decision.auditSeq).toBe(653);
    expect(decision.reasoning).toBe(
      "Received 1.25 USDC from 0x351d…6833 on Arc testnet on Oct 1, 2026, and matched it to this invoice: it is the only open receivable of that amount, and CME was sent its pay link."
    );
    expect(decision.evidence).toEqual([
      { label: "Due", value: "10/30/2026", state: "neutral" },
      { label: "Received from", value: "0x351d…6833", state: "ok" },
      { label: "Matched by", value: "amount, through the pay link", state: "ok" },
    ]);
  });

  it("says the client's own address matched it", () => {
    const bySender = { ...received, detail: { ...received.detail, matchedBy: "sender" } } as unknown as LedgerEntry;
    const decision = invoiceDecision(receivable({ status: "received", tx_ref: "0xabc" }), undefined, [bySender], { network: "arc-testnet" });
    expect(decision.reasoning).toContain("it came from CME's address on file");
    expect(decision.evidence).toContainEqual({ label: "Matched by", value: "the client's address", state: "ok" });
  });

  it("names the viewed workspace's network in a receivable's reasoning: Arc mainnet there (mainnet copy C1, C4)", () => {
    expect(invoiceDecision(receivable({ status: "received", tx_ref: "0xabc" }), undefined, [received as unknown as LedgerEntry], { network: "arc-mainnet" }).reasoning).toContain("on Arc mainnet");
    const waiting = invoiceDecision(receivable({ status: "pending" }), undefined, [], { network: "arc-mainnet" }).reasoning;
    expect(waiting).toContain("operating wallet on Arc mainnet");
    expect(waiting).not.toContain("Arc testnet");
  });

  it("waits on the client while it is open, with nothing of a payable's", () => {
    const decision = invoiceDecision(receivable({ status: "pending" }), undefined, [], { network: "arc-testnet" });
    expect(decision.outcomeLabel).toBe("Awaiting payment");
    expect(decision.reasoning).toBe(
      "Waiting for CME to pay. When the exact amount arrives in the operating wallet on Arc testnet, the agent matches it to this invoice."
    );
    expect(decision.evidence).toEqual([{ label: "Due", value: "10/30/2026", state: "neutral" }]);
  });

  it("reads Received for one a person marked received without a transfer", () => {
    expect(invoiceDecision(receivable({ status: "received", tx_ref: null }), undefined, [], { network: "arc-testnet" }).outcomeLabel).toBe("Received");
  });
});

describe("invoiceDecision: a payment held for the agent's spending limit (outflow budget spec §4)", () => {
  const entry = (detail: Record<string, unknown>) =>
    ({ seq: 21, id: "e21", ts: "2026-10-02T09:00:00.000Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "",
      detail: { invoiceId: "inv-1", guardrailBlocked: true, guardrailRule: "workspace.outflow_budget", observed: { paymentLimit: 500, riskLevel: "clear" }, ...detail } }) as unknown as LedgerEntry;
  const room = { dailyUsdc: 500, weeklyUsdc: 2000, spentToday: 300, spentThisWeek: 300, remaining: 200, binding: "day" };

  it("sets the amount against what the limit left, naming the figure and what was already paid", () => {
    const decision = invoiceDecision(invoice({ amount: 250, status: "held" }), { payment_limit: 500 } as never, [entry({ currency: "USDC", outflowBudget: room })], { network: "arc-testnet" });
    expect(decision.outcome).toBe("refused");
    expect(decision.guardrail).toEqual({ rule: "workspace.outflow_budget", attempted: 250, attemptedToken: "USDC", limit: 200, limitToken: "USDC", note: "left of the 500.00 USDC daily spending limit; 300.00 USDC already paid today" });
  });

  it("names the 7-day figure, and weighs a EURC payable at its USDC value", () => {
    const decision = invoiceDecision(invoice({ amount: 100, currency: "EURC", status: "held" }), { payment_limit: 500 } as never, [
      entry({ currency: "EURC", usdcValue: 117, outflowBudget: { ...room, spentThisWeek: 1950, remaining: 50, binding: "week" } }),
    ], { network: "arc-testnet" });
    expect(decision.guardrail).toEqual({ rule: "workspace.outflow_budget", attempted: 117, attemptedToken: "USDC", limit: 50, limitToken: "USDC", note: "left of the 2,000.00 USDC 7-day spending limit; 1,950.00 USDC already paid in the last 7 days" });
  });
});
