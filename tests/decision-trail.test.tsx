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

  it("names the viewed workspace's network in each step that reached the chain: Arc mainnet there (mainnet copy C1, C4)", () => {
    expect(trailStep(JIREN[4], "arc-mainnet")!.notes).toContain("✓ Sent on Arc mainnet");
    expect(trailStep(step(1, "02:00:00", "agent", "ap_reconcile", { invoiceId: INVOICE, execution: { txRef: TX, resultingStatus: "paid" } }), "arc-mainnet")!.text).toBe(
      "The agent confirmed the payment on Arc mainnet."
    );
    expect(trailStep(step(2, "02:00:00", "agent", "ar_received", { invoiceId: INVOICE, txHash: TX }), "arc-mainnet")!.text).toBe("The agent matched the payment received on Arc mainnet.");
    const steps = invoiceTrail([...JIREN].reverse(), INVOICE, "arc-mainnet");
    expect(JSON.stringify(steps)).not.toContain("Arc testnet");
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

  it("says when a first payment's address came through a payee link or a GitHub bounty, and whether someone other than who asked for it confirmed it", () => {
    const decided = (newPayee: Record<string, unknown>) =>
      trailStep(
        step(983, "02:43:00", "agent", "ap_pay", { decisionMode: "deepseek", decision: { action: "pay" }, observed: { riskLevel: "clear", amount: 0.3, newPayee } })
      )!.notes;
    expect(decided({ addressBy: "payee", linkCreatedBy: "m1", confirmedBy: "m1", twoParties: false })).toContain(
      "✗ First payment to this address, sent through a payee link and confirmed by no one but the member who created it"
    );
    expect(decided({ addressBy: "payee", linkCreatedBy: "m1", confirmedBy: "m2", twoParties: true })).toContain(
      "✓ First payment to this address, sent through a payee link and confirmed by someone other than the member who created it"
    );
    expect(decided({ addressBy: "payee", bountyBy: "m1", confirmedBy: "m1", twoParties: false })).toContain(
      "✗ First payment to this address, sent on GitHub and confirmed by no one but the member its bounty acts as"
    );
    // A payee's address no member can be named as having asked for.
    expect(decided({ addressBy: "payee", confirmedBy: "m2", twoParties: false })).toContain("✗ First payment to this address, and only one person stands behind it");
  });

  it("says a first payment to a mirror address is to a wallet Vestiarion made, not one two people stand behind (shadow mode S7)", () => {
    const notes = trailStep(
      step(982, "02:42:00", "agent", "ap_pay", {
        decisionMode: "deepseek",
        decision: { action: "pay" },
        observed: { riskLevel: "clear", amount: 0.3, newPayee: { addressBy: "mirror", confirmedBy: null, twoParties: true } },
      })
    )!.notes;
    expect(notes).toContain("✓ First payment to this address, a mirror address Vestiarion made in shadow mode");
    expect(notes.join(" ")).not.toContain("two people");
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
    expect(trailStep(step(980, "02:47:18", "human", "approval_paid", { txRef: TX, status: "paid" }))).toMatchObject({ text: "A person approved and paid it.", txHash: TX, who: "person", tone: "done" });
    expect(trailStep(step(980, "02:47:18", "human", "approval_paid", { soleApprover: true, status: "paid" }))!.text).toBe(
      "The person who entered it approved and paid it, as the workspace's only approver."
    );
  });

  it("says an approval paid only once its transfer confirmed: submitted, failed, or not said (settlement lifecycle L9, I17)", () => {
    expect(trailStep(step(985, "02:47:18", "human", "approval_paid", { txRef: TX, status: "matched" }))).toMatchObject({
      text: "A person approved it; the payment was submitted and is waiting for Circle to confirm it on Arc testnet.",
      txHash: TX,
      tone: "neutral",
    });
    expect(trailStep(step(985, "02:47:18", "human", "approval_paid", { txRef: TX, status: "matched" }), "arc-mainnet")!.text).toBe(
      "A person approved it; the payment was submitted and is waiting for Circle to confirm it on Arc mainnet."
    );
    // Held again: Circle may have ended the transfer, or Gateway reported it failed though it may still be minted, or a read
    // of ours failed on a transfer still moving. The entry does not say which, so the step never says it failed.
    expect(trailStep(step(986, "02:47:18", "human", "approval_paid", { txRef: null, status: "held" }))).toMatchObject({
      text: "A person approved it; the payment was not confirmed, so it was held again.",
      tone: "stopped",
    });
    for (const held of [
      // A Gateway payout whose intent Gateway reported GATEWAY_FAILED: approving read it again and sent nothing.
      { txRef: "gateway:0f2b", status: "held", attempt: 1 },
      // A transfer Circle took whose read threw: the intent stays failed with its provider id, and may still settle.
      { txRef: "circle-tx-7", status: "held", attempt: 1 },
    ]) {
      expect(trailStep(step(991, "02:47:18", "human", "approval_paid", held))!.text).not.toMatch(/failed/);
    }
    expect(trailStep(step(987, "02:47:18", "human", "approval_paid", { txRef: TX }))).toMatchObject({ text: "A person approved paying it.", tone: "neutral" });
    expect(trailStep(step(988, "02:47:18", "human", "approval_paid", { soleApprover: true, status: "matched" }))!.text).toBe(
      "The person who entered it approved it, as the workspace's only approver; the payment was submitted and is waiting for Circle to confirm it on Arc testnet."
    );
    expect(trailStep(step(989, "02:47:18", "human", "approval_paid", { soleApprover: true, status: "held" }))!.text).toBe(
      "The person who entered it approved it, as the workspace's only approver; the payment was not confirmed, so it was held again."
    );
    expect(trailStep(step(990, "02:47:18", "human", "approval_paid", { soleApprover: true }))!.text).toBe(
      "The person who entered it approved paying it, as the workspace's only approver."
    );
    expect(trailStep(step(981, "02:47:18", "human", "approval_rejected", { reason: "Duplicate bill" }))).toMatchObject({ text: "A person rejected it.", notes: ["· Duplicate bill"] });
    expect(trailStep(step(982, "02:47:18", "agent", "recurring_invoice_created"))!.text).toBe("Its recurring schedule created it.");
    // A person moved its day from the payment plan (payment plan design P9): the agent still checks it on that day.
    expect(trailStep(step(985, "02:47:18", "human", "payment_rescheduled", { from: "2026-10-22", to: "2026-10-15" }))).toMatchObject({
      who: "person",
      tone: "neutral",
      text: "A person moved its payment to Oct 15 from the payment plan.",
      notes: ["· The agent checks it again on that day before it pays"],
    });
    expect(trailStep(step(986, "02:47:18", "human", "payment_rescheduled", { to: "2026-10-15", soleApprover: true }))!.text).toBe(
      "A person moved its payment to Oct 15 from the payment plan, as the workspace's only approver."
    );
    expect(trailStep(step(983, "02:47:18", "human", "create_invoice", { document: { kind: "pdf" } }))!.text).toBe("A person added it, read from a document.");
    expect(trailStep(step(983, "02:47:18", "human", "create_invoice", { via: "import", importRow: 12 }))!.text).toBe("A person added it, imported from a list.");
    expect(trailStep(step(983, "02:47:18", "human", "create_invoice", { via: "xero", xero: { tenantId: "t", billId: "b", contactId: "c", invoiceNumber: "PD-4471" } }))!.text).toBe(
      "A person added it, brought in from Xero."
    );
    expect(trailStep(step(983, "02:47:18", "human", "create_invoice", { via: "quickbooks", quickbooks: { tenantId: "9341455327810551", billId: "146", contactId: "56", invoiceNumber: "PD-4471" } }))!.text).toBe(
      "A person added it, brought in from QuickBooks."
    );
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

describe("a reconcile, as it found the payment (stuck-transfer alert D8)", () => {
  const reconcile = (resultingStatus?: string) =>
    step(995, "08:00:00", "agent", "ap_reconcile", { execution: { txRef: TX, ...(resultingStatus ? { resultingStatus } : {}) } });

  it("says confirmed only when the payment was paid", () => {
    expect(trailStep(reconcile("paid"))).toMatchObject({ who: "agent", tone: "done", text: "The agent confirmed the payment on Arc testnet.", txHash: TX });
    expect(trailStep(reconcile("matched"))).toMatchObject({ tone: "neutral", text: "The agent checked the payment: still in flight on Arc testnet." });
    // Held for a person, never "did not go through": a payout across chains is held with its USDC already sent.
    expect(trailStep(reconcile("held"))).toMatchObject({ tone: "stopped", text: "The agent checked the payment and held the invoice for a person." });
    expect(trailStep(reconcile())).toMatchObject({ tone: "neutral", text: "The agent checked the payment on Arc testnet." });
  });

  it("shows a payment that has not confirmed, and that the workspace's people were told", () => {
    expect(trailStep(step(996, "08:05:00", "agent", "payment_stuck", { minutes: 18, txHash: TX }))).toMatchObject({
      who: "agent",
      tone: "stopped",
      text: "Not confirmed 18 minutes after it was submitted; the workspace's people were told.",
      txHash: TX,
    });
  });
});

describe("a receivable's trail of what its customer said (customer portal P10)", () => {
  it("tells a claim of payment as the customer's word, a promise, a dispute and a person's answers", () => {
    const SAID: TrailEntry[] = [
      step(1200, "08:00:00", "human", "customer_said_paid", { via: "customer_portal", paidOn: "2026-10-12", amount: 750, currency: "USDC" }),
      step(1201, "08:10:00", "human", "customer_promised_payment", { via: "customer_portal", promisedOn: "2026-10-20" }),
      step(1202, "08:20:00", "human", "customer_disputed_invoice", { via: "customer_portal" }),
      step(1203, "09:00:00", "human", "customer_request_replied", { by: "u1", kind: "dispute" }),
      step(1204, "09:30:00", "human", "customer_request_closed", { by: "u1", kind: "paid", outcome: "not_received" }),
    ];
    const steps = invoiceTrail([...SAID].reverse(), INVOICE);
    expect(steps.map((s) => s.text)).toEqual([
      "The customer said on its statement that it paid 750.00 USDC on Oct 12.",
      "The customer promised on its statement to pay by Oct 20.",
      "The customer disputed the invoice on its statement.",
      "A person replied to the customer on its statement.",
      "A person closed the customer's claim of payment: not received.",
    ]);
    expect(steps[0].notes).toEqual([
      "· Its word, not a payment: the invoice stays open until the money arrives and is applied",
      "· The agent's reminders wait until a person finds it or marks it not received; finance is asked after 7 days",
    ]);
  });

  it("tells what the collections stage asked a person, their answer, and a reminder they approved (collections context C6)", () => {
    const ASKED = [
      step(1300, "08:00:00", "agent", "collection_task_opened", { taskId: "t1", reason: "promise_passed" }),
      step(1301, "08:30:00", "human", "collection_task_resolved", { by: "u1", taskId: "t1", outcome: "held", holdUntil: "2026-10-25" }),
      step(1302, "09:00:00", "agent", "collection_task_opened", { taskId: "t2", reason: "policy_ask_first" }),
      step(1303, "09:10:00", "human", "collection_task_resolved", { by: "u1", taskId: "t2", outcome: "approved", reminder: { number: 2, tone: "firm" } }),
      step(1304, "09:20:00", "agent", "ar_reminder_sent", { decisionMode: "person", tone: "firm", daysFromDue: 4, number: 2, to: "bi***@acme.example" }),
      step(1305, "10:00:00", "agent", "collection_task_opened", { taskId: "t3", reason: "claim_unverified" }),
      step(1306, "10:10:00", "human", "collection_task_resolved", { by: "u1", taskId: "t3", reason: "claim_unverified", outcome: "resumed" }),
      step(1307, "10:20:00", "human", "collection_task_resolved", { by: "u1", taskId: "t4", reason: "claim_unverified", outcome: "held", holdUntil: "2026-10-30" }),
    ];
    const steps = invoiceTrail([...ASKED].reverse(), INVOICE);
    expect(steps.map((s) => s.text)).toEqual([
      "The agent asked a person before going on: the customer's promised day passed.",
      "A person held reminders until Oct 25.",
      "The agent asked a person before going on: the customer's rules say to ask first.",
      "A person approved reminder 2, firm.",
      "A person approved the reminder, and the agent sent it to the client by email, in a firm tone, 4 days after the due date.",
      "The agent asked a person before going on: the customer says it paid, and the payment is still not found a week later.",
      "A person marked the customer's claim of payment not received and let reminders go again.",
      "A person marked the customer's claim of payment not received and held reminders until Oct 30.",
    ]);
  });
});
