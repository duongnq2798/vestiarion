import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncErrorWords } from "@/lib/connectors/status";
import { stateWords } from "@/lib/jira/acceptance";
import { approvesOwnJiraPayout, identitiesOf } from "@/lib/jira/identities";
import { selfAcceptance } from "@/lib/jira/acceptance";
import { acceptLink, liveLinks, milestonesForAcceptance } from "@/lib/jira/links";
import { readLink, type LinkDepth } from "@/lib/jira/reads";
import { siteRef } from "@/lib/jira/sites";
import type { JiraDeliveryEvent } from "@/lib/jira/webhook";
import { jiraContext, recheckJiraBeforeSending, refreshJiraMilestones, rereadForDelivery, syncJiraConnection } from "@/lib/jira/workspace";
import {
  ADMIN,
  CLOUD,
  CONN,
  CRITERIA,
  DOCS,
  ENG,
  ENG_142,
  ENG_143,
  EXPORT,
  FERNHILL,
  jiraWorld,
  MAI_ATLASSIAN,
  NEW_CLOUD,
  NEW_CONN,
  OPS,
  OPS_7,
  ORG,
  ORIGIN,
  OTHER_CONN,
  OTHER_EXPORT,
  OTHER_ORG,
  OWNER,
  OWNER_ATLASSIAN,
  PAYEE_MEMBER,
  sha,
  SITE_URL,
  STATUS,
  type JiraWorld,
  type WorldHooks,
} from "./support/jira-world";

/**
 * Contractor work accepted from Jira, its reads end to end over the real stores
 * (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR8 to JR17, JR19, JR21): what a read of a linked issue
 * does to the link and, through 0149's functions alone, to the milestone; what a signed delivery reads again, in which
 * workspaces; what the sweep reads, and what it spends of Atlassian's shared rate limit; the agent's own reads before it
 * decides and before it sends; and who may accept. The database is an in-memory PostgREST holding 0149's checks; Jira is
 * a fake Atlassian (tests/support/jira-world.ts). The commands that link, accept and unlink are tested with their own
 * chunk: links here are made and accepted through the stores, as those commands do.
 */

