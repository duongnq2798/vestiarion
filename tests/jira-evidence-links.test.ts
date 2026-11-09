import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { checkTargetOf, JIRA_API_HOST, NOT_CHECKED_WORDS, requestAllowed } from "@/lib/evidence-links/allow-list";
import { checkEvidenceLinks, forgetLinkChecks, LINK_WORDS, type LinkCheckOptions } from "@/lib/evidence-links/check";
import { JIRA_API_HOST as JIRA_CLIENT_API_HOST } from "@/lib/jira/http";
import { jiraLinkCheck, type JiraLinkCheck } from "@/lib/jira/workspace";
import { CLOUD, CONN, jiraWorld, NEW_CLOUD, NOW, type JiraWorld, type WorldHooks } from "./support/jira-world";

/**
 * Jira's links on the evidence allow-list (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR20): an issue's
 * own page on the site the workspace connected, `https://<site>/browse/KEY`, is asked about at Atlassian's API,
 * `api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/KEY?fields=summary`, at an address built from the site's cloudId
 * and the issue's key alone, with the workspace's own Jira connection, and nowhere else. Any other Atlassian site, and any
 * other page on the connected one, is not checked; the page a person typed is never fetched. The site is read once per
 * check, in the workspace's scope, only while Jira is on and only when some link is on a host no other check knows.
 */

const { hooks } = vi.hoisted(() => ({ hooks: { tokens: null, enter: null } as WorldHooks }));
vi.mock("@/lib/connectors/token-store", async (original) => ({
  ...(await original<typeof import("@/lib/connectors/token-store")>()),
  connectionTokenStore: (_orgId: string, connectionId: string) => hooks.tokens?.(connectionId),
}));
vi.mock("@/lib/dal/scope", async (original) => ({
  ...(await original<typeof import("@/lib/dal/scope")>()),
  withOrg: <T,>(orgId: string, fn: () => Promise<T>) => (hooks.enter ? hooks.enter(orgId, fn) : Promise.reject(new Error("no scope"))),
}));

