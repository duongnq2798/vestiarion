import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import {
  closeDay, hubspotAmount, hubspotTime, mapAccountDetails, mapAssociations, mapBatchDeals, mapCompanies, mapContactEmails, mapDeal, mapIntrospection,
  mapPipelines, mapSearchPage, mapTokens, PRIMARY_COMPANY_OF_DEAL, PRIMARY_CONTACT_OF_COMPANY, type DealContext,
} from "@/lib/hubspot/map";

/**
 * HubSpot's JSON in the connector core's shapes (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H5,
 * H6), against recorded HubSpot-shaped answers: tokens and the account, pipelines and what each stage means, a search
 * page with its paging and the 10,000 cap, a deal's companies and their main contacts, amounts as exact decimals,
 * currencies, and the close day in the account's own time zone.
 */

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "hubspot", name), "utf8"));
const NOW = Date.parse("2026-10-12T08:00:00.000Z");

describe("tokens and the account", () => {
  it("reads the code exchange: both tokens, their expiry, the scopes, and the account's hub id", () => {
    expect(mapTokens(fixture("token.json"), NOW)).toEqual({
      tokens: {
        accessToken: "CNb5recorded-access-token",
        refreshToken: "na1-7f3e-recorded-refresh",
        expiresAt: NOW + 1_800_000,
        scopes: ["oauth", "crm.objects.companies.read", "crm.objects.contacts.read", "crm.objects.deals.read"],
      },
      hubId: "48291736",
    });
  });

  it("keeps the refresh token sent when a refresh answers without one, and refuses an exchange without one", () => {
    expect(mapTokens(fixture("refresh-without-refresh-token.json"), NOW, "na1-sent-refresh").tokens.refreshToken).toBe("na1-sent-refresh");
    expect(() => mapTokens(fixture("refresh-without-refresh-token.json"), NOW)).toThrow(ProviderError);
    expect(() => mapTokens({ refresh_token: "r" }, NOW)).toThrow(/no access_token/);
  });

  it("reads the account's domain from the introspection, and its currency and time zone from its details", () => {
    expect(mapIntrospection(fixture("introspect.json"))).toEqual({ hubId: "48291736", hubDomain: "northstar-studio.example" });
    expect(mapIntrospection({ active: false })).toEqual({ hubId: null, hubDomain: null });
    expect(mapAccountDetails(fixture("account-details.json"))).toEqual({ hubId: "48291736", currency: "USD", timeZone: "Asia/Singapore" });
    expect(mapAccountDetails({ companyCurrency: "dollars", timeZone: 7 })).toEqual({ hubId: null, currency: null, timeZone: null });
  });
});

describe("pipelines", () => {
  it("labels every stage and says which are won, lost or open, by HubSpot's own metadata", () => {
    const pipelines = mapPipelines(fixture("pipelines-deals.json"));
    expect(pipelines.get("default")?.label).toBe("Sales Pipeline");
    expect(pipelines.get("default")?.stages.get("closedwon")).toEqual({ label: "Closed Won", state: "won" });
    expect(pipelines.get("default")?.stages.get("closedlost")).toEqual({ label: "Closed Lost", state: "lost" });
    expect(pipelines.get("default")?.stages.get("contractsent")).toEqual({ label: "Contract Sent", state: "open" });
    expect(pipelines.get("84721930")?.stages.get("160239002")).toEqual({ label: "Signed", state: "won" });
    expect(pipelines.get("84721930")?.stages.get("160239003")).toEqual({ label: "Walked away", state: "lost" });
    expect(() => mapPipelines({ pipelines: [] })).toThrow(ProviderError);
  });
});

describe("amounts, times and days", () => {
  it("reads an amount as an exact decimal, and nothing that is not one", () => {
    expect(hubspotAmount("12500")).toBe("12500");
    expect(hubspotAmount("4800.50")).toBe("4800.5");
    expect(hubspotAmount(" 0012.000 ")).toBe("12");
    expect(hubspotAmount("0.125")).toBe("0.125");
    expect(hubspotAmount("")).toBeNull();
    expect(hubspotAmount(null)).toBeNull();
    expect(hubspotAmount("-50")).toBeNull();
    expect(hubspotAmount("1,000")).toBeNull();
    expect(hubspotAmount("1.1234567")).toBeNull();
    expect(hubspotAmount("1e6")).toBeNull();
  });

  it("reads an instant from an ISO time or epoch milliseconds", () => {
    expect(hubspotTime("2026-10-01T02:04:11.733Z")).toBe("2026-10-01T02:04:11.733Z");
    expect(hubspotTime("2026-10-01T02:04:11Z")).toBe("2026-10-01T02:04:11.000Z");
    expect(hubspotTime("1790820251733")).toBe("2026-10-01T02:04:11.733Z");
    expect(hubspotTime("yesterday")).toBeNull();
    expect(hubspotTime(undefined)).toBeNull();
  });

  it("takes the close day in the account's own time zone, else in UTC", () => {
    expect(closeDay("2026-09-30T18:30:00Z", "Asia/Singapore")).toBe("2026-10-01");
    expect(closeDay("2026-09-30T18:30:00Z", "America/New_York")).toBe("2026-09-30");
    expect(closeDay("2026-09-30T18:30:00Z", null)).toBe("2026-09-30");
    expect(closeDay("2026-09-30T18:30:00Z", "Not/AZone")).toBe("2026-09-30");
    expect(closeDay("2026-10-01", "Asia/Singapore")).toBe("2026-10-01");
    expect(closeDay(null, "Asia/Singapore")).toBeNull();
  });
});

