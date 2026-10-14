import { describe, expect, it } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import { apiHostOf, openCredential, sealCredential } from "@/lib/pipedrive/credential";
import { amountOf, EMPTY_CONTEXT, instantOf, mapDeal, mapDealFields, mapMe, mapPersonEmails, mapTokens, scopesOf, type DealContext } from "@/lib/pipedrive/map";
import { fromPipedrive, pipedriveFieldName, pipedriveFieldType, toPipedrive } from "@/lib/pipedrive/receipts";
import { readsDeals } from "@/lib/pipedrive/settings";

/**
 * Pipedrive's JSON in the core's shapes (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P5, P6, P11):
 * the company's `api_domain` sealed with the tokens it came with, and never another host's; deals as the core keeps
 * them; the receipts' fields and words.
 */

const NOW = Date.parse("2026-10-14T08:00:00.000Z");

describe("the API domain a token comes with", () => {
  it("takes only https://<name>.pipedrive.com", () => {
    expect(apiHostOf("https://cedar-and-co.pipedrive.com")).toBe("cedar-and-co.pipedrive.com");
    expect(apiHostOf("https://Cedar-And-Co.pipedrive.com/")).toBe("cedar-and-co.pipedrive.com");
    // Pipedrive's own zone, whatever subdomain it names.
    expect(apiHostOf("https://cedar.eu.pipedrive.com")).toBe("cedar.eu.pipedrive.com");
    for (const bad of [
      "http://cedar.pipedrive.com",
      "https://cedar.pipedrive.com.evil.example",
      "https://cedarpipedrive.com",
      "https://evil.example/cedar.pipedrive.com",
      "https://cedar.pipedrive.com:8443",
      "https://user:pw@cedar.pipedrive.com",
      "https://a.b.c.d.pipedrive.com",
      "https://pipedrive.com",
      "https://cedar.pipedrive.com/api",
      "https://cedar.pipedrive.com?x=1",
      42,
      null,
    ]) {
      expect(apiHostOf(bad), String(bad)).toBeNull();
    }
  });

  it("seals a token with its host and opens it again; anything else does not open", () => {
    const sealed = sealCredential("cedar-and-co.pipedrive.com", "v1u:AQIB+/x=|odd");
    expect(sealed).toBe("pd1|cedar-and-co.pipedrive.com|v1u:AQIB+/x=|odd");
    expect(openCredential(sealed)).toEqual({ host: "cedar-and-co.pipedrive.com", token: "v1u:AQIB+/x=|odd" });
    expect(openCredential("v1u:plain-token")).toBeNull();
    expect(openCredential("pd1|evil.example|token")).toBeNull();
    expect(openCredential("pd1|cedar.pipedrive.com|")).toBeNull();
    expect(() => sealCredential("evil.example", "t")).toThrow();
  });
});

describe("mapTokens", () => {
  const answer = {
    access_token: "v1u:access",
    token_type: "Bearer",
    refresh_token: "1:1:refresh",
    scope: "base,deals:full,contacts:read",
    expires_in: 3599,
    api_domain: "https://cedar-and-co.pipedrive.com",
  };

  it("seals both tokens with the answer's api_domain, and reads the scopes", () => {
    const tokens = mapTokens(answer, NOW);
    expect(tokens).toEqual({
      accessToken: "pd1|cedar-and-co.pipedrive.com|v1u:access",
      refreshToken: "pd1|cedar-and-co.pipedrive.com|1:1:refresh",
      expiresAt: NOW + 3_599_000,
      scopes: ["base", "deals:full", "contacts:read"],
    });
    expect(scopesOf("base deals:read  contacts:read")).toEqual(["base", "deals:read", "contacts:read"]);
  });

  it("refuses an api_domain that is not a Pipedrive company's, whatever came with it", () => {
    expect(() => mapTokens({ ...answer, api_domain: "https://attacker.example" }, NOW)).toThrow(ProviderError);
    expect(() => mapTokens({ ...answer, api_domain: undefined }, NOW)).toThrow(/api_domain/);
  });

  it("keeps the refresh token and domain sent when a refresh answers without them; a new domain replaces the old", () => {
    const sent = { refreshCredential: "pd1|cedar-and-co.pipedrive.com|1:1:old" };
    expect(mapTokens({ access_token: "v1u:new", expires_in: 3599 }, NOW, sent)).toMatchObject({
      accessToken: "pd1|cedar-and-co.pipedrive.com|v1u:new",
      refreshToken: "pd1|cedar-and-co.pipedrive.com|1:1:old",
    });
    expect(mapTokens({ ...answer, api_domain: "https://cedar-renamed.pipedrive.com", refresh_token: "1:1:rotated" }, NOW, sent)).toMatchObject({
      accessToken: "pd1|cedar-renamed.pipedrive.com|v1u:access",
      refreshToken: "pd1|cedar-renamed.pipedrive.com|1:1:rotated",
    });
  });

  it("reads the grant's scopes, either pair for deals and contacts", () => {
    expect(readsDeals(["base", "deals:full", "contacts:read"])).toBe(true);
    expect(readsDeals(["base", "deals:read", "contacts:full"])).toBe(true);
    expect(readsDeals(["base", "deals:full"])).toBe(false);
    expect(readsDeals(["base"])).toBe(false);
  });
});

