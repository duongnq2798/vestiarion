import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision } from "@/components/vx/map";
import { settlementAnchor, settlementSummary, SettlementTrack, UNKNOWN_OUTCOME } from "@/components/vx/SettlementTrack";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow } from "@/lib/queries";
import { reduceSettlement, type Settlement, type SettlementBooks, type SettlementFact } from "@/lib/settlement";

/**
 * Where a payment is, on a payable's card (settlement lifecycle L7): each stage with when, from which source, and its
 * entry or transaction; the ends and an unknown outcome in words (L3, I18); never a bank; nothing by colour alone.
 */

const T = (minute: number) => `2026-10-11T10:${String(minute).padStart(2, "0")}:00.000Z`;
const NOW = Date.parse(T(40));
const TX = `0x${"ab".repeat(32)}`;
const MINT = `0x${"ef".repeat(32)}`;
const ID = "4c6d0f1e-0000-4000-8000-00000000a001";
const paid: SettlementBooks = { paid: true, txRef: TX, at: T(6) };
const open: SettlementBooks = { paid: false, txRef: null, at: null };

const decided: SettlementFact[] = [
  { kind: "proposed", at: T(0), by: "agent", seq: 41 },
  { kind: "authorized", at: T(0), by: "code", seq: 41 },
  { kind: "submitted", at: T(1), attempt: 1 },
];
const pending: SettlementFact = { kind: "pending", at: T(2), attempt: 1, state: "SENT", by: "circle" };
const confirmed: SettlementFact = { kind: "confirmed", at: T(5), attempt: 1, refs: [TX], txHash: TX };
const recorded: SettlementFact = { kind: "recorded", at: T(6), seq: 42, txRef: TX };

const lifecycle = (facts: SettlementFact[], books: SettlementBooks | null = paid, over: { crossChain?: boolean; simulated?: boolean } = {}): Settlement =>
  reduceSettlement({ facts, books, crossChain: over.crossChain ?? false, simulated: over.simulated ?? false });

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const render = (settlement: Settlement, network: "arc-testnet" | "arc-mainnet" = "arc-testnet") =>
  renderToStaticMarkup(<SettlementTrack id={ID} settlement={settlement} orgSlug="acme" network={network} now={NOW} />);

