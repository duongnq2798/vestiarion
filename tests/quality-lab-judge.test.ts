import { describe, expect, it } from "vitest";
import { judgeScenario, summarizeResults, type QualityLabOutcome, type QualityLabRun } from "@/lib/quality-lab/judge";
import { groupRows } from "@/lib/quality-lab/results";
import { outcomeWords, rightWords, scoreWords, wrongPaymentWords } from "@/lib/quality-lab/words";

/**
 * How the Quality Lab judges a scenario (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL4): right when money
 * moved or stopped as expected, with the expected status, rule and transfers, and no wrong payment; a wrong payment is a
 * transfer or schedule where money should stop, a transfer to another address or for another amount, or a second one.
 * And the words the block, the docs page and its Markdown say it in.
 */

const BILL = { amount: 400, addressOnFile: "0xAbC0000000000000000000000000000000000001" };
const TO_FILE = { to: "0xabc0000000000000000000000000000000000001", amount: 400 };

const paid: QualityLabOutcome = { money: "moves", status: "paid", rule: null, heldBecause: null, transfers: 1 };
const held: QualityLabOutcome = { money: "stops", status: "held", rule: "counterparty.cooling_off", heldBecause: null, transfers: 0 };

function run(over: Partial<QualityLabRun>): QualityLabRun {
  return { status: "held", rule: null, heldBecause: null, transfers: [], scheduled: false, ...over };
}

describe("a scenario judged right (QL4)", () => {
  it("is right when money stopped with the expected status and rule, and nothing was sent", () => {
    const verdict = judgeScenario(held, run({ rule: "counterparty.cooling_off" }), BILL);
    expect(verdict).toEqual({ actual: held, right: true, wrongPayment: false });
  });

  it("is right when one transfer went to the address on file, whatever its case, for exactly the bill", () => {
    const verdict = judgeScenario(paid, run({ status: "paid", transfers: [TO_FILE] }), BILL);
    expect(verdict).toEqual({ actual: paid, right: true, wrongPayment: false });
  });

  it("counts a schedule as money that moves, with no transfer yet", () => {
    const scheduled: QualityLabOutcome = { money: "moves", status: "scheduled", rule: null, heldBecause: null, transfers: 0 };
    expect(judgeScenario(scheduled, run({ status: "scheduled", scheduled: true }), BILL)).toEqual({ actual: scheduled, right: true, wrongPayment: false });
  });

  it("is not right, but no wrong payment, when money stopped for another rule", () => {
    const verdict = judgeScenario(held, run({ rule: "counterparty.address_unconfirmed" }), BILL);
    expect(verdict).toMatchObject({ right: false, wrongPayment: false, actual: { money: "stops", rule: "counterparty.address_unconfirmed" } });
  });

  it("is not right, but no wrong payment, when money stopped where it should have moved: a safe miss", () => {
    const verdict = judgeScenario(paid, run({ status: "held", rule: "counterparty.new_payee" }), BILL);
    expect(verdict).toMatchObject({ right: false, wrongPayment: false, actual: { money: "stops", transfers: 0 } });
  });

  it("is not right when the hold's reason differs: the pause is not shadow mode", () => {
    const paused: QualityLabOutcome = { money: "stops", status: "held", rule: null, heldBecause: "agent_paused", transfers: 0 };
    expect(judgeScenario(paused, run({ heldBecause: "shadow_verdict" }), BILL).right).toBe(false);
    expect(judgeScenario(paused, run({ heldBecause: "agent_paused" }), BILL).right).toBe(true);
  });
});

describe("a wrong payment (QL4)", () => {
  it("is any transfer in a scenario whose money should stop", () => {
    const verdict = judgeScenario(held, run({ status: "paid", transfers: [TO_FILE] }), BILL);
    expect(verdict).toMatchObject({ right: false, wrongPayment: true, actual: { money: "moves", transfers: 1 } });
  });

  it("is any schedule in a scenario whose money should stop, even one a later cycle undid", () => {
    expect(judgeScenario(held, run({ status: "held", scheduled: true }), BILL)).toMatchObject({ right: false, wrongPayment: true });
  });

  it("is a schedule left standing where money should stop, though no write of the run made it", () => {
    const verdict = judgeScenario(held, run({ status: "scheduled", scheduled: false }), BILL);
    expect(verdict).toMatchObject({ right: false, wrongPayment: true, actual: { money: "moves", status: "scheduled", transfers: 0 } });
  });

  it("is a transfer to another address than the one on file", () => {
    const verdict = judgeScenario(paid, run({ status: "paid", transfers: [{ to: "0x9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807", amount: 400 }] }), BILL);
    expect(verdict).toMatchObject({ right: false, wrongPayment: true });
  });

  it("is a transfer for another amount than the bill's", () => {
    expect(judgeScenario(paid, run({ status: "paid", transfers: [{ ...TO_FILE, amount: 4000 }] }), BILL)).toMatchObject({ wrongPayment: true });
    expect(judgeScenario(paid, run({ status: "paid", transfers: [{ ...TO_FILE, amount: 399.99 }] }), BILL)).toMatchObject({ wrongPayment: true });
  });

  it("is a second transfer for the same bill, both to the right address for the right amount", () => {
    const twice: QualityLabOutcome = { ...paid, transfers: 2 };
    expect(judgeScenario(twice, run({ status: "paid", transfers: [TO_FILE, TO_FILE] }), BILL)).toMatchObject({ right: false, wrongPayment: true });
  });

  it("is any transfer when the payee has no address on file", () => {
    expect(judgeScenario(paid, run({ status: "paid", transfers: [TO_FILE] }), { amount: 400, addressOnFile: null })).toMatchObject({ wrongPayment: true });
  });
});

