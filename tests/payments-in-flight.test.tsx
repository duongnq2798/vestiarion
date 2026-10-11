import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { flightLine, PaymentsInFlight } from "@/components/vx/PaymentsInFlight";
import { paymentsInFlight, reduceSettlement, type SettlementBooks, type SettlementFact } from "@/lib/settlement";
import type { FlightRow } from "@/lib/settlement-facts";

/**
 * Treasury's Payments in flight (settlement lifecycle L7): what was sent and not confirmed, the oldest first, with its age
 * and where it is; what the books do not match; the line with the pending-aging and outstanding-mismatch figures; a
 * payment past the network's wait said in words; nothing when there is nothing to show.
 */

const T = (minute: number) => `2026-10-11T10:${String(minute).padStart(2, "0")}:00.000Z`;
const NOW = Date.parse(T(40));
const TX = `0x${"ab".repeat(32)}`;
const open: SettlementBooks = { paid: false, txRef: null, at: null };

const row = (id: string, facts: SettlementFact[], over: Partial<FlightRow> = {}, books: SettlementBooks = open, crossChain = false): FlightRow => ({
  source: { type: "invoice", id },
  name: `Payee ${id}`,
  amount: 10,
  currency: "USDC",
  settlement: reduceSettlement({ facts, books, crossChain, simulated: false }),
  ...over,
});

const sent = (minute: number): SettlementFact => ({ kind: "submitted", at: T(minute), attempt: 1 });
const old = row("a", [sent(1), { kind: "pending", at: T(2), attempt: 1, state: "STUCK", by: "watch" }], { amount: 120.5 });
const fresh = row("b", [sent(35)], { amount: 2.25 });
const unknown = row("c", [sent(30), { kind: "unanswered", at: T(31), attempt: 1 }], { amount: 4, currency: "EURC", source: { type: "milestone", id: "c" }, name: "Design review for Ana Lima" });
const lagging = row("d", [sent(36), { kind: "confirmed", at: T(38), attempt: 1, refs: [TX], txHash: TX }], { amount: 7 });
const done = row("e", [sent(1), { kind: "confirmed", at: T(3), attempt: 1, refs: [TX], txHash: TX }, { kind: "recorded", at: T(4), seq: 9, txRef: TX }], { amount: 99 }, { paid: true, txRef: TX, at: T(4) });

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const render = (payments: FlightRow[]) => renderToStaticMarkup(<PaymentsInFlight payments={payments} now={NOW} stuckAfterMinutes={15} orgSlug="acme" />);

describe("the section's line", () => {
  it("gives how many, the sum per currency, the oldest's age, how many are past the wait, and how many do not match", () => {
    expect(flightLine(paymentsInFlight([fresh, done, unknown, old, lagging], NOW, 15), 15)).toBe(
      "3 in flight · 122.75 USDC + 4.00 EURC · oldest sent 39 min ago · 1 past the 15 min wait · 1 payment not matching the books"
    );
    expect(flightLine(paymentsInFlight([fresh], NOW, 15), 15)).toBe("1 in flight · 2.25 USDC · oldest sent 5 min ago");
    expect(flightLine(paymentsInFlight([lagging, { ...lagging, source: { type: "invoice", id: "f" } }], NOW, 15), 15)).toBe("2 payments not matching the books");
  });
});

describe("Payments in flight", () => {
  const markup = render([fresh, done, unknown, old, lagging]);
  const words = text(markup);

  it("lists what was sent and not confirmed, the oldest first, with where each is and how long ago it was sent", () => {
    expect(words).toContain("Payments in flight");
    expect(words).toContain("Sent and not confirmed by Circle yet, the oldest first. Nothing here is in the payee's wallet until Circle confirms it.");
    const order = ["Payee a", "Design review for Ana Lima", "Payee b"].map((name) => words.indexOf(name));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(words).toContain("Pending · sent 39 min ago · Circle: STUCK");
    expect(words).toContain("Submitted · sent 5 min ago");
    // A reconciled payment is not in flight.
    expect(words).not.toContain("Payee e");
  });

  it("says a payment past the network's wait in words, not by colour alone", () => {
    expect(words).toContain("Pending · sent 39 min ago · Circle: STUCK · past the 15 min wait");
    expect(words.match(/past the 15 min wait/g)).toHaveLength(2);
  });

  it("says an unknown outcome is being checked, and that nothing new is sent before Circle answers (I18)", () => {
    expect(words).toContain("Outcome unknown · checking with Circle · sent 10 min ago");
    expect(words).toContain("Vestiarion looks for it on Circle before anything else is sent, and sends a new transfer only once Circle shows none.");
  });

  it("lists a confirmed payment the books do not show paid yet, with why", () => {
    expect(words).toContain("Not matching the books");
    expect(words).toContain("Payee d");
    expect(words).toContain("Confirmed, but the bill is not marked paid yet: the agent's next cycle marks it.");
  });

  it("links each payable to its track on Bills & receivables, and a milestone to Contractors", () => {
    expect(markup).toContain('href="/o/acme/invoices#settlement-a"');
    expect(markup).toContain('href="/o/acme/contractors"');
  });

  it("shows each amount in its own currency", () => {
    expect(words).toContain("120.50 USDC");
    expect(words).toContain("4.00 EURC");
  });

  it("is hidden when nothing is in flight and the books match", () => {
    expect(render([done])).toBe("");
    expect(render([])).toBe("");
  });

  it("leaves out a Gateway payout Gateway reported failed: nothing watches it, and it is not counted or aged (L3)", () => {
    const reported = row("g", [sent(1), { kind: "pending", at: T(2), attempt: 1, state: "GATEWAY_FAILED", by: "circle" }], { amount: 500 }, open, true);
    expect(render([reported])).toBe("");
    expect(flightLine(paymentsInFlight([fresh, reported], NOW, 15), 15)).toBe("1 in flight · 2.25 USDC · oldest sent 5 min ago");
  });
});

describe("Treasury", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

  it("reads the payments in flight in the workspace's scope, best effort, and shows them by the network's wait (L8)", () => {
    expect(page).toMatch(/return inOrg\(access, async \(\) => \{[\s\S]*readPaymentsInFlight\(db\(\), \[/);
    expect(page).toContain('invoice.direction === "payable" && invoice.status === "matched"');
    expect(page).toContain('milestone.status === "verified"');
    expect(page).toMatch(/\}\)\(\)\.catch\(\(error: unknown\) => \{\s*console\.error\("console: payments in flight not loaded"/);
    // Entries read up to the read's limit may leave out older ones: a missing entry is then no mismatch.
    expect(page).toContain("entriesComplete: !ledgerReadMayBeCut(invoiceEntries) && !ledgerReadMayBeCut(milestoneEntries)");
    expect(page).toContain("<PaymentsInFlight payments={flight} now={flightNow} stuckAfterMinutes={networkProfile(network).stuckAfterMinutes} orgSlug={slug} />");
  });
});