const { ledger, usage, hooks } = vi.hoisted(() => ({ ledger: vi.fn(), usage: vi.fn(async () => undefined), hooks: { tokens: null, enter: null } as WorldHooks }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledger }));
vi.mock("@/lib/usage/record", () => ({ recordUsage: usage }));
vi.mock("@/lib/connectors/token-store", async (original) => ({
  ...(await original<typeof import("@/lib/connectors/token-store")>()),
  connectionTokenStore: (_orgId: string, connectionId: string) => hooks.tokens?.(connectionId),
}));
vi.mock("@/lib/dal/scope", async (original) => ({
  ...(await original<typeof import("@/lib/dal/scope")>()),
  withOrg: <T,>(orgId: string, fn: () => Promise<T>) => (hooks.enter ? hooks.enter(orgId, fn) : Promise.reject(new Error("no scope"))),
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CURLY = String.fromCodePoint(0x2019);
const HEX64 = /^[0-9a-f]{64}$/;

const entries = (action: string) => ledger.mock.calls.filter(([, input]) => input.action === action).map(([, input]) => input);

/** The site row as the connect flow's first upkeep leaves it, with a webhook for both projects checked just now. */
function seedFreshSite(w: JiraWorld, connectionId = CONN, orgId = ORG, jql = `project in (${ENG}, ${OPS})`) {
  const id = w.seedWebhook(jql);
  w.seedSite({ webhook_ids: [id], webhook_jql: jql, webhook_expires_at: w.iso(w.clock.now + 30 * 24 * HOUR), webhook_registered_at: w.iso(), webhook_checked_at: w.iso() }, connectionId, orgId);
  return id;
}

/** Check Jira now, as the card's button reads one link: with the workspace's connection, on its site. */
const readNow = (w: JiraWorld, milestoneId: string, orgId = ORG, depth: LinkDepth = "auto") =>
  w.runIn(orgId, async () => {
    const context = await jiraContext(w.provider);
    if ("missing" in context) throw new Error(context.missing);
    if (!context.site) throw new Error("no site");
    const link = (await liveLinks({ milestoneIds: [milestoneId] }))[0];
    const milestone = (await milestonesForAcceptance([milestoneId])).get(milestoneId);
    if (!link || !milestone) throw new Error("no link");
    return readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, { session: context.session, reader: context.provider.reader, site: siteRef(context.site), now: () => w.clock.now }, depth);
  });

/** A person's acceptance, through `accept_jira_issue`, of the deliverables last read. */
const accept = (w: JiraWorld, milestoneId: string, orgId = ORG) =>
  w.runIn(orgId, async () => {
    const link = (await liveLinks({ milestoneIds: [milestoneId] }))[0];
    return acceptLink(link, { by: ADMIN, fingerprint: link.fingerprint ?? "", criteriaSha256: sha(CRITERIA), note: "Checked each criterion against the deliverables." });
  });

async function acceptedExport(w: JiraWorld, orgId = ORG, milestoneId = EXPORT) {
  await w.link(milestoneId, ENG_142, orgId);
  w.done(ENG_142);
  await readNow(w, milestoneId, orgId);
  await accept(w, milestoneId, orgId);
  expect(w.milestone(milestoneId, orgId)).toMatchObject({ status: "verified", verification_method: "jira" });
}

const sweep = (w: JiraWorld, options: { force?: boolean; connectionId?: string } = {}) =>
  w.run(() => syncJiraConnection(options.connectionId ?? CONN, w.provider, { now: () => w.clock.now, origin: ORIGIN, ...(options.force ? { force: true } : {}) }));
/** The requests that read issues: the issue reads, their web links, and the change check. */
const readCalls = (w: JiraWorld) => w.jira.calls.filter((call) => call.startsWith("GET /issue/") || call.startsWith("GET /search/"));
const deliver = (w: JiraWorld, fields: Partial<JiraDeliveryEvent> = {}) =>
  w.platform(() =>
    rereadForDelivery({ event: "jira:issue_updated", webhookIds: [101], issueId: ENG_142, self: { cloudId: CLOUD }, timestamp: w.clock.now, ...fields }, w.provider, { now: () => w.clock.now })
  );

let w: JiraWorld;
beforeEach(() => {
  ledger.mockReset();
  usage.mockClear();
  w = jiraWorld(hooks);
});

describe("reading a linked issue (Jira acceptance JR8 to JR10)", () => {
  it("costs one request while the issue is open, a status read then a full one once it is done, and a full one at once after that", async () => {
    seedFreshSite(w);
    await w.link(EXPORT, ENG_142);
    expect(await readNow(w, EXPORT)).toMatchObject({ kind: "read", plan: { kind: "set", state: "waiting" } });
    expect(w.jira.calls).toEqual(["GET /issue/10042 status"]);
    expect(w.row(EXPORT)).toMatchObject({
      state: "waiting", status_category: "indeterminate", status_name: "In Progress", resolution_name: null, completed: false, completed_at: null,
      deliverables: [], deliverable_fingerprint: null, last_read_at: w.iso(), read_error: null, issue_updated_at: "2026-11-08T10:00:00.000Z",
    });

    w.done(ENG_142);
    w.jira.calls.length = 0;
    expect(await readNow(w, EXPORT)).toMatchObject({ kind: "read", becameReady: true });
    expect(w.jira.calls).toEqual(["GET /issue/10042 status", "GET /issue/10042 full", "GET /issue/10042/remotelink"]);

    // Ready: read in full at once, so a change in what it delivers is seen.
    w.jira.calls.length = 0;
    expect(await readNow(w, EXPORT)).toMatchObject({ kind: "read", becameReady: false, plan: { kind: "set", state: "ready" } });
    expect(w.jira.calls).toEqual(["GET /issue/10042 full", "GET /issue/10042/remotelink"]);
  });

  it("makes a done issue ready for a person, never the milestone verified, with one jira_issue_ready; without criteria it is held until they are written", async () => {
    seedFreshSite(w);
    await w.link(EXPORT, ENG_142);
    await w.link(DOCS, ENG_143);
    const doneAt = w.clock.now - HOUR;
    w.done(ENG_142, doneAt);
    w.done(ENG_143, doneAt);
    await readNow(w, EXPORT);
    await readNow(w, DOCS);
    expect(w.row(EXPORT)).toMatchObject({ state: "ready", held_reason: null, completed: true, completed_at: w.iso(doneAt), status_category: "done", status_name: "Done", resolution_name: "Done" });
    expect(w.row(EXPORT).deliverable_fingerprint).toMatch(HEX64);
    expect(w.row(EXPORT).deliverables).toEqual([{ kind: "link", label: "figma.com/file/AbC123/webhooks", href: "https://www.figma.com/file/AbC123/webhooks", id: "https://www.figma.com/file/AbC123/webhooks" }]);
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false, verification_method: "unverified" });
    expect(entries("jira_issue_ready")).toHaveLength(1);
    expect(entries("jira_issue_ready")[0]).toMatchObject({
      actor: "system",
      domain: "contractor",
      detail: {
        milestoneId: EXPORT, linkId: w.row(EXPORT).id, issueId: ENG_142, identifier: "ENG-142", completedAt: w.iso(doneAt), statusName: "Done", resolutionName: "Done",
        fingerprint: w.row(EXPORT).deliverable_fingerprint, deliverables: 1,
      },
    });
    // The docs have no criteria: held, and ready once a person writes them.
    expect(w.row(DOCS)).toMatchObject({ state: "held", held_reason: "no_criteria" });
    Object.assign(w.milestone(DOCS), { acceptance_criteria: "The export, CSV and PDF, with tests." });
    await readNow(w, DOCS);
    expect(w.row(DOCS)).toMatchObject({ state: "ready", held_reason: null });
    expect(entries("jira_issue_ready")).toHaveLength(2);
  });

  it("holds an issue resolved as Won't Do as canceled, never ready, in Jira's own words, after one status read", async () => {
    seedFreshSite(w);
    await w.link(STATUS, OPS_7);
    w.done(OPS_7, w.clock.now - HOUR, `Won${CURLY}t Do`);
    await readNow(w, STATUS);
    expect(w.row(STATUS)).toMatchObject({ state: "held", held_reason: "canceled", completed: false, completed_at: null, resolution_name: `Won${CURLY}t Do`, status_category: "done" });
    expect(w.jira.calls).toEqual(["GET /issue/10107 status"]);
    expect(entries("jira_issue_ready")).toHaveLength(0);
    expect(stateWords("held", "canceled", false, String(w.row(STATUS).resolution_name)).line).toBe(
      `Jira resolved the issue as Won${CURLY}t Do, which is not done. Nothing is accepted from it: reopen it, or link another issue.`
    );
  });

  it("follows an issue moved to another project: its new key, project and browse link, by the numeric id it keeps", async () => {
    seedFreshSite(w);
    await w.link(EXPORT, ENG_142);
    w.change(ENG_142, { key: "OPS-12", projectId: OPS, projectKey: "OPS" });
    await readNow(w, EXPORT);
    expect(w.row(EXPORT)).toMatchObject({ issue_id: ENG_142, identifier: "OPS-12", project_id: OPS, project_key: "OPS", issue_url: `${SITE_URL}/browse/OPS-12` });
  });

  it("writes a failed read's words on the link and changes nothing else; an issue Jira no longer shows is held", async () => {
    seedFreshSite(w);
    await w.link(EXPORT, ENG_142);
    w.jira.down = true;
    expect(await readNow(w, EXPORT)).toEqual({ kind: "failed", message: "Jira did not answer just now. It is read again within 15 minutes." });
    expect(w.row(EXPORT)).toMatchObject({ state: "waiting", read_error: "Jira did not answer just now. It is read again within 15 minutes.", last_read_at: null });
    w.jira.down = false;
    w.issues.get(CLOUD)?.delete(ENG_142);
    await readNow(w, EXPORT);
    expect(w.row(EXPORT)).toMatchObject({ state: "held", held_reason: "issue_unreachable", read_error: null });
  });
});

