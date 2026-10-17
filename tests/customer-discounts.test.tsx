import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), ledger: vi.fn(), link: null as { token_enc: unknown; revoked_at: string | null } | null }));

vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  platformDb: () => ({
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { mode: "live" }, error: null }) }) }) }),
  }),
  db: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.link, error: null }) }) }) }) }),
}));
vi.mock("@/lib/dal/scope", () => ({ withOrg: async (_orgId: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));
vi.mock("@/lib/platform/pay-links", () => ({ payLinkToken: () => "vxr_kept" }));
vi.mock("@/app/actions/customer-offers", () => ({ setCustomerOffersAction: vi.fn() }));
vi.mock("@/app/discount/[token]/actions", () => ({ decideDiscountAction: vi.fn() }));
vi.mock("@/components/PaymentCheck", () => ({ default: () => null }));

import { PayInvoice } from "@/components/PayInvoice";
import { CustomerDiscounts } from "@/components/customer-offers/CustomerDiscounts";
import { DiscountDecision } from "@/components/customer-offers/DiscountDecision";
import { decideDiscount, discountTokenHash, generateDiscountToken, owedNow, type CustomerOffersView } from "@/lib/customer-offers/store";
import { discountLine, recentDiscountLine } from "@/lib/customer-offers/words";

/**
 * Discounts offered to customers for paying early (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C1, C4-C6): the one-time link, the customer's answer recorded with a cycle started on an acceptance, what the receivable
 * is owed while the discount applies, and the words on each side.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.link = null;
});

describe("the one-time link (C4)", () => {
  it("is vxd_ and 43 characters, kept only as its hash", () => {
    const { token, secretHash } = generateDiscountToken();
    expect(token).toMatch(/^vxd_[A-Za-z0-9_-]{43}$/);
    expect(discountTokenHash(token)).toBe(secretHash);
    expect(discountTokenHash("vxo_" + token.slice(4))).toBeNull();
    expect(discountTokenHash("nonsense")).toBeNull();
  });
});

describe("what is owed while the discount applies (C5, C6)", () => {
  const row = { amount: 300, early_pay_discount_pct: "1.00", discount_due_date: "2026-10-22T12:00:00Z" };

  it("is the discounted amount through the pay-by day, and the full amount after", () => {
    expect(owedNow(row, new Date("2026-10-22T23:00:00Z"))).toEqual({ owed: 297, discount: { pct: 1, payBy: "2026-10-22", full: 300 } });
    expect(owedNow(row, new Date("2026-10-23T00:00:01Z"))).toEqual({ owed: 300, discount: null });
    expect(owedNow({ amount: 300 }, new Date("2026-10-20T00:00:00Z"))).toEqual({ owed: 300, discount: null });
  });
});

describe("the customer's answer (C5)", () => {
  const token = generateDiscountToken().token;
  const answer = (outcome: string) => ({
    data: [{ outcome, offer_id: "discount-1", org_id: "org-1", invoice_id: "inv-1", discount_pct: outcome === "accepted" ? "1.00" : null, offered_amount: outcome === "accepted" ? "297.000000" : null, pay_by: outcome === "accepted" ? "2026-10-22" : null }],
    error: null,
  });

  it("records an acceptance, starts a cycle, and names the receivable's pay link", async () => {
    mocks.rpc.mockResolvedValue(answer("accepted"));
    mocks.link = { token_enc: { v: 1 }, revoked_at: null };
    const raise = vi.fn();
    const decided = await decideDiscount(token, true, { raise, origin: "https://www.vestiarion.xyz" });
    expect(decided).toEqual({ outcome: "accepted", payUrl: "https://www.vestiarion.xyz/pay/vxr_kept" });
    expect(mocks.rpc).toHaveBeenCalledWith("decide_customer_discount", { p_token_hash: discountTokenHash(token), p_accept: true });
    expect(mocks.ledger).toHaveBeenCalledWith("org-1", expect.objectContaining({ action: "customer_discount_accepted", detail: expect.objectContaining({ discountPct: 1, offeredAmount: 297, payBy: "2026-10-22" }) }));
    expect(raise).toHaveBeenCalledWith({ orgId: "org-1", sandbox: false, kind: "customer_discount_accepted" });
  });

  it("names no pay link when the receivable has none kept", async () => {
    mocks.rpc.mockResolvedValue(answer("accepted"));
    expect(await decideDiscount(token, true, { raise: vi.fn() })).toEqual({ outcome: "accepted", payUrl: null });
  });

  it("records a decline and starts nothing; a changed receivable or a stale link records nothing", async () => {
    const raise = vi.fn();
    mocks.rpc.mockResolvedValue(answer("declined"));
    expect(await decideDiscount(token, false, { raise })).toEqual({ outcome: "declined" });
    expect(mocks.ledger).toHaveBeenCalledWith("org-1", expect.objectContaining({ action: "customer_discount_declined" }));
    mocks.ledger.mockClear();
    mocks.rpc.mockResolvedValue({ data: [{ outcome: "changed", offer_id: "discount-1", org_id: "org-1", invoice_id: "inv-1" }], error: null });
    expect(await decideDiscount(token, true, { raise })).toEqual({ outcome: "changed" });
    expect(await decideDiscount("vxd_short", true, { raise })).toEqual({ outcome: "not_valid" });
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("the customer's page (C4)", () => {
  const offer = { orgName: "Pinecrest Studio", customerName: "Northwind Goods", reference: "INV-2041", amount: 300, discounted: 297, currency: "USDC", pct: 1, dueDate: "2026-11-16T12:00:00Z", payBy: "2026-10-22" };

  it("names who offers what for which invoice, by when, with Accept and No thanks", () => {
    const html = decode(renderToStaticMarkup(<DiscountDecision token="vxd_x" offer={offer} />));
    expect(html).toContain("Pinecrest Studio offers 1.00% off invoice INV-2041: pay 297.00 USDC by Oct 22, 2026 instead of 300.00 USDC on Nov 16, 2026.");
    expect(html).toContain("Accept: pay less by paying early");
    expect(html).toContain("No thanks");
    expect(discountLine({ ...offer, reference: null })).toContain("off your invoice");
  });
});

describe("Paid sooner when cash is short, on Bills & receivables (C1)", () => {
  const view = (over: Partial<CustomerOffersView["setting"]> = {}, recent: CustomerOffersView["recent"] = []): CustomerOffersView => ({ setting: { on: false, maxPct: null, sandbox: false, ...over }, recent });

  it("lets an owner or admin turn it on with the most to give, or stop it", () => {
    const off = decode(renderToStaticMarkup(<CustomerDiscounts orgSlug="pinecrest" view={view()} canWrite />));
    expect(off).toContain("Let the agent offer discounts");
    expect(off).toContain('name="maxPct"');
    const on = decode(renderToStaticMarkup(<CustomerDiscounts orgSlug="pinecrest" view={view({ on: true, maxPct: 2 })} canWrite />));
    expect(on).toContain("Stop the agent's discounts");
    expect(on).toContain("up to 2.00% off for paying an open invoice within 5 days");
  });

  it("tells anyone else which it is, and a sandbox that it offers nothing", () => {
    expect(decode(renderToStaticMarkup(<CustomerDiscounts orgSlug="pinecrest" view={view()} canWrite={false} />))).toContain("The agent offers customers no discounts. An owner or admin turns it on.");
    const sandbox = decode(renderToStaticMarkup(<CustomerDiscounts orgSlug="pinecrest" view={view({ sandbox: true })} canWrite />));
    expect(sandbox).toContain("A sandbox has no wallet to receive a payment in");
    expect(sandbox).not.toContain("Let the agent offer discounts");
  });

  it("lists the latest offers", () => {
    const recent = [
      { id: "1", customerName: "Northwind Goods", pct: 1, amount: 300, discounted: 297, status: "paid", payBy: "2026-10-22", at: "2026-10-20T10:00:00Z" },
      { id: "2", customerName: "Acme", pct: 0.75, amount: 120, discounted: 119.1, status: "declined", payBy: "2026-10-22", at: "2026-10-18T10:00:00Z" },
    ];
    const html = decode(renderToStaticMarkup(<CustomerDiscounts orgSlug="pinecrest" view={view({ on: true, maxPct: 2 }, recent)} canWrite />));
    expect(html).toContain("Northwind Goods paid 297.00 USDC at 1.00% off 300.00, by Oct 22, 2026.");
    expect(html).toContain("Acme declined 0.75% off 120.00 USDC, to pay by Oct 22, 2026.");
    expect(recentDiscountLine(recent[1])).toBe("Acme declined 0.75% off 120.00 USDC, to pay by Oct 22, 2026.");
  });
});

describe("the pay link while a discount applies (C5)", () => {
  const preview = {
    orgId: "org-1",
    invoiceId: "inv-1",
    createdBy: null,
    orgName: "Pinecrest Studio",
    clientName: "Northwind Goods",
    amount: 300,
    currency: "USDC" as const,
    dueDate: "Nov 16, 2026",
    memo: "INV-2041",
    status: "open" as const,
    payTo: "0x1111111111111111111111111111111111111111",
    chain: "ARC-TESTNET",
  };

  it("asks for the discounted amount and says until when, and what it is after", () => {
    const html = decode(renderToStaticMarkup(<PayInvoice preview={preview} balance={null} token="vxr_x" discount={{ owed: 297, pct: 1, payBy: "2026-10-22", full: 300 }} />));
    expect(html).toContain("Send exactly 297.00 USDC to");
    expect(html).toContain("1.00% off 300.00 USDC, for paying by the end of 2026-10-22 (UTC). After that, the invoice is 300.00 USDC again.");
  });

  it("asks for the whole invoice with no discount, as before", () => {
    const html = decode(renderToStaticMarkup(<PayInvoice preview={preview} balance={null} token="vxr_x" />));
    expect(html).toContain("Send exactly 300.00 USDC to");
    expect(html).not.toContain("Discount");
  });
});
