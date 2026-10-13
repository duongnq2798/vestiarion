import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { createContext, runWith } from "@/lib/context";

vi.mock("server-only", () => ({}));

import { checkEvidenceLinks, forgetLinkChecks, LINK_WORDS, type LinkCheckOptions } from "@/lib/evidence-links/check";

/**
 * Whether an evidence link can be opened (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md
 * E1 to E4): GitHub's API and the workspace's own storage only, each host resolved and refused unless public, no redirect
 * followed but GitHub's to itself, the workspace's GitHub token sent to GitHub's API and nowhere else, results kept
 * briefly per workspace, and a private repository seen only through the deployment's token read as not public.
 */

const PR = "https://github.com/acme/app/pull/12";
const PR_API = "https://api.github.com/repos/acme/app/pulls/12";
const STORAGE = "abcdefghijklmnop.supabase.co";
const PUBLIC_DNS = async () => [{ address: "140.82.112.6", family: 4 }];
const signed = (exp: number) =>
  `https://${STORAGE}/storage/v1/object/sign/evidence/a.pdf?token=${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

type Call = { url: string; init: RequestInit };

function github(replies: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const reply = replies[url];
    return reply ? reply() : new Response("not here", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const pull = (isPrivate: boolean) => json({ base: { repo: { private: isPrivate } }, merged: true });

const options = (over: Partial<LinkCheckOptions> = {}): LinkCheckOptions => ({ resolve: PUBLIC_DNS, fallbackToken: "deployment-token", storageUrl: `https://${STORAGE}`, now: () => Date.parse("2026-10-13T09:00:00Z"), ...over });

beforeEach(() => {
  forgetLinkChecks();
});