describe("an acceptance taken back (JR13)", () => {
  it.each([
    ["reopened", "reopened", (world: JiraWorld): void => world.reopen(ENG_142)],
    [
      "done again at another time",
      "reopened",
      (world: JiraWorld): void => {
        world.reopen(ENG_142, world.clock.now - 10 * MINUTE);
        world.done(ENG_142, world.clock.now - MINUTE);
      },
    ],
    [
      "given a new web link",
      "deliverable_changed",
      (world: JiraWorld): void => {
        world.fakeIssue(ENG_142).remoteLinks.push({ id: 9001, object: { url: "https://github.com/northstar/app/pull/7", title: "PR 7" } });
        world.change(ENG_142, {});
      },
    ],
    ["deleted (404)", "issue_unreachable", (world: JiraWorld): void => void world.issues.get(CLOUD)?.delete(ENG_142)],
  ] as const)("when the issue is %s, before any payment: the milestone goes back to pending", async (_what, reason, move) => {
    seedFreshSite(w);
    await acceptedExport(w);
    const acceptedFingerprint = w.row(EXPORT).accepted_fingerprint;
    const original = w.fakeIssue(ENG_142);
    w.clock.now += MINUTE;
    move(w);
    expect(await readNow(w, EXPORT)).toMatchObject({ kind: "read", held: "held", plan: { kind: "withdraw", reason } });
    expect(w.row(EXPORT)).toMatchObject({ state: "held", held_reason: reason, after_payment: false });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false, verification_status: "unverified" });
    expect(entries("jira_acceptance_withdrawn")).toHaveLength(1);
    expect(entries("jira_acceptance_withdrawn")[0]).toMatchObject({
      actor: "system",
      domain: "contractor",
      summary: expect.stringContaining("before payment. Held for review"),
      detail: { milestoneId: EXPORT, linkId: w.row(EXPORT).id, issueId: ENG_142, identifier: "ENG-142", reason, afterPayment: false, acceptedFingerprint },
    });
    // Held after an acceptance: no read moves it back.
    if (reason === "issue_unreachable") w.issues.get(CLOUD)?.set(ENG_142, original);
    w.done(ENG_142);
    await readNow(w, EXPORT);
    expect(w.row(EXPORT)).toMatchObject({ state: "held", held_reason: reason });
  });

  it("keeps the acceptance while the issue is what was accepted", async () => {
    seedFreshSite(w);
    await acceptedExport(w);
    w.clock.now += HOUR;
    expect(await readNow(w, EXPORT)).toMatchObject({ kind: "read", plan: { kind: "keep" }, held: null });
    expect(w.row(EXPORT)).toMatchObject({ state: "accepted" });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified" });
  });

  it("holds the link alone, as a dispute, when the payment was sent: the milestone is not touched", async () => {
    seedFreshSite(w);
    await acceptedExport(w);
    w.database.rows("payment_intents").push({ id: "intent-1", org_id: ORG, source_type: "milestone", source_id: EXPORT, status: "sent" });
    w.reopen(ENG_142);
    expect(await readNow(w, EXPORT)).toMatchObject({ held: "held_after_payment" });
    expect(w.row(EXPORT)).toMatchObject({ state: "held", held_reason: "reopened", after_payment: true });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified", verified: true });
    expect(entries("jira_acceptance_withdrawn")[0]).toMatchObject({ summary: expect.stringContaining("after its payment was sent"), detail: { afterPayment: true } });
    expect(stateWords("held", "reopened", true).label).toBe("Changed after payment");
  });

  it("waits while a person decides the milestone, and takes the acceptance back once their ten minutes are over", async () => {
    seedFreshSite(w);
    await acceptedExport(w);
    Object.assign(w.milestone(EXPORT), { decision_claimed_at: w.iso() });
    w.reopen(ENG_142);
    expect(await readNow(w, EXPORT)).toMatchObject({ held: "deferred" });
    expect(w.row(EXPORT)).toMatchObject({ state: "accepted", completed: false });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified" });
    expect(entries("jira_acceptance_withdrawn")).toHaveLength(0);
    w.clock.now += 11 * MINUTE;
    expect(await readNow(w, EXPORT)).toMatchObject({ held: "held" });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(entries("jira_acceptance_withdrawn")).toHaveLength(1);
  });

  it("holds the old site's links with no request once another site is connected, and never reads the new site's issue of the same id", async () => {
    seedFreshSite(w);
    await acceptedExport(w);
    w.connectSouthwind();
    w.jira.calls.length = 0;
    expect(await sweep(w, { connectionId: NEW_CONN })).toMatchObject({ outcome: "synced", upkeep: "none" });
    expect(w.jira.calls).toEqual(["GET /accessible-resources"]);
    expect(w.restCalls()).toEqual([]);
    expect(w.row(EXPORT)).toMatchObject({ state: "held", held_reason: "issue_unreachable", cloud_id: CLOUD });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(w.site(NEW_CONN)).toMatchObject({ cloud_id: NEW_CLOUD });
    // Held now: the next sweeps leave it alone, still with no request.
    w.clock.now += 15 * MINUTE;
    await sweep(w, { connectionId: NEW_CONN });
    expect(w.restCalls()).toEqual([]);
    expect(w.jira.calls.some((call) => call.includes(NEW_CLOUD))).toBe(false);
  });
});

