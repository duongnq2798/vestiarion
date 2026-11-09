import { beforeEach, describe, expect, it, vi } from "vitest";
import { JIRA_EVENTS, cleanOrphans, ensureJiraSite, ensureJiraWebhook, JiraSiteGoneError, stopJiraWebhooks, type JiraUpkeepContext } from "@/lib/jira/webhooks";
import { jiraSession } from "@/lib/jira/session";
import { clearSite, markMissing, saveSite, setWebhooks, siteFor, sitesForWebhooks, touchDelivery } from "@/lib/jira/sites";
import { syncJiraConnection } from "@/lib/jira/workspace";
import { CLOUD, CONN, DOCS, ENG, ENG_142, ENG_143, EXPORT, jiraWorld, OPS, OPS_7, ORG, ORIGIN, OTHER_CONN, OTHER_ORG, SITE_URL, STATUS, WEBHOOK_URL, type JiraWorld, type WorldHooks } from "./support/jira-world";

/**
 * The one webhook a Jira connection keeps on its site, and the site row that holds it
 * (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR3, JR4, JR14, JR15): registered for the projects of the
 * open links, renewed before Jira lets it lapse, rotated when renewing does not help, deleted when no open link is left,
 * and the daily keep-alive that goes with it. Over a fake Atlassian and an in-memory platform table holding 0149's checks.
 */

const { hooks } = vi.hoisted(() => ({ hooks: { tokens: null, enter: null } as WorldHooks }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: vi.fn() }));
vi.mock("@/lib/usage/record", () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/connectors/token-store", async (original) => ({
  ...(await original<typeof import("@/lib/connectors/token-store")>()),
  connectionTokenStore: (_orgId: string, connectionId: string) => hooks.tokens?.(connectionId),
}));
vi.mock("@/lib/dal/scope", async (original) => ({
  ...(await original<typeof import("@/lib/dal/scope")>()),
  withOrg: <T,>(orgId: string, fn: () => Promise<T>) => (hooks.enter ? hooks.enter(orgId, fn) : Promise.reject(new Error("no scope"))),
}));

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const upkeepCtx = (w: JiraWorld, connectionId = CONN, orgId = ORG): JiraUpkeepContext => ({
  connection: { id: connectionId, orgId, externalOrgId: CLOUD, externalOrgName: "Northstar" },
  provider: w.provider,
  session: jiraSession({ provider: w.provider, tokens: (hooks.tokens as NonNullable<WorldHooks["tokens"]>)(connectionId), now: () => w.clock.now }),
});
const ensure = (w: JiraWorld, options: { force?: boolean; origin?: string } = {}) =>
  w.run(() => ensureJiraWebhook(upkeepCtx(w), { now: () => w.clock.now, origin: ORIGIN, ...options }));
const sweep = (w: JiraWorld, options: { force?: boolean } = {}) => w.run(() => syncJiraConnection(CONN, w.provider, { now: () => w.clock.now, origin: ORIGIN, ...options }));
const hooksAt = (w: JiraWorld, cloud = CLOUD) => [...(w.webhooks.get(cloud)?.values() ?? [])];
const registrations = (w: JiraWorld) => w.jira.bodies.filter((one) => one.call === "POST /webhook").map((one) => one.body);

let w: JiraWorld;
beforeEach(() => {
  w = jiraWorld(hooks);
});

