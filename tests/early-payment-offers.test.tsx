import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), orgMode: "live" as "live" | "sandbox", ledger: vi.fn() }));

vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  platformDb: () => ({
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { mode: mocks.orgMode }, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/dal/scope", () => ({ withOrg: async (_orgId: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));
vi.mock("@/app/actions/early-payment-offers", () => ({ makeOfferAction: vi.fn(), withdrawOfferAction: vi.fn(), setAgentOffersAction: vi.fn() }));
vi.mock("@/app/offer/[token]/actions", () => ({ decideOfferAction: vi.fn(), counterOfferAction: vi.fn() }));

import { EarlyPaymentOffers } from "@/components/bills/EarlyPaymentOffers";
import { OfferDecision } from "@/components/early-pay/OfferDecision";
import { counterOffer, decideOffer, generateOfferToken, offerTokenHash } from "@/lib/early-pay/offers";
import { annualPct, daysEarly, offeredAmount, offerLine, offerWorth, suggestOffer, type OffersView } from "@/lib/early-pay/offers-words";

/**
 * Early-payment offers (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E2-E6, E8): the discount worth
 * asking, the one-time link, the supplier's answer recorded and the cycle started on an acceptance, and the words on both
 * sides.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
const NOW = new Date("2026-10-16T09:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgMode = "live";
});

describe("the discount worth asking (E2)", () => {
  it("is twice the reserve's yield to the due date, up to the next 0.25%, from 0.5% to 5%", () => {
    expect(daysEarly("2026-11-05T12:00:00Z", NOW)).toBe(20);
    // 4.2% a year for 20 days is 0.23%: twice that, 0.46%, is below the floor.
    expect(suggestOffer({ dueDate: "2026-11-05T12:00:00Z", now: NOW, reserveApy: 0.042 })).toMatchObject({ days: 20, pct: 0.5 });
    // 4.2% for 120 days is 1.38%: twice that, 2.76%, rounds up to the next quarter, 3.00%.
    expect(suggestOffer({ dueDate: "2027-02-13T12:00:00Z", now: NOW, reserveApy: 0.042 }).pct).toBe(3);
    expect(suggestOffer({ dueDate: "2028-10-16T12:00:00Z", now: NOW, reserveApy: 0.1 }).pct).toBe(5);
    expect(suggestOffer({ dueDate: "2026-11-05T12:00:00Z", now: NOW, reserveApy: 0 }).pct).toBe(0.5);
  });

  it("says what it is worth a year, and what the supplier receives", () => {
    expect(annualPct(1, 20)).toBe(18.3);
    expect(offeredAmount(1000, 1)).toBe(990);
    expect(offerWorth({ pct: 1, days: 20, reserveApy: 0.042 })).toBe("Paying 20 days early for 1.00% is like earning 18.3% a year, above the reserve's 4.2%.");
    expect(offerWorth({ pct: 1, days: 20, reserveApy: 0 })).toBe("Paying 20 days early for 1.00% is like earning 18.3% a year.");
    expect(offerLine({ orgName: "Northwind Supply", reference: "INV-108", amount: 1000, offered: 990, currency: "USDC", dueDate: "2026-10-30T12:00:00Z" })).toBe(
      "Northwind Supply offers to pay invoice INV-108 today: 990.00 USDC instead of 1,000.00 USDC on Oct 30, 2026."
    );
    // A discount under a cent still shows: 0.50% off 0.50 USDC is 0.4975, never 0.50.
    expect(offerLine({ orgName: "Pinecrest Studio", reference: "LP-121", amount: 0.5, offered: 0.4975, currency: "USDC", dueDate: "2026-11-12T12:00:00Z" })).toBe(
      "Pinecrest Studio offers to pay invoice LP-121 today: 0.4975 USDC instead of 0.50 USDC on Nov 12, 2026."
    );
  });
});

describe("the one-time link (E3)", () => {
  it("is vxo_ and 43 characters, kept only as its hash", () => {
    const { token, secretHash } = generateOfferToken();
    expect(token).toMatch(/^vxo_[A-Za-z0-9_-]{43}$/);
    expect(offerTokenHash(token)).toBe(secretHash);
    expect(offerTokenHash("vxp_" + token.slice(4))).toBeNull();
    expect(offerTokenHash("nope")).toBeNull();
  });
});

describe("the supplier's counter (offer counters N2)", () => {
  const { token } = generateOfferToken();

  it("records a smaller discount on the agent's offer and starts a cycle for the agent to answer it", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ outcome: "countered", offer_id: "offer-1", org_id: "org-1", invoice_id: "inv-1", counter_pct: "0.25", discount_pct: "0.50", currency: "USDC" }], error: null });
    const raise = vi.fn();
    expect(await counterOffer(token, 0.25, { raise })).toBe("countered");
    expect(mocks.rpc).toHaveBeenCalledWith("counter_early_payment_offer", { p_token_hash: offerTokenHash(token), p_pct: 0.25 });
    expect(mocks.ledger.mock.calls[0][1]).toMatchObject({ action: "early_payment_offer_countered", detail: { offerId: "offer-1", counterPct: 0.25, discountPct: 0.5, via: "offer_link" } });
    expect(raise).toHaveBeenCalledWith({ orgId: "org-1", sandbox: false, kind: "early_payment_countered" });
  });

  it("records nothing for a person's offer, a discount not below the offer's, or a stale link", async () => {
    const raise = vi.fn();
    for (const outcome of ["not_agent", "bad_pct", "not_valid"]) {
      mocks.rpc.mockResolvedValueOnce({ data: [{ outcome, offer_id: null, org_id: null, invoice_id: null, counter_pct: null, discount_pct: null, currency: null }], error: null });
      expect(await counterOffer(token, 0.25, { raise })).toBe(outcome);
    }
    expect(await counterOffer("not-a-token", 0.25, { raise })).toBe("not_valid");
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("the supplier's answer (E5, E6)", () => {
  const { token } = generateOfferToken();
  const row = (outcome: string) => ({ data: [{ outcome, offer_id: "offer-1", org_id: "org-1", invoice_id: "inv-1", discount_pct: "1.00", offered_amount: "990", currency: "USDC" }], error: null });

  it("records an acceptance and starts a cycle in the workspace at once", async () => {
    mocks.rpc.mockResolvedValueOnce(row("accepted"));
    const raise = vi.fn();
    expect(await decideOffer(token, true, { raise })).toBe("accepted");
    expect(mocks.rpc).toHaveBeenCalledWith("decide_early_payment_offer", { p_token_hash: offerTokenHash(token), p_accept: true });
    expect(mocks.ledger.mock.calls[0][1]).toMatchObject({ action: "early_payment_offer_accepted", detail: { offerId: "offer-1", invoiceId: "inv-1", discountPct: 1, offeredAmount: 990, via: "offer_link" } });
    expect(raise).toHaveBeenCalledWith({ orgId: "org-1", sandbox: false, kind: "early_payment_accepted" });
  });

  it("records a decline and starts nothing; a changed bill or a stale link records nothing", async () => {
    const raise = vi.fn();
    mocks.rpc.mockResolvedValueOnce(row("declined"));
    expect(await decideOffer(token, false, { raise })).toBe("declined");
    expect(mocks.ledger.mock.calls[0][1]).toMatchObject({ action: "early_payment_offer_declined" });
    mocks.rpc.mockResolvedValueOnce({ data: [{ outcome: "bill_changed", offer_id: "offer-1", org_id: "org-1", invoice_id: "inv-1", discount_pct: null, offered_amount: null, currency: null }], error: null });
    expect(await decideOffer(token, true, { raise })).toBe("bill_changed");
    mocks.rpc.mockResolvedValueOnce({ data: [{ outcome: "not_valid", offer_id: null, org_id: null, invoice_id: null, discount_pct: null, offered_amount: null, currency: null }], error: null });
    expect(await decideOffer(token, true, { raise })).toBe("not_valid");
    expect(await decideOffer("not-a-token", true, { raise })).toBe("not_valid");
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("Pay early for a discount on Bills (E8)", () => {
  const view: OffersView = {
    reserveApy: 0.042,
    agent: { on: false, maxPct: null },
    candidates: [
      { invoiceId: "inv-1", counterpartyName: "Taller Norte", reference: "INV-108", amount: 1000, currency: "USDC", dueDate: "2026-11-05T12:00:00Z", suggestion: { days: 20, breakEvenPct: 0.23, pct: 1, annualPct: 18.3 }, open: null },
      { invoiceId: "inv-2", counterpartyName: "Cobalt Cloud", reference: null, amount: 50, currency: "USDC", dueDate: "2026-11-01T12:00:00Z", suggestion: { days: 16, breakEvenPct: 0.18, pct: 0.5, annualPct: 11.4 }, open: { id: "offer-2", pct: 0.5, offered: 49.75, expiresAt: "2026-10-23T09:00:00Z", byAgent: true, counterPct: null } },
      { invoiceId: "inv-3", counterpartyName: "Birch Paper", reference: null, amount: 80, currency: "USDC", dueDate: "2026-11-08T12:00:00Z", suggestion: { days: 23, breakEvenPct: 0.26, pct: 0.75, annualPct: 11.9 }, open: { id: "offer-3", pct: 0.75, offered: 79.4, expiresAt: "2026-10-23T09:00:00Z", byAgent: true, counterPct: 0.5 } },
    ],
    recent: [
      { id: "offer-0", counterpartyName: "Lumen Print Co.", pct: 1.5, status: "accepted", decidedAt: "2026-10-15T10:00:00Z" },
      { id: "offer-4", counterpartyName: "Alder Copy", pct: 0.25, status: "accepted", decidedAt: "2026-10-15T11:00:00Z", counterPct: 0.25 },
      { id: "offer-5", counterpartyName: "Cedar & Co", pct: 1, status: "declined", decidedAt: "2026-10-15T12:00:00Z", counterPct: 0.2 },
    ],
  };
  const render = (canOffer: boolean) => decode(renderToStaticMarkup(<EarlyPaymentOffers orgSlug="pinecrest" view={view} canOffer={canOffer} />));

  it("lists each bill with what the discount is worth, the offer out, and the offers decided", () => {
    const markup = render(true);
    expect(markup).toContain("Pay early for a discount");
    expect(markup).toContain("Paying 20 days early for 1.00% is like earning 18.3% a year, above the reserve's 4.2%.");
    expect(markup).toContain("Offer this discount for paying today");
    expect(markup).toContain("Offer out: 0.50% off");
    expect(markup).toContain("The agent emailed it to the supplier.");
    expect(markup).toContain("Withdraw");
    expect(markup).toContain("Let the agent make offers");
    expect(markup).toContain("Lumen Print Co. accepted 1.50% off, Oct 15, 2026.");
    // A counter the agent has not answered, and counters it answered (offer counters N7).
    expect(markup).toContain("Birch Paper proposed 0.50% instead of 0.75%. The agent answers it at its next cycle.");
    expect(markup.match(/>Withdraw</g)).toHaveLength(1);
    expect(markup).toContain("Alder Copy accepted 0.25% off, after a counter, Oct 15, 2026.");
    expect(markup).toContain("The agent declined Cedar & Co's counter of 0.20%, Oct 15, 2026.");
    expect(markup).toContain('href="/docs/guides/early-payment-offers"');
  });

  it("lets only an owner or admin make the offer, or withdraw one", () => {
    const markup = render(false);
    expect(markup).not.toContain("Offer this discount for paying today");
    expect(markup).toContain("An owner or admin makes the offer.");
    expect(markup).toContain("Offer out: 0.50% off");
    expect(markup).not.toContain("Withdraw");
    expect(markup).not.toContain("Let the agent make offers");
    expect(markup).toContain("The agent does not make these offers itself. An owner or admin turns it on.");
  });

  it("says when the agent makes the offers itself, and lets an owner or admin stop it (AO1)", () => {
    const markup = decode(renderToStaticMarkup(<EarlyPaymentOffers orgSlug="pinecrest" view={{ ...view, agent: { on: true, maxPct: 2 } }} canOffer />));
    expect(markup).toContain("The agent makes these offers itself: it picks the bills and the discount, asking at most 2.00%, only from cash it can pay today, and emails each supplier the link at the address payment notices go to.");
    expect(markup).toContain("Stop the agent's offers");
  });
});

describe("the supplier's page (E4)", () => {
  it("names who offers what for which invoice, with Accept and Decline", () => {
    const markup = decode(
      renderToStaticMarkup(
        <OfferDecision
          token="vxo_x"
          offer={{ orgName: "Pinecrest Studio", counterpartyName: "Taller Norte", reference: "INV-108", amount: 1000, offered: 990, currency: "USDC", pct: 1, dueDate: "2026-10-30T12:00:00Z", expiresAt: "2026-10-23T09:00:00Z" }}
        />
      )
    );
    expect(markup).toContain("Pinecrest Studio offers to pay invoice INV-108 today: 990.00 USDC instead of 1,000.00 USDC on Oct 30, 2026.");
    expect(markup).toContain("That is 1.00% less, paid today instead of waiting for the due date.");
    expect(markup).toContain("Accept: get paid today");
    expect(markup).toContain("Decline");
    expect(markup).not.toContain("Propose a smaller discount");
  });

  it("lets the supplier propose a smaller discount on the agent's offer, starting at half of it (offer counters N1)", () => {
    const markup = decode(
      renderToStaticMarkup(
        <OfferDecision
          token="vxo_x"
          canCounter
          offer={{ orgName: "Pinecrest Studio", counterpartyName: "Lumen Print Co.", reference: "LP-121", amount: 0.5, offered: 0.4975, currency: "USDC", pct: 0.5, dueDate: "2026-11-12T12:00:00Z", expiresAt: "2026-10-23T09:00:00Z" }}
        />
      )
    );
    expect(markup).toContain("Would a smaller discount work for you? Propose one, and Pinecrest Studio answers you by email.");
    expect(markup).toContain("Propose a smaller discount");
    expect(markup).toContain('value="0.25"');
  });
});