describe("checkEvidenceLinks: GitHub", () => {
  it("opens a pull request GitHub shows publicly, asking its API, never the link itself", async () => {
    const { calls, fetchImpl } = github({ [PR_API]: pull(false) });
    const access = await checkEvidenceLinks([PR], options({ fetch: fetchImpl }));
    expect(access.get(PR)).toEqual({ state: "open" });
    expect(calls.map((call) => call.url)).toEqual([PR_API]);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.method).toBe("GET");
  });

  it("says a deleted pull request can't be opened", async () => {
    const { fetchImpl } = github({});
    expect((await checkEvidenceLinks([PR], options({ fetch: fetchImpl }))).get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
  });

  it("says a pull request in the workspace's private repository can't be opened by everyone, and why", async () => {
    const { calls, fetchImpl } = github({ [PR_API]: pull(true) });
    const access = await checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => "installation-token" }));
    expect(access.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.private });
    // The workspace's own connection, not the deployment's token.
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer installation-token");
  });

  it("never says what only the deployment's token can see: a private repository it reads is not public, as a deleted one", async () => {
    const { calls, fetchImpl } = github({ [PR_API]: pull(true) });
    const access = await checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => undefined }));
    expect(access.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer deployment-token");
  });

  it("says GitHub refused access, and that the workspace's connection no longer reaches a repository it cannot find", async () => {
    expect((await checkEvidenceLinks([PR], options({ fetch: github({ [PR_API]: json({}, 403) }).fetchImpl }))).get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.refused });
    forgetLinkChecks();
    const gone = await checkEvidenceLinks([PR], options({ fetch: github({}).fetchImpl, tokenFor: async () => "installation-token" }));
    expect(gone.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notFoundConnected });
  });

  it("reads a rate limit, a server error, a timeout and a reply it cannot read as no answer, never as open", async () => {
    const cases: Array<() => Response> = [
      json({}, 403, { "x-ratelimit-remaining": "0" }),
      json({}, 429),
      json({}, 502),
      json({ unexpected: true }),
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ];
    for (const reply of cases) {
      forgetLinkChecks();
      const access = (await checkEvidenceLinks([PR], options({ fetch: github({ [PR_API]: reply }).fetchImpl }))).get(PR);
      expect(access?.state).toBe("no_answer");
    }
  });

  it("checks a comment, then its repository for whether it is private", async () => {
    const comment = `${PR}#issuecomment-987654`;
    const { calls, fetchImpl } = github({
      "https://api.github.com/repos/acme/app/issues/comments/987654": json({ id: 987654 }),
      "https://api.github.com/repos/acme/app": json({ private: false }),
    });
    expect((await checkEvidenceLinks([comment], options({ fetch: fetchImpl }))).get(comment)).toEqual({ state: "open" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/repos/acme/app/issues/comments/987654", "https://api.github.com/repos/acme/app"]);
  });

  it("follows GitHub's own redirect for a renamed repository, once, and no other", async () => {
    const moved = "https://api.github.com/repositories/42/pulls/12";
    const { calls, fetchImpl } = github({ [PR_API]: () => new Response(null, { status: 301, headers: { location: moved } }), [moved]: pull(false) });
    expect((await checkEvidenceLinks([PR], options({ fetch: fetchImpl }))).get(PR)).toEqual({ state: "open" });
    expect(calls.map((call) => call.url)).toEqual([PR_API, moved]);
  });

  it.each([
    "http://api.github.com/repositories/42/pulls/12",
    "https://evil.example.com/steal",
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/repos/acme/app/pulls/12",
    "https://api.github.com/user",
    "file:///etc/passwd",
  ])("refuses a redirect to %s without sending anything there, and without the token", async (location) => {
    const { calls, fetchImpl } = github({ [PR_API]: () => new Response(null, { status: 302, headers: { location } }) });
    const access = (await checkEvidenceLinks([PR], options({ fetch: fetchImpl }))).get(PR);
    expect(access).toEqual({ state: "not_checked", reason: LINK_WORDS.redirected });
    expect(calls).toHaveLength(1);
  });

  it("refuses a second redirect", async () => {
    const one = "https://api.github.com/repositories/42/pulls/12";
    const two = "https://api.github.com/repositories/43/pulls/12";
    const { calls, fetchImpl } = github({
      [PR_API]: () => new Response(null, { status: 301, headers: { location: one } }),
      [one]: () => new Response(null, { status: 301, headers: { location: two } }),
      [two]: pull(false),
    });
    expect((await checkEvidenceLinks([PR], options({ fetch: fetchImpl }))).get(PR)?.state).toBe("not_checked");
    expect(calls.map((call) => call.url)).toEqual([PR_API, one]);
  });

  it("sends nothing to a host whose name resolves to a private address", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::5"]) {
      forgetLinkChecks();
      const { calls, fetchImpl } = github({ [PR_API]: pull(false) });
      const access = await checkEvidenceLinks([PR], options({ fetch: fetchImpl, resolve: async () => [{ address: "140.82.112.6", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] }));
      expect(access.get(PR)?.state, address).toBe("not_checked");
      expect(calls).toHaveLength(0);
    }
    forgetLinkChecks();
    const { calls, fetchImpl } = github({ [PR_API]: pull(false) });
    expect((await checkEvidenceLinks([PR], options({ fetch: fetchImpl, resolve: async () => { throw new Error("ENOTFOUND"); } }))).get(PR)?.state).toBe("not_checked");
    expect(calls).toHaveLength(0);
  });
});

describe("checkEvidenceLinks: what is never requested", () => {
  it("shows a link on any other site as not checked, and sends no request at all", async () => {
    const { calls, fetchImpl } = github({});
    const links = [
      "https://drive.example.test/handoff",
      "http://github.com/acme/app/pull/12",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost:3000/admin",
      "https://user:pw@github.com/acme/app/pull/12",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ];
    const access = await checkEvidenceLinks(links, options({ fetch: fetchImpl }));
    for (const link of links) expect(access.get(link)?.state, link).toBe("not_checked");
    expect(calls).toHaveLength(0);
  });

  it("checks at most 25 links in one call; the rest read as not checked", async () => {
    const replies: Record<string, () => Response> = {};
    const links = Array.from({ length: 27 }, (_, index) => {
      replies[`https://api.github.com/repos/acme/app/pulls/${index + 1}`] = pull(false);
      return `https://github.com/acme/app/pull/${index + 1}`;
    });
    const { calls, fetchImpl } = github(replies);
    const access = await checkEvidenceLinks(links, options({ fetch: fetchImpl }));
    expect(calls).toHaveLength(25);
    expect([...access.values()].filter((each) => each.state === "not_checked")).toEqual([
      { state: "not_checked", reason: LINK_WORDS.tooMany },
      { state: "not_checked", reason: LINK_WORDS.tooMany },
    ]);
  });
});

