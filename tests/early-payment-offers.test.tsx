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
vi.mock("@/app/actions/early-payment-offers", () => ({ makeOfferAction: vi.fn(), withdrawOfferAction: vi.fn() }));
vi.mock("@/app/offer/[token]/actions", () => ({ decideOfferAction: vi.fn() }));

import { EarlyPaymentOffers } from "@/components/bills/EarlyPaymentOffers";
import { OfferDecision } from "@/components/early-pay/OfferDecision";
import { decideOffer, generateOfferToken, offerTokenHash } from "@/lib/early-pay/offers";
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
    candidates: [
      { invoiceId: "inv-1", counterpartyName: "Taller Norte", reference: "INV-108", amount: 1000, currency: "USDC", dueDate: "2026-11-05T12:00:00Z", suggestion: { days: 20, breakEvenPct: 0.23, pct: 1, annualPct: 18.3 }, open: null },
      { invoiceId: "inv-2", counterpartyName: "Cobalt Cloud", reference: null, amount: 50, currency: "USDC", dueDate: "2026-11-01T12:00:00Z", suggestion: { days: 16, breakEvenPct: 0.18, pct: 0.5, annualPct: 11.4 }, open: { id: "offer-2", pct: 0.5, offered: 49.75, expiresAt: "2026-10-23T09:00:00Z" } },
    ],
    recent: [{ id: "offer-0", counterpartyName: "Lumen Print Co.", pct: 1.5, status: "accepted", decidedAt: "2026-10-15T10:00:00Z" }],
  };
  const render = (canOffer: boolean) => decode(renderToStaticMarkup(<EarlyPaymentOffers orgSlug="pinecrest" view={view} canOffer={canOffer} />));

  it("lists each bill with what the discount is worth, the offer out, and the offers decided", () => {
    const markup = render(true);
    expect(markup).toContain("Pay early for a discount");
    expect(markup).toContain("Paying 20 days early for 1.00% is like earning 18.3% a year, above the reserve's 4.2%.");
    expect(markup).toContain("Offer this discount for paying today");
    expect(markup).toContain("Offer out: 0.50% off");
    expect(markup).toContain("Withdraw");
    expect(markup).toContain("Lumen Print Co. accepted 1.50% off, Oct 15, 2026.");
    expect(markup).toContain('href="/docs/guides/early-payment-offers"');
  });

  it("lets only an owner or admin make the offer, or withdraw one", () => {
    const markup = render(false);
    expect(markup).not.toContain("Offer this discount for paying today");
    expect(markup).toContain("An owner or admin makes the offer.");
    expect(markup).toContain("Offer out: 0.50% off");
    expect(markup).not.toContain("Withdraw");
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
  });
});
