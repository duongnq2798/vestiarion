import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { DECIDING_NOW, invoiceDecision } from "@/components/vx/map";
import { deciderName, invoiceTrail, laterBy, trailStep, TRAIL_STEPS_SHOWN, type TrailEntry } from "@/lib/decision-trail";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow } from "@/lib/queries";

/**
 * How the agent decided, step by step (decision trail spec R1–R3): the signed entries about a payable as a person
 * reads them, on its card; and a payable a running cycle is deciding says so.
 */

const INVOICE = "3755e7fa-e2e1-4803-9be3-c26604af5b3f";
const TX = `0x${"79".repeat(32)}`;
const at = (time: string) => `2026-10-03T${time}Z`;
const step = (seq: number, time: string, actor: string, action: string, detail: Record<string, unknown> = {}): TrailEntry => ({
  seq,
  ts: at(time),
  actor,
  action,
  summary: "",
  detail: { invoiceId: INVOICE, ...detail },
});

/** The #153 test in testnet-2, as the ledger holds it. */
const JIREN: TrailEntry[] = [
  step(963, "01:59:42", "human", "create_invoice"),
  step(965, "02:00:04", "agent", "ap_request_info", {
    decisionMode: "deepseek",
    agreedWithReference: true,
    decision: { action: "request_info" },
    observed: { riskLevel: "clear", paymentLimit: 30, poReference: null, goodsReceived: false, amount: 0.3, duplicateCheck: { matchesTotal: 2 } },
  }),
  step(968, "02:20:25", "human", "invoice_details_added", { added: { poReference: "PO-131", goodsReceived: true } }),
  step(971, "02:20:43", "agent", "invoice_reopened", { followUp: { changes: ["purchase order PO-131 has since been supplied", "goods have since been confirmed received"] } }),
  step(972, "02:20:53", "agent", "ap_pay", {
    decisionMode: "deepseek",
    agreedWithReference: false,
    decision: { action: "pay" },
    observed: { riskLevel: "clear", paymentLimit: 30, poReference: "PO-131", goodsReceived: true, amount: 0.3, duplicateCheck: { matchesTotal: 2 } },
    onChainLimit: { verdict: { state: "allowed" } },
    execution: { txRef: TX, resultingStatus: "paid" },
  }),
  step(990, "02:30:00", "human", "receipt_shared"),
];