describe("the webhook's registration (JR14)", () => {
  it("names the five events, this deployment's address and the open links' projects, each once, in order", async () => {
    await w.link(STATUS, OPS_7);
    await w.link(EXPORT, ENG_142);
    await w.link(DOCS, ENG_143);
    const upkeep = await ensure(w);
    expect(upkeep.outcome).toBe("registered");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "POST /webhook"]);
    expect(registrations(w)).toEqual([{ url: WEBHOOK_URL, webhooks: [{ events: [...JIRA_EVENTS], jqlFilter: `project in (${ENG}, ${OPS})` }] }]);
    expect(JIRA_EVENTS).toEqual(["jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"]);
    // No field filter: a new file or a comment must arrive.
    expect(JSON.stringify(registrations(w))).not.toMatch(/fieldIdsFilter|issuePropertyKeysFilter/);
    const [hook] = hooksAt(w);
    expect(w.site()).toMatchObject({
      org_id: ORG,
      cloud_id: CLOUD,
      site_url: SITE_URL,
      webhook_ids: [hook.id],
      webhook_jql: "project in (10000, 10001)",
      webhook_expires_at: w.iso(w.clock.now + 30 * DAY),
      webhook_registered_at: w.iso(),
      webhook_checked_at: w.iso(),
      webhook_error: null,
    });
  });

  it("makes no webhook without an open link, and deletes the one there was when the last open link goes", async () => {
    expect((await ensure(w)).outcome).toBe("none");
    expect(w.jira.calls).toEqual(["GET /accessible-resources"]);
    expect(hooksAt(w)).toEqual([]);

    await w.link(EXPORT, ENG_142);
    expect((await ensure(w)).outcome).toBe("registered");
    const [hook] = hooksAt(w);
    // The milestone was paid: its link stays, as history, but it is not open.
    Object.assign(w.milestone(EXPORT), { status: "paid" });
    w.jira.calls.length = 0;
    expect((await ensure(w)).outcome).toBe("removed");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "DELETE /webhook"]);
    expect(hooksAt(w)).toEqual([]);
    expect(w.site()).toMatchObject({ webhook_ids: [], webhook_jql: null, retired_webhook_ids: [hook.id], retired_until: w.iso(w.clock.now + 2 * HOUR) });
  });

  it("registers a new webhook when a new project is linked, and retires the old one: still routed for two hours, not after", async () => {
    await w.link(EXPORT, ENG_142);
    await ensure(w);
    const [first] = hooksAt(w);
    w.clock.now += 60_000;
    await w.link(STATUS, OPS_7);
    // The filter wanted changed: no 24 hours wait, and no force, is needed.
    expect((await ensure(w)).outcome).toBe("registered");
    const [second] = hooksAt(w);
    expect(second.id).not.toBe(first.id);
    expect(second.jqlFilter).toBe("project in (10000, 10001)");
    expect(w.site()).toMatchObject({ webhook_ids: [second.id], retired_webhook_ids: [first.id], retired_until: w.iso(w.clock.now + 2 * HOUR) });
    const retiredAt = w.clock.now;
    const routed = (at: number) => w.platform(async () => (await sitesForWebhooks([first.id], w.iso(at))).map((site) => site.connectionId));
    expect(await routed(retiredAt + 2 * HOUR - 1000)).toEqual([CONN]);
    expect(await routed(retiredAt + 2 * HOUR + 1000)).toEqual([]);
    expect(await w.platform(async () => (await sitesForWebhooks([second.id], w.iso(retiredAt + 3 * HOUR))).map((site) => site.connectionId))).toEqual([CONN]);
  });

  it("does nothing within the day while the filter is the one wanted and the webhook is far from lapsing", async () => {
    await w.link(EXPORT, ENG_142);
    await ensure(w);
    w.jira.calls.length = 0;
    w.clock.now += 23 * HOUR;
    expect((await ensure(w)).outcome).toBe("fresh");
    expect(w.jira.calls).toEqual([]);
    // Forced, as on Check linked issues now: Jira's list is the truth.
    expect((await ensure(w, { force: true })).outcome).toBe("present");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "GET /webhook"]);
  });
});