describe("users/me", () => {
  it("names the company and whether the user is an admin", () => {
    expect(mapMe({ success: true, data: { id: 1, name: "Owen", company_id: 13013937, company_name: "Cedar & Co", company_domain: "cedar-and-co", access: [{ app: "sales", admin: false }] } })).toEqual({
      companyId: "13013937",
      companyName: "Cedar & Co",
      companyDomain: "cedar-and-co",
      userId: "1",
      userName: "Owen",
      admin: false,
    });
    expect(() => mapMe({ success: true, data: { id: 1 } })).toThrow(/no company/);
  });
});

describe("mapDeal", () => {
  const context: DealContext = {
    stages: new Map([
      ["4", { name: "Negotiation", pipelineId: "1" }],
      ["1", { name: "Qualified", pipelineId: "1" }],
    ]),
    pipelines: new Map([["1", "Sales"]]),
    organizations: new Map([["501", "Cedar & Co"]]),
    emails: new Map([["601", "rosa@cedarandco.example"]]),
  };
  const won = {
    id: 42,
    title: "Spring campaign",
    value: 200,
    currency: "USD",
    status: "won",
    stage_id: 4,
    pipeline_id: 1,
    org_id: 501,
    person_id: 601,
    owner_id: 7001,
    update_time: "2026-10-14T08:00:00Z",
    won_time: "2026-10-13T23:30:00Z",
    local_won_date: "2026-10-14",
    expected_close_date: "2026-10-30",
  };

  it("reads a won deal: the won day in the company's time, its organization and its person's email", () => {
    expect(mapDeal(won, context)).toEqual({
      externalId: "42",
      version: "2026-10-14T08:00:00.000Z",
      updatedAt: "2026-10-14T08:00:00.000Z",
      name: "Spring campaign",
      amount: "200",
      currency: "USD",
      closeOn: "2026-10-14",
      pipelineId: "1",
      pipelineLabel: "Sales",
      stageId: "4",
      stageLabel: "Negotiation",
      stage: "won",
      company: { externalId: "501", name: "Cedar & Co", email: "rosa@cedarandco.example" },
      ownerId: "7001",
    });
  });

  it("reads an open deal's expected close date, and a lost deal's reason as its label", () => {
    expect(mapDeal({ ...won, status: "open", local_won_date: null, won_time: null }, context)).toMatchObject({ stage: "open", closeOn: "2026-10-30", stageLabel: "Negotiation" });
    expect(mapDeal({ ...won, status: "lost", lost_reason: "Went with another agency", lost_time: "2026-10-15T10:00:00Z" }, context)).toMatchObject({
      stage: "lost",
      stageLabel: "Went with another agency",
      closeOn: "2026-10-15",
    });
  });

  it("says a deleted deal was deleted, and nothing else", () => {
    expect(mapDeal({ ...won, status: "deleted" }, context)).toMatchObject({ externalId: "42", deleted: true, company: null, amount: null });
    expect(mapDeal({ ...won, is_deleted: true }, context)).toMatchObject({ deleted: true });
  });

  it("has no company without an organization, and leaves out what does not read", () => {
    expect(mapDeal({ ...won, org_id: null }, context)?.company).toBeNull();
    expect(mapDeal({ ...won, org_id: { value: 777, name: "Embedded Org" } }, EMPTY_CONTEXT)?.company).toEqual({ externalId: "777", name: "Embedded Org", email: null });
    expect(mapDeal({ ...won, id: "x" }, context)).toBeNull();
    expect(mapDeal({ ...won, update_time: "never" }, context)).toBeNull();
    expect(mapDeal({ ...won, status: "frozen" }, context)).toBeNull();
    expect(mapDeal({ ...won, currency: "usd" }, context)?.currency).toBeNull();
  });

  it("writes amounts as exact decimals, refusing more than six places", () => {
    expect(amountOf(200)).toBe("200");
    expect(amountOf(199.99)).toBe("199.99");
    expect(amountOf(0.1234567)).toBeNull();
    expect(amountOf(-5)).toBeNull();
    expect(amountOf(1e21)).toBeNull();
    expect(amountOf(null)).toBeNull();
  });

  it("reads instants in one format, older answers in UTC", () => {
    expect(instantOf("2026-10-14T08:00:00Z")).toBe("2026-10-14T08:00:00.000Z");
    expect(instantOf("2026-10-14 08:00:00")).toBe("2026-10-14T08:00:00.000Z");
    expect(instantOf("")).toBeNull();
  });
});