describe("the decision trail", () => {
  it("tells each step in words, oldest first, leaving out what is not a step", () => {
    const steps = invoiceTrail([...JIREN].reverse(), INVOICE);
    expect(steps.map((s) => s.seq)).toEqual([963, 965, 968, 971, 972]);
    expect(steps.map((s) => s.text)).toEqual([
      "A person added it.",
      "DeepSeek decided to ask for more information before paying it, as the written policy would.",
      "A person added purchase order PO-131 and goods received.",
      "The agent saw the facts change and took it up again.",
      "DeepSeek decided to pay it; the written policy would have decided otherwise.",
    ]);
    expect(steps.map((s) => s.who)).toEqual(["person", "agent", "person", "agent", "agent"]);
  });

  it("says what each decision checked, what code said, and what reached Arc", () => {
    const paid = trailStep(JIREN[4])!;
    expect(paid.notes).toEqual([
      "✓ Purchase order PO-131 on file and the goods received",
      "✓ Counterparty screened clear",
      "✓ 0.30 USDC within its 30.00 USDC limit",
      "· Resembles 2 earlier invoices",
      "✓ The spending-limit contract on Arc allowed it",
      "✓ Sent on Arc testnet",
    ]);
    expect(paid).toMatchObject({ tone: "done", txHash: TX });
    expect(trailStep(JIREN[1])).toMatchObject({ tone: "stopped", txHash: null });
    expect(trailStep(JIREN[1])!.notes[0]).toBe("✗ No purchase order on file");
    expect(trailStep(JIREN[3])!.notes).toEqual(["· Purchase order PO-131 has since been supplied", "· Goods have since been confirmed received"]);
  });

  it("says whether two people stood behind the address of a first payment (new payee check N6)", () => {
    const decided = (twoParties: boolean) =>
      trailStep(
        step(981, "02:41:00", "agent", "ap_pay", {
          decisionMode: "deepseek",
          decision: { action: "pay" },
          observed: { riskLevel: "clear", paymentLimit: 30, poReference: "PO-1", goodsReceived: true, amount: 0.3, newPayee: { addressBy: "m1", confirmedBy: twoParties ? "m2" : null, twoParties } },
        })
      )!.notes;
    expect(decided(false)).toContain("✗ First payment to this address, and only one person stands behind it");
    expect(decided(true)).toContain("✓ First payment to this address, with two people behind it");
  });

  it("says no purchase order was needed for a counterparty paid without them (three-way match design M4)", () => {
    const decided = (goodsReceived: boolean) =>
      trailStep(
        step(980, "02:40:00", "agent", "ap_pay", {
          decisionMode: "deepseek",
          decision: { action: "pay" },
          observed: { riskLevel: "clear", paymentLimit: 30, poReference: null, goodsReceived, purchaseOrderRequired: false, amount: 0.3 },
        })
      )!.notes[0];
    expect(decided(true)).toBe("✓ The goods received; no purchase order needed for this counterparty");
    expect(decided(false)).toBe("✗ The goods not marked received; no purchase order needed for this counterparty");
  });

  it("says when code refused what the model decided, and sends nothing", () => {
    const refused = trailStep(step(977, "02:23:07", "agent", "ap_pay", { decisionMode: "deepseek", guardrailBlocked: true, guardrailRule: "bridge.fee_above_cap", execution: { txRef: null } }))!;
    expect(refused).toMatchObject({ tone: "stopped", txHash: null });
    expect(refused.notes).toContain("✗ Code refused it before anything was sent: bridge.fee_above_cap");
  });

  it("names a person's decisions and the agent's other steps", () => {
    expect(trailStep(step(980, "02:47:18", "human", "approval_paid", { txRef: TX }))).toMatchObject({ text: "A person approved and paid it.", txHash: TX, who: "person" });
    expect(trailStep(step(980, "02:47:18", "human", "approval_paid", { soleApprover: true }))!.text).toBe(
      "The person who entered it approved and paid it, as the workspace's only approver."
    );
    expect(trailStep(step(981, "02:47:18", "human", "approval_rejected", { reason: "Duplicate bill" }))).toMatchObject({ text: "A person rejected it.", notes: ["· Duplicate bill"] });
    expect(trailStep(step(982, "02:47:18", "agent", "recurring_invoice_created"))!.text).toBe("Its recurring schedule created it.");
    expect(trailStep(step(983, "02:47:18", "human", "create_invoice", { document: { kind: "pdf" } }))!.text).toBe("A person added it, read from a document.");
    expect(trailStep(step(984, "02:47:18", "agent", "ap_schedule", { decisionMode: "heuristic", decision: { payOn: "2026-10-05" } }))!.text).toBe(
      "The written policy decided to pay it on Oct 5."
    );
  });

  it("keeps the latest steps of a long history", () => {
    const many = Array.from({ length: TRAIL_STEPS_SHOWN + 4 }, (_, index) => step(index + 1, "01:00:00", "agent", "invoice_escalated"));
    const steps = invoiceTrail(many, INVOICE);
    expect(steps).toHaveLength(TRAIL_STEPS_SHOWN);
    expect(steps.at(-1)!.seq).toBe(TRAIL_STEPS_SHOWN + 4);
  });

  it("says how long after the step before each came", () => {
    expect(laterBy(null, at("02:20:53"))).toBeNull();
    expect(laterBy(at("02:20:25"), at("02:20:53"))).toBe("28 s later");
    expect(laterBy(at("01:59:42"), at("02:20:25"))).toBe("21 min later");
    expect(laterBy(at("01:59:42"), "2026-10-05T01:00:00Z")).toBeNull();
  });

  it("names who decided", () => {
    expect(deciderName("deepseek")).toBe("DeepSeek");
    expect(deciderName("heuristic")).toBe("The written policy");
    expect(deciderName(undefined)).toBe("The model");
  });
});

