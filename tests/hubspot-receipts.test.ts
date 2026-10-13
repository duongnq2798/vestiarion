import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RECEIPT_FIELDS, RECEIPT_GROUP, RECEIPT_PROPERTIES } from "@/lib/connectors/crm-receipts";
import { ProviderError } from "@/lib/connectors/provider";
import { hubspotReceipts } from "@/lib/hubspot/receipts";

/**
 * Writing receipts to HubSpot deals over HTTP (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R2-R6), against
 * a recording fetch answering with HubSpot-shaped bodies: the account's type, the Vestiarion group and properties made
 * only where missing, a deal's fields read, and a write, with HubSpot's refusals. No call leaves the test.
 */

const fixture = (name: string): string => readFileSync(path.join(process.cwd(), "tests", "fixtures", "hubspot", name), "utf8");
const NOW = Date.parse("2026-10-13T08:00:00.000Z");
const ACCOUNT = { accessToken: "access-1", externalOrgId: "48291736" };

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

function recorder(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    sent.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { sent, writer: hubspotReceipts({ fetchImpl, now: () => NOW }) };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const property = (name: string, type: string) => ({ name, type, groupName: "vestiarion", label: name, fieldType: "text", options: [], description: "" });

describe("account", () => {
  it("reads the account's type: a developer test account or a sandbox is a test one, a standard account never", async () => {
    const test = recorder(() => json(JSON.parse(fixture("account-details.json"))));
    expect(await test.writer.account(ACCOUNT)).toEqual({ accountType: "DEVELOPER_TEST", test: true });
    expect(test.sent[0].url.pathname).toBe("/account-info/2026-03/details");
    expect(test.sent[0].headers.get("authorization")).toBe("Bearer access-1");
    for (const [accountType, isTest] of [["SANDBOX", true], ["STANDARD", false], ["APP_DEVELOPER", false]] as const) {
      const one = recorder(() => json({ ...JSON.parse(fixture("account-details.json")), accountType }));
      expect(await one.writer.account(ACCOUNT)).toEqual({ accountType, test: isTest });
    }
    // An account that names no type, or one that does not read, is neither a test one nor a real one: not read, so the
    // run neither writes nor refuses (a refusal is final, and would say the account is a real one).
    for (const accountType of [undefined, "", "developer test", 7]) {
      const unnamed = recorder(() => json({ portalId: 48291736, companyCurrency: "USD", ...(accountType === undefined ? {} : { accountType }) }));
      expect(await unnamed.writer.account(ACCOUNT)).toEqual({ accountType: null, test: null });
    }
  });

  it("throws on a refused or unanswered read, never guessing the account", async () => {
    await expect(recorder(() => new Response("", { status: 503 })).writer.account(ACCOUNT)).rejects.toBeInstanceOf(ProviderError);
    await expect(recorder(() => new Response("", { status: 401 })).writer.account(ACCOUNT)).rejects.toMatchObject({ failure: "unauthorized" });
  });
});

describe("ensureFields", () => {
  const ensure = (writer: ReturnType<typeof recorder>["writer"]) => writer.ensureFields({ ...ACCOUNT, group: RECEIPT_GROUP, properties: RECEIPT_PROPERTIES });

  it("makes nothing when every property is there", async () => {
    const { sent, writer } = recorder(() => json({ status: "COMPLETE", results: RECEIPT_PROPERTIES.map((p) => property(p.name, p.type)) }));
    expect(await ensure(writer)).toEqual({ ok: true });
    expect(sent.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["POST /crm/properties/2026-03/deals/batch/read"]);
    expect(JSON.parse(sent[0].body)).toEqual({ archived: false, inputs: RECEIPT_FIELDS.map((name) => ({ name })) });
  });

  it("makes the Vestiarion group, then each missing property in it, taking a 409 as there already", async () => {
    const { sent, writer } = recorder((call) => {
      if (call.url.pathname.endsWith("/batch/read")) return json({ status: "COMPLETE", results: [property("vestiarion_collected", "number")] });
      if (call.url.pathname.endsWith("/groups")) return json({ category: "OBJECT_ALREADY_EXISTS", message: "exists" }, { status: 409 });
      return json({}, { status: JSON.parse(call.body).name === "vestiarion_still_owed" ? 409 : 201 });
    });
    expect(await ensure(writer)).toEqual({ ok: true });
    const posts = sent.filter((call) => call.method === "POST" && call.url.pathname === "/crm/properties/2026-03/deals");
    expect(posts.map((call) => JSON.parse(call.body).name)).toEqual(RECEIPT_FIELDS.filter((name) => name !== "vestiarion_collected"));
    const group = sent.find((call) => call.url.pathname.endsWith("/groups"));
    expect(JSON.parse(group?.body ?? "{}")).toEqual({ name: "vestiarion", label: "Vestiarion", displayOrder: -1 });
    const status = posts.find((call) => JSON.parse(call.body).name === "vestiarion_collection_status");
    expect(JSON.parse(status?.body ?? "{}")).toMatchObject({ groupName: "vestiarion", type: "enumeration", fieldType: "select", formField: false });
    expect(JSON.parse(status?.body ?? "{}").options[0]).toEqual({ value: "paid_in_full", label: "Paid in full", displayOrder: 0, hidden: false });
  });

  it("never touches a property of the name with another type: someone else's", async () => {
    const { sent, writer } = recorder(() => json({ status: "COMPLETE", results: [property("vestiarion_collected", "string")] }));
    const outcome = await ensure(writer);
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.message).toMatch(/vestiarion_collected exists already with another type/);
    expect(sent).toHaveLength(1);
  });

  it("says what HubSpot refused, and throws on a missing scope, so the run asks to allow writing again", async () => {
    const refused = recorder((call) =>
      call.url.pathname.endsWith("/batch/read") ? json({ status: "COMPLETE", results: [] }) : json({ category: "VALIDATION_ERROR", message: "Property group name is invalid" }, { status: 400 })
    );
    expect(await ensure(refused.writer)).toEqual({ ok: false, message: "HubSpot said: Property group name is invalid" });
    const forbidden = recorder((call) => (call.url.pathname.endsWith("/batch/read") ? json({ status: "COMPLETE", results: [] }) : new Response("", { status: 403 })));
    await expect(ensure(forbidden.writer)).rejects.toMatchObject({ failure: "forbidden" });
  });
});