describe("renewing (JR14)", () => {
  it("renews by /webhook/refresh, then by PUT /webhook on a 404 or 405, and rotates when neither gives a later expiry", async () => {
    await w.link(EXPORT, ENG_142);
    await ensure(w);
    const [first] = hooksAt(w);

    // Six days from lapsing: renewed as the REST reference says.
    w.clock.now += 24 * DAY;
    w.jira.calls.length = 0;
    expect((await ensure(w)).outcome).toBe("renewed");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "GET /webhook", "PUT /webhook/refresh"]);
    expect(w.jira.bodies.at(-1)).toEqual({ call: "PUT /webhook/refresh", body: { webhookIds: [first.id] } });
    expect(w.site()).toMatchObject({ webhook_ids: [first.id], webhook_expires_at: w.iso(w.clock.now + 30 * DAY) });

    // The refresh path is not there: renewed as the guide says.
    for (const missing of [405, 404] as const) {
      w.clock.now += 24 * DAY;
      w.jira.refreshAnswer = missing;
      w.jira.calls.length = 0;
      expect((await ensure(w)).outcome).toBe("renewed");
      expect(w.jira.calls).toEqual(["GET /accessible-resources", "GET /webhook", "PUT /webhook/refresh", "PUT /webhook"]);
      expect(w.site()).toMatchObject({ webhook_ids: [first.id], webhook_expires_at: w.iso(w.clock.now + 30 * DAY) });
    }

    // Neither renews it: a new webhook takes over, and the old one is retired and deleted.
    w.clock.now += 24 * DAY;
    w.jira.guideAnswer = 404;
    w.jira.calls.length = 0;
    expect((await ensure(w)).outcome).toBe("registered");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "GET /webhook", "PUT /webhook/refresh", "PUT /webhook", "POST /webhook", "DELETE /webhook"]);
    const [second] = hooksAt(w);
    expect(hooksAt(w)).toHaveLength(1);
    expect(second.id).not.toBe(first.id);
    expect(w.site()).toMatchObject({ webhook_ids: [second.id], retired_webhook_ids: [first.id] });
  });

  it("rotates when renewing answers an expiry within the week", async () => {
    await w.link(EXPORT, ENG_142);
    await ensure(w);
    const [first] = hooksAt(w);
    w.clock.now += 25 * DAY;
    w.jira.refreshAnswer = "short";
    expect((await ensure(w)).outcome).toBe("registered");
    expect(hooksAt(w).map((hook) => hook.id)).not.toContain(first.id);
  });

  it("takes the expiry as 30 days after registration when Jira's list does not say it", async () => {
    await w.link(EXPORT, ENG_142);
    await ensure(w);
    for (const hook of hooksAt(w)) (hook as { expirationDate: unknown }).expirationDate = null;
    w.clock.now += 2 * DAY;
    expect((await ensure(w)).outcome).toBe("present");
    expect(w.site()).toMatchObject({ webhook_expires_at: w.iso(w.clock.now - 2 * DAY + 30 * DAY) });
  });

  it("registers again when Jira's list no longer has the webhook", async () => {
    await w.link(EXPORT, ENG_142);
    await ensure(w);
    const [first] = hooksAt(w);
    w.webhooks.get(CLOUD)?.delete(first.id);
    w.clock.now += 25 * HOUR;
    w.jira.calls.length = 0;
    expect((await ensure(w)).outcome).toBe("registered");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "GET /webhook", "POST /webhook", "DELETE /webhook"]);
    expect(w.site()?.webhook_ids).toEqual([hooksAt(w)[0].id]);
  });
});

describe("a registration Jira refuses (JR14, JR22)", () => {
  it("cleans orphans once and tries once more, then keeps Jira's words on the row, and the sweep goes on", async () => {
    await w.link(EXPORT, ENG_142);
    w.jira.refuseRegistrations = 2;
    expect((await ensure(w)).outcome).toBe("refused");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "POST /webhook", "GET /webhook", "POST /webhook"]);
    expect(w.site()).toMatchObject({ webhook_ids: [], webhook_error: "The app already has the most webhooks allowed for this user." });

    // The sweep tries again, and reads the links whatever Jira said of the webhook.
    w.jira.refuseRegistrations = 2;
    w.clock.now += 15 * 60_000;
    w.jira.calls.length = 0;
    const run = await sweep(w);
    expect(run).toMatchObject({ outcome: "synced", upkeep: "refused" });
    expect(w.issueReads(ENG_142)).toBe(1);
    expect(w.connection()).toMatchObject({ status: "connected", last_error: null });

    // Taken at last: the words go.
    w.clock.now += 15 * 60_000;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "registered" });
    expect(w.site()).toMatchObject({ webhook_error: null, webhook_ids: [hooksAt(w)[0].id] });
  });

  it("makes no webhook from a deployment Jira cannot reach", async () => {
    await w.link(EXPORT, ENG_142);
    expect((await ensure(w, { origin: "http://localhost:3000" })).outcome).toBe("skipped");
    expect(w.jira.calls).toEqual(["GET /accessible-resources"]);
    expect(hooksAt(w)).toEqual([]);
  });
});