describe("checkEvidenceLinks: the workspace's own storage", () => {
  it("says an expired signed link can't be opened, from its token, without asking", async () => {
    const { calls, fetchImpl } = github({});
    const link = signed(Date.parse("2026-10-12T08:30:00Z") / 1000);
    expect((await checkEvidenceLinks([link], options({ fetch: fetchImpl }))).get(link)).toEqual({ state: "cannot_open", reason: "The signed link expired on 2026-10-12 08:30 UTC." });
    expect(calls).toHaveLength(0);
  });

  it("asks the storage itself with the link's own signature only, for its first byte", async () => {
    const link = signed(Date.parse("2026-10-14T00:00:00Z") / 1000);
    const { calls, fetchImpl } = github({ [new URL(link).href]: () => new Response("x", { status: 206 }) });
    expect((await checkEvidenceLinks([link], options({ fetch: fetchImpl }))).get(link)).toEqual({ state: "open" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers).toEqual({ Range: "bytes=0-0" });
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("says a deleted file or a refused signature can't be opened, and follows no storage redirect", async () => {
    const link = signed(Date.parse("2026-10-14T00:00:00Z") / 1000);
    const href = new URL(link).href;
    expect((await checkEvidenceLinks([link], options({ fetch: github({ [href]: json({ statusCode: "404" }, 400) }).fetchImpl }))).get(link)).toEqual({ state: "cannot_open", reason: LINK_WORDS.storageGone });
    forgetLinkChecks();
    expect((await checkEvidenceLinks([link], options({ fetch: github({ [href]: json({}, 403) }).fetchImpl }))).get(link)).toEqual({ state: "cannot_open", reason: LINK_WORDS.storageRefused });
    forgetLinkChecks();
    const { calls, fetchImpl } = github({ [href]: () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }) });
    expect((await checkEvidenceLinks([link], options({ fetch: fetchImpl }))).get(link)?.state).toBe("not_checked");
    expect(calls).toHaveLength(1);
  });

  it("checks no storage when the workspace's own is local or plain http", async () => {
    const link = signed(Date.parse("2026-10-14T00:00:00Z") / 1000);
    const { calls, fetchImpl } = github({});
    expect((await checkEvidenceLinks([link], options({ fetch: fetchImpl, storageUrl: "http://127.0.0.1:54321" }))).get(link)?.state).toBe("not_checked");
    expect(calls).toHaveLength(0);
  });
});

describe("checkEvidenceLinks: kept briefly, per workspace", () => {
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${STORAGE}`, SUPABASE_SERVICE_ROLE_KEY: "k" });
  const inOrg = <T,>(orgId: string, fn: () => Promise<T>) => runWith(createContext(config, { orgId }), fn);

  it("asks once in five minutes for a link that opens, and again after", async () => {
    let now = Date.parse("2026-10-13T09:00:00Z");
    const { calls, fetchImpl } = github({ [PR_API]: pull(false) });
    const check = () => inOrg("org-a", () => checkEvidenceLinks([PR], options({ fetch: fetchImpl, now: () => now })));
    await check();
    now += 4 * 60_000;
    await check();
    expect(calls).toHaveLength(1);
    now += 2 * 60_000;
    await check();
    expect(calls).toHaveLength(2);
  });

  it("keeps one workspace's answer from another: each is asked with its own connection", async () => {
    const { calls, fetchImpl } = github({ [PR_API]: pull(true) });
    const a = await inOrg("org-a", () => checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => "a-installation" })));
    const b = await inOrg("org-b", () => checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => undefined })));
    expect(a.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.private });
    expect(b.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
    expect(calls).toHaveLength(2);
  });

  it("asks again soon after no answer", async () => {
    let now = Date.parse("2026-10-13T09:00:00Z");
    let up = false;
    const { calls, fetchImpl } = github({ [PR_API]: () => (up ? pull(false)() : json({}, 503)()) });
    const check = () => checkEvidenceLinks([PR], options({ fetch: fetchImpl, now: () => now }));
    expect((await check()).get(PR)?.state).toBe("no_answer");
    up = true;
    now += 31_000;
    expect((await check()).get(PR)).toEqual({ state: "open" });
    expect(calls).toHaveLength(2);
  });
});
