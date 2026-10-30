import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { checkTargetOf, NOT_CHECKED_WORDS, requestAllowed } from "@/lib/evidence-links/allow-list";
import { checkEvidenceLinks, forgetLinkChecks, LINK_WORDS, type LinkCheckOptions } from "@/lib/evidence-links/check";

/**
 * Linear's links on the evidence allow-list (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN14): an
 * issue's link on linear.app is asked about at Linear's GraphQL API, with a query built from the issue's identifier alone
 * and the workspace's own Linear connection, and nowhere else; without a connection nothing is asked. The page a person
 * typed is never fetched.
 */

const ISSUE = "https://linear.app/fernhill/issue/ENG-123/billing-export";
const GRAPHQL = "https://api.linear.app/graphql";
const PUBLIC_DNS = async () => [{ address: "35.190.10.1", family: 4 }];

function linear(reply: (body: { query: string; variables: { id: string } }) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply(JSON.parse(String(init?.body ?? "{}")));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const options = (over: Partial<LinkCheckOptions> = {}): LinkCheckOptions => ({ resolve: PUBLIC_DNS, fallbackToken: null, storageUrl: null, now: () => Date.parse("2026-10-31T09:00:00Z"), ...over });

beforeEach(() => {
  forgetLinkChecks();
});

describe("the allow-list (Linear acceptance LN14)", () => {
  it("asks about an issue at Linear's GraphQL API, by its identifier", () => {
    const target = checkTargetOf(ISSUE);
    expect(target).toMatchObject({ target: { kind: "linear_issue", href: ISSUE, identifier: "ENG-123", workspaceKey: "fernhill", request: GRAPHQL } });
    if (!("target" in target) || target.target.kind !== "linear_issue") throw new Error("not a Linear issue");
    expect(JSON.parse(target.target.body)).toEqual({ query: "query IssueExists($id: String!) { issue(id: $id) { id url } }", variables: { id: "ENG-123" } });
  });

  it("checks no other page on Linear, and no look-alike host", () => {
    expect(checkTargetOf("https://linear.app/fernhill/project/billing-1a2b3c")).toEqual({ notChecked: "path" });
    expect(checkTargetOf("https://linear.app/fernhill")).toEqual({ notChecked: "path" });
    expect(checkTargetOf("https://linear.app.evil.example/fernhill/issue/ENG-1")).toEqual({ notChecked: "host" });
    expect(checkTargetOf("https://uploads.linear.app/abc/def/shot.png")).toEqual({ notChecked: "host" });
    expect(checkTargetOf("http://linear.app/fernhill/issue/ENG-1")).toEqual({ notChecked: "scheme" });
    expect(NOT_CHECKED_WORDS.host).toMatch(/Linear/);
  });

  it("sends a request to Linear's GraphQL API only, never to the page", () => {
    expect(requestAllowed(GRAPHQL)).toBe(true);
    expect(requestAllowed(`${GRAPHQL}?query=x`)).toBe(false);
    expect(requestAllowed("https://api.linear.app/oauth/token")).toBe(false);
    expect(requestAllowed("https://api.linear.app/oauth/revoke")).toBe(false);
    expect(requestAllowed(ISSUE)).toBe(false);
  });
});

describe("checking an issue's link", () => {
  it("posts the query with the workspace's own Linear token, and reads an issue Linear answers as open", async () => {
    const http = linear(() => json({ data: { issue: { id: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01", url: "https://linear.app/fernhill/issue/ENG-123/billing-export" } } }));
    const found = await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, linearToken: async () => "lin_oauth_access_1" }));
    expect(found.get(ISSUE)).toEqual({ state: "open" });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe(GRAPHQL);
    expect(http.calls[0].init.method).toBe("POST");
    expect(new Headers(http.calls[0].init.headers).get("authorization")).toBe("Bearer lin_oauth_access_1");
    expect(http.calls[0].init.redirect).toBe("manual");
  });

  it("says an issue Linear cannot find, or refuses, cannot be opened, and a rate limit or an outage is no answer", async () => {
    const cases: Array<[() => Response, unknown]> = [
      [() => json({ data: null, errors: [{ message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } }] }, 400), { state: "cannot_open", reason: LINK_WORDS.linearNotFound }],
      [() => json({ data: { issue: null } }), { state: "cannot_open", reason: LINK_WORDS.linearNotFound }],
      [() => json({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] }, 400), { state: "cannot_open", reason: LINK_WORDS.linearRefused }],
      [() => json({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, 400), { state: "no_answer", reason: LINK_WORDS.linearLimited }],
      [() => json({}, 429), { state: "no_answer", reason: LINK_WORDS.linearLimited }],
      [() => json({}, 503), { state: "no_answer", reason: LINK_WORDS.linearSilent }],
      [() => json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, 401), { state: "no_answer", reason: LINK_WORDS.linearSilent }],
    ];
    for (const [reply, expected] of cases) {
      forgetLinkChecks();
      const http = linear(reply);
      expect((await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, linearToken: async () => "t" }))).get(ISSUE)).toEqual(expected);
    }
  });

  it("checks a link only against the Linear workspace it names: the same ID in another one is not checked (Linear acceptance LN14)", async () => {
    // Linear finds ENG-123 in the connected workspace, northstar; the link is to acme's ENG-123.
    const other = "https://linear.app/acme/issue/ENG-123/x";
    const northstar = () => json({ data: { issue: { id: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01", url: "https://linear.app/northstar/issue/ENG-123/billing-export" } } });
    const http = linear(northstar);
    expect((await checkEvidenceLinks([other], options({ fetch: http.fetchImpl, linearToken: async () => "t" }))).get(other)).toEqual({ state: "not_checked", reason: LINK_WORDS.linearOtherWorkspace });
    expect(http.calls).toHaveLength(1);
    // The connected workspace's own link, in any case, opens.
    forgetLinkChecks();
    const own = "https://linear.app/NorthStar/issue/ENG-123/billing-export";
    expect((await checkEvidenceLinks([own], options({ fetch: linear(northstar).fetchImpl, linearToken: async () => "t" }))).get(own)).toEqual({ state: "open" });
    // An answer that does not say where the issue is is no answer, never open.
    forgetLinkChecks();
    const bare = linear(() => json({ data: { issue: { id: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01" } } }));
    expect((await checkEvidenceLinks([own], options({ fetch: bare.fetchImpl, linearToken: async () => "t" }))).get(own)).toEqual({ state: "no_answer", reason: LINK_WORDS.linearSilent });
  });

  it("asks nothing without the workspace's Linear connection, and follows no redirect", async () => {
    const http = linear(() => json({}));
    expect((await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, linearToken: async () => null }))).get(ISSUE)).toEqual({ state: "not_checked", reason: LINK_WORDS.linearNotConnected });
    expect(http.calls).toHaveLength(0);
    forgetLinkChecks();
    const moved = linear(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    expect((await checkEvidenceLinks([ISSUE], options({ fetch: moved.fetchImpl, linearToken: async () => "t" }))).get(ISSUE)).toEqual({ state: "not_checked", reason: LINK_WORDS.redirected });
    expect(moved.calls).toHaveLength(1);
  });

  it("never sends the Linear token to a host that is not public", async () => {
    const http = linear(() => json({ data: { issue: { id: "x" } } }));
    const found = await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, linearToken: async () => "t", resolve: async () => [{ address: "10.0.0.5", family: 4 }] }));
    expect(found.get(ISSUE)).toEqual({ state: "not_checked", reason: NOT_CHECKED_WORDS.address });
    expect(http.calls).toHaveLength(0);
  });
});
