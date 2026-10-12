import { describe, expect, it } from "vitest";
import { changePrefill, dealPrefill, plannedCurrency, totalFor, type PrefillDeal } from "@/lib/connectors/crm-prefill";

/**
 * A won HubSpot deal as the New deal form, prefilled (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md
 * H11): the customer by its link, else its name, else a new one; the title; the total and the currency under today's
 * rules; the start; the reference. And a change from HubSpot as the Change deal form, prefilled (H12).
 */

const TODAY = "2026-10-12";
const DEAL: PrefillDeal = {
  externalId: "30117482911",
  name: "Website rebuild",
  amount: "12500",
  currency: "USD",
  closeOn: "2026-10-01",
  company: { externalId: "9100000001", name: "Northwind Labs" },
};
const CUSTOMERS = [
  { id: "c1", name: "Northwind Labs" },
  { id: "c2", name: "Contoso Design" },
  { id: "c3", name: "Contoso design " },
];
const OUTSIDE_SHADOW = { shadowOn: false };
const prefill = (fields: Partial<PrefillDeal> = {}, options: Partial<Parameters<typeof dealPrefill>[0]> = {}) =>
  dealPrefill({ deal: { ...DEAL, ...fields }, linkedCustomerId: null, customers: CUSTOMERS, workspace: OUTSIDE_SHADOW, today: TODAY, label: "HubSpot", ...options });

describe("plannedCurrency", () => {
  it("plans US dollars in USDC and euros in EURC, one for one, and USDC and EURC as they are", () => {
    expect(plannedCurrency("USD", OUTSIDE_SHADOW)).toEqual({ currency: "USDC", atPar: true });
    expect(plannedCurrency("EUR", OUTSIDE_SHADOW)).toEqual({ currency: "EURC", atPar: true });
    expect(plannedCurrency("USDC", OUTSIDE_SHADOW)).toEqual({ currency: "USDC", atPar: false });
  });

  it("plans another currency as it is in shadow mode only, and never VND", () => {
    expect(plannedCurrency("GBP", { shadowOn: true })).toEqual({ currency: "GBP", atPar: false });
    expect(plannedCurrency("GBP", OUTSIDE_SHADOW)).toBeNull();
    expect(plannedCurrency("VND", { shadowOn: true })).toBeNull();
    expect(plannedCurrency(null, { shadowOn: true })).toBeNull();
  });
});

describe("totalFor", () => {
  it("writes the amount with the currency's own decimals, and nothing for one it cannot hold exactly", () => {
    expect(totalFor("12500", "USDC")).toBe("12500.00");
    expect(totalFor("4800.5", "USDC")).toBe("4800.50");
    expect(totalFor("120000", "JPY")).toBe("120000");
    expect(totalFor("1234.567", "USDC")).toBeNull();
    expect(totalFor("0", "USDC")).toBeNull();
    expect(totalFor(null, "USDC")).toBeNull();
  });
});

