import { describe, expect, it } from "vitest";
import {
  amountToPay,
  boundPayOn,
  discountApplies,
  planPaymentTiming,
  utcDate,
  type PaymentTimingInput,
} from "@/lib/agent/payment-timing";

describe("utcDate", () => {
  it("takes the UTC calendar date from a Date, regardless of what local time would say", () => {
    expect(utcDate(new Date("2026-09-30T23:30:00.000Z"))).toBe("2026-09-30");
    expect(utcDate(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10-01");
  });

  it("takes the UTC calendar date from an ISO string", () => {
    expect(utcDate("2026-10-30T12:00:00.000Z")).toBe("2026-10-30");
    expect(utcDate("2026-10-10")).toBe("2026-10-10");
  });
});

describe("discountApplies", () => {
  const discount = { pct: 2, deadline: "2026-10-10T12:00:00.000Z" };

  it("is false when there is no discount", () => {
    expect(discountApplies(null, new Date("2026-10-01T00:00:00.000Z"))).toBe(false);
  });

  it("applies through the end of the deadline's UTC day, however late", () => {
    expect(discountApplies(discount, new Date("2026-10-10T23:59:59.000Z"))).toBe(true);
  });

  it("applies at the very start of the deadline's UTC day", () => {
    expect(discountApplies(discount, new Date("2026-10-10T00:00:00.000Z"))).toBe(true);
  });

  it("no longer applies the day after the deadline", () => {
    expect(discountApplies(discount, new Date("2026-10-11T00:00:00.000Z"))).toBe(false);
  });
});

describe("amountToPay", () => {
  const discount = { pct: 2, deadline: "2026-10-10T12:00:00.000Z" };

  it("discounts the amount, rounded to 6 decimals, on the deadline day", () => {
    const result = amountToPay(400, discount, new Date("2026-10-10T12:00:00.000Z"));
    expect(result).toEqual({ amountPaid: 392, discountTaken: 8 });
  });

  it("pays the full amount the day after the deadline", () => {
    const result = amountToPay(400, discount, new Date("2026-10-11T00:00:00.000Z"));
    expect(result).toEqual({ amountPaid: 400, discountTaken: 0 });
  });

  it("pays the full amount when there is no discount at all", () => {
    expect(amountToPay(400, null, new Date("2026-10-01T00:00:00.000Z"))).toEqual({
      amountPaid: 400,
      discountTaken: 0,
    });
  });

  it("rounds a non-terminating discount to 6 decimals and keeps paid + taken summing to the amount", () => {
    // 100 * 1/3% = 0.333333... — must round, not truncate to a repeating decimal.
    const result = amountToPay(100, { pct: 1 / 3, deadline: "2026-10-10T12:00:00.000Z" }, new Date("2026-10-05T00:00:00.000Z"));
    expect(result.discountTaken).toBeCloseTo(0.333333, 6);
    expect(Number((result.amountPaid + result.discountTaken).toFixed(6))).toBe(100);
  });
});

describe("boundPayOn", () => {
  const input = { now: new Date("2026-09-30T00:00:00.000Z"), dueDate: "2026-10-30T12:00:00.000Z" };

  it("keeps a payOn strictly between today and the due date", () => {
    expect(boundPayOn("2026-10-10", input)).toEqual({ action: "schedule", payOn: "2026-10-10", timingRule: null });
  });

  it("moves a payOn after the due date back to the due date", () => {
    expect(boundPayOn("2026-11-15", input)).toEqual({ action: "schedule", payOn: "2026-10-30", timingRule: "payon.after_due" });
  });

  it("clamps a payOn on the due date itself (boundary, not after it)", () => {
    expect(boundPayOn("2026-10-30", input)).toEqual({ action: "schedule", payOn: "2026-10-30", timingRule: null });
  });

  it("treats a payOn of today as pay now", () => {
    expect(boundPayOn("2026-09-30", input)).toEqual({ action: "pay", timingRule: "payon.not_after_today" });
  });

  it("treats a payOn before today as pay now", () => {
    expect(boundPayOn("2026-09-01", input)).toEqual({ action: "pay", timingRule: "payon.not_after_today" });
  });

  it("treats an unparseable date as pay now", () => {
    expect(boundPayOn("not-a-date", input)).toEqual({ action: "pay", timingRule: "payon.invalid" });
  });

  it("treats an impossible calendar date as pay now", () => {
    expect(boundPayOn("2026-02-30", input)).toEqual({ action: "pay", timingRule: "payon.invalid" });
  });

  it("treats a missing payOn as pay now", () => {
    expect(boundPayOn(undefined, input)).toEqual({ action: "pay", timingRule: "payon.invalid" });
  });

  it("treats an empty string as pay now", () => {
    expect(boundPayOn("", input)).toEqual({ action: "pay", timingRule: "payon.invalid" });
  });
});

describe("planPaymentTiming", () => {
  const baseInput: PaymentTimingInput = {
    now: new Date("2026-09-30T00:00:00.000Z"),
    amount: 400,
    dueDate: "2026-10-30T12:00:00.000Z",
    discount: { pct: 2, deadline: "2026-10-10T12:00:00.000Z" },
    operatingBalance: 1000,
    reserveApy: 0,
    earlierObligations: 0,
  };

  it("pays now when the invoice is due today", () => {
    const result = planPaymentTiming({ ...baseInput, dueDate: "2026-09-30T12:00:00.000Z" });
    expect(result.recommendation).toEqual({ action: "pay" });
    expect(result.targetOn).toBe("2026-09-30");
    expect(result.reason).toBe("Due today; paying now.");
  });

  it("pays now when the invoice is overdue", () => {
    const result = planPaymentTiming({ ...baseInput, dueDate: "2026-09-20T12:00:00.000Z", discount: null });
    expect(result.recommendation).toEqual({ action: "pay" });
    expect(result.targetOn).toBe("2026-09-30");
    expect(result.reason).toContain("Overdue since Sep 20, 2026");
  });

  it("schedules for the discount deadline when the discount beats the float value (apy 0)", () => {
    const result = planPaymentTiming(baseInput);
    expect(result.discountValue).toBe(8);
    expect(result.floatValueToDue).toBe(0);
    expect(result.discountAvailableUntil).toBe("2026-10-10");
    expect(result.targetOn).toBe("2026-10-10");
    expect(result.recommendation).toEqual({ action: "schedule", payOn: "2026-10-10" });
    expect(result.reason).toBe(
      "A 2% early-payment discount (8 USDC) is worth more than holding the cash to the due date (0 USDC of yield); paying on the discount deadline, Oct 10, 2026."
    );
    expect(result.amountDueAtTarget).toBe(392);
  });

  it("pays now, not schedules, when the discount deadline is today", () => {
    const result = planPaymentTiming({ ...baseInput, now: new Date("2026-10-10T00:00:00.000Z") });
    expect(result.targetOn).toBe("2026-10-10");
    expect(result.recommendation).toEqual({ action: "pay" });
    expect(result.reason).toContain("the discount deadline is today, so paying now");
  });

  it("targets the due date, not the deadline, once the discount has lapsed", () => {
    const result = planPaymentTiming({ ...baseInput, now: new Date("2026-10-11T00:00:00.000Z") });
    expect(result.discountValue).toBeNull();
    expect(result.discountAvailableUntil).toBeNull();
    expect(result.floatValueToDue).toBe(0);
    expect(result.targetOn).toBe("2026-10-30");
    expect(result.recommendation).toEqual({ action: "schedule", payOn: "2026-10-30" });
  });

  it("targets the due date when yield on the reserve beats a tiny discount", () => {
    const result = planPaymentTiming({
      ...baseInput,
      amount: 1000,
      discount: { pct: 0.1, deadline: "2026-10-10T12:00:00.000Z" },
      reserveApy: 0.5,
    });
    // discountValue = 1000 * 0.001 = 1; floatValueToDue = 1000*0.5*20/365 ≈ 27.397 > 1
    expect(result.discountValue).toBe(1);
    expect(result.floatValueToDue).toBeGreaterThan(1);
    expect(result.targetOn).toBe("2026-10-30");
    expect(result.recommendation).toEqual({ action: "schedule", payOn: "2026-10-30" });
    expect(result.reason).toContain("Yield to the due date");
    expect(result.amountDueAtTarget).toBe(1000);
  });

  it("targets the due date when there is no discount at all", () => {
    const result = planPaymentTiming({ ...baseInput, discount: null });
    expect(result.discountValue).toBeNull();
    expect(result.floatValueToDue).toBe(0);
    expect(result.targetOn).toBe("2026-10-30");
    expect(result.recommendation).toEqual({ action: "schedule", payOn: "2026-10-30" });
    expect(result.reason).toBe("No early-payment discount; paying on the due date, Oct 30, 2026, keeps 400 USDC available until then.");
    expect(result.amountDueAtTarget).toBe(400);
  });

  it("rounds floatValueToDue to 6 decimals rather than a repeating fraction", () => {
    const result = planPaymentTiming({
      ...baseInput,
      amount: 1000,
      reserveApy: 0.05,
      discount: { pct: 50, deadline: "2026-10-23T12:00:00.000Z" }, // 7 days before due
    });
    // 1000 * 0.05 * 7 / 365 = 0.9589041095890...
    expect(result.floatValueToDue).toBe(0.958904);
  });

  it("flags a shortfall when the balance less earlier obligations cannot cover the target amount", () => {
    const result = planPaymentTiming({
      ...baseInput,
      operatingBalance: 100,
      earlierObligations: 50,
      discount: null, // amountDueAtTarget = 400 (full), 100 - 50 = 50 < 400
    });
    expect(result.shortfall).toBe(true);
  });

  it("does not flag a shortfall when the balance covers the target amount", () => {
    const result = planPaymentTiming(baseInput); // amountDueAtTarget 392, balance 1000, earlierObligations 0
    expect(result.shortfall).toBe(false);
  });
});