const HOST = "northstar.atlassian.net";
const SITE = { host: HOST, cloudId: CLOUD };
const ISSUE = `https://${HOST}/browse/ENG-142`;
const REQUEST = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/ENG-142?fields=summary`;
const PR = "https://github.com/acme/app/pull/12";
const PUBLIC_DNS = async () => [{ address: "104.192.142.1", family: 4 }];

function atlassian(reply: (url: string) => Response = () => json({ id: "10042", key: "ENG-142", fields: { summary: "Webhook retries with backoff" } })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return reply(url);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The workspace's Jira as the check sees it: the connected site, a token, and Atlassian's shared limit not spent. */
const connected = (over: Partial<JiraLinkCheck> = {}): JiraLinkCheck => ({ site: SITE, token: async () => "jira_access_1", pausedUntil: () => null, ...over });
const options = (over: Partial<LinkCheckOptions> = {}): LinkCheckOptions => ({ resolve: PUBLIC_DNS, fallbackToken: null, storageUrl: null, now: () => NOW, ...over });

beforeEach(() => {
  forgetLinkChecks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the allow-list (Jira acceptance JR20)", () => {
  it("asks about an issue's page on the connected site at Jira's API, by its key, on the site's cloudId", () => {
    expect(checkTargetOf(ISSUE, { jiraSite: SITE })).toEqual({ target: { kind: "jira_issue", href: ISSUE, key: "ENG-142", cloudId: CLOUD, request: REQUEST } });
    // The same issue however its page is written: the host in any case, the key in any case, a trailing slash, a query.
    for (const href of [`https://NorthStar.Atlassian.net/browse/ENG-142`, `https://${HOST}/browse/eng-142`, `${ISSUE}/`, `${ISSUE}?focusedCommentId=10010`, `${ISSUE}#comment-10010`]) {
      const decided = checkTargetOf(href, { jiraSite: SITE });
      expect("target" in decided && decided.target.request, href).toBe(REQUEST);
    }
    // Another site connected names its own cloudId.
    expect(checkTargetOf("https://southwind.atlassian.net/browse/OPS-7", { jiraSite: { host: "southwind.atlassian.net", cloudId: NEW_CLOUD } })).toMatchObject({
      target: { kind: "jira_issue", key: "OPS-7", request: `https://api.atlassian.com/ex/jira/${NEW_CLOUD}/rest/api/3/issue/OPS-7?fields=summary` },
    });
  });

  it("checks no other Atlassian site, no look-alike host, and nothing without the connected site", () => {
    expect(checkTargetOf(ISSUE)).toEqual({ notChecked: "host" });
    expect(checkTargetOf(ISSUE, { jiraSite: null })).toEqual({ notChecked: "host" });
    for (const href of [
      "https://southwind.atlassian.net/browse/ENG-142",
      `https://${HOST}.evil.example/browse/ENG-142`,
      `https://evil.example/${HOST}/browse/ENG-142`,
      `https://ns.${HOST}/browse/ENG-142`,
      REQUEST,
      "https://id.atlassian.com/login",
      "https://admin.atlassian.com/o/1/users",
      "https://api.media.atlassian.com/file/1/binary",
    ]) {
      expect(checkTargetOf(href, { jiraSite: SITE }), href).toEqual({ notChecked: "host" });
    }
    // A site that is not what Atlassian names a site by is no site: its links are not checked.
    expect(checkTargetOf(ISSUE, { jiraSite: { host: HOST, cloudId: "not-a-cloud-id" } })).toEqual({ notChecked: "host" });
    expect(checkTargetOf(ISSUE, { jiraSite: { host: HOST, cloudId: CLOUD.toUpperCase() } })).toEqual({ notChecked: "host" });
    expect(checkTargetOf("https://api.atlassian.com/browse/ENG-142", { jiraSite: { host: JIRA_API_HOST, cloudId: CLOUD } })).toEqual({ notChecked: "host" });
    expect(NOT_CHECKED_WORDS.host).toMatch(/the connected Jira site/);
  });

  it("checks no other page on the connected site: its files, boards, filters and other paths", () => {
    for (const href of [
      `https://${HOST}/secure/attachment/10001/handoff.pdf`,
      `https://${HOST}/browse/ENG-142/comments`,
      `https://${HOST}/browse/ENG`,
      `https://${HOST}/browse/142`,
      `https://${HOST}/browse/`,
      `https://${HOST}/`,
      `https://${HOST}/jira/software/projects/ENG/boards/1?selectedIssue=ENG-142`,
      `https://${HOST}/jira/software/projects/ENG/issues/ENG-142`,
      `https://${HOST}/issues/?jql=project%20%3D%20ENG`,
      `https://${HOST}/rest/api/3/issue/ENG-142`,
      `https://${HOST}/wiki/spaces/ENG/pages/1`,
    ]) {
      expect(checkTargetOf(href, { jiraSite: SITE }), href).toEqual({ notChecked: "path" });
    }
    expect(checkTargetOf(`http://${HOST}/browse/ENG-142`, { jiraSite: SITE })).toEqual({ notChecked: "scheme" });
    expect(checkTargetOf(`https://${HOST}:8443/browse/ENG-142`, { jiraSite: SITE })).toEqual({ notChecked: "port" });
    expect(checkTargetOf(`https://mai:pw@${HOST}/browse/ENG-142`, { jiraSite: SITE })).toEqual({ notChecked: "credentials" });
    expect(NOT_CHECKED_WORDS.path).toMatch(/on Linear and the connected Jira site, issues/);
  });

  it("sends a request to Jira's API only for one issue's summary on the connected site, in exactly the shape built", () => {
    expect(JIRA_API_HOST).toBe(JIRA_CLIENT_API_HOST);
    expect(requestAllowed(REQUEST, { jiraSite: SITE })).toBe(true);
    expect(requestAllowed(REQUEST)).toBe(false);
    expect(requestAllowed(REQUEST, { jiraSite: { host: "southwind.atlassian.net", cloudId: NEW_CLOUD } })).toBe(false);
    const api = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api`;
    for (const url of [
      `${api}/3/issue/ENG-142`,
      `${api}/3/issue/ENG-142?fields=summary,description`,
      `${api}/3/issue/ENG-142?fields=*all`,
      `${api}/3/issue/ENG-142?fields=summary&expand=changelog`,
      `${api}/3/issue/ENG-142?fields=summary#x`,
      `${api}/3/issue/ENG-142/?fields=summary`,
      `${api}/3/issue/eng-142?fields=summary`,
      `${api}/3/issue/10042?fields=summary`,
      `${api}/3/issue/ENG-142/comment?fields=summary`,
      `${api}/3/issue/ENG-142/remotelink?fields=summary`,
      `${api}/2/issue/ENG-142?fields=summary`,
      `${api}/3/myself`,
      `${api}/3/webhook`,
      `${api}/3/search/jql?jql=id%20in%20(10042)&fields=summary`,
      `https://api.atlassian.com/ex/jira/${CLOUD.toUpperCase()}/rest/api/3/issue/ENG-142?fields=summary`,
      "https://api.atlassian.com/oauth/token/accessible-resources",
      "https://auth.atlassian.com/oauth/token",
      `http://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/ENG-142?fields=summary`,
      `https://api.atlassian.com:8443/ex/jira/${CLOUD}/rest/api/3/issue/ENG-142?fields=summary`,
      ISSUE,
    ]) {
      expect(requestAllowed(url, { jiraSite: SITE }), url).toBe(false);
    }
  });
});