describe("orphans (JR14)", () => {
  it("deletes the app's webhooks no row holds, and keeps one another workspace holds, current or retired, or one to another address", async () => {
    w = jiraWorld(hooks, { secondWorkspace: true });
    const held = w.seedWebhook("project in (10000)");
    const retired = w.seedWebhook("project in (10001)");
    const orphan = w.seedWebhook("project in (10000)");
    const elsewhere = w.seedWebhook("project in (10000)", { url: "https://staging.vestiarion.example/api/integrations/jira/webhook" });
    w.seedSite({ webhook_ids: [held], retired_webhook_ids: [retired], retired_until: w.iso(w.clock.now + HOUR) }, OTHER_CONN, OTHER_ORG);
    w.seedSite();
    expect(await w.run(() => cleanOrphans(upkeepCtx(w), { cloudId: CLOUD }, WEBHOOK_URL, w.clock.now))).toBe(1);
    expect(hooksAt(w).map((hook) => hook.id).sort()).toEqual([held, retired, elsewhere].sort());
    expect(w.jira.bodies.find((one) => one.call === "DELETE /webhook")?.body).toEqual({ webhookIds: [orphan] });
  });

  it("are cleaned by the connect flow's first upkeep, which saves the site row and makes the webhook only when links exist", async () => {
    const orphan = w.seedWebhook("project in (10000)");
    const connection = { id: CONN, orgId: ORG, externalOrgId: CLOUD, externalOrgName: "Northstar" };
    expect((await w.run(() => ensureJiraSite(connection, w.provider, { now: () => w.clock.now, origin: ORIGIN }))).outcome).toBe("none");
    expect(w.site()).toMatchObject({ cloud_id: CLOUD, site_url: SITE_URL, webhook_ids: [] });
    // No link yet: no webhook is made, so the orphan stays for the first registration to clean.
    expect(hooksAt(w).map((hook) => hook.id)).toEqual([orphan]);

    await w.link(EXPORT, ENG_142);
    w.jira.calls.length = 0;
    expect((await w.run(() => ensureJiraSite(connection, w.provider, { now: () => w.clock.now, origin: ORIGIN }))).outcome).toBe("registered");
    expect(w.jira.calls).toEqual(["GET /accessible-resources", "GET /webhook", "DELETE /webhook", "POST /webhook"]);
    expect(hooksAt(w).map((hook) => hook.id)).not.toContain(orphan);
    expect(hooksAt(w)).toHaveLength(1);
  });
});

describe("the daily keep-alive and the site (JR3)", () => {
  it("runs with no link at all, which keeps the grant alive, and not again within 24 hours", async () => {
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "none" });
    expect(w.jira.calls).toEqual(["GET /accessible-resources"]);
    w.jira.calls.length = 0;
    for (let at = 0; at < 4; at += 1) {
      w.clock.now += 15 * 60_000;
      expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "fresh" });
    }
    expect(w.jira.calls).toEqual([]);
    w.clock.now += 24 * HOUR;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "none" });
    expect(w.jira.calls).toEqual(["GET /accessible-resources"]);
  });

  it("follows a renamed site's address", async () => {
    await ensure(w);
    w.sites[0].url = "https://northstar-labs.atlassian.net";
    await ensure(w, { force: true });
    expect(w.site()).toMatchObject({ cloud_id: CLOUD, site_url: "https://northstar-labs.atlassian.net" });
  });

  it("marks a site Atlassian no longer lists, clears the mark when it is back, and needs a reconnect on a second miss 10 minutes later", async () => {
    await ensure(w);
    const northstar = w.sites.splice(0, 1);
    w.clock.now += 25 * HOUR;
    const first = w.clock.now;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "site_missing" });
    expect(w.site()?.site_missing_at).toBe(w.iso(first));
    // A mark is looked at again on the next sweep, measured from the first miss.
    w.clock.now += 5 * 60_000;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "site_missing" });
    expect(w.site()?.site_missing_at).toBe(w.iso(first));
    // Back: the mark goes.
    w.sites.push(...northstar);
    w.clock.now += 60_000;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "none" });
    expect(w.site()?.site_missing_at).toBeNull();

    // Gone again: seen by the next day's check, then a second miss 10 minutes after it.
    w.sites.splice(0, 1);
    w.clock.now += 15 * 60_000;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "fresh" });
    w.clock.now += 25 * HOUR;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "site_missing" });
    w.clock.now += 10 * 60_000;
    expect(await sweep(w)).toMatchObject({ outcome: "reconnect" });
    expect(w.connection()).toMatchObject({
      status: "needs_reconnect",
      last_error: "Jira no longer shows Vestiarion the Northstar site: the site was removed, or the person who connected Jira lost access to it. Reconnect Jira.",
    });
  });

  it("throws the site-gone words, final, from the upkeep itself on the second miss", async () => {
    await ensure(w);
    w.sites.splice(0, 1);
    await ensure(w, { force: true });
    w.clock.now += 10 * 60_000;
    const error = await ensure(w, { force: true }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JiraSiteGoneError);
    expect(error).toMatchObject({ final: true, siteName: "Northstar" });
  });
});