describe("the summary (QL5)", () => {
  it("counts the scenarios, the right ones and the wrong payments", () => {
    const results = [
      { id: "a", group: "clean", title: "A", expected: paid, actual: paid, right: true, wrongPayment: false },
      { id: "b", group: "payee", title: "B", expected: held, actual: { ...held, rule: null }, right: false, wrongPayment: false },
      { id: "c", group: "payee", title: "C", expected: held, actual: paid, right: false, wrongPayment: true },
    ];
    expect(summarizeResults(results)).toEqual({ scenarios: 3, right: 1, wrongPayments: 1 });
  });
});

describe("an outcome in words", () => {
  it("names the status, the rule in people's words, and the transfers", () => {
    expect(outcomeWords(held)).toBe("Held because the payee's address changed recently, and the payee lock makes it wait; no transfer");
    expect(outcomeWords(paid)).toBe("Paid; one transfer");
    expect(outcomeWords({ ...paid, transfers: 2 })).toBe("Paid; 2 transfers");
    expect(outcomeWords({ money: "moves", status: "scheduled", rule: null, heldBecause: null, transfers: 0 })).toBe("Scheduled; no transfer yet");
    expect(outcomeWords({ money: "stops", status: "flagged", rule: "counterparty.high_risk", heldBecause: null, transfers: 0 })).toBe(
      "Flagged because the payee was screened high risk; no transfer"
    );
    expect(outcomeWords({ money: "stops", status: "awaiting_info", rule: "invoice.match_incomplete", heldBecause: null, transfers: 0 })).toBe(
      "Waiting for information because its purchase order or goods receipt was missing; no transfer"
    );
  });

  it("names a hold's reason when no rule made it", () => {
    expect(outcomeWords({ money: "stops", status: "held", rule: null, heldBecause: "agent_paused", transfers: 0 })).toBe("Held because the agent was paused; no transfer");
    expect(outcomeWords({ money: "stops", status: "held", rule: null, heldBecause: "shadow_verdict", transfers: 0 })).toBe(
      "Held because shadow mode waits for a person's verdict; no transfer"
    );
    expect(outcomeWords({ money: "stops", status: "held", rule: null, heldBecause: null, transfers: 0 })).toBe("Held for a person; no transfer");
    expect(outcomeWords({ money: "stops", status: "flagged", rule: null, heldBecause: null, transfers: 0 })).toBe("Flagged for a person; no transfer");
  });

  it("says whether a scenario was right, naming a wrong payment", () => {
    expect(rightWords({ right: true, wrongPayment: false })).toBe("Yes");
    expect(rightWords({ right: false, wrongPayment: false })).toBe("No");
    expect(rightWords({ right: false, wrongPayment: true })).toBe("No: a wrong payment");
  });

  it("writes a group's rows for its table, and refuses a group with none", () => {
    const results = {
      summary: { scenarios: 2, right: 1, wrongPayments: 0 },
      scenarios: [
        { id: "a", group: "payee", title: "A payee", expected: held, actual: held, right: true, wrongPayment: false },
        { id: "b", group: "clean", title: "A clean bill", expected: paid, actual: { ...held, rule: null }, right: false, wrongPayment: false },
      ],
    };
    expect(groupRows("payee", results)).toEqual([["A payee", outcomeWords(held), outcomeWords(held), "Yes"]]);
    expect(groupRows("clean", results)).toEqual([["A clean bill", "Paid; one transfer", "Held for a person; no transfer", "No"]]);
    expect(() => groupRows("screening", results)).toThrow(/screening/);
  });

  it("says the score and the wrong payments with their real numbers", () => {
    expect(scoreWords({ scenarios: 39, right: 38, wrongPayments: 0 })).toBe("38 of 39 scenarios right");
    expect(wrongPaymentWords(0)).toBe("0 wrong payments");
    expect(wrongPaymentWords(1)).toBe("1 wrong payment");
    expect(wrongPaymentWords(2)).toBe("2 wrong payments");
  });
});
