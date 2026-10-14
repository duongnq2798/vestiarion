import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { checkTargetOf, NOT_CHECKED_WORDS, requestAllowed } from "@/lib/evidence-links/allow-list";
import { checkEvidenceLinks, forgetLinkChecks, LINK_WORDS, type LinkCheckOptions } from "@/lib/evidence-links/check";

/**
 * Asana's links on the evidence allow-list (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A13): a task's
 * or an attachment's link is asked about at Asana's API, at an address built from its id alone, with the workspace's own
 * Asana connection, and nowhere else; without a connection nothing is asked. The page a person typed is never fetched.
 */

const TASK = "https://app.asana.com/0/1219477646404725/1219477646404728";
const TASK_API = "https://app.asana.com/api/1.0/tasks/1219477646404728?opt_fields=gid";
const ASSET = "https://app.asana.com/app/asana/-/get_asset?asset_id=1219477646404801";
const ASSET_API = "https://app.asana.com/api/1.0/attachments/1219477646404801?opt_fields=gid";
const PUBLIC_DNS = async () => [{ address: "52.20.140.1", family: 4 }];

function asana(replies: Record<string, number>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return new Response("{}", { status: replies[url] ?? 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const options = (over: Partial<LinkCheckOptions> = {}): LinkCheckOptions => ({ resolve: PUBLIC_DNS, fallbackToken: null, storageUrl: null, now: () => Date.parse("2026-10-14T09:00:00Z"), ...over });

beforeEach(() => {
  forgetLinkChecks();
});

describe("the allow-list", () => {
  it("asks about a task or an attachment at Asana's API, built from the id", () => {
    expect(checkTargetOf(TASK)).toEqual({ target: { kind: "asana_task", href: TASK, taskGid: "1219477646404728", request: TASK_API } });
    expect(checkTargetOf("https://app.asana.com/1/1204081671801519/project/1219477646404725/task/1219477646404730")).toMatchObject({
      target: { kind: "asana_task", request: "https://app.asana.com/api/1.0/tasks/1219477646404730?opt_fields=gid" },
    });
    expect(checkTargetOf(ASSET)).toEqual({ target: { kind: "asana_attachment", href: ASSET, attachmentGid: "1219477646404801", request: ASSET_API } });
  });

  it("checks no other page on Asana, and no look-alike host", () => {
    expect(checkTargetOf("https://app.asana.com/0/home/1204081671801519")).toEqual({ notChecked: "path" });
    expect(checkTargetOf("https://app.asana.com.evil.example/0/1/2")).toEqual({ notChecked: "host" });
    expect(checkTargetOf("http://app.asana.com/0/1/2")).toEqual({ notChecked: "scheme" });
    expect(NOT_CHECKED_WORDS.host).toMatch(/Asana/);
  });

  it("sends a request to Asana's API for one task or attachment only", () => {
    expect(requestAllowed(TASK_API)).toBe(true);
    expect(requestAllowed(ASSET_API)).toBe(true);
    expect(requestAllowed("https://app.asana.com/api/1.0/users/me")).toBe(false);
    expect(requestAllowed("https://app.asana.com/api/1.0/tasks/1/stories")).toBe(false);
    expect(requestAllowed("https://app.asana.com/-/oauth_token")).toBe(false);
    expect(requestAllowed(TASK)).toBe(false);
  });
});

describe("checkEvidenceLinks: Asana", () => {
  it("opens a task the workspace's Asana connection reads, sending its token to Asana's API only", async () => {
    const { calls, fetchImpl } = asana({ [TASK_API]: 200, [ASSET_API]: 200 });
    const access = await checkEvidenceLinks([TASK, ASSET], options({ fetch: fetchImpl, asanaToken: async () => "asana-access" }));
    expect(access.get(TASK)).toEqual({ state: "open" });
    expect(access.get(ASSET)).toEqual({ state: "open" });
    expect(calls.map((call) => call.url).sort()).toEqual([ASSET_API, TASK_API].sort());
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer asana-access");
      expect(call.init.redirect).toBe("manual");
    }
  });

  it("says a deleted task, or one out of the connection's reach, can't be opened", async () => {
    const { fetchImpl } = asana({ [TASK_API]: 404 });
    expect((await checkEvidenceLinks([TASK], options({ fetch: fetchImpl, asanaToken: async () => "a" }))).get(TASK)).toEqual({ state: "cannot_open", reason: LINK_WORDS.asanaNotFound });
    forgetLinkChecks();
    const refused = asana({ [TASK_API]: 403 });
    expect((await checkEvidenceLinks([TASK], options({ fetch: refused.fetchImpl, asanaToken: async () => "a" }))).get(TASK)).toEqual({ state: "cannot_open", reason: LINK_WORDS.asanaRefused });
  });

  it("asks nothing without the workspace's Asana connection", async () => {
    const { calls, fetchImpl } = asana({ [TASK_API]: 200 });
    expect((await checkEvidenceLinks([TASK], options({ fetch: fetchImpl, asanaToken: async () => null }))).get(TASK)).toEqual({ state: "not_checked", reason: LINK_WORDS.asanaNotConnected });
    expect(calls).toHaveLength(0);
  });

  it("follows no redirect from Asana", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) as unknown as typeof fetch;
    expect((await checkEvidenceLinks([TASK], options({ fetch: fetchImpl, asanaToken: async () => "a" }))).get(TASK)).toEqual({ state: "not_checked", reason: LINK_WORDS.redirected });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a host that resolves to a private address", async () => {
    const { calls, fetchImpl } = asana({ [TASK_API]: 200 });
    const access = await checkEvidenceLinks([TASK], options({ fetch: fetchImpl, asanaToken: async () => "a", resolve: async () => [{ address: "10.0.0.5", family: 4 }] }));
    expect(access.get(TASK)?.state).toBe("not_checked");
    expect(calls).toHaveLength(0);
  });
});