describe("checking an issue's link (JR20)", () => {
  it("asks Jira's API with the workspace's own Jira token, and reads an issue Jira answers as open", async () => {
    const http = atlassian();
    const found = await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira: async () => connected() }));
    expect(found.get(ISSUE)).toEqual({ state: "open" });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe(REQUEST);
    expect(http.calls[0].init.method).toBe("GET");
    expect(http.calls[0].init.body).toBeUndefined();
    expect(new Headers(http.calls[0].init.headers).get("authorization")).toBe("Bearer jira_access_1");
    expect(new Headers(http.calls[0].init.headers).get("accept")).toBe("application/json");
    expect(http.calls[0].init.redirect).toBe("manual");
    expect(http.calls[0].init.cache).toBe("no-store");
  });

  it("says an issue Jira cannot find or refuses cannot be opened, and a rate limit or an outage is no answer", async () => {
    const cases: Array<[() => Response, unknown]> = [
      [() => json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404), { state: "cannot_open", reason: LINK_WORDS.jiraNotFound }],
      [() => json({ errorMessages: ["You do not have permission to see this issue."] }, 403), { state: "cannot_open", reason: LINK_WORDS.jiraRefused }],
      [() => json({}, 429, { "retry-after": "30", "ratelimit-reason": "jira-burst-based" }), { state: "no_answer", reason: LINK_WORDS.jiraLimited }],
      [() => json({}, 500), { state: "no_answer", reason: LINK_WORDS.jiraSilent }],
      [() => json({}, 503), { state: "no_answer", reason: LINK_WORDS.jiraSilent }],
      [() => json({}, 401), { state: "no_answer", reason: LINK_WORDS.jiraSilent }],
    ];
    for (const [reply, expected] of cases) {
      forgetLinkChecks();
      const http = atlassian(reply);
      expect((await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira: async () => connected() }))).get(ISSUE)).toEqual(expected);
      expect(http.calls).toHaveLength(1);
    }
    expect(LINK_WORDS.jiraNotFound).toBe("Jira could not find it: it was deleted, or the workspace's Jira connection does not reach it.");
    expect(LINK_WORDS.jiraRefused).toBe("Jira refused access to it.");
    expect(LINK_WORDS.jiraLimited).toBe("Jira's rate limit was reached; it is checked again in a minute.");
    expect(LINK_WORDS.jiraSilent).toBe("Jira did not answer just now.");
  });

  it("asks nothing when the workspace's connection gives no token, and says so", async () => {
    const http = atlassian();
    const found = await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira: async () => connected({ token: async () => null }) }));
    expect(found.get(ISSUE)).toEqual({ state: "not_checked", reason: LINK_WORDS.jiraNotConnected });
    expect(LINK_WORDS.jiraNotConnected).toBe("Reconnect Jira to this workspace to check Jira links: Vestiarion asks Jira with the workspace's own connection only.");
    expect(http.calls).toHaveLength(0);
  });

  it("asks nothing, and reads no token, while Atlassian's shared limit is spent (JR17)", async () => {
    const http = atlassian();
    const token = vi.fn(async () => "jira_access_1");
    const found = await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira: async () => connected({ token, pausedUntil: () => NOW + 60_000 }) }));
    expect(found.get(ISSUE)).toEqual({ state: "no_answer", reason: LINK_WORDS.jiraLimited });
    expect(token).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(0);
  });

  it("checks no Jira link without the connected site, or when it could not be read, and asks nothing", async () => {
    for (const jira of [async () => null, async () => Promise.reject(new Error("the database did not answer"))]) {
      forgetLinkChecks();
      const http = atlassian();
      expect((await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira }))).get(ISSUE)).toEqual({ state: "not_checked", reason: NOT_CHECKED_WORDS.host });
      expect(http.calls).toHaveLength(0);
    }
  });

  it("leaves a link unanswered when Atlassian gave no token just now", async () => {
    const http = atlassian();
    const found = await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira: async () => connected({ token: () => Promise.reject(new Error("Jira access: unavailable")) }) }));
    expect(found.get(ISSUE)).toEqual({ state: "no_answer", reason: LINK_WORDS.jiraSilent });
    expect(http.calls).toHaveLength(0);
  });

  it("reads the site and its token once per check, and the site only when some link is on a host no other check knows", async () => {
    const token = vi.fn(async () => "jira_access_1");
    const load = vi.fn(async () => connected({ token }));
    const known = atlassian(() => json({}, 404));
    await checkEvidenceLinks([PR, "https://app.asana.com/0/1219477646404725/1219477646404728", "https://linear.app/fernhill/issue/ENG-123/x"], options({ fetch: known.fetchImpl, jira: load }));
    expect(load).not.toHaveBeenCalled();
    const second = `https://${HOST}/browse/ENG-143`;
    const http = atlassian();
    const found = await checkEvidenceLinks([ISSUE, second, "https://drive.example.test/handoff"], options({ fetch: http.fetchImpl, jira: load }));
    expect(found.get(ISSUE)).toEqual({ state: "open" });
    expect(found.get(second)).toEqual({ state: "open" });
    expect(found.get("https://drive.example.test/handoff")).toEqual({ state: "not_checked", reason: NOT_CHECKED_WORDS.host });
    expect(load).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledTimes(1);
    expect(http.calls.map((call) => call.url).sort()).toEqual([REQUEST, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/ENG-143?fields=summary`]);
  });

  it("follows no redirect, and never sends the Jira token to a host that is not public", async () => {
    const moved = atlassian(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    expect((await checkEvidenceLinks([ISSUE], options({ fetch: moved.fetchImpl, jira: async () => connected() }))).get(ISSUE)).toEqual({ state: "not_checked", reason: LINK_WORDS.redirected });
    expect(moved.calls).toHaveLength(1);
    forgetLinkChecks();
    const http = atlassian();
    const found = await checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira: async () => connected(), resolve: async () => [{ address: "10.0.0.5", family: 4 }] }));
    expect(found.get(ISSUE)).toEqual({ state: "not_checked", reason: NOT_CHECKED_WORDS.address });
    expect(http.calls).toHaveLength(0);
  });
});

describe("the connected site, read in the workspace's scope (jiraLinkCheck, JR20)", () => {
  let w: JiraWorld;
  beforeEach(() => {
    w = jiraWorld(hooks);
  });

  it("is the site row the upkeep keeps, with the connection's own token, and asks Jira nothing to find it", async () => {
    w.seedSite();
    const check = await w.run(() => jiraLinkCheck(w.provider));
    expect(check?.site).toEqual(SITE);
    expect(w.jira.calls).toEqual([]);
    expect(await w.run(() => (check as JiraLinkCheck).token())).toBe("jira_access_1");
    expect(check?.pausedUntil()).toBeNull();
    w.pause.until = NOW + 60_000;
    expect(check?.pausedUntil()).toBe(NOW + 60_000);
    expect(w.jira.calls).toEqual([]);
  });

  it("checks a link on the site end to end: Jira's API, with the connection's token, in the workspace's scope", async () => {
    w.seedSite();
    const http = atlassian();
    const found = await w.run(() => checkEvidenceLinks([ISSUE, `https://${HOST}/secure/attachment/10001/handoff.pdf`], options({ fetch: http.fetchImpl, jira: () => jiraLinkCheck(w.provider) })));
    expect(found.get(ISSUE)).toEqual({ state: "open" });
    expect(found.get(`https://${HOST}/secure/attachment/10001/handoff.pdf`)).toEqual({ state: "not_checked", reason: NOT_CHECKED_WORDS.path });
    expect(http.calls.map((call) => [call.url, new Headers(call.init.headers).get("authorization")])).toEqual([[REQUEST, "Bearer jira_access_1"]]);
  });

  it("keeps the site of a connection that must be reconnected, with no token, so its links say so", async () => {
    w.seedSite();
    Object.assign(w.connection(CONN), { status: "needs_reconnect" });
    const check = await w.run(() => jiraLinkCheck(w.provider));
    expect(check?.site).toEqual(SITE);
    expect(await check?.token()).toBeNull();
    const http = atlassian();
    expect((await w.run(() => checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl, jira: () => jiraLinkCheck(w.provider) })))).get(ISSUE)).toEqual({
      state: "not_checked",
      reason: LINK_WORDS.jiraNotConnected,
    });
    expect(http.calls).toHaveLength(0);
  });

  it("is null before the site was saved, once Jira is disconnected, and outside a workspace's scope", async () => {
    expect(await w.run(() => jiraLinkCheck(w.provider))).toBeNull();
    w.seedSite();
    expect(await jiraLinkCheck(w.provider)).toBeNull();
    Object.assign(w.connection(CONN), { status: "revoked", revoked_at: w.iso() });
    expect(await w.run(() => jiraLinkCheck(w.provider))).toBeNull();
    expect(w.jira.calls).toEqual([]);
  });

  it("reads nothing while Jira is off: no site, no database request, and the link not checked (JR1)", async () => {
    w.seedSite();
    vi.stubEnv("JIRA_CLIENT_ID", "");
    vi.stubEnv("JIRA_CLIENT_SECRET", "");
    const before = w.database.requests.length;
    expect(await w.run(() => jiraLinkCheck(null))).toBeNull();
    expect(await w.run(() => jiraLinkCheck())).toBeNull();
    const http = atlassian();
    // The default: in the workspace's scope, the site is read through `jiraLinkCheck`, which answers null while off.
    expect((await w.run(() => checkEvidenceLinks([ISSUE], options({ fetch: http.fetchImpl })))).get(ISSUE)).toEqual({ state: "not_checked", reason: NOT_CHECKED_WORDS.host });
    expect(w.database.requests.length).toBe(before);
    expect(http.calls).toHaveLength(0);
    expect(w.jira.calls).toEqual([]);
  });
});