describe("the site row (JR5, JR15)", () => {
  it("is reached only in its own workspace's scope, but by the webhook route's lookup", async () => {
    w.seedSite();
    for (const call of [
      async (): Promise<unknown> => siteFor(ORG, CONN),
      () => saveSite(ORG, { connectionId: CONN, cloudId: CLOUD, siteUrl: SITE_URL }, w.iso()),
      () => setWebhooks(ORG, CONN, { webhookIds: [], jql: null, expiresAt: null, registeredAt: null, error: null }, w.iso()),
      () => markMissing(ORG, CONN, w.iso()),
      () => clearSite(ORG, CONN),
    ]) {
      await expect(w.runIn(OTHER_ORG, call)).rejects.toThrow("A Jira site is reached only in its own workspace's scope");
    }
    expect(w.site()).toBeDefined();
    expect(await w.run(() => siteFor(ORG, CONN))).toMatchObject({ connectionId: CONN, orgId: ORG, cloudId: CLOUD, siteUrl: SITE_URL });
  });

  it("is found by a delivery's webhook ids, current or retired within two hours, at most 20 rows, and notes the delivery", async () => {
    w = jiraWorld(hooks, { secondWorkspace: true });
    w.seedSite({ webhook_ids: [101] });
    w.seedSite({ webhook_ids: [102], retired_webhook_ids: [90], retired_until: w.iso(w.clock.now + HOUR) }, OTHER_CONN, OTHER_ORG);
    const found = (ids: number[], at = w.clock.now) => w.platform(async () => (await sitesForWebhooks(ids, w.iso(at))).map((site) => site.connectionId).sort());
    expect(await found([101])).toEqual([CONN]);
    expect(await found([101, 102])).toEqual([CONN, OTHER_CONN].sort());
    expect(await found([90])).toEqual([OTHER_CONN]);
    expect(await found([90], w.clock.now + 2 * HOUR)).toEqual([]);
    expect(await found([7])).toEqual([]);
    expect(await found([])).toEqual([]);

    await w.platform(() => touchDelivery([CONN], w.iso()));
    expect(w.site()?.last_delivery_at).toBe(w.iso());
    expect(w.site(OTHER_CONN)?.last_delivery_at).toBeNull();

    for (let at = 0; at < 22; at += 1) w.seedSite({ connection_id: `eeeeeeee-0000-4000-8000-0000000000${String(at).padStart(2, "0")}`, webhook_ids: [500] });
    expect(await found([500])).toHaveLength(20);
  });

  it("holds 0149's checks: at most five ids, and a site's address and cloudId as Atlassian writes them", async () => {
    w.seedSite();
    await expect(w.run(() => setWebhooks(ORG, CONN, { webhookIds: [1, 2, 3, 4, 5, 6], jql: "project in (10000)", expiresAt: null, registeredAt: null, error: null }, w.iso()))).resolves.toBeUndefined();
    // Kept to five by the store before Postgres would refuse a sixth.
    expect(w.site()?.webhook_ids).toEqual([1, 2, 3, 4, 5]);
    await expect(w.run(() => saveSite(ORG, { connectionId: CONN, cloudId: "not-a-cloud", siteUrl: SITE_URL }, w.iso()))).rejects.toThrow(/jira_sites_cloud_id_check/);
    await expect(w.run(() => saveSite(ORG, { connectionId: CONN, cloudId: CLOUD, siteUrl: "https://northstar.atlassian.net/jira" }, w.iso()))).rejects.toThrow(/jira_sites_site_url_check/);
  });
});

describe("disconnecting (JR4)", () => {
  it("deletes the webhooks at Jira, current and retired, then the site row", async () => {
    const current = w.seedWebhook("project in (10000)");
    w.seedSite({ webhook_ids: [current], retired_webhook_ids: [77], retired_until: w.iso(w.clock.now + HOUR) });
    expect(await w.run(() => stopJiraWebhooks(upkeepCtx(w)))).toEqual({ deleted: true });
    expect(w.jira.bodies.find((one) => one.call === "DELETE /webhook")?.body).toEqual({ webhookIds: [current, 77] });
    expect(hooksAt(w)).toEqual([]);
    expect(w.site()).toBeUndefined();
  });

  it("deletes the row anyway when the token no longer works, and says the webhook was not deleted", async () => {
    const current = w.seedWebhook("project in (10000)");
    w.seedSite({ webhook_ids: [current] });
    w.revokeAtAtlassian();
    expect(await w.run(() => stopJiraWebhooks(upkeepCtx(w)))).toEqual({ deleted: false });
    expect(w.site()).toBeUndefined();
    expect(hooksAt(w).map((hook) => hook.id)).toEqual([current]);
  });

  it("deletes nothing at Jira when there is no webhook, or no row", async () => {
    expect(await w.run(() => stopJiraWebhooks(upkeepCtx(w)))).toEqual({ deleted: true });
    w.seedSite();
    expect(await w.run(() => stopJiraWebhooks(upkeepCtx(w)))).toEqual({ deleted: true });
    expect(w.jira.calls).toEqual([]);
  });
});