describe("a delivery only nudges a read (JR15)", () => {
  it("reads the issue again in every workspace whose webhook it matched, and notes each delivery", async () => {
    w = jiraWorld(hooks, { secondWorkspace: true });
    w.seedSite({ webhook_ids: [101], webhook_jql: "project in (10000)" });
    w.seedSite({ webhook_ids: [202], webhook_jql: "project in (10000)" }, OTHER_CONN, OTHER_ORG);
    await w.link(EXPORT, ENG_142);
    await w.link(OTHER_EXPORT, ENG_142, OTHER_ORG);
    expect(await deliver(w, { webhookIds: [101, 202] })).toBe(2);
    expect(w.issueReads(ENG_142)).toBe(2);
    expect(w.row(EXPORT).last_read_at).toBe(w.iso());
    expect(w.row(OTHER_EXPORT, OTHER_ORG).last_read_at).toBe(w.iso());
    expect(w.site()?.last_delivery_at).toBe(w.iso());
    expect(w.site(OTHER_CONN)?.last_delivery_at).toBe(w.iso());
  });

  it("skips a row whose site the issue's address does not name, and reads one whose address does not parse", async () => {
    w.seedSite({ webhook_ids: [101] });
    await w.link(EXPORT, ENG_142);
    expect(await deliver(w, { self: { host: "ridge.atlassian.net" } })).toBe(0);
    expect(await deliver(w, { self: { cloudId: NEW_CLOUD } })).toBe(0);
    expect(w.issueReads()).toBe(0);
    expect(w.site()?.last_delivery_at).toBeNull();
    w.clock.now += 10 * 1000;
    expect(await deliver(w, { self: { host: "northstar.atlassian.net" } })).toBe(1);
    w.clock.now += 10 * 1000;
    expect(await deliver(w, { self: null })).toBe(1);
    expect(w.issueReads()).toBe(2);
  });

  it("reads nothing for a webhook no row holds, or a connection no longer live", async () => {
    w.seedSite({ webhook_ids: [101] });
    await w.link(EXPORT, ENG_142);
    expect(await deliver(w, { webhookIds: [999] })).toBe(0);
    Object.assign(w.connection(), { status: "needs_reconnect" });
    expect(await deliver(w)).toBe(0);
    expect(w.jira.calls).toEqual([]);
  });

  it("skips a link whose last read started at least 5 s after the delivery was sent: that read saw the change", async () => {
    seedFreshSite(w);
    w.seedSite({ webhook_ids: [101] }, OTHER_CONN, OTHER_ORG);
    w.database.rows("jira_sites")[0].webhook_ids = [101];
    await w.link(EXPORT, ENG_142);
    await readNow(w, EXPORT);
    const readAt = w.clock.now;
    w.clock.now += MINUTE;
    w.jira.calls.length = 0;
    expect(await deliver(w, { timestamp: readAt - 5000 })).toBe(0);
    expect(await deliver(w, { timestamp: readAt - 5001 })).toBe(0);
    expect(w.jira.calls).toEqual([]);
    expect(await deliver(w, { timestamp: readAt - 4999 })).toBe(1);
    // A delivery that does not say when it was sent is read.
    expect(await deliver(w, { timestamp: null })).toBe(1);
  });

  it("reads a comment and the Done that follows it 30 s later both, never leaving the second for the sweep", async () => {
    seedFreshSite(w);
    w.database.rows("jira_sites")[0].webhook_ids = [101];
    await w.link(EXPORT, ENG_142);
    await readNow(w, EXPORT);
    w.clock.now += MINUTE;
    w.fakeIssue(ENG_142).comments.push({ id: "10300", created: w.jiraTime(w.clock.now), body: { type: "doc", version: 1, content: [] } });
    w.change(ENG_142, {});
    const commentSent = w.clock.now;
    w.clock.now += 1000;
    expect(await deliver(w, { event: "comment_created", timestamp: commentSent })).toBe(1);
    w.clock.now = commentSent + 30_000;
    w.done(ENG_142, w.clock.now);
    const doneSent = w.clock.now;
    w.clock.now += 1000;
    expect(await deliver(w, { timestamp: doneSent })).toBe(1);
    expect(w.row(EXPORT)).toMatchObject({ state: "ready" });
    expect(entries("jira_issue_ready")).toHaveLength(1);
  });
});

