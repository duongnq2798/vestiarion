import { describe, expect, it } from "vitest";
import type { StatementLine } from "@/lib/bank-statement/lines";
import { matchStatement, nameFound, numberFound, type StatementBill } from "@/lib/bank-statement/match";

/**
 * Which bill a money-out line paid (docs/superpowers/specs/2026-10-10-bank-statement-design.md B6-B7): the same
 * currency, a date window, an equal amount or one within 5% with the payee's name or an invoice number in the line; one
 * line for one bill, paired in rounds; ties left to the person; lines already recorded or used say so.
 */

let next = 0;
function line(over: Partial<StatementLine> = {}): StatementLine {
  next += 1;
  return {
    line: next + 1,
    bookedOn: "2026-10-05",
    valueOn: null,
    minor: -125000,
    currency: "SGD",
    description: "GIRO PAYMENT",
    payee: "",
    reference: "",
    balance: null,
    occurrence: 0,
    lookalike: false,
    ...over,
  };
}

function bill(id: string, over: Partial<StatementBill> = {}): StatementBill {
  return { id, payee: "Northwind Cloud Pte Ltd", memo: null, amount: 1250, currency: "SGD", createdAt: "2026-10-01T09:00:00Z", dueDate: "2026-10-15", current: null, ...over };
}

const statuses = (matches: ReturnType<typeof matchStatement>) => matches.map((match) => (match.status === "matched" ? `matched:${match.candidate.invoiceId}${match.ticked ? "" : " (unticked)"}` : match.status));

describe("nameFound and numberFound", () => {
  it("finds the payee's whole name without its legal words, written apart or together, or one long word of it", () => {
    expect(nameFound("Northwind Cloud Pte Ltd", "GIRO NORTHWIND CLOUD SG")).toEqual({ strength: 2, found: "Northwind Cloud Pte Ltd" });
    expect(nameFound("Northwind Cloud Pte Ltd", "PAYNOW NORTHWINDCLOUD")).toEqual({ strength: 2, found: "Northwind Cloud Pte Ltd" });
    expect(nameFound("Northwind Cloud Pte Ltd", "NORTHWIND 778812")).toEqual({ strength: 1, found: "Northwind" });
    expect(nameFound("Ace Co", "SPACE ACE LTD")).toEqual({ strength: 2, found: "Ace Co" });
    expect(nameFound("Ace Co", "SPACEX")).toEqual({ strength: 0, found: null });
    expect(nameFound("Café Lumière GmbH", "CAFE LUMIERE")).toEqual({ strength: 2, found: "Café Lumière GmbH" });
  });

  it("finds a word of the memo with a digit in it, whole, in the line", () => {
    expect(numberFound("Invoice INV-2207 for October", "GIRO inv-2207 NORTHWIND")).toBe("INV-2207");
    expect(numberFound("Invoice INV-2207 for October", "GIRO INV-22071")).toBeNull();
    expect(numberFound("Q3 support", "Q3 SUPPORT")).toBeNull();
    expect(numberFound(null, "anything")).toBeNull();
  });

  it("never takes a year, a date or an amount in the memo for an invoice number: bank lines carry dates", () => {
    expect(numberFound("Hosting October 2026", "CARD PAYMENT 03/10/2026 STREAMING")).toBeNull();
    expect(numberFound("Rent 10/2026", "STANDING ORDER 10/2026")).toBeNull();
    expect(numberFound("Rent 2026-10", "SEPA 2026-10 RENT")).toBeNull();
    expect(numberFound("Retainer 09.10.2026", "TRF 09.10.2026")).toBeNull();
    expect(numberFound("Retainer Oct-2026", "TRF OCT-2026")).toBeNull();
    expect(numberFound("Plan 99.00 monthly", "CARD 99.00 USD")).toBeNull();
    expect(numberFound("Rent 20261009", "SEPA 20261009 RENT")).toBeNull();
    // Four digits alone are as often a card's last digits.
    expect(numberFound("Invoice 4821", "CARD ****4821 STREAMING")).toBeNull();
    // Invoice numbers keep being found, digits only or with letters, a year inside them or not.
    expect(numberFound("Invoice 10442", "ACH ACME 10442")).toBe("10442");
    expect(numberFound("Invoice R-1042", "TRF R-1042")).toBe("R-1042");
    expect(numberFound("Invoice INV/2026/0042", "TRF INV/2026/0042")).toBe("INV/2026/0042");
    expect(numberFound("Invoice 2026-0042", "TRF 2026-0042")).toBe("2026-0042");
  });
});