describe("readFields and writeFields", () => {
  it("reads a deal's Vestiarion fields, none as null, and a deal HubSpot no longer has as not found", async () => {
    const { sent, writer } = recorder(() =>
      json({ id: "9001", properties: { vestiarion_collected: "2000", vestiarion_still_owed: null, hs_object_id: "9001" }, createdAt: "", updatedAt: "", archived: false })
    );
    const read = await writer.readFields({ ...ACCOUNT, dealId: "9001", names: ["vestiarion_collected", "vestiarion_still_owed", "vestiarion_currency"] });
    expect(read).toEqual({ found: true, values: { vestiarion_collected: "2000", vestiarion_still_owed: null, vestiarion_currency: null } });
    expect(sent[0].url.pathname).toBe("/crm/objects/2026-03/deals/9001");
    expect(sent[0].url.searchParams.get("properties")).toBe("vestiarion_collected,vestiarion_still_owed,vestiarion_currency");
    expect(await recorder(() => new Response("", { status: 404 })).writer.readFields({ ...ACCOUNT, dealId: "9001", names: ["vestiarion_collected"] })).toEqual({ found: false });
  });

  it("writes only the fields given, and says HubSpot's refusal in its own words", async () => {
    const { sent, writer } = recorder(() => json({ id: "9001", properties: {} }));
    expect(await writer.writeFields({ ...ACCOUNT, dealId: "9001", values: { vestiarion_collected: "2000.00" } })).toEqual({ ok: true });
    expect(sent[0].method).toBe("PATCH");
    expect(JSON.parse(sent[0].body)).toEqual({ properties: { vestiarion_collected: "2000.00" } });
    const refused = recorder(() => json({ category: "VALIDATION_ERROR", message: "Property values were not valid" }, { status: 400 }));
    expect(await refused.writer.writeFields({ ...ACCOUNT, dealId: "9001", values: {} })).toEqual({ ok: false, message: "HubSpot said: Property values were not valid" });
    expect(await recorder(() => new Response("", { status: 404 })).writer.writeFields({ ...ACCOUNT, dealId: "9001", values: {} })).toEqual({ ok: false, message: "HubSpot no longer has this deal." });
  });

  it("throws a rate limit with HubSpot's wait, and an outage, for the run to handle", async () => {
    const limited = recorder(() => json({ policyName: "TEN_SECONDLY_ROLLING" }, { status: 429, headers: { "x-hubspot-ratelimit-interval-milliseconds": "10000" } }));
    await expect(limited.writer.writeFields({ ...ACCOUNT, dealId: "9001", values: {} })).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 10_000 });
    await expect(recorder(() => new Response("", { status: 502 })).writer.writeFields({ ...ACCOUNT, dealId: "9001", values: {} })).rejects.toMatchObject({ failure: "unavailable" });
  });
});
