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

  it("opens a pull request in the workspace's own private repository, read through its own GitHub connection", async () => {
    const { calls, fetchImpl } = github({ [PR_API]: pull(true) });
    const access = await checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => "installation-token" }));
    // Its people open it on GitHub: a merged pull request in it stays verified, as before any check.
    expect(access.get(PR)).toEqual({ state: "open" });
    // The workspace's own connection, not the deployment's token.
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer installation-token");
  });

  it("opens a comment in the workspace's own private repository, asking its repository first", async () => {
    const comment = `${PR}#issuecomment-987654`;
    const { calls, fetchImpl } = github({
      "https://api.github.com/repos/acme/app": json({ private: true }),
      "https://api.github.com/repos/acme/app/issues/comments/987654": json({ id: 987654 }),
    });
    expect((await checkEvidenceLinks([comment], options({ fetch: fetchImpl, tokenFor: async () => "installation-token" }))).get(comment)).toEqual({ state: "open" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/repos/acme/app", "https://api.github.com/repos/acme/app/issues/comments/987654"]);
  });

  it("never says what only the deployment's token can see: a private repository it reads is not public, as a deleted one", async () => {
    const { calls, fetchImpl } = github({ [PR_API]: pull(true) });
    const access = await checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => undefined }));
    expect(access.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer deployment-token");
  });

  it("says GitHub refused the workspace's connection, and that the connection no longer reaches a repository it cannot find", async () => {
    expect((await checkEvidenceLinks([PR], options({ fetch: github({ [PR_API]: json({}, 403) }).fetchImpl, tokenFor: async () => "installation-token" }))).get(PR)).toEqual({
      state: "cannot_open",
      reason: LINK_WORDS.refused,
    });
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

  it("checks a comment's repository for whether it is private, then the comment", async () => {
    const comment = `${PR}#issuecomment-987654`;
    const { calls, fetchImpl } = github({
      "https://api.github.com/repos/acme/app/issues/comments/987654": json({ id: 987654 }),
      "https://api.github.com/repos/acme/app": json({ private: false }),
    });
    expect((await checkEvidenceLinks([comment], options({ fetch: fetchImpl }))).get(comment)).toEqual({ state: "open" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/repos/acme/app", "https://api.github.com/repos/acme/app/issues/comments/987654"]);
    forgetLinkChecks();
    const deleted = github({ "https://api.github.com/repos/acme/app": json({ private: false }) });
    expect((await checkEvidenceLinks([comment], options({ fetch: deleted.fetchImpl }))).get(comment)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
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
    expect(a.get(PR)).toEqual({ state: "open" });
    expect(b.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
    expect(calls).toHaveLength(2);
    // Asked again from either workspace, each keeps its own answer.
    expect((await inOrg("org-b", () => checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => undefined })))).get(PR)?.state).toBe("cannot_open");
    expect((await inOrg("org-a", () => checkEvidenceLinks([PR], options({ fetch: fetchImpl, tokenFor: async () => "a-installation" })))).get(PR)?.state).toBe("open");
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

describe("checkEvidenceLinks: nothing reaches past GitHub's API and the workspace's storage (SSRF)", () => {
  it("sends every request, a redirect's included, to GitHub's API or the workspace's own storage, and resolves only those", async () => {
    const link = signed(Date.parse("2026-10-14T00:00:00Z") / 1000);
    const resolved: string[] = [];
    const away = (location: string) => () => new Response(null, { status: 302, headers: { location } });
    const { calls, fetchImpl } = github({
      [PR_API]: away("https://api.github.com.evil.example/repos/acme/app/pulls/12"),
      "https://api.github.com/repos/acme/app/pulls/13": away("https://api.github.com@evil.example/repos/acme/app/pulls/13"),
      "https://api.github.com/repos/acme/app/pulls/14": away("https://[::ffff:127.0.0.1]/repos/acme/app/pulls/14"),
      "https://api.github.com/repos/acme/app/pulls/15": away("//evil.example/repos/acme/app/pulls/15"),
      "https://api.github.com/repos/acme/app/pulls/16": away("https://api.github.com./repos/acme/app/pulls/16"),
      [new URL(link).href]: away("https://api.github.com/repos/acme/app/pulls/17"),
    });
    const links = [
      PR,
      "https://github.com/acme/app/pull/13",
      "https://github.com/acme/app/pull/14",
      "https://github.com/acme/app/pull/15",
      "https://github.com/acme/app/pull/16",
      link,
      "https://[::ffff:127.0.0.1]/acme/app/pull/1",
      "https://2130706433/acme/app/pull/1",
      "https://github.com./acme/app/pull/1",
      "https://api.github.com.evil.example/repos/acme/app/pulls/1",
      "https://api.github.com@evil.example/repos/acme/app/pulls/1",
      "https://gіthub.com/acme/app/pull/1",
      `https://other-project.supabase.co/storage/v1/object/sign/evidence/a.pdf?token=${new URL(link).searchParams.get("token")}`,
    ];
    const access = await checkEvidenceLinks(
      links,
      options({
        fetch: fetchImpl,
        resolve: async (host) => {
          resolved.push(host);
          return [{ address: "140.82.112.6", family: 4 }];
        },
      })
    );
    for (const each of links) expect(access.get(each)?.state, each).toBe("not_checked");
    expect(new Set(calls.map((call) => new URL(call.url).hostname))).toEqual(new Set(["api.github.com", STORAGE]));
    expect(new Set(resolved)).toEqual(new Set(["api.github.com", STORAGE]));
    // Only the first hop of each allowed link: none of the redirects above was followed.
    expect(calls).toHaveLength(6);
    // The token went to GitHub's API only; storage got the link's own signature and nothing else.
    for (const call of calls) {
      const sent = call.init.headers as Record<string, string>;
      if (new URL(call.url).hostname === STORAGE) expect(sent).toEqual({ Range: "bytes=0-0" });
      else expect(sent.Authorization).toBe("Bearer deployment-token");
    }
  });

  it("resolves the host again before each hop, and drops the hop whose name now resolves to a private address", async () => {
    const moved = "https://api.github.com/repositories/42/pulls/12";
    const answers = ["140.82.112.6", "127.0.0.1"];
    const { calls, fetchImpl } = github({ [PR_API]: () => new Response(null, { status: 301, headers: { location: moved } }), [moved]: pull(false) });
    const access = await checkEvidenceLinks([PR], options({ fetch: fetchImpl, resolve: async () => [{ address: answers.shift() ?? "127.0.0.1", family: 4 }] }));
    expect(access.get(PR)?.state).toBe("not_checked");
    expect(calls.map((call) => call.url)).toEqual([PR_API]);
  });

  it("never reads a storage reply's body, however large: it asks for one byte and cancels the rest", async () => {
    const link = signed(Date.parse("2026-10-14T00:00:00Z") / 1000);
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
        { status: 200 }
      );
    const { fetchImpl } = github({ [new URL(link).href]: endless });
    expect((await checkEvidenceLinks([link], options({ fetch: fetchImpl }))).get(link)).toEqual({ state: "open" });
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("asks under a timeout, so a reply that never ends is cut off", async () => {
    const { calls, fetchImpl } = github({ [PR_API]: pull(false) });
    await checkEvidenceLinks([PR], options({ fetch: fetchImpl }));
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init.signal?.aborted).toBe(false);
  });
});

describe("checkEvidenceLinks: what only the deployment's token can see is never told (oracle)", () => {
  const COMMENT = `${PR}#issuecomment-987654`;
  const COMMENT_API = "https://api.github.com/repos/acme/app/issues/comments/987654";
  const REPO_API = "https://api.github.com/repos/acme/app";
  const deployment = (over: Partial<LinkCheckOptions> = {}) => options({ tokenFor: async () => undefined, ...over });

  it("says a refusal of the deployment's token as it says a deleted link: GitHub refuses only what exists", async () => {
    const refused = await checkEvidenceLinks([PR], deployment({ fetch: github({ [PR_API]: json({ message: "Resource protected by organization SAML enforcement." }, 403) }).fetchImpl }));
    forgetLinkChecks();
    const deleted = await checkEvidenceLinks([PR], deployment({ fetch: github({}).fetchImpl }));
    expect(refused.get(PR)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
    expect(refused.get(PR)).toEqual(deleted.get(PR));
  });

  it("asks as many questions about a comment in a private repository it alone can read as about a deleted one", async () => {
    const hidden = github({ [COMMENT_API]: json({ id: 987654 }), [REPO_API]: json({ private: true }) });
    const seen = await checkEvidenceLinks([COMMENT], deployment({ fetch: hidden.fetchImpl }));
    forgetLinkChecks();
    const gone = github({});
    const missing = await checkEvidenceLinks([COMMENT], deployment({ fetch: gone.fetchImpl }));
    expect(seen.get(COMMENT)).toEqual({ state: "cannot_open", reason: LINK_WORDS.notPublic });
    expect(missing.get(COMMENT)).toEqual(seen.get(COMMENT));
    expect(hidden.calls).toHaveLength(gone.calls.length);
  });

  it("keeps its answer exactly as long as a deleted one's", async () => {
    const asked = async (fetchImpl: typeof fetch) => {
      forgetLinkChecks();
      const counts: number[] = [];
      for (const minutes of [0, 1.9, 2.1]) {
        const now = Date.parse("2026-10-13T09:00:00Z") + minutes * 60_000;
        await checkEvidenceLinks([PR], deployment({ fetch: fetchImpl, now: () => now }));
        counts.push((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length);
      }
      return counts;
    };
    expect(await asked(github({ [PR_API]: pull(true) }).fetchImpl)).toEqual(await asked(github({}).fetchImpl));
  });

  it("logs neither a token nor a signed link's token when a check fails", async () => {
    const link = signed(Date.parse("2026-10-14T00:00:00Z") / 1000);
    const secret = new URL(link).searchParams.get("token") ?? "";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      throw new Error(`connect failed for ${String(input)} with ${JSON.stringify(init?.headers)}`);
    }) as unknown as typeof fetch;
    await checkEvidenceLinks([PR, link], options({ fetch: failing }));
    const logged = JSON.stringify(errors.mock.calls);
    errors.mockRestore();
    expect(logged).not.toContain("deployment-token");
    expect(logged).not.toContain(secret);
  });
});
