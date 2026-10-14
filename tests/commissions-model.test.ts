import { describe, expect, it } from "vitest";
import {
  commissionErrorFromDb,
  commissionMicros,
  formulaWords,
  parsePlanForm,
  parseRate,
  payableMemo,
  ratePercent,
  rateTyped,
  reviewCommissions,
  type CommissionLine,
  type CommissionPayout,
} from "@/lib/commissions/model";

/**
 * Commissions, pure (docs/superpowers/specs/2026-10-14-commissions-design.md C2, C4, C7, C10): the rate typed, the
 * formula rounded down to the millionth exactly as `record_commissions` (0118) rounds it, and each partner's review.
 */

const PAT = "0b1c2d3e-0000-4000-8000-000000000001";
const SAM = "0b1c2d3e-0000-4000-8000-000000000002";
const DEAL = "0b1c2d3e-0000-4000-8000-0000000000d1";

describe("the rate", () => {
  it.each([
    ["10", 1000],
    ["12.5", 1250],
    ["12.50", 1250],
    ["0.01", 1],
    ["100", 10000],
    ["7 %", 700],
    [" 3.25% ", 325],
  ])("reads %j as %d basis points", (typed, bps) => {
    expect(parseRate(typed)).toBe(bps);
  });

  it.each(["0", "0.00", "100.01", "101", "12.345", "-5", "ten", "", "1,5"])("refuses %j", (typed) => {
    expect(parseRate(typed)).toBeNull();
  });

  it("says a rate back as typed", () => {
    expect([1000, 1250, 1, 10000, 325].map(ratePercent)).toEqual(["10%", "12.5%", "0.01%", "100%", "3.25%"]);
    expect(rateTyped(1250)).toBe("12.5");
  });
});

describe("the commission (C4)", () => {
  it("is the base times the rate, rounded down to the millionth, as 0118 rounds it", () => {
    // 300.00 at 10%: a part of a 1,000.00 invoice earns exactly its part.
    expect(commissionMicros(300_000_000, 1000)).toBe(30_000_000);
    // 33.333333 at 12.5% is 4.16666662..., recorded as 4.166666 (tests/commissions-migration.test.ts).
    expect(commissionMicros(33_333_333, 1250)).toBe(4_166_666);
    // Below one millionth: nothing.
    expect(commissionMicros(5_000, 1)).toBe(0);
    // A large figure stays exact.
    expect(commissionMicros(9_000_000_000_000_000, 9999)).toBe(8_999_100_000_000_000);
  });

  it("is said with its formula", () => {
    const line = { kind: "accrual", source: "payment", base: 300_000_000, rateBps: 1000, amount: 30_000_000, currency: "USDC", reason: null } as const;
    expect(formulaWords(line)).toBe("300.00 USDC received × 10% = 30.00 USDC");
    expect(formulaWords({ ...line, source: "fee", base: 500_000, amount: 50_000 })).toBe("0.50 USDC recorded as a fee on the invoice × 10% = 0.05 USDC");
    expect(formulaWords({ ...line, kind: "adjustment", amount: -30_000_000, reason: "allocation_reversed" })).toBe(
      "−30.00 USDC: the payment it was earned on was reversed (300.00 USDC × 10%)"
    );
  });
});

describe("the plan form (C2)", () => {
  const form = {
    beneficiaryId: PAT,
    rate: "10",
    basis: "net",
    scope: "all_deals",
    dealIds: [] as string[],
    holdDays: "",
    reference: "  Referral agreement  ",
    memberId: "none",
  };

  it("reads a plan, the hold window 30 days when left empty", () => {
    expect(parsePlanForm(form)).toEqual({
      ok: true,
      draft: { beneficiaryId: PAT, rateBps: 1000, basis: "net", scope: "all_deals", dealIds: [], holdDays: 30, reference: "Referral agreement", memberId: null },
    });
  });

  it("keeps the chosen deals once each, and only for chosen deals", () => {
    const chosen = parsePlanForm({ ...form, scope: "chosen_deals", dealIds: [DEAL, DEAL, "nonsense"] });
    expect(chosen.ok && chosen.draft.dealIds).toEqual([DEAL]);
    const every = parsePlanForm({ ...form, dealIds: [DEAL] });
    expect(every.ok && every.draft.dealIds).toEqual([]);
  });

  it.each([
    [{ beneficiaryId: "" }, "beneficiary"],
    [{ rate: "0" }, "rate"],
    [{ basis: "both" }, "basis"],
    [{ scope: "chosen_deals" }, "deals"],
    [{ holdDays: "366" }, "holdDays"],
    [{ holdDays: "1.5" }, "holdDays"],
    [{ reference: "x".repeat(81) }, "reference"],
    [{ memberId: "someone" }, "member"],
  ])("refuses %j on its field", (change, field) => {
    const read = parsePlanForm({ ...form, ...change });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.field).toBe(field);
  });
});

let ids = 0;
function line(over: Partial<CommissionLine>): CommissionLine {
  ids += 1;
  return {
    id: `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`,
    kind: "accrual",
    planId: "plan",
    beneficiaryId: PAT,
    invoiceId: "inv",
    dealId: DEAL,
    source: "payment",
    allocationId: "alloc",
    transferId: "t",
    adjusts: null,
    basis: "net",
    base: 300_000_000,
    rateBps: 1000,
    amount: 30_000_000,
    currency: "USDC",
    appliedAt: "2026-09-01T10:00:00.000Z",
    dueAt: "2026-10-01T10:00:00.000Z",
    reason: null,
    payoutId: null,
    ...over,
  };
}