describe("the track of a reconciled payment", () => {
  const markup = render(lifecycle([...decided, pending, confirmed, recorded]));
  const words = text(markup);

  it("is folded under Where the payment is, says where it is now, and opens at its anchor", () => {
    expect(markup).toContain(`id="${settlementAnchor(ID)}"`);
    expect(settlementAnchor(ID)).toBe(`settlement-${ID}`);
    expect(markup).toMatch(/<details[^>]*id="settlement-/);
    expect(markup).not.toMatch(/<details[^>]*open/);
    expect(words).toContain("Where the payment is");
    expect(words).toContain("Reconciled");
  });

  it("says each stage, when, and from which source, with its entry and its transaction", () => {
    for (const line of [
      "Proposed",
      "The agent decided to pay it.",
      "Authorized",
      "Code's checks passed, so the agent could pay it on its own.",
      "Submitted",
      "Vestiarion sent it to Circle.",
      "Pending",
      "Circle took it and had not confirmed it yet (Circle: SENT).",
      "Confirmed",
      "Circle confirmed it on Arc testnet.",
      "In the payee's wallet",
      "A confirmed transfer on Arc testnet is final: the money is in the payee's wallet there. Moving it to a bank is the payee's own step, which Vestiarion does not see.",
      "The bill is marked paid with this transaction, and a signed entry records it.",
      "Oct 11, 2026, 10:05 UTC",
      "A confirmed transfer cannot be charged back or reversed. A refund would be a new transfer back, a separate payment.",
    ]) {
      expect(words, line).toContain(line);
    }
    expect(markup).toContain('href="/o/acme/audit#seq-41"');
    expect(markup).toContain('href="/o/acme/audit#seq-42"');
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/tx/${TX}"`);
  });

  it("tells each stage reached or not in words, not by colour alone", () => {
    expect(markup.match(/, reached/g)).toHaveLength(7);
    expect(markup).not.toContain("not reached");
  });

  it("never says the money is in a bank", () => {
    expect(words).not.toMatch(/in (?:the|their|your) bank|bank[- ]available|available in/i);
  });
});

describe("the track in flight", () => {
  it("says it is pending, how long ago it was sent, and what is still to come", () => {
    const settlement = lifecycle([...decided, pending], open);
    expect(settlementSummary(settlement, NOW)).toBe("Pending · sent 39 min ago");
    const words = text(render(settlement));
    expect(words).toContain("Pending · sent 39 min ago");
    expect(words).toContain("Confirmed , not reached Not yet.");
  });

  it("says Circle could not be read just now, and that nothing is sent again", () => {
    const words = text(render(lifecycle([...decided, pending, { kind: "read_failed", at: T(20), attempt: 1 }], open)));
    expect(words).toContain("Circle could not be read just now; nothing is sent again until it answers.");
  });

  it("says Circle's stuck state as Circle's, and the transfer watch's read as the watch's", () => {
    expect(text(render(lifecycle([...decided, { ...pending, state: "STUCK" }], open)))).toContain("Circle shows it stuck: it was sent and can still be mined (Circle: STUCK).");
    expect(text(render(lifecycle([...decided, { ...pending, state: "QUEUED", by: "watch" }], open)))).toContain("Not confirmed when the transfer watch asked Circle (Circle: QUEUED).");
  });

  it("says an unknown outcome is being checked with Circle, and that nothing new is sent until Circle answers (I18)", () => {
    const settlement = lifecycle([...decided, { kind: "unanswered", at: T(3), attempt: 1 }], open);
    expect(settlementSummary(settlement, NOW)).toBe("Outcome unknown · checking with Circle · sent 39 min ago");
    const words = text(render(settlement));
    expect(words).toContain("Outcome unknown");
    expect(words).toContain(UNKNOWN_OUTCOME.replace(/^Outcome unknown: /, ""));
    expect(UNKNOWN_OUTCOME).toBe(
      "Outcome unknown: Circle did not answer when this payment was sent, so it may have taken the transfer. Vestiarion looks for it on Circle before anything else is sent, and sends a new transfer only once Circle shows none."
    );
  });

  it("says a payout to another chain is asked for again under its own key, which Circle cannot list (I18)", () => {
    const settlement = lifecycle([...decided, { kind: "unanswered", at: T(3), attempt: 1 }], open, { crossChain: true });
    const words = text(render(settlement));
    expect(words).toContain(
      "Circle did not answer when this payment was sent, so it may have taken the transfer. A payout to another chain is asked for again under the same payment key, which Circle takes only once, so it is never sent twice."
    );
    expect(words).not.toContain("looks for it on Circle");
  });

  it("says Gateway's failure may still be minted, and that nothing is sent again (L3)", () => {
    const words = text(render(lifecycle([...decided, { ...pending, state: "GATEWAY_FAILED" }], open, { crossChain: true })));
    expect(words).toContain("Pending · sent 39 min ago");
    expect(words).toContain("Gateway reported it failed, but it may still be minted on the payee's chain, so nothing is sent again (Circle: GATEWAY_FAILED).");
    expect(words).not.toContain("Circle could not be read just now");
  });
});

describe("the ends", () => {
  it("say failed, cancelled and not sent apart, and that the payee was not paid", () => {
    const failed = text(render(lifecycle([...decided, pending, { kind: "ended", at: T(4), attempt: 1, end: "failed", state: "FAILED", reason: "INSUFFICIENT_TOKEN" }], open)));
    expect(failed).toContain("Failed: Circle ended it (FAILED: INSUFFICIENT_TOKEN). The payee was not paid.");
    expect(failed).toContain("Confirmed , not reached Not reached.");
    expect(failed).not.toMatch(/no money moved/i);
    expect(text(render(lifecycle([...decided, pending, { kind: "ended", at: T(4), attempt: 1, end: "cancelled", state: "CANCELLED", reason: null }], open)))).toContain(
      "Cancelled: Circle cancelled it. The payee was not paid."
    );
    expect(text(render(lifecycle([...decided, { kind: "ended", at: T(4), attempt: 1, end: "not_sent", state: null, reason: "refused" }], open)))).toContain(
      "Not sent: the send did not reach Circle, so the payee was not paid."
    );
  });

  it("follows a new attempt, and lists the earlier one with how it ended", () => {
    const settlement = lifecycle(
      [...decided, pending, { kind: "ended", at: T(4), attempt: 1, end: "cancelled", state: "CANCELLED", reason: null }, { kind: "authorized", at: T(9), by: "person", seq: 50 }, { kind: "submitted", at: T(10), attempt: 2 }],
      open
    );
    expect(settlementSummary(settlement, NOW)).toBe("Submitted · sent 30 min ago · attempt 2");
    const words = text(render(settlement));
    expect(words).toContain("A person approved it.");
    expect(words).toContain("Vestiarion sent it to Circle, as attempt 2.");
    expect(words).toContain("Earlier attempts");
    expect(words).toContain("Attempt 1, Oct 11, 2026, 10:04 UTC: Cancelled: Circle cancelled it. The payee was not paid.");
  });
});

describe("what available means (L4)", () => {
  it("names the chain a payout to another chain was minted on, and links the mint there", () => {
    const minted: SettlementFact = { kind: "minted", at: T(6), attempt: 1, chain: "BASE-SEPOLIA", txHash: MINT };
    const markup = render(lifecycle([...decided, { ...confirmed, refs: [MINT], txHash: MINT }, minted], null, { crossChain: true }));
    expect(text(markup)).toContain("Minted on Base Sepolia: the money is in the payee's wallet there.");
    expect(markup).toContain(`href="https://sepolia.basescan.org/tx/${MINT}"`);
    expect(text(render(lifecycle([...decided, confirmed], null, { crossChain: true })))).toContain("Not minted on the payee's chain yet.");
  });

  it("says a simulated payment reached no wallet", () => {
    const words = text(render(lifecycle([...decided, { ...confirmed, refs: ["sim_1"], txHash: "sim_1" }, { ...recorded, txRef: "sim_1" }], { paid: true, txRef: "sim_1", at: T(6) }, { simulated: true })));
    expect(words).toContain("Simulated in the sandbox: confirmed at once, with nothing on chain.");
    expect(words).toContain("A simulated payment reaches no wallet.");
    expect(words).not.toContain("cannot be charged back");
  });

  it("names Arc mainnet on a mainnet workspace, and never Arc testnet", () => {
    const markup = render(lifecycle([...decided, pending, confirmed, recorded]), "arc-mainnet");
    expect(text(markup)).toContain("Circle confirmed it on Arc mainnet.");
    expect(markup).not.toContain("Arc testnet");
  });
});

describe("the books", () => {
  it("says what does not match, in the summary and in a sentence", () => {
    const settlement = lifecycle([...decided, confirmed], open);
    expect(settlementSummary(settlement, NOW)).toBe("Confirmed · not yet marked paid");
    expect(text(render(settlement))).toContain("Confirmed, but the bill is not marked paid yet: the agent's next cycle marks it.");
    expect(text(render(lifecycle([...decided, pending])))).toContain("The bill is marked paid, but Circle has not confirmed this transfer.");
  });

  it("says a stage before the furthest one with nothing recorded is not recorded here, rather than not yet", () => {
    expect(text(render(lifecycle([pending, confirmed, recorded])))).toContain("Proposed , not reached Not recorded here.");
  });

  it("says a contradiction it ignored, and why the confirmed state stands", () => {
    const words = text(render(lifecycle([...decided, pending, confirmed, recorded, { kind: "ended", at: T(30), attempt: 1, end: "failed", state: "FAILED", reason: null }])));
    expect(words).toContain("A failure recorded on Oct 11, 2026, 10:30 UTC, after Circle confirmed this transfer, is ignored: a confirmed transfer stays confirmed.");
  });
});

describe("a payable's card", () => {
  const INVOICE: InvoiceRow = {
    id: ID,
    direction: "payable",
    counterparty_id: "cp-1",
    counterparty_name: "Harbor VPS",
    amount: 24,
    memo: null,
    po_reference: "PO-7",
    goods_received: true,
    due_date: "2026-10-20",
    status: "matched",
    agent_reasoning: "Paid.",
    tx_ref: "circle-tx-1",
    scheduled_for: null,
    early_pay_discount_pct: null,
    discount_due_date: null,
    paid_amount: 24,
  };

  it("shows the track under the trail when the page read the payment, and none otherwise", () => {
    const settlement = lifecycle([...decided, pending], open);
    const decision = invoiceDecision(INVOICE, undefined, [] as LedgerEntry[], { network: "arc-testnet", settlements: new Map([[ID, settlement]]), asOf: NOW });
    expect(decision.settlement).toEqual({ lifecycle: settlement, asOf: NOW });
    expect(text(renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="acme" />))).toContain("Where the payment is Pending · sent 39 min ago");
    expect(invoiceDecision(INVOICE, undefined, [], { network: "arc-testnet" }).settlement).toBeUndefined();
    // A receivable's card never shows one: it is money coming in.
    expect(invoiceDecision({ ...INVOICE, direction: "receivable" }, undefined, [], { network: "arc-testnet", settlements: new Map([[ID, settlement]]) }).settlement).toBeUndefined();
  });
});

describe("Bills & receivables", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "invoices", "page.tsx"), "utf8");

  it("reads each payable's payment in the workspace's scope, best effort, and hands the cards their lifecycle (L8)", () => {
    expect(page).toMatch(/return inOrg\(access, async \(\) => \{[\s\S]*readInvoicePayments\(db\(\)\)\.catch\(/);
    expect(page).toContain("settlementsByBill({ payments: payments.values(), invoices: shown.filter((invoice) => invoice.direction === \"payable\"), entries, now: asOf })");
    expect(page).toContain("{ network, deciding, verdicts, settlements, asOf }");
  });
});