describe("a search page", () => {
  it("reads the deals, HubSpot's count, and whether a page follows", () => {
    const first = mapSearchPage(fixture("deals-search-page-1.json"), 1, 2);
    expect(first.deals.map((deal) => deal.id)).toEqual(["30117482911", "30117482912"]);
    expect(first).toMatchObject({ last: false, capped: false, total: 4 });
    expect(mapSearchPage(fixture("deals-search-page-2.json"), 2, 2)).toMatchObject({ last: true, capped: false, total: 4 });
  });

  it("ends the read at the 10,000 results HubSpot's search stops at", () => {
    expect(mapSearchPage(fixture("deals-search-capped.json"), 100, 100)).toMatchObject({ last: true, capped: true, total: 12840 });
  });

  it("refuses an answer that does not read", () => {
    expect(() => mapSearchPage({ deals: [] }, 1, 100)).toThrow(ProviderError);
  });
});

describe("companies and their main contacts", () => {
  it("takes a deal's primary company, else its lowest id", () => {
    const companies = mapAssociations(fixture("assoc-deals-companies.json"), PRIMARY_COMPANY_OF_DEAL);
    expect(companies.get("30117482911")).toBe("9100000001");
    expect(companies.get("30117482912")).toBe("9100000002");
    expect(companies.has("30117482913")).toBe(false);
  });

  it("takes the contact whose primary company it is, else the lowest id", () => {
    const contacts = mapAssociations(fixture("assoc-companies-contacts.json"), PRIMARY_CONTACT_OF_COMPANY);
    expect(contacts.get("9100000001")).toBe("8200000011");
    expect(contacts.get("9100000002")).toBe("8200000020");
  });

  it("reads each company's name (its domain when it has none) and each contact's email, when it is one", () => {
    const companies = mapCompanies(fixture("companies-batch.json"));
    expect(companies.get("9100000001")).toEqual({ name: "Northwind Labs" });
    expect(companies.get("9100000003")).toEqual({ name: "fabrikam.example" });
    const emails = mapContactEmails(fixture("contacts-batch.json"));
    expect(emails.get("8200000011")).toBe("jane.ito@northwind.example");
    expect(emails.has("8200000020")).toBe(false);
  });
});

describe("a deal", () => {
  const pipelines = mapPipelines(fixture("pipelines-deals.json"));
  const northwind = { externalId: "9100000001", name: "Northwind Labs", email: "jane.ito@northwind.example" };
  const context = (fields: Partial<DealContext> = {}): DealContext => ({
    pipelines,
    accountCurrency: "USD",
    timeZone: "Asia/Singapore",
    companyOf: (dealId) => (dealId === "30117482911" ? northwind : null),
    ...fields,
  });
  const page1 = mapSearchPage(fixture("deals-search-page-1.json"), 1, 2).deals;
  const page2 = mapSearchPage(fixture("deals-search-page-2.json"), 2, 2).deals;

  it("reads a won deal with its amount, currency, close day, pipeline, stage and company", () => {
    expect(mapDeal(page1[0], context())).toEqual({
      externalId: "30117482911",
      version: "2026-10-01T02:04:11.733Z",
      updatedAt: "2026-10-01T02:04:11.733Z",
      name: "Website rebuild",
      amount: "12500",
      currency: "USD",
      closeOn: "2026-10-01",
      pipelineId: "default",
      pipelineLabel: "Sales Pipeline",
      stageId: "closedwon",
      stageLabel: "Closed Won",
      stage: "won",
      company: northwind,
    });
  });

  it("takes the account's currency for a deal without one, and says an open deal is open", () => {
    expect(mapDeal(page1[1], context())).toMatchObject({ amount: "4800.5", currency: "USD", stage: "open", stageLabel: "Contract Sent", company: null });
    expect(mapDeal(page1[1], context({ accountCurrency: null }))?.currency).toBeNull();
  });

  it("reads won or lost from the stage's metadata when the deal does not say, and a missing amount as none", () => {
    expect(mapDeal(page2[0], context())).toMatchObject({ amount: null, currency: "EUR", stage: "won", pipelineLabel: "Retainers", stageLabel: "Signed" });
    expect(mapDeal(page2[1], context())).toMatchObject({ stage: "lost", currency: "GBP", closeOn: "2026-10-08" });
  });

  it("says open for a stage nobody can read, and leaves out a deal without an id or a time", () => {
    const unknown = { ...page1[1], properties: { ...page1[1].properties, dealstage: "gone", pipeline: "gone", hs_is_closed: null, hs_is_closed_won: null } };
    expect(mapDeal(unknown, context())).toMatchObject({ stage: "open", stageId: "gone", stageLabel: null, pipelineLabel: null });
    expect(mapDeal({ ...page1[0], id: "" }, context())).toBeNull();
    expect(mapDeal({ ...page1[0], updatedAt: null, properties: { ...page1[0].properties, hs_lastmodifieddate: null } }, context())).toBeNull();
  });
});

describe("deals read by id", () => {
  it("names the deals HubSpot no longer has", () => {
    const read = mapBatchDeals(fixture("deals-batch-read.json"), ["30117482911", "30117400000"]);
    expect(read.deals.map((deal) => deal.id)).toEqual(["30117482911"]);
    expect(read.missing).toEqual(["30117400000"]);
  });

  it("names none missing when an error other than not found leaves it unsure", () => {
    const body = { status: "COMPLETE", results: [], errors: [{ status: "error", category: "RATE_LIMITS", message: "x" }] };
    expect(mapBatchDeals(body, ["1", "2"]).missing).toEqual([]);
  });
});