/** Links as the stores keep them, each to its own milestone and issue, with a last read `minutesAgo` before now. */
function seedLinks(w: JiraWorld, count: number, fields: { status?: string; firstIssue?: number; minutesAgo?: (index: number) => number | null; inJira?: boolean } = {}) {
  const made: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const issueId = String((fields.firstIssue ?? 20000) + index);
    const key = `ENG-${issueId}`;
    const milestoneId = `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const ago = fields.minutesAgo ? fields.minutesAgo(index) : 30;
    w.database.rows("milestones").push({
      id: milestoneId, org_id: ORG, title: `Milestone ${index}`, amount: "100", contractor_id: FERNHILL, status: fields.status ?? "pending", verified: false, verification_method: "unverified",
      verification_status: "unverified", verification_source: null, verification_detail: null, acceptance_criteria: CRITERIA, decision_claimed_at: null, created_at: `2026-10-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
    });
    w.database.rows("jira_issue_links").push({
      id: crypto.randomUUID(), org_id: ORG, milestone_id: milestoneId, connection_id: CONN, cloud_id: CLOUD, issue_id: issueId, identifier: key, project_id: ENG, project_key: "ENG",
      issue_title: `Issue ${index}`, issue_url: `${SITE_URL}/browse/${key}`, state: "waiting", held_reason: null, after_payment: false, held_at: null, status_category: "indeterminate",
      status_name: "In Progress", resolution_name: null, completed: false, completed_at: null, deliverables: [], deliverable_fingerprint: null, attachments_read: 0, remote_links_read: 0,
      comments_read: 0, more_unread: false, issue_updated_at: "2026-11-08T10:00:00.000Z", last_read_at: ago === null ? null : w.iso(w.clock.now - ago * MINUTE), read_error: null,
      accepted_by: null, accepted_at: null, accepted_fingerprint: null, accepted_completed_at: null, accepted_criteria_sha256: null, accepted_deliverables: null, linked_by: ADMIN,
      linked_at: "2026-10-01T00:00:00Z", unlinked_by: null, unlinked_at: null, updated_at: "2026-10-01T00:00:00Z",
    });
    if (fields.inJira !== false) {
      w.issues.get(CLOUD)?.set(issueId, { ...w.fakeIssue(ENG_143), id: issueId, key, title: `Issue ${index}`, updated: "2026-11-08T10:00:00.000+0000" });
    }
    made.push(issueId);
  }
  return made;
}

