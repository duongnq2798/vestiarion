import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision } from "@/components/vx/map";
import { settlementAnchor, settlementSummary, SettlementTrack, UNKNOWN_OUTCOME } from "@/components/vx/SettlementTrack";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow } from "@/lib/queries";
import { reduceSettlement, type Settlement, type SettlementBooks, type SettlementFact, type SettlementInput } from "@/lib/settlement";
import { settlementOf, type IntentRecord } from "@/lib/settlement-facts";

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
/** Circle's answer to the send, in the send's minute: its word needs no time of its own. */
const pending: SettlementFact = { kind: "pending", at: T(1), attempt: 1, state: "SENT", by: "circle" };
const confirmed: SettlementFact = { kind: "confirmed", at: T(5), attempt: 1, refs: [TX], txHash: TX };
const recorded: SettlementFact = { kind: "recorded", at: T(6), seq: 42, txRef: TX };

const lifecycle = (facts: SettlementFact[], books: SettlementBooks | null = paid, over: { crossChain?: boolean; simulated?: boolean; bridge?: SettlementInput["bridge"] } = {}): Settlement =>
  reduceSettlement({ facts, books, crossChain: over.crossChain ?? false, simulated: over.simulated ?? false, bridge: over.bridge ?? null });

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

  it("shows Pending from the send, when Circle took it, and Circle's latest word with when it was read", () => {
    // Sent at 10:01 and answered at once; the agent's cycle read it again at 10:25, rewriting the intent's executed_at.
    const read = text(render(lifecycle([...decided, { ...pending, at: T(25) }], open)));
    expect(read).toContain("Pending , reached Oct 11, 2026, 10:01 UTC Circle took it and had not confirmed it yet (Circle: SENT, as of Oct 11, 2026, 10:25 UTC).");
    expect(read).not.toContain("reached Oct 11, 2026, 10:25 UTC");
    // The transfer watch's read says when the watch asked, and one with no word from Circle says when it checked.
    expect(text(render(lifecycle([...decided, pending, { ...pending, at: T(20), state: "STUCK", by: "watch" }], open)))).toContain(
      "Pending , reached Oct 11, 2026, 10:01 UTC Circle shows it stuck: it was sent and can still be mined (Circle: STUCK, as of Oct 11, 2026, 10:20 UTC)."
    );
    expect(text(render(lifecycle([...decided, { ...pending, at: T(20), state: null, by: "watch" }], open)))).toContain(
      "Not confirmed when the transfer watch checked it (as of Oct 11, 2026, 10:20 UTC)."
    );
  });

  it("says an unknown outcome is being checked with Circle while the agent's cycle comes back to the bill, and that nothing new is sent until Circle answers (I18)", () => {
    const settlement = lifecycle([...decided, { kind: "unanswered", at: T(3), attempt: 1 }], { ...open, followUp: "cycle" });
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

  it("says an unknown outcome on a bill held for a person waits for them, never that it is being checked (L10)", () => {
    const unanswered: SettlementFact = { kind: "unanswered", at: T(3), attempt: 1 };
    const held = lifecycle([...decided, unanswered], { ...open, followUp: "approvals" });
    expect(settlementSummary(held, NOW)).toBe("Outcome unknown · waiting for a person in Approvals · sent 39 min ago");
    const words = text(render(held));
    expect(words).not.toContain("checking with Circle");
    expect(words).toContain(`${UNKNOWN_OUTCOME.replace(/^Outcome unknown: /, "")} Nothing checks it on its own now: it waits for a person's Approve and pay in Approvals.`);
    // A held milestone is paid on Contractors.
    const milestone = lifecycle([...decided, unanswered], { ...open, followUp: "contractors" });
    expect(settlementSummary(milestone, NOW)).toBe("Outcome unknown · waiting for a person on Contractors · sent 39 min ago");
    expect(text(render(milestone))).toContain("Nothing checks it on its own now: it waits for a person's Pay now on Contractors.");
    // No one known to come back to it: nothing is promised.
    const none = lifecycle([...decided, unanswered], open);
    expect(settlementSummary(none, NOW)).toBe("Outcome unknown · sent 39 min ago");
    expect(text(render(none))).not.toMatch(/checking with Circle|waits for a person/);
  });

  it("says Gateway's failure may still be minted, that nothing is sent again, and that nothing checks it on its own (L3)", () => {
    const settlement = lifecycle([...decided, { ...pending, state: "GATEWAY_FAILED" }], open, { crossChain: true });
    // Not in flight: no age, as Treasury does not count it.
    expect(settlementSummary(settlement, NOW)).toBe("Gateway reported it failed");
    const markup = render(settlement);
    const words = text(markup);
    expect(words).toContain("Where the payment is Gateway reported it failed");
    expect(words).toContain(
      "Gateway reported it failed, but it may still be minted on the payee's chain, so nothing is sent again (Circle: GATEWAY_FAILED). Nothing checks it on its own: check with Circle whether it was minted."
    );
    expect(words).not.toContain("sent 39 min ago");
    expect(words).not.toContain("Circle could not be read just now");
    // Not a failure by colour alone, nor a green line: the summary is told in words, as an end's.
    expect(markup).toMatch(/text-held[^"]*">Gateway reported it failed/);
  });
});

describe("a CCTP payout waiting for its mint (L3)", () => {
  const BURN = `0x${"cd".repeat(32)}`;
  const bridged = (state: string, by: "circle" | "watch" = "circle", step: "approve" | "burn" = "burn") =>
    lifecycle([...decided, { ...pending, state, by }], open, { crossChain: true, bridge: { step, txHash: BURN, chain: "BASE-SEPOLIA" } });

  it("says Circle confirmed the burn on Arc and the mint is not recorded yet, linking the burn, never that Circle had not confirmed it", () => {
    for (const state of ["CONFIRMED", "COMPLETE"]) {
      const markup = render(bridged(state));
      const words = text(markup);
      expect(words, state).toContain(`Circle confirmed the burn on Arc testnet; the mint on Base Sepolia is not recorded yet (Circle: ${state}).`);
      expect(words, state).not.toContain("had not confirmed it yet");
      expect(markup, state).toContain(`href="https://explorer.testnet.arc.io/tx/${BURN}"`);
    }
    expect(settlementSummary(bridged("CONFIRMED"), NOW)).toBe("Pending · sent 39 min ago");
  });

  it("says the transfer watch's read of it as the watch's", () => {
    const words = text(render(bridged("CONFIRMED", "watch")));
    expect(words).toContain("When the transfer watch asked, Circle had confirmed the burn on Arc testnet; the mint on Base Sepolia is not recorded yet (Circle: CONFIRMED).");
    expect(words).not.toContain("Not confirmed when the transfer watch asked Circle");
  });

  it("says an approve Circle confirmed, whose burn was never sent, as that", () => {
    const words = text(render(bridged("CONFIRMED", "circle", "approve")));
    expect(words).toContain("Circle confirmed the approve on Arc testnet; the burn that pays the payee has not been sent yet (Circle: CONFIRMED).");
    expect(words).not.toContain("had not confirmed it yet");
  });

  it("says when Circle's word about the burn was read, once that is after the send", () => {
    const read = lifecycle([...decided, { ...pending, at: T(25), state: "CONFIRMED" }], open, { crossChain: true, bridge: { step: "burn", txHash: BURN, chain: "BASE-SEPOLIA" } });
    expect(text(render(read))).toContain(
      "Pending , reached Oct 11, 2026, 10:01 UTC Circle confirmed the burn on Arc testnet; the mint on Base Sepolia is not recorded yet (Circle: CONFIRMED, as of Oct 11, 2026, 10:25 UTC)."
    );
  });

  it("keeps Circle's word while the burn is not confirmed, and names the network a mainnet workspace pays on", () => {
    expect(text(render(bridged("SENT")))).toContain("Circle took it and had not confirmed it yet (Circle: SENT).");
    expect(text(render(bridged("CONFIRMED"), "arc-mainnet"))).toContain("Circle confirmed the burn on Arc mainnet;");
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
    const notSent = text(render(lifecycle([...decided, { kind: "ended", at: T(4), attempt: 1, end: "not_sent", state: null, reason: "This workspace has no Gateway balance yet." }], open)));
    expect(notSent).toContain("Not sent: it stopped before Circle took the transfer (This workspace has no Gateway balance yet). The payee was not paid.");
    // Started, never said sent to Circle, when Circle never took it.
    expect(notSent).toContain("Vestiarion started sending it.");
    expect(notSent).not.toContain("Vestiarion sent it to Circle");
  });

  it("says a request Circle refused stopped before Circle took the transfer, never that it did not reach Circle, with Circle's words", () => {
    // Circle answered the send with a 4xx in its own words: the row keeps them in last_error, with no provider id.
    const refused = text(render(lifecycle([...decided, { kind: "ended", at: T(4), attempt: 1, end: "not_sent", state: null, reason: "the asset amount owned by the wallet is insufficient" }], open)));
    expect(refused).toContain("Not sent: it stopped before Circle took the transfer (the asset amount owned by the wallet is insufficient). The payee was not paid.");
    expect(refused).not.toContain("did not reach Circle");
    // With no reason recorded, it says so without one.
    expect(text(render(lifecycle([...decided, { kind: "ended", at: T(4), attempt: 1, end: "not_sent", state: null, reason: null }], open)))).toContain(
      "Not sent: it stopped before Circle took the transfer. The payee was not paid."
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
    // Gateway's transaction is its mint: linked on the payee's chain at both stages, never on Arc's explorer.
    expect(markup).not.toContain(`explorer.testnet.arc.io/tx/${MINT}`);
    expect(markup.match(/sepolia\.basescan\.org\/tx\//g)).toHaveLength(2);
    expect(text(render(lifecycle([...decided, confirmed], null, { crossChain: true })))).toContain("Not minted on the payee's chain yet.");
  });

  it("names a chain no network lists by its own id, unlinked, rather than failing the page", () => {
    const minted: SettlementFact = { kind: "minted", at: T(6), attempt: 1, chain: "NOT-A-CHAIN", txHash: MINT };
    const markup = render(lifecycle([...decided, { ...confirmed, refs: [MINT], txHash: MINT }, minted], null, { crossChain: true }));
    expect(text(markup)).toContain("Minted on NOT-A-CHAIN: the money is in the payee's wallet there.");
    // Known by its mint, on a chain the track cannot link: neither stage links it, and never on Arc's explorer.
    expect(markup).not.toContain(`/tx/${MINT}`);
    expect(text(markup)).toContain("Circle confirmed it.");
  });

  it("says a simulated payment was simulated from its send on, and reached no wallet", () => {
    const words = text(render(lifecycle([...decided, { ...confirmed, refs: ["sim_1"], txHash: "sim_1" }, { ...recorded, txRef: "sim_1" }], { paid: true, txRef: "sim_1", at: T(6) }, { simulated: true })));
    // The simulator never contacts Circle.
    expect(words).toContain("Vestiarion simulated sending it.");
    expect(words).not.toContain("Vestiarion sent it to Circle");
    expect(words).toContain("Simulated in the sandbox: confirmed at once, with nothing on chain.");
    expect(words).toContain("A simulated payment reaches no wallet.");
    expect(words).not.toContain("cannot be charged back");
  });

  it("says a payment created in a sandbox and paid live once the workspace went live was sent to Circle, as its receipt does", () => {
    // The simulator refused it in the sandbox; the row keeps provider 'simulate', and the live result wrote 'live'.
    const intent: IntentRecord = {
      status: "confirmed",
      provider: "simulate",
      provider_mode: "live",
      provider_tx_id: "circle-tx-1",
      provider_state: "COMPLETE",
      failure_reason: null,
      last_error: null,
      tx_hash: TX,
      mint_tx_hash: null,
      destination_chain: null,
      transfer_attempt: 1,
      previous_attempts: [],
      submitted_at: T(1),
      executed_at: T(5),
      confirmed_at: T(5),
      created_at: T(0),
      updated_at: T(5),
      batch_key: null,
      network: "arc-testnet",
    };
    const entries = [{ seq: 42, ts: T(6), action: "approval_paid", detail: { invoiceId: "inv-1", status: "paid", txRef: TX } }];
    const words = text(render(settlementOf({ intent, entries, source: { type: "invoice", id: "inv-1" }, books: paid, now: NOW })));
    expect(words).toContain("Vestiarion sent it to Circle.");
    expect(words).toContain("Circle confirmed it on Arc testnet.");
    expect(words).toContain("A confirmed transfer on Arc testnet is final: the money is in the payee's wallet there.");
    expect(words).toContain("A confirmed transfer cannot be charged back or reversed.");
    expect(words).not.toMatch(/simulated/i);
  });

  it("links a reconciled Gateway payout's transaction on the payee's chain, never on Arc's explorer", () => {
    const minted: SettlementFact = { kind: "minted", at: T(6), attempt: 1, chain: "BASE-SEPOLIA", txHash: MINT };
    const settlement = lifecycle([...decided, { ...confirmed, refs: [MINT, "gateway:x"], txHash: MINT }, minted, { ...recorded, txRef: MINT }], { paid: true, txRef: MINT, at: T(7) }, { crossChain: true });
    expect(settlement.status).toBe("reconciled");
    const markup = render(settlement);
    expect(markup).not.toContain(`explorer.testnet.arc.io/tx/${MINT}`);
    // Confirmed, in the payee's wallet, and reconciled: all three on the payee's chain.
    expect(markup.match(/sepolia\.basescan\.org\/tx\//g)).toHaveLength(3);
  });

  it("names Arc mainnet on a mainnet workspace, and never Arc testnet", () => {
    const markup = render(lifecycle([...decided, pending, confirmed, recorded]), "arc-mainnet");
    expect(text(markup)).toContain("Circle confirmed it on Arc mainnet.");
    expect(markup).not.toContain("Arc testnet");
  });
});

describe("the books", () => {
  it("says what does not match, in the summary and in a sentence", () => {
    const settlement = lifecycle([...decided, confirmed], { ...open, followUp: "cycle" });
    expect(settlementSummary(settlement, NOW)).toBe("Confirmed · not yet marked paid");
    expect(text(render(settlement))).toContain("Confirmed, but the bill is not marked paid yet: the agent's next cycle marks it.");
    expect(text(render(lifecycle([...decided, pending])))).toContain("The bill is marked paid, but Circle has not confirmed this transfer.");
  });

  it("says who records a confirmed transfer the books do not show, and promises no one when no one comes back to the bill", () => {
    const books = (followUp: SettlementBooks["followUp"]) => text(render(lifecycle([...decided, confirmed], { ...open, followUp })));
    expect(books("approvals")).toContain("Confirmed, but the bill is not marked paid yet: Approve and pay in Approvals records it.");
    expect(books("contractors")).toContain("Confirmed, but the bill is not marked paid yet: Pay now on Contractors records it.");
    expect(books(null)).toContain("Confirmed, but the bill is not marked paid yet.");
    expect(books(null)).not.toContain("next cycle");
  });

  it("says the entry was not among those read, rather than a mismatch, when the read was cut short", () => {
    const settlement = reduceSettlement({ facts: [...decided, pending, confirmed], books: paid, crossChain: false, simulated: false, recordingsComplete: false });
    expect(settlementSummary(settlement, NOW)).toBe("Confirmed");
    const words = text(render(settlement));
    expect(words).toContain(
      "Reconciled , not reached The bill is marked paid with this transaction. The signed entry that records it is older than the entries this page reads, so it is not checked here."
    );
    expect(words).not.toContain("no signed entry names it");
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
    // Entries read up to the read's limit may leave out older ones: the lifecycle is told, so a missing entry is no mismatch.
    expect(page).toContain(
      "settlementsByBill({ payments: payments.values(), invoices: shown.filter((invoice) => invoice.direction === \"payable\"), entries, entriesComplete: !ledgerReadMayBeCut(entries), now: asOf })"
    );
    expect(page).toContain("{ network, deciding, verdicts, settlements, asOf, allocations }");
  });
});