const row = (overrides: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: INVOICE,
  direction: "payable",
  counterparty_id: "cp-1",
  counterparty_name: "Jiren",
  amount: 0.3,
  memo: null,
  po_reference: "PO-131",
  goods_received: true,
  due_date: "2026-10-03",
  status: "paid",
  agent_reasoning: "Paid.",
  tx_ref: TX,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: 0.3,
  ...overrides,
});
const ledger = (entries: TrailEntry[]) =>
  [...entries].reverse().map((entry) => ({ ...entry, id: `e${entry.seq}`, bodyHash: "00", signature: "00", prevHash: null, hash: "00", signingKeyId: null })) as unknown as LedgerEntry[];

describe("a receivable's trail (collections R8)", () => {
  const RECEIVABLE: TrailEntry[] = [
    step(1100, "06:00:00", "human", "ar_reminders_on", { by: "u1", linkId: "l1" }),
    step(1101, "06:00:20", "agent", "ar_reminder_deferred", { decisionMode: "deepseek", agreedWithReference: false, until: "2026-10-05T06:00:20.000Z" }),
    step(1102, "09:00:00", "agent", "ar_reminder_sent", {
      decisionMode: "deepseek",
      agreedWithReference: true,
      tone: "firm",
      daysFromDue: 3,
      number: 2,
      to: "bi***@acme.example",
      toneLimited: { chosen: "final", sent: "firm" },
    }),
    step(1103, "10:00:00", "agent", "ar_received", { txHash: TX }),
  ];

  it("tells reminders turned on, a wait, a reminder sent and the payment matched", () => {
    const steps = invoiceTrail([...RECEIVABLE].reverse(), INVOICE);
    expect(steps.map((s) => s.text)).toEqual([
      "A person turned on the agent's reminders to the client.",
      "DeepSeek decided to wait until Oct 5 before reminding the client; the written policy would have decided otherwise.",
      "DeepSeek decided to remind the client by email, in a firm tone, 3 days after the due date, as the written policy would.",
      "The agent matched the payment received on Arc testnet.",
    ]);
    expect(steps[2].notes).toEqual(["· Reminder 2 of 4, sent to bi***@acme.example", "✗ It chose a final tone; code sent it firm"]);
  });

  it("is on the receivable's card", () => {
    const decision = invoiceDecision(row({ direction: "receivable", status: "pending", tx_ref: null, paid_amount: null }), undefined, ledger(RECEIVABLE), { network: "arc-testnet" });
    expect(decision.trail?.map((s) => s.seq)).toEqual([1100, 1101, 1102, 1103]);
  });
});

describe("a payable's card", () => {
  it("carries its trail, folded under How the agent decided, which a link opens at", () => {
    const decision = invoiceDecision(row(), undefined, ledger(JIREN), { network: "arc-testnet" });
    expect(decision.trail?.map((s) => s.seq)).toEqual([963, 965, 968, 971, 972]);
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="acme" />);
    expect(markup).toContain(`id="trail-${INVOICE}"`);
    expect(markup).toContain("How the agent decided");
    expect(markup).toContain("5 steps · signed");
    expect(markup).toContain("10 s later");
    expect(markup).toContain("22 s later");
    expect(markup).toContain('href="/o/acme/audit#seq-972"');
    // Each check on its own line, read down a list (the partner's ask): never run together in one wrapped row.
    expect(markup).toContain('<ul class="mt-1 space-y-0.5 text-xs text-ink-2"><li>✓ Purchase order PO-131 on file and the goods received</li><li>✓ Counterparty screened clear</li>');
    expect(markup).not.toMatch(/<ul class="[^"]*flex-wrap[^"]*"><li>✓/);
  });

  it("says a payable not yet decided is being decided while a cycle runs", () => {
    const pending = row({ status: "pending", tx_ref: null, paid_amount: null, agent_reasoning: null });
    const deciding = invoiceDecision(pending, undefined, [], { network: "arc-testnet", deciding: true });
    expect(deciding).toMatchObject({ outcome: "deciding", reasoning: DECIDING_NOW });
    expect(renderToStaticMarkup(<DecisionCard decision={deciding} orgSlug="acme" />)).toContain("Deciding now");
    expect(invoiceDecision(pending, undefined, [], { network: "arc-testnet" })).toMatchObject({ outcome: "scheduled", outcomeLabel: "Not yet decided" });
    // A decided payable stays as it was.
    expect(invoiceDecision(row(), undefined, ledger(JIREN), { network: "arc-testnet", deciding: true }).outcome).toBe("settled");
  });
});