function payout(over: Partial<CommissionPayout>): CommissionPayout {
  return {
    id: "payout-1",
    beneficiaryId: PAT,
    invoiceId: "bill-1",
    statement: "CS-0A1B2C3D",
    currency: "USDC",
    amount: 30_000_000,
    lineCount: 1,
    createdBy: null,
    createdAt: "2026-10-02T10:00:00.000Z",
    invoiceStatus: "paid",
    ...over,
  };
}

describe("a partner's review (C10)", () => {
  const now = new Date("2026-10-14T12:00:00.000Z");

  it("splits what is due now from what is held, with the next day one falls due", () => {
    const due = line({ dueAt: "2026-10-13T10:00:00.000Z" });
    const held = line({ amount: 70_000_000, dueAt: "2026-11-01T10:00:00.000Z" });
    const later = line({ amount: 5_000_000, dueAt: "2026-11-20T10:00:00.000Z" });
    const [review] = reviewCommissions([later, held, due], [], now);
    expect(review.due.map((entry) => entry.id)).toEqual([due.id]);
    expect(review.dueTotal).toBe(30_000_000);
    expect(review.held.map((entry) => entry.id)).toEqual([held.id, later.id]);
    expect(review.heldTotal).toBe(75_000_000);
    expect(review.nextDueAt).toBe("2026-11-01T10:00:00.000Z");
    expect(review.payable).toBe(true);
  });

  it("nets a reversal not paid out against its accrual, and carries one paid out forward", () => {
    const accrual = line({ dueAt: "2026-10-10T00:00:00.000Z" });
    const undone = line({ kind: "adjustment", amount: -30_000_000, adjusts: accrual.id, reason: "allocation_reversed", dueAt: accrual.dueAt });
    const netted = reviewCommissions([accrual, undone], [], now)[0];
    expect(netted).toMatchObject({ dueTotal: 0, payable: false, carriedForward: 0 });

    const paidOut = line({ payoutId: "payout-1" });
    const after = line({ kind: "adjustment", amount: -30_000_000, adjusts: paidOut.id, reason: "allocation_reversed", dueAt: "2026-10-12T00:00:00.000Z" });
    const carried = reviewCommissions([paidOut, after], [payout({})], now)[0];
    expect(carried).toMatchObject({ dueTotal: -30_000_000, payable: false, carriedForward: -30_000_000 });
    expect(carried.paidOut).toHaveLength(1);
    expect(carried.paidOut[0].lines.map((entry) => entry.id)).toEqual([paidOut.id]);

    const next = line({ amount: 50_000_000, dueAt: "2026-10-13T00:00:00.000Z" });
    expect(reviewCommissions([paidOut, after, next], [payout({})], now)[0]).toMatchObject({ dueTotal: 20_000_000, payable: true });
  });

  it("gives a rejected payable's lines back to what is due", () => {
    const rejected = line({ payoutId: "payout-1", dueAt: "2026-10-10T00:00:00.000Z" });
    const review = reviewCommissions([rejected], [payout({ invoiceStatus: "rejected" })], now)[0];
    expect(review.due.map((entry) => entry.id)).toEqual([rejected.id]);
    expect(review.payable).toBe(true);
  });

  it("keeps partners and currencies apart, in the order given", () => {
    const reviews = reviewCommissions(
      [line({ beneficiaryId: SAM }), line({ currency: "EURC" }), line({})],
      [],
      now,
      [SAM, PAT]
    );
    expect(reviews.map((review) => [review.beneficiaryId, review.currency])).toEqual([
      [SAM, "USDC"],
      [PAT, "EURC"],
      [PAT, "USDC"],
    ]);
  });
});

describe("the payable's memo", () => {
  it("names how many commissions and adjustments it pays, and the agreement", () => {
    expect(payableMemo([{ kind: "accrual" }, { kind: "accrual" }, { kind: "adjustment" }], "Referral agreement")).toBe(
      "Commissions on money received: 2 commissions and 1 adjustment under Referral agreement"
    );
    expect(payableMemo([{ kind: "accrual" }], null)).toBe("Commissions on money received: 1 commission");
  });
});

describe("refusals from 0118", () => {
  it.each([
    [{ message: "commission_changed: the commissions due changed since they were read" }, "changed"],
    [{ message: "commission_beneficiary: a partner does not set their own commission plan" }, "beneficiary"],
    [{ message: "commission_beneficiary_client: a client pays the business" }, "beneficiary_client"],
    [{ message: "commission_nothing_due: nothing is due to pay" }, "nothing_due"],
    [{ code: "23505", message: 'duplicate key value violates unique constraint "commission_plans_one_active"' }, "plan_changed"],
    [{ code: "23503", message: 'insert or update on table "commission_plan_deals" violates foreign key constraint "commission_plan_deals_deal_fkey"' }, "deal_not_found"],
    [{ code: "PGRST202", message: "Could not find the function public.record_commissions(p_org_id) in the schema cache" }, "not_ready"],
    [{ code: "42P01", message: 'relation "public.commission_lines" does not exist' }, "not_ready"],
  ])("reads %j as %s", (error, code) => {
    expect(commissionErrorFromDb(error)?.code).toBe(code);
  });

  it("leaves any other failure alone", () => {
    expect(commissionErrorFromDb({ message: "connection reset" })).toBeNull();
    expect(commissionErrorFromDb(null)).toBeNull();
  });
});