describe("dealPrefill", () => {
  it("fills the form from a won deal in US dollars, its customer found by name", () => {
    expect(prefill()).toEqual({
      customerId: "c1",
      customerName: "",
      title: "Website rebuild",
      total: "12500.00",
      currency: "USDC",
      startsOn: "2026-10-01",
      externalRef: "30117482911",
      notes: ["HubSpot says 12,500 USD: planned as 12,500.00 USDC, one for one."],
    });
  });

  it("takes the customer the company is linked to before any name", () => {
    expect(prefill({}, { linkedCustomerId: "c2" }).customerId).toBe("c2");
    // A link to a customer no longer here falls back to the name.
    expect(prefill({}, { linkedCustomerId: "gone" }).customerId).toBe("c1");
  });

  it("proposes a new customer with the company's name, and leaves the choice when two have it", () => {
    const fresh = prefill({ company: { externalId: "9", name: "Fabrikam" } });
    expect(fresh).toMatchObject({ customerId: "new", customerName: "Fabrikam" });
    expect(fresh.notes).toContain("Fabrikam is not a customer here yet: it is added as a new customer when you confirm.");
    const two = prefill({ company: { externalId: "2", name: "Contoso Design" } });
    expect(two).toMatchObject({ customerId: "", customerName: "" });
    expect(two.notes).toContain("More than one customer is named Contoso Design: choose one.");
  });

  it("never takes by name a customer linked to another HubSpot company: two companies of one name are two customers", () => {
    // Northwind Labs here was planned from HubSpot company 9100000001; this deal is another company of the same name.
    const other = prefill({ company: { externalId: "9100000777", name: "Northwind Labs" } }, { linkedElsewhere: new Set(["c1"]) });
    expect(other).toMatchObject({ customerId: "", customerName: "" });
    expect(other.notes).toContain("Northwind Labs here is linked to another HubSpot company: choose the customer, or add a new one under another name.");
    // Its own company's link still finds it.
    expect(prefill({}, { linkedCustomerId: "c1", linkedElsewhere: new Set() }).customerId).toBe("c1");
  });

  it("says so when a customer is taken by a name written differently", () => {
    const loose = prefill({ company: { externalId: "9", name: "NORTHWIND LABS, Ltd." } });
    expect(loose.customerId).toBe("c1");
    expect(loose.notes).toContain("Matched to the customer Northwind Labs by its name: check it is the same company as NORTHWIND LABS, Ltd. in HubSpot.");
    expect(prefill().notes).not.toContain(expect.stringContaining("Matched to the customer"));
  });

  it("plans a deal in another currency as it is in shadow mode, and leaves the total to type outside it", () => {
    expect(prefill({ currency: "GBP", amount: "9000" }, { workspace: { shadowOn: true } })).toMatchObject({ currency: "GBP", total: "9000.00", notes: [] });
    const outside = prefill({ currency: "GBP", amount: "9000" });
    expect(outside).toMatchObject({ currency: "USDC", total: "" });
    expect(outside.notes).toEqual(["HubSpot says 9,000 GBP. Type the total in USDC."]);
  });

  it("never names VND, nor shows its amount", () => {
    const vnd = prefill({ currency: "VND", amount: "250000000" }, { workspace: { shadowOn: true } });
    expect(vnd).toMatchObject({ currency: "USDC", total: "" });
    expect(vnd.notes).toEqual(["Type the total in USDC."]);
    expect(JSON.stringify(vnd)).not.toMatch(/VND|250/);
  });

  it("leaves the total to type for an amount the currency cannot hold, and starts today without a close day", () => {
    const odd = prefill({ amount: "1234.567", closeOn: null });
    expect(odd).toMatchObject({ total: "", startsOn: TODAY });
    expect(odd.notes).toEqual(["HubSpot says 1,234.567 USD, with more decimals than USDC takes. Type the total."]);
  });
});

describe("changePrefill", () => {
  it("proposes HubSpot's new amount as the total when it is in the deal's currency, with the changes as the reason", () => {
    const changes = [
      { what: "amount" as const, from: { amount: "12500", currency: "USD" }, to: { amount: "15000", currency: "USD" } },
      { what: "close" as const, from: "2026-10-01", to: "2026-10-20" },
    ];
    expect(changePrefill(changes, { currency: "USDC" }, "HubSpot")).toEqual({
      total: "15000.00",
      reason: "From HubSpot: amount 12,500 USD to 15,000 USD; close date Oct 1, 2026 to Oct 20, 2026",
    });
  });

  it("keeps the deal's total when HubSpot's amount is in another currency, or did not change", () => {
    expect(changePrefill([{ what: "amount", from: { amount: "1", currency: "USD" }, to: { amount: "2", currency: "GBP" } }], { currency: "USDC" }, "HubSpot").total).toBeNull();
    expect(changePrefill([{ what: "stage", from: "won", to: "lost", label: "Closed Lost" }], { currency: "USDC" }, "HubSpot")).toEqual({
      total: null,
      reason: "From HubSpot: marked lost (Closed Lost)",
    });
    expect(changePrefill([{ what: "deleted" }], { currency: "USDC" }, "HubSpot").reason).toBe("From HubSpot: deleted there");
  });
});
