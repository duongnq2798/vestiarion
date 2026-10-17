import { describe, expect, it } from "vitest";
import {
  boundCustomerPct,
  cashShortfall,
  customerOfferAllowed,
  discountedAmount,
  payByDay,
  pickCustomerOffers,
  referenceCustomerDecision,
  suggestedCustomerPct,
  type CustomerOfferFacts,
} from "@/lib/customer-offers/rules";

const NOW = Date.parse("2026-10-17T06:00:00Z");

const facts = (over: Partial<CustomerOfferFacts> = {}): CustomerOfferFacts => ({
  shortfall: 40,
  open: true,
  currency: "USDC",
  daysEarly: 20,
  partPaid: false,
  offeredBefore: false,
  reviewed: false,
  billingEmail: "ap@client.example",
  payLink: true,
  customerHasOpenOffer: false,
  customerDeclinedAt: null,
  now: NOW,
  ...over,
});

describe("customerOfferAllowed (C2)", () => {
  it("allows an open USDC receivable due 7 days or more out while bills are held for cash", () => {
    expect(customerOfferAllowed(facts())).toEqual({ allowed: true });
    expect(customerOfferAllowed(facts({ daysEarly: 7 }))).toEqual({ allowed: true });
  });

  it("asks nothing while cash is not short", () => {
    expect(customerOfferAllowed(facts({ shortfall: 0 }))).toEqual({ allowed: false, because: "no_shortfall" });
    expect(customerOfferAllowed(facts({ shortfall: -5 }))).toEqual({ allowed: false, because: "no_shortfall" });
  });

  it("refuses each case code does not allow, with its reason", () => {
    expect(customerOfferAllowed(facts({ open: false }))).toMatchObject({ because: "not_open" });
    expect(customerOfferAllowed(facts({ currency: "EURC" }))).toMatchObject({ because: "not_usdc" });
    expect(customerOfferAllowed(facts({ daysEarly: 6 }))).toMatchObject({ because: "too_soon" });
    expect(customerOfferAllowed(facts({ partPaid: true }))).toMatchObject({ because: "part_paid" });
    expect(customerOfferAllowed(facts({ offeredBefore: true }))).toMatchObject({ because: "offered_before" });
    expect(customerOfferAllowed(facts({ reviewed: true }))).toMatchObject({ because: "reviewed" });
    expect(customerOfferAllowed(facts({ billingEmail: null }))).toMatchObject({ because: "no_email" });
    expect(customerOfferAllowed(facts({ payLink: false }))).toMatchObject({ because: "no_pay_link" });
    expect(customerOfferAllowed(facts({ customerHasOpenOffer: true }))).toMatchObject({ because: "customer_has_offer" });
  });

  it("waits 30 days after a customer declined", () => {
    const declined29 = new Date(NOW - 29 * 86_400_000).toISOString();
    const declined31 = new Date(NOW - 31 * 86_400_000).toISOString();
    expect(customerOfferAllowed(facts({ customerDeclinedAt: declined29 }))).toMatchObject({ because: "customer_declined" });
    expect(customerOfferAllowed(facts({ customerDeclinedAt: declined31 }))).toEqual({ allowed: true });
  });
});

describe("the discount (C3)", () => {
  it("suggests 1% for each 30 days early, to 0.25%, between 0.25% and the ceiling", () => {
    expect(suggestedCustomerPct(30, 5)).toBe(1);
    expect(suggestedCustomerPct(7, 5)).toBe(0.25);
    expect(suggestedCustomerPct(20, 5)).toBe(0.75);
    expect(suggestedCustomerPct(90, 2)).toBe(2);
    expect(suggestedCustomerPct(1, 5)).toBe(0.25);
  });

  it("keeps the model's discount between 0.25% and the ceiling", () => {
    expect(boundCustomerPct(1.1, 0.75, 2)).toEqual({ pct: 1, limited: false });
    expect(boundCustomerPct(3, 0.75, 2)).toEqual({ pct: 2, limited: true });
    expect(boundCustomerPct(0.1, 0.75, 2)).toEqual({ pct: 0.25, limited: true });
    expect(boundCustomerPct(undefined, 0.75, 2)).toEqual({ pct: 0.75, limited: false });
    expect(boundCustomerPct(Number.NaN, 0.75, 2)).toEqual({ pct: 0.75, limited: false });
  });

  it("works out what the customer pays to 6 places", () => {
    expect(discountedAmount(100, 1)).toBe(99);
    expect(discountedAmount(0.5, 0.75)).toBe(0.49625);
    expect(discountedAmount(33.333333, 0.25)).toBe(33.25);
  });

  it("gives the written policy's answer at the suggestion", () => {
    const answer = referenceCustomerDecision({ suggestedPct: 0.75, daysEarly: 20, shortfall: 40 });
    expect(answer.action).toBe("offer");
    expect(answer.pct).toBe(0.75);
    expect(answer.reasoning).toContain("40 USDC");
  });
});

describe("how much to ask for (C2)", () => {
  it("counts the shortfall after the operating USDC and the discounts already accepted", () => {
    expect(cashShortfall({ heldForCash: 120, operating: 50, acceptedUnpaid: 30 })).toBe(40);
    expect(cashShortfall({ heldForCash: 20, operating: 50, acceptedUnpaid: 0 })).toBe(0);
  });

  it("does not count operating USDC already set for scheduled payables (cash ahead A5)", () => {
    // The live test's book: 150 held, 140 scheduled, 150.03 in the wallet.
    expect(cashShortfall({ heldForCash: 150, scheduled: 140, operating: 150.03, acceptedUnpaid: 0 })).toBe(139.97);
    expect(cashShortfall({ heldForCash: 20, scheduled: 20, operating: 50, acceptedUnpaid: 0 })).toBe(0);
  });

  it("takes the largest first until they cover the shortfall, three at most", () => {
    const rows = [{ amount: 10 }, { amount: 50 }, { amount: 30 }, { amount: 5 }, { amount: 40 }];
    expect(pickCustomerOffers(rows, 45, 1).map((row) => row.amount)).toEqual([50]);
    expect(pickCustomerOffers(rows, 60, 1).map((row) => row.amount)).toEqual([50, 40]);
    expect(pickCustomerOffers(rows, 1000, 1).map((row) => row.amount)).toEqual([50, 40, 30]);
    expect(pickCustomerOffers(rows, 0, 1)).toEqual([]);
  });
});

describe("payByDay (C4)", () => {
  it("gives five days, and always ends before the day it falls due", () => {
    expect(payByDay("2026-10-17", "2026-11-30")).toBe("2026-10-22");
    expect(payByDay("2026-10-17", "2026-10-21")).toBe("2026-10-20");
  });
});