describe("the sweep (JR16)", () => {
  it("asks once when the issues last changed, then reads only those that changed or are past their floor", async () => {
    seedFreshSite(w);
    await w.link(EXPORT, ENG_142);
    await w.link(DOCS, ENG_143);
    await w.link(STATUS, OPS_7);
    w.done(ENG_142);
    // Never read: every one is read, and no change check is needed for them.
    expect(await sweep(w)).toMatchObject({ outcome: "synced", upkeep: "fresh", summary: { read: 3, failed: 0, ready: 1 } });
    expect(readCalls(w)).toEqual(["GET /issue/10042 status", "GET /issue/10042 full", "GET /issue/10042/remotelink", "GET /issue/10043 status", "GET /issue/10107 status"]);
    expect(usage).toHaveBeenCalledWith({ kind: "connector_sync", action: "jira", provider: "jira", ok: true });
    await accept(w, EXPORT);

    w.clock.now += 15 * MINUTE;
    w.jira.calls.length = 0;
    await sweep(w);
    expect(readCalls(w)).toEqual([`GET /search/jql id in (${ENG_142}, ${ENG_143}, ${OPS_7}) updated`]);

    w.clock.now += MINUTE;
    w.change(ENG_143, { title: "Billing export, CSV and PDF" });
    w.clock.now += 14 * MINUTE;
    w.jira.calls.length = 0;
    await sweep(w);
    expect(readCalls(w)).toEqual([`GET /search/jql id in (${ENG_142}, ${ENG_143}, ${OPS_7}) updated`, "GET /issue/10043 status"]);
    expect(w.row(DOCS)).toMatchObject({ issue_title: "Billing export, CSV and PDF" });

    // An hour since the accepted issue was read: its floor, in full, as web-link edits may not move `updated`.
    w.clock.now += 31 * MINUTE;
    w.jira.calls.length = 0;
    await sweep(w);
    expect(readCalls(w)).toEqual([`GET /search/jql id in (${ENG_142}, ${ENG_143}, ${OPS_7}) updated`, "GET /issue/10042 full", "GET /issue/10042/remotelink"]);
  });

  it("reads every link, oldest read first, at most 20, when Jira refuses the change check, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedFreshSite(w, CONN, ORG, `project in (${ENG})`);
    const ids = seedLinks(w, 25, { minutesAgo: (index) => 100 - index });
    w.jira.searchRefused = true;
    expect(await sweep(w)).toMatchObject({ outcome: "synced", summary: { read: 20 } });
    const read = readCalls(w).filter((call) => call.startsWith("GET /issue/")).map((call) => call.split(" ")[1].replace("/issue/", ""));
    expect(read).toEqual(ids.slice(0, 20));
    expect(readCalls(w).filter((call) => call.startsWith("GET /search/"))).toHaveLength(1);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("change check was refused"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("is not starved by the links of paid milestones, which stay live as history", async () => {
    seedFreshSite(w, CONN, ORG, `project in (${ENG})`);
    seedLinks(w, 120, { status: "paid", firstIssue: 30000, minutesAgo: () => null, inJira: false });
    await w.link(EXPORT, ENG_142);
    expect(await sweep(w)).toMatchObject({ outcome: "synced", summary: { read: 1 } });
    expect(readCalls(w)).toEqual(["GET /issue/10042 status"]);
  });

  it.each([
    ["30 s old", 30_000, false, false],
    ["3 minutes old, with no delivery since", 3 * MINUTE, false, true],
    ["3 minutes old, with a delivery since", 3 * MINUTE, true, false],
  ] as const)("notes a change no delivery told of only when it is at least 2 minutes old: one %s", async (_what, age, delivered, noted) => {
    seedFreshSite(w, CONN, ORG, `project in (${ENG})`);
    await w.link(EXPORT, ENG_142);
    await sweep(w);
    w.clock.now += 15 * MINUTE;
    const changedAt = w.clock.now - age;
    w.change(ENG_142, { title: "Webhook retries with backoff, v2" }, changedAt);
    if (delivered) Object.assign(w.site() ?? {}, { last_delivery_at: w.iso(changedAt + 10_000) });
    await sweep(w);
    expect(w.row(EXPORT)).toMatchObject({ issue_title: "Webhook retries with backoff, v2" });
    expect(w.site()?.missed_change_at ?? null).toBe(noted ? w.iso() : null);
  });

  it("asks nothing while Atlassian's shared limit is spent, and runs again when the pause ends", async () => {
    seedFreshSite(w, CONN, ORG, `project in (${ENG})`);
    await w.link(EXPORT, ENG_142);
    w.pause.until = w.clock.now + 2 * MINUTE;
    expect(await sweep(w)).toMatchObject({ outcome: "rate_limited" });
    expect(w.jira.calls).toEqual([]);
    expect(w.connection()).toMatchObject({ next_sync_after: w.iso(w.pause.until), failures: 1 });
    expect(String(w.connection().last_error)).toMatch(/^Jira asked Vestiarion to slow down\. Syncing again at /);
  });

  it("reads nothing when the limit is spent during the webhook upkeep", async () => {
    seedFreshSite(w);
    await w.link(EXPORT, ENG_142);
    w.jira.quotaSpent = true;
    // The links are all in ENG now, so the upkeep registers a webhook for ENG alone, and Atlassian refuses it.
    expect(await sweep(w)).toMatchObject({ outcome: "rate_limited" });
    expect(w.restCalls()).toEqual(["POST /webhook"]);
    expect(w.row(EXPORT).last_read_at).toBeNull();
    expect(w.connection()).toMatchObject({ next_sync_after: w.iso(w.clock.now + 120_000) });
  });

  it("stops reading the moment Atlassian says its shared limit is spent, and waits for the pause's end", async () => {
    seedFreshSite(w, CONN, ORG, `project in (${ENG})`);
    await w.link(EXPORT, ENG_142);
    await w.link(DOCS, ENG_143);
    w.jira.quotaSpent = true;
    expect(await sweep(w)).toMatchObject({ outcome: "rate_limited" });
    expect(w.restCalls()).toEqual(["GET /issue/10042 status"]);
    expect(w.pause.until).toBe(w.clock.now + 120_000);
    expect(w.connection()).toMatchObject({ next_sync_after: w.iso(w.clock.now + 120_000) });
    expect(w.row(EXPORT).read_error).toBe("Jira asked Vestiarion to slow down. It is read again within 15 minutes.");
    expect(w.row(DOCS).read_error).toBeNull();
  });

  it("marks a connection whose grant Atlassian refuses to reconnect, in the 90-day words", async () => {
    seedFreshSite(w, CONN, ORG, `project in (${ENG})`);
    await w.link(EXPORT, ENG_142);
    w.revokeAtAtlassian();
    expect(await sweep(w)).toMatchObject({ outcome: "reconnect" });
    expect(w.jira.calls).toContain("POST /oauth/token");
    expect(w.connection()).toMatchObject({ status: "needs_reconnect", last_error: syncErrorWords("reconnect", "Jira", null) });
    expect(String(w.connection().last_error)).toContain("or it went unused for 90 days");
  });
});

describe("the agent's own reads (JR16)", () => {
  it("reads each accepted issue of a milestone verified by Jira in full before the cycle decides, and takes back one reopened", async () => {
    seedFreshSite(w);
    await acceptedExport(w);
    w.reopen(ENG_142);
    w.jira.calls.length = 0;
    expect(await w.run(() => refreshJiraMilestones(w.provider))).toMatchObject({ checked: 1, read: 1, withdrawn: 1 });
    expect(w.jira.calls[0]).toBe("GET /issue/10042 full");
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
  });

  it("reads the releases' accepted issues right before sending, and says when that could not be done", async () => {
    seedFreshSite(w);
    await acceptedExport(w);
    expect(await w.run(() => recheckJiraBeforeSending([EXPORT], w.provider))).toMatchObject({ checked: 1, read: 1, complete: true });

    w.pause.until = w.clock.now + MINUTE;
    w.jira.calls.length = 0;
    expect(await w.run(() => recheckJiraBeforeSending([EXPORT], w.provider))).toMatchObject({ checked: 1, read: 0, complete: false });
    expect(w.jira.calls).toEqual([]);
    w.pause.until = 0;

    w.jira.down = true;
    expect(await w.run(() => recheckJiraBeforeSending([EXPORT], w.provider))).toMatchObject({ checked: 1, failed: 1, complete: false });
    expect(w.row(EXPORT)).toMatchObject({ state: "accepted" });
    expect(await w.run(() => recheckJiraBeforeSending([], w.provider))).toMatchObject({ checked: 0, complete: true });
  });

  it("never throws, Jira off or not connected", async () => {
    expect(await w.run(() => refreshJiraMilestones(null))).toMatchObject({ checked: 0 });
    Object.assign(w.connection(), { status: "revoked" });
    expect(await w.run(() => refreshJiraMilestones(w.provider))).toMatchObject({ checked: 0 });
  });
});

describe("who may accept (JR12)", () => {
  const identities = (world: JiraWorld, userId: string) =>
    world.run(async () => {
      const context = await jiraContext(world.provider);
      if ("missing" in context) throw new Error(context.missing);
      return identitiesOf({ orgId: ORG, userId }, { contractorId: FERNHILL }, context);
    });

  it("refuses the payee by their email in Vestiarion", async () => {
    seedFreshSite(w);
    expect(selfAcceptance(await identities(w, PAYEE_MEMBER))).toBe("payee_member");
  });

  it("refuses a member whose Atlassian account, found by their email, is the payee's", async () => {
    seedFreshSite(w);
    w.jira.accounts.set("admin@business.example", [MAI_ATLASSIAN]);
    expect(await identities(w, ADMIN)).toMatchObject({ payeeJiraIds: [MAI_ATLASSIAN], memberJiraIds: [MAI_ATLASSIAN] });
    expect(selfAcceptance(await identities(w, ADMIN))).toBe("payee_jira");
    expect(w.jira.calls).not.toContain("GET /myself");
    w.jira.accounts.delete("admin@business.example");
    expect(selfAcceptance(await identities(w, ADMIN))).toBeNull();
  });

  it("refuses the person who connected Jira when their own account, /myself, is the payee's", async () => {
    w = jiraWorld(hooks, { ownerAtlassianIsPayee: true });
    seedFreshSite(w);
    const found = await identities(w, OWNER);
    expect(found).toMatchObject({ payeeJiraIds: [OWNER_ATLASSIAN], memberJiraIds: [OWNER_ATLASSIAN] });
    expect(selfAcceptance(found)).toBe("payee_jira");
    expect(w.jira.calls).toContain("GET /myself");
    // The member's own email is not looked up when /myself answers for them.
    expect(w.jira.people).toEqual(["mai@fernhill.example"]);
  });

  it("asks Jira nothing without the payee's email, and checks a payout by email alone", async () => {
    w = jiraWorld(hooks, { payeeEmail: null });
    seedFreshSite(w);
    expect(selfAcceptance(await identities(w, ADMIN))).toBeNull();
    expect(w.jira.calls).toEqual([]);

    w = jiraWorld(hooks);
    seedFreshSite(w);
    await w.link(EXPORT, ENG_142);
    expect(await w.run(() => approvesOwnJiraPayout({ orgId: ORG, userId: PAYEE_MEMBER }, EXPORT))).toBe(true);
    expect(await w.run(() => approvesOwnJiraPayout({ orgId: ORG, userId: ADMIN }, EXPORT))).toBe(false);
    expect(await w.run(() => approvesOwnJiraPayout({ orgId: ORG, userId: PAYEE_MEMBER }, DOCS))).toBe(false);
    expect(w.jira.calls).toEqual([]);
  });
});

describe("what is kept, and what is written (JR18, JR19)", () => {
  it("keeps no Atlassian account, completer or assignee anywhere, and writes a milestone only through 0149's functions", async () => {
    seedFreshSite(w);
    w.jira.accounts.set("admin@business.example", [MAI_ATLASSIAN]);
    await acceptedExport(w);
    await w.run(async () => {
      const context = await jiraContext(w.provider);
      if ("missing" in context) throw new Error(context.missing);
      return identitiesOf({ orgId: ORG, userId: ADMIN }, { contractorId: FERNHILL }, context);
    });
    w.reopen(ENG_142);
    await readNow(w, EXPORT);
    const kept = JSON.stringify([w.database.tables, w.database.requests.map((request) => request.body), w.jira.bodies, ledger.mock.calls]);
    for (const word of [OWNER_ATLASSIAN, MAI_ATLASSIAN, "accountId", "completed_by", "assignee"]) expect(kept).not.toContain(word);
    expect(w.database.requests.filter((request) => request.path === "/rest/v1/milestones" && request.method !== "GET")).toEqual([]);
    expect(w.database.requests.filter((request) => request.path.startsWith("/rest/v1/rpc/")).map((request) => request.path)).toEqual(
      expect.arrayContaining(["/rest/v1/rpc/accept_jira_issue", "/rest/v1/rpc/hold_jira_acceptance"])
    );
  });
});