describe("matchStatement", () => {
  it("ticks an exact amount in the same currency within the window, saying why", () => {
    const lines = [line({ description: "GIRO NORTHWIND CLOUD INV-2207" })];
    const [match] = matchStatement(lines, [bill("b1", { memo: "INV-2207" })], [null]);
    expect(match).toMatchObject({ status: "matched", ticked: true, candidate: { invoiceId: "b1", exact: true, replaces: null } });
    expect(match.status === "matched" && match.candidate.why).toEqual([
      "Same amount",
      "Paid 10 days before the due day",
      "Payee's name found: Northwind Cloud Pte Ltd",
      "Invoice number found: INV-2207",
    ]);
  });

  it("never matches money in, another currency, or a day outside the window", () => {
    const lines = [
      line({ minor: 125000 }),
      line({ currency: "USD" }),
      line({ bookedOn: "2026-09-29" }),
      line({ bookedOn: "2026-12-15" }),
      line({ bookedOn: "2026-09-30" }),
    ];
    // A day's grace before the bill was added; at most 60 days after it was due.
    expect(statuses(matchStatement(lines, [bill("b1")], [null, null, null, null, null]))).toEqual(["money_in", "none", "none", "none", "matched:b1"]);
    expect(statuses(matchStatement([line({ bookedOn: "2026-12-14" })], [bill("b1")], [null]))).toEqual(["matched:b1"]);
    expect(statuses(matchStatement([line({ currency: "USDC" })], [bill("b1", { currency: "USD" })], [null]))).toEqual(["none"]);
  });

  it("counts the window from the day added when the bill has no due day", () => {
    expect(statuses(matchStatement([line({ bookedOn: "2026-11-30" })], [bill("b1", { dueDate: null })], [null]))).toEqual(["matched:b1"]);
    expect(statuses(matchStatement([line({ bookedOn: "2026-12-01" })], [bill("b1", { dueDate: null })], [null]))).toEqual(["none"]);
  });

  it("shows an amount within 5% only with the name or an invoice number in the line, and never ticks it", () => {
    const fee = line({ minor: -124000, description: "NORTHWIND CLOUD" });
    const [match] = matchStatement([fee], [bill("b1")], [null]);
    expect(match).toMatchObject({ status: "matched", ticked: false, candidate: { exact: false } });
    expect(match.status === "matched" && match.candidate.why[0]).toBe("Amount differs: 1,240.00 SGD paid, the bill is 1,250.00 SGD");
    expect(statuses(matchStatement([line({ minor: -124000 })], [bill("b1")], [null]))).toEqual(["none"]);
    expect(statuses(matchStatement([line({ minor: -110000, description: "NORTHWIND CLOUD" })], [bill("b1")], [null]))).toEqual(["none"]);
  });

  it("pairs one line with one bill in rounds, each the other's single best", () => {
    const lines = [line({ description: "ATLAS COMPUTE" }), line({ description: "NORTHWIND CLOUD" })];
    const bills = [bill("north"), bill("atlas", { payee: "Atlas Compute" })];
    expect(statuses(matchStatement(lines, bills, [null, null]))).toEqual(["matched:atlas", "matched:north"]);
  });

  it("leaves a tie for the person to choose, ticking nothing", () => {
    const [match] = matchStatement([line()], [bill("b1", { payee: "Atlas" }), bill("b2", { payee: "Kestrel" })], [null]);
    expect(match).toMatchObject({ status: "choose" });
    expect(match.status === "choose" && match.candidates.map((candidate) => candidate.invoiceId)).toEqual(["b1", "b2"]);
  });

  it("leaves a tie to the person when a bill's memo holds a year and the line a date", () => {
    const card = line({ minor: -9900, currency: "USD", bookedOn: "2026-10-09", description: "CARD 09/10/2026 STREAMING" });
    const bills = [
      bill("acme", { payee: "Acme Design", memo: "Logo work", amount: 99, currency: "USD" }),
      bill("beta", { payee: "Beta Hosting", memo: "Hosting October 2026", amount: 99, currency: "USD" }),
    ];
    const [match] = matchStatement([card], bills, [null]);
    expect(match.status).toBe("choose");
    expect(match.status === "choose" && match.candidates.every((candidate) => candidate.number === null)).toBe(true);
    // Nor does the year make a bill within 5% a candidate.
    expect(statuses(matchStatement([line({ ...card, minor: -9700 })], [bills[1]], [null]))).toEqual(["none"]);
  });

  it("says a line booked the day before a bill with no due day was added was paid before it", () => {
    const early = line({ bookedOn: "2026-10-07" });
    const [match] = matchStatement([early], [bill("b1", { dueDate: null, createdAt: "2026-10-08T10:00:00Z" })], [null]);
    expect(match.status === "matched" && match.candidate.why).toEqual(["Same amount", "Paid 1 day before the bill was added"]);
    const [same] = matchStatement([line({ bookedOn: "2026-10-08" })], [bill("b1", { dueDate: null, createdAt: "2026-10-08T10:00:00Z" })], [null]);
    expect(same.status === "matched" && same.candidate.why[1]).toBe("Paid on the day the bill was added");
  });

  it("keeps two identical lines, both competing for one bill", () => {
    const lines = [line({ lookalike: true }), line({ lookalike: true, occurrence: 1 })];
    expect(statuses(matchStatement(lines, [bill("b1")], [null, null]))).toEqual(["choose", "choose"]);
  });

  it("says a line is already recorded when the bill's newest record says it, and takes that bill", () => {
    const current = { id: "rec-1", outcome: "paid" as const, paidOn: "2026-10-05", amount: 1250, currency: "SGD", source: "form" as const };
    const lines = [line(), line()];
    expect(statuses(matchStatement(lines, [bill("b1", { current })], [null, null]))).toEqual(["recorded", "none"]);
  });

  it("offers a correction of a record that differs, saying what it corrects", () => {
    const current = { id: "rec-1", outcome: "not_paid" as const, paidOn: null, amount: null, currency: null, source: "form" as const };
    const [match] = matchStatement([line()], [bill("b1", { current })], [null]);
    expect(match).toMatchObject({ status: "matched", ticked: true, candidate: { replaces: "rec-1" } });
    expect(match.status === "matched" && match.candidate.why.at(-1)).toBe("Corrects the record: not paid");
    const paid = { id: "rec-2", outcome: "paid" as const, paidOn: "2026-10-04", amount: 1200, currency: "SGD", source: "csv" as const };
    const [again] = matchStatement([line()], [bill("b1", { current: paid })], [null]);
    expect(again.status === "matched" && again.candidate.why.at(-1)).toBe("Corrects the record: 1,200.00 SGD on Oct 4, 2026");
  });

  it("skips a line already used and its bill, and never proposes a bill a statement line recorded", () => {
    const fromStatement = { id: "rec-3", outcome: "paid" as const, paidOn: "2026-10-02", amount: 1250, currency: "SGD", source: "statement" as const };
    const lines = [line(), line({ bookedOn: "2026-10-06" })];
    const matches = matchStatement(lines, [bill("b1"), bill("b2", { current: fromStatement })], [{ invoiceId: "b1", payee: "Northwind Cloud Pte Ltd" }, null]);
    expect(matches[0]).toEqual({ line: lines[0].line, status: "used", invoiceId: "b1", payee: "Northwind Cloud Pte Ltd" });
    expect(matches[1].status).toBe("none");
  });

  it("says a line is already recorded when a statement's record of the bill says it, read again with other columns", () => {
    // The same payment, its hash changed by a payee column mapped this time: the record still says it.
    const fromStatement = { id: "rec-3", outcome: "paid" as const, paidOn: "2026-10-05", amount: 1250, currency: "SGD", source: "statement" as const };
    expect(matchStatement([line({ payee: "NORTHWIND" })], [bill("b1", { current: fromStatement })], [null])).toEqual([
      { line: expect.any(Number), status: "recorded", invoiceId: "b1", payee: "Northwind Cloud Pte Ltd" },
    ]);
  });

  it("keeps the yen whole when it compares amounts", () => {
    expect(statuses(matchStatement([line({ minor: -125000, currency: "JPY" })], [bill("b1", { amount: 125000, currency: "JPY" })], [null]))).toEqual(["matched:b1"]);
  });
});