describe("persons and deal fields", () => {
  it("takes a person's primary email, in lowercase", () => {
    const emails = mapPersonEmails([
      { id: 601, emails: [{ value: "other@x.example", primary: false }, { value: "Rosa@CedarAndCo.example", primary: true }] },
      { id: 602, emails: [{ value: "first@x.example", primary: false }] },
      { id: 603, emails: [{ value: "not an email", primary: true }] },
    ]);
    expect([...emails]).toEqual([
      ["601", "rosa@cedarandco.example"],
      ["602", "first@x.example"],
    ]);
  });

  it("reads deal fields' names, keys and types", () => {
    expect(mapDealFields([{ field_name: "Vestiarion: Collected", field_code: "a".repeat(40), field_type: "double", is_custom_field: true }, { field_name: "x" }])).toEqual([
      { name: "Vestiarion: Collected", code: "a".repeat(40), type: "double", custom: true },
    ]);
  });
});

describe("the receipts' fields in Pipedrive", () => {
  it("names each field after Vestiarion, numbers as doubles, the day as a date, the rest as text", () => {
    expect(pipedriveFieldName({ label: "Collected" })).toBe("Vestiarion: Collected");
    expect(pipedriveFieldType({ type: "number" })).toBe("double");
    expect(pipedriveFieldType({ type: "date" })).toBe("date");
    expect(pipedriveFieldType({ type: "enumeration" })).toBe("varchar");
    expect(pipedriveFieldType({ type: "string" })).toBe("varchar");
  });

  it("writes statuses in words and reads them back into their codes; clears with null; numbers as numbers", () => {
    expect(toPipedrive("vestiarion_collection_status", "varchar", "paid_in_full")).toBe("Paid in full");
    expect(fromPipedrive("vestiarion_collection_status", "Paid in full")).toBe("paid_in_full");
    expect(fromPipedrive("vestiarion_reconciliation", "needs review")).toBe("needs_review");
    // Something a person typed stays as it is: a conflict, never a code guessed.
    expect(fromPipedrive("vestiarion_collection_status", "Paid, says Rosa")).toBe("Paid, says Rosa");
    expect(toPipedrive("vestiarion_collected", "double", "20.00")).toBe(20);
    expect(toPipedrive("vestiarion_last_receipt_date", "date", "")).toBeNull();
    expect(fromPipedrive("vestiarion_collected", 20)).toBe("20");
    expect(fromPipedrive("vestiarion_collected", null)).toBe("");
  });
});
