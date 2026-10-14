import { describe, expect, it } from "vitest";
import { ConnectRefusal } from "@/lib/connectors/connect-refusal";
import { ProviderError } from "@/lib/connectors/provider";
import { pipedriveReader } from "@/lib/pipedrive/api";
import { failureOf } from "@/lib/pipedrive/http";
import { authorizeUrl, exchangeCode, listCompany, refreshTokens, revokeToken } from "@/lib/pipedrive/oauth";
import { API_DOMAIN, COMPANY_ID, fakePipedrive } from "./support/fake-pipedrive";

/**
 * Pipedrive over HTTP (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4, P5, P6, P8), against an
 * in-memory Pipedrive: the authorize URL; the code exchange and refresh with the client's credentials as Basic auth; the
 * company's `api_domain` used for every call, and no other host; a grant without its read scopes refused; a 429's wait;
 * deal pages walked by cursor, resumed mid-run; deals by id with archived and deleted ones.
 */

const settings = { clientId: "b4d083d9216b7d0c", clientSecret: "client-secret-value" };
const NOW = Date.parse("2026-10-14T08:00:00.000Z");
const HOST = new URL(API_DOMAIN).host;

describe("Pipedrive's OAuth", () => {
  it("authorizes with the client id, the callback and the state, and no scope: Pipedrive asks for the app's own", () => {
    const url = new URL(authorizeUrl(settings, { state: "vx1.state", redirectUri: "https://www.vestiarion.xyz/api/integrations/pipedrive/callback" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://oauth.pipedrive.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: settings.clientId,
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/pipedrive/callback",
      state: "vx1.state",
    });
  });

  it("exchanges the code with Basic auth, never the secret in the body, and seals the tokens with the company's domain", async () => {
    const fake = fakePipedrive();
    const outcome = await exchangeCode(settings, { code: "code-1", redirectUri: "https://www.vestiarion.xyz/api/integrations/pipedrive/callback" }, { fetchImpl: fake.fetchImpl, now: () => NOW });
    expect(outcome).toEqual({
      ok: true,
      authEventId: null,
      tokens: { accessToken: `pd1|${HOST}|v1u:access-a`, refreshToken: `pd1|${HOST}|1:1:refresh-a`, expiresAt: NOW + 3_599_000, scopes: expect.arrayContaining(["deals:full", "contacts:read"]) },
    });
    const sent = fake.requests[0];
    expect(sent.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`);
    expect(sent.body).not.toContain(settings.clientSecret);
    expect(Object.fromEntries(new URLSearchParams(sent.body))).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: "https://www.vestiarion.xyz/api/integrations/pipedrive/callback" });
  });

  it("keeps nothing when the answer names a domain that is not Pipedrive's", async () => {
    const fake = fakePipedrive({ apiDomain: "https://attacker.example" });
    expect(await exchangeCode(settings, { code: "c", redirectUri: "r" }, { fetchImpl: fake.fetchImpl })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refreshes to the domain of the token, stores the rotated refresh token, and asks for a reconnect when it is refused", async () => {
    const fake = fakePipedrive();
    const refreshed = await refreshTokens(settings, `pd1|${HOST}|1:1:refresh-a`, { fetchImpl: fake.fetchImpl, now: () => NOW });
    expect(refreshed).toMatchObject({ ok: true, tokens: { accessToken: `pd1|${HOST}|v1u:access-b`, refreshToken: `pd1|${HOST}|1:1:refresh-b` } });
    // The old refresh token no longer works: a refresh that sent it again is refused, and the connection needs a person.
    expect(await refreshTokens(settings, `pd1|${HOST}|1:1:refresh-a`, { fetchImpl: fake.fetchImpl })).toEqual({ ok: false, reason: "reconnect" });
    expect(await refreshTokens(settings, "not-sealed", { fetchImpl: fake.fetchImpl })).toEqual({ ok: false, reason: "reconnect" });
  });

  it("revokes the refresh token, which uninstalls the app", async () => {
    const fake = fakePipedrive();
    expect(await revokeToken(settings, `pd1|${HOST}|1:1:refresh-a`, { fetchImpl: fake.fetchImpl })).toBe(true);
    expect(fake.state.revoked).toEqual(["1:1:refresh-a"]);
    expect(Object.fromEntries(new URLSearchParams(fake.requests[0].body))).toEqual({ token: "1:1:refresh-a", token_type_hint: "refresh_token" });
  });

  it("names the one company a grant reaches, from users/me at its own domain", async () => {
    const fake = fakePipedrive();
    const tokens = { accessToken: `pd1|${HOST}|v1u:access-a`, refreshToken: `pd1|${HOST}|1:1:refresh-a`, expiresAt: NOW + 3_600_000, scopes: ["base", "deals:full", "contacts:read"] };
    expect(await listCompany(settings, tokens, { fetchImpl: fake.fetchImpl })).toEqual([{ externalOrgId: String(COMPANY_ID), name: "Cedar & Co", connectionId: null }]);
    expect(fake.requests.map((request) => `${request.host}${request.path}`)).toEqual([`${HOST}/api/v1/users/me`]);
    expect(fake.requests[0].headers.get("authorization")).toBe("Bearer v1u:access-a");
  });

  it("refuses a grant without the scopes that read deals and organizations, and revokes it", async () => {
    const fake = fakePipedrive();
    const tokens = { accessToken: `pd1|${HOST}|v1u:access-a`, refreshToken: `pd1|${HOST}|1:1:refresh-a`, expiresAt: NOW + 3_600_000, scopes: ["base", "users:read"] };
    await expect(listCompany(settings, tokens, { fetchImpl: fake.fetchImpl })).rejects.toEqual(new ConnectRefusal("scopes"));
    expect(fake.state.revoked).toEqual(["1:1:refresh-a"]);
  });
});

describe("429 and other refusals", () => {
  it("waits what Pipedrive asks: Retry-After, else x-ratelimit-reset, else the two-second burst window", () => {
    const at = (headers: Record<string, string>) => failureOf(new Response(null, { status: 429, headers }), "deals", NOW);
    expect(at({ "retry-after": "3" })).toMatchObject({ failure: "rate_limited", retryAfterMs: 3_000 });
    expect(at({ "x-ratelimit-reset": "7" })).toMatchObject({ failure: "rate_limited", retryAfterMs: 7_000 });
    expect(at({})).toMatchObject({ failure: "rate_limited", retryAfterMs: 2_000 });
    expect(failureOf(new Response(null, { status: 401 }), "deals", NOW).failure).toBe("unauthorized");
    expect(failureOf(new Response(null, { status: 403 }), "deals", NOW).failure).toBe("forbidden");
    expect(failureOf(new Response(null, { status: 503 }), "deals", NOW).failure).toBe("unavailable");
    expect(failureOf(new Response(null, { status: 402 }), "deals", NOW).failure).toBe("bad_response");
  });
});

describe("reading deals", () => {
  const credential = `pd1|${HOST}|v1u:access-a`;
  const request = { accessToken: credential, externalOrgId: String(COMPANY_ID), windowFrom: "2026-07-16" };

  function seeded(count: number) {
    const fake = fakePipedrive();
    for (let id = 1; id <= count; id += 1) fake.addDeal({ id, status: id % 3 === 0 ? "won" : "open", update_time: `2026-10-14T08:${String(id % 60).padStart(2, "0")}:00Z`, local_won_date: "2026-10-14" });
    return fake;
  }

  it("backfills open and won deals, 100 a page in the order of their change, with their organization and person, at the company's domain", async () => {
    const fake = seeded(150);
    const reader = pipedriveReader({ fetchImpl: fake.fetchImpl });
    const first = await reader.deals({ ...request, page: 1, phase: "backfill", since: null });
    expect(first.items).toHaveLength(100);
    expect(first.last).toBe(false);
    expect(first.items[0]).toMatchObject({ company: { externalId: "501", name: "Cedar & Co", email: "rosa@cedarandco.example" }, pipelineLabel: "Sales" });
    const asked = fake.requests.find((sent) => sent.path === "/api/v2/deals");
    expect(Object.fromEntries(asked?.query ?? [])).toEqual({ limit: "100", sort_by: "update_time", sort_direction: "asc", status: "open,won" });
    expect(new Set(fake.requests.map((sent) => sent.host))).toEqual(new Set([HOST]));
    const second = await reader.deals({ ...request, page: 2, phase: "backfill", since: null });
    expect(second.items).toHaveLength(50);
    expect(second.last).toBe(true);
  });

  it("follows changes since five minutes before the last run, lost and deleted deals too", async () => {
    const fake = seeded(3);
    const reader = pipedriveReader({ fetchImpl: fake.fetchImpl });
    await reader.deals({ ...request, page: 1, phase: "incremental", since: "2026-10-14T08:10:00.000Z" });
    const asked = fake.requests.find((sent) => sent.path === "/api/v2/deals");
    expect(asked?.query.get("status")).toBe("open,won,lost,deleted");
    expect(asked?.query.get("updated_since")).toBe("2026-10-14T08:05:00Z");
  });

  it("resumes a run at page 3 by walking the cursors from page 1, then goes on from what it walked", async () => {
    const fake = seeded(250);
    const reader = pipedriveReader({ fetchImpl: fake.fetchImpl });
    const third = await reader.deals({ ...request, page: 3, phase: "backfill", since: null });
    expect(third.items).toHaveLength(50);
    expect(third.last).toBe(true);
    expect(fake.requests.filter((sent) => sent.path === "/api/v2/deals")).toHaveLength(3);
    // Past the end: no deals, and the last page.
    expect(await reader.deals({ ...request, page: 5, phase: "backfill", since: null })).toMatchObject({ items: [], last: true });
  });

  it("reads linked deals by id: archived ones are still the deals they were, deleted and missing ones are missing", async () => {
    const fake = fakePipedrive();
    fake.addDeal({ id: 42, status: "won", local_won_date: "2026-10-14" });
    fake.addDeal({ id: 43, status: "won", is_archived: true, local_won_date: "2026-10-01" });
    fake.addDeal({ id: 44, status: "deleted" });
    const read = await pipedriveReader({ fetchImpl: fake.fetchImpl }).dealsById({ accessToken: credential, externalOrgId: String(COMPANY_ID), ids: ["42", "43", "44", "45"] });
    expect(read.deals.map((deal) => deal.externalId).sort()).toEqual(["42", "43"]);
    expect(read.missing.sort()).toEqual(["44", "45"]);
    expect(fake.requests.find((sent) => sent.path === "/api/v2/deals/archived")?.query.get("ids")).toBe("43,45");
  });

  it("throws a refused token as unauthorized, for the runner to refresh", async () => {
    const fake = seeded(1);
    fake.state.refused.add("v1u:access-a");
    await expect(pipedriveReader({ fetchImpl: fake.fetchImpl }).deals({ ...request, page: 1, phase: "backfill", since: null })).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(pipedriveReader({ fetchImpl: fake.fetchImpl }).deals({ ...request, accessToken: "v1u:not-sealed", page: 1, phase: "backfill", since: null })).rejects.toBeInstanceOf(ProviderError);
  });
});
