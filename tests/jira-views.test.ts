import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Connection } from "@/lib/connectors/connections";
import type { IssueLink } from "@/lib/jira/links";
import { jiraPanelFor } from "@/lib/jira/panel";
import type { StoredSite } from "@/lib/jira/sites";
import { criteriaHash, jiraMilestoneView, jiraNeedsPerson, jiraPanelView, noticeLine } from "@/lib/jira/views";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * What the Contractors card and the Settings card are given of Jira (docs/superpowers/specs/2026-11-09-jira-acceptance-
 * design.md JR11, JR19, JR21, JR22): words, links and the hashes the acceptance is held to, built on the server, never a
 * token, an Atlassian account or an email; whether Jira's notices arrive, in one line; the figures count Jira's
 * acceptances only.
 */

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1c01";
const CLOUD = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const CRITERIA = "The billing export screen, CSV and PDF.";

const link = (fields: Partial<IssueLink> = {}): IssueLink => ({
  id: "link-1", milestoneId: "m-1", connectionId: "conn-jira", cloudId: CLOUD, issueId: "10123", identifier: "ENG-123", projectId: "10000", projectKey: "ENG",
  issueTitle: "Billing export", issueUrl: "https://fernhill.atlassian.net/browse/ENG-123", state: "ready", heldReason: null, afterPayment: false, heldAt: null,
  statusCategory: "done", statusName: "Done", resolutionName: "Done", completed: true, completedAt: "2026-11-09T08:30:00.000Z",
  deliverables: [
    { kind: "attachment", id: "file:10042", label: "export-spec.pdf", href: "https://fernhill.atlassian.net/secure/attachment/10042/export-spec.pdf", version: "2026-11-09T08:00:00.000Z" },
    { kind: "attachment", id: "remotelink:10007", label: "PR #42", href: "https://github.com/fernhill/app/pull/42", version: "https://github.com/fernhill/app/pull/42" },
    { kind: "comment_link", id: "https://docs.fernhill.example/export", label: "docs.fernhill.example/export", href: "https://docs.fernhill.example/export" },
  ],
  fingerprint: "f".repeat(64), attachmentsRead: 1, remoteLinksRead: 1, commentsRead: 2, moreUnread: false, issueUpdatedAt: "2026-11-09T08:30:00.000Z", lastReadAt: "2026-11-09T09:00:00.000Z",
  readError: null, acceptedBy: null, acceptedAt: null, acceptedFingerprint: null, acceptedCompletedAt: null, acceptedDeliverables: null, linkedAt: "2026-11-09T08:00:00.000Z", ...fields,
});

const connection = (fields: Partial<Connection> = {}): Connection => ({
  id: "conn-jira", orgId: ORG, provider: "jira", externalOrgId: CLOUD, externalOrgName: "Fernhill", status: "connected", scopes: ["read:jira-work"],
  connectedBy: null, connectedAt: "2026-11-09T08:00:00Z", consentVersion: "jira-2026-11-09", consentedAt: "2026-11-09T08:00:00Z", revokedAt: null, windowFrom: "2026-08-11",
  lastSyncedAt: "2026-11-09T11:55:00Z", lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null, syncLeaseUntil: null, paymentAccount: null, paymentAccountAt: null, ...fields,
});

type Notices = Pick<StoredSite, "siteUrl" | "webhookError" | "missedChangeAt" | "lastDeliveryAt">;
const site = (fields: Partial<Notices> = {}): Notices => ({ siteUrl: "https://fernhill.atlassian.net", webhookError: null, missedChangeAt: null, lastDeliveryAt: null, ...fields });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a milestone's Jira card (Jira acceptance JR11, JR19, JR22)", () => {
  it("offers acceptance of a done issue with criteria, with the deliverables, the site and the hashes the acceptance is held to", () => {
    const view = jiraMilestoneView({ milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA }, link: link(), connected: true, canWrite: true });
    expect(view).toMatchObject({
      linked: true,
      identifier: "ENG-123",
      issueTitle: "Billing export",
      jiraStatus: "Done",
      resolutionName: "Done",
      siteHost: "fernhill.atlassian.net",
      state: "ready",
      label: "Ready for acceptance",
      canAccept: true,
      canEditCriteria: true,
      fingerprint: "f".repeat(64),
      criteriaSha256: criteriaHash(CRITERIA),
      deliverables: [
        { kind: "file", label: "export-spec.pdf", href: "https://fernhill.atlassian.net/secure/attachment/10042/export-spec.pdf", note: null, given: true },
        { kind: "web_link", label: "PR #42", href: "https://github.com/fernhill/app/pull/42", note: null, given: true },
        { kind: "comment_link", label: "docs.fernhill.example/export", href: "https://docs.fernhill.example/export", note: null, given: true },
      ],
    });
    if (!view.linked) throw new Error("not linked");
    expect(view.facts).toEqual(["Done in Jira on Nov 9, 2026 (Done, resolved as Done).", "On fernhill.atlassian.net.", "Read from Jira Nov 9, 2026, 09:00 UTC."]);
    // No Atlassian person, and no email, in a view no one has accepted yet (JR19).
    expect(JSON.stringify(view)).not.toMatch(/@/);
    expect(Object.keys(view)).not.toEqual(expect.arrayContaining(["completedByName"]));
    expect(Object.keys(view)).not.toEqual(expect.arrayContaining(["assigneeName"]));
  });

  it("offers none for an issue Jira resolved as not done, naming the resolution, or without the connection", () => {
    const canceled = jiraMilestoneView({
      milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA },
      link: link({ completed: false, completedAt: null, statusName: "Closed", resolutionName: "Won't Do", state: "held", heldReason: "canceled" }),
      connected: true,
      canWrite: true,
    });
    if (!canceled.linked) throw new Error("not linked");
    expect(canceled).toMatchObject({ canAccept: false, label: "Held for review", resolutionName: "Won't Do" });
    expect(canceled.facts[0]).toBe("Resolved in Jira as Won't Do (Closed): not done.");
    expect(canceled.line).toBe("Jira resolved the issue as Won't Do, which is not done. Nothing is accepted from it: reopen it, or link another issue.");
    expect(JSON.stringify(canceled)).not.toMatch(/@/);
    const waiting = jiraMilestoneView({
      milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA },
      link: link({ completed: false, completedAt: null, statusCategory: "indeterminate", statusName: "In Review", resolutionName: null, state: "waiting" }),
      connected: true,
      canWrite: true,
    });
    if (!waiting.linked) throw new Error("not linked");
    expect(waiting.facts[0]).toBe("In Review in Jira: not done yet.");
    expect(waiting.canAccept).toBe(false);
    const unreachable = jiraMilestoneView({ milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA }, link: link({ state: "held", heldReason: "issue_unreachable" }), connected: true, canWrite: true });
    expect(unreachable).toMatchObject({ canAccept: false, label: "Held for review" });
    expect(jiraMilestoneView({ milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA }, link: link(), connected: false, canWrite: true })).toMatchObject({ canAccept: false });
  });

  it("shows an unlinked milestone by whether Jira is connected and its criteria, and nothing of an issue", () => {
    const view = jiraMilestoneView({ milestone: { id: "m-1", status: "pending" }, link: null, connected: true, canWrite: false });
    expect(view).toEqual({ linked: false, connected: true, criteria: null, canWrite: false });
    expect(JSON.stringify(view)).not.toMatch(/@/);
  });

  it("shows an accepted issue as accepted, with the version a person accepted and who, and says when Jira has more than is read", () => {
    const view = jiraMilestoneView({
      milestone: { id: "m-1", status: "verified", acceptance_criteria: CRITERIA },
      link: link({ state: "accepted", acceptedBy: "u-1", acceptedAt: "2026-11-09T09:30:00.000Z", acceptedDeliverables: [], moreUnread: true }),
      connected: true,
      canWrite: true,
      memberEmails: { "u-1": "admin@business.example" },
    });
    expect(view).toMatchObject({ state: "accepted", canAccept: false, canEditCriteria: false, acceptedBy: "admin@business.example", deliverables: [] });
    if (!view.linked) throw new Error("not linked");
    expect(view.facts).toContain("Accepted on Nov 9, 2026 by admin@business.example.");
    expect(view.facts).toContain("Jira has more than Vestiarion reads: the first 50 attachments, 50 web links and the newest 50 comments were checked.");
    expect(jiraNeedsPerson(link({ state: "held", heldReason: "reopened" }))).toBe(true);
    expect(jiraNeedsPerson(link({ state: "ready" }))).toBe(true);
    expect(jiraNeedsPerson(link({ state: "accepted" }))).toBe(false);
    expect(jiraNeedsPerson(null)).toBe(false);
  });

  it("shows a deliverable that cannot be opened without its link, and says why", () => {
    const href = "https://github.com/fernhill/app/pull/42";
    const view = jiraMilestoneView({
      milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA },
      link: link(),
      connected: true,
      canWrite: true,
      links: new Map([[href, { state: "cannot_open" as const, reason: "GitHub does not show this pull request to the connection." }]]),
    });
    if (!view.linked) throw new Error("not linked");
    expect(view.deliverables[1]).toEqual({ kind: "web_link", label: "PR #42", href: null, note: "GitHub does not show this pull request to the connection.", given: false });
  });
});

describe("whether Jira's notices arrive, in the card's one line (JR21, JR22)", () => {
  it("says Jira refused the webhook, in Jira's words cut to 200 characters, first", () => {
    expect(noticeLine(site({ webhookError: "The JQL is not valid.", lastDeliveryAt: "2026-11-09T11:00:00Z" }), 2, NOW)).toBe(
      "Jira did not take Vestiarion's webhook: The JQL is not valid. Linked issues are read every 15 minutes."
    );
    const long = noticeLine(site({ webhookError: "x".repeat(300) }), 1, NOW) ?? "";
    expect(long).toBe(`Jira did not take Vestiarion's webhook: ${"x".repeat(199)}…. Linked issues are read every 15 minutes.`);
  });

  it("says the notices are not arriving when the sweep found a change none told of, in the last 24 hours and since the last notice", () => {
    const missed = "Jira's notices are not reaching Vestiarion: the 15-minute check found a change Jira did not send. Linked issues are still read every 15 minutes.";
    expect(noticeLine(site({ missedChangeAt: "2026-11-09T11:30:00Z" }), 1, NOW)).toBe(missed);
    expect(noticeLine(site({ missedChangeAt: "2026-11-09T11:30:00Z", lastDeliveryAt: "2026-11-09T10:00:00Z" }), 1, NOW)).toBe(missed);
    // A notice since, or a day gone: the line goes back to the last notice.
    expect(noticeLine(site({ missedChangeAt: "2026-11-09T11:30:00Z", lastDeliveryAt: "2026-11-09T11:45:00Z" }), 1, NOW)).toBe("Jira last told Vestiarion of a change Nov 9, 2026, 11:45 UTC.");
    expect(noticeLine(site({ missedChangeAt: "2026-11-08T11:59:00Z" }), 1, NOW)).toBe("Jira has not told Vestiarion of a change yet. Linked issues are read every 15 minutes.");
  });

  it("says when the last notice came, or that none has, and nothing while no open milestone is linked on the site", () => {
    expect(noticeLine(site({ lastDeliveryAt: "2026-11-09T10:20:00Z" }), 3, NOW)).toBe("Jira last told Vestiarion of a change Nov 9, 2026, 10:20 UTC.");
    expect(noticeLine(site(), 3, NOW)).toBe("Jira has not told Vestiarion of a change yet. Linked issues are read every 15 minutes.");
    expect(noticeLine(null, 3, NOW)).toBe("Jira has not told Vestiarion of a change yet. Linked issues are read every 15 minutes.");
    expect(noticeLine(site({ webhookError: "Refused." }), 0, NOW)).toBeNull();
  });
});

describe("the Settings card (JR21, JR22)", () => {
  it("names the site and its host, counts the linked issues by state, and the last 30 days' figures of Jira's entries only", () => {
    const view = jiraPanelView({
      connection: connection(),
      site: site({ lastDeliveryAt: "2026-11-09T10:20:00Z" }),
      links: [link(), link({ id: "l-2", state: "accepted" }), link({ id: "l-3", state: "held", heldReason: "reopened" })],
      openLinks: 3,
      events: [
        { action: "jira_work_accepted", ts: "2026-11-09T10:00:00Z", milestoneId: "m-1" },
        { action: "milestone_release", ts: "2026-11-09T10:05:00Z", milestoneId: "m-1" },
        { action: "jira_acceptance_withdrawn", ts: "2026-11-09T11:00:00Z", milestoneId: "m-3" },
        // Linear's own: never counted on Jira's card.
        { action: "linear_work_accepted", ts: "2026-11-09T10:30:00Z", milestoneId: "m-9" },
      ],
      nowMs: NOW,
    });
    expect(view).toMatchObject({
      state: "connection",
      connected: true,
      revoked: false,
      siteName: "Fernhill",
      siteHost: "fernhill.atlassian.net",
      noticeLine: "Jira last told Vestiarion of a change Nov 9, 2026, 10:20 UTC.",
      counts: { linked: 3, ready: 1, accepted: 1, held: 1 },
      figures: { manualChecks: 1, disputes: 1, timeToProposal: "5 minutes", window: "the last 30 days" },
      status: { tone: "ok", title: "Connected to the Fernhill site in Jira" },
    });
    expect(jiraPanelView({ connection: null, site: null, links: [], openLinks: 0, events: [], nowMs: NOW })).toEqual({ state: "not_connected" });
  });

  it("says nothing of notices once disconnected, and the reconnect words when Jira no longer takes the connection", () => {
    const revoked = jiraPanelView({ connection: connection({ status: "revoked" }), site: null, links: [], openLinks: 0, events: [], nowMs: NOW });
    expect(revoked).toMatchObject({ state: "connection", revoked: true, noticeLine: null, status: { tone: "off", title: "Disconnected from the Fernhill site in Jira" } });
    const reconnect = jiraPanelView({ connection: connection({ status: "needs_reconnect" }), site: site(), links: [link()], openLinks: 1, events: [], nowMs: NOW });
    expect(reconnect).toMatchObject({ connected: false, status: { tone: "error", title: "Jira needs you to reconnect", reconnect: true } });
    if (reconnect.state !== "connection") throw new Error("no connection");
    expect(reconnect.status.detail[0]).toContain("Atlassian account");
  });
});

describe("jiraPanelFor (JR1, JR5)", () => {
  const row = {
    id: "conn-jira", org_id: ORG, provider: "jira", external_org_id: CLOUD, external_org_name: "Fernhill", status: "connected", scopes: ["read:jira-work"],
    connected_by: null, connected_at: "2026-11-09T08:00:00Z", consent_version: "jira-2026-11-09", consented_at: "2026-11-09T08:00:00Z", revoked_at: null, window_from: "2026-08-11",
    last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
  };
  const config = () => configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const on = () => {
    vi.stubEnv("JIRA_CLIENT_ID", "jIrAcLiEnT0123");
    vi.stubEnv("JIRA_CLIENT_SECRET", "s");
  };

  it("is null without both of Jira's settings, so Settings has no Jira card, and asks nothing", async () => {
    vi.stubEnv("JIRA_CLIENT_ID", "");
    vi.stubEnv("JIRA_CLIENT_SECRET", "");
    const fake = fakeSupabase();
    expect(await runWith(orgTestContext({ config: config(), client: fake.client, orgId: ORG }), () => jiraPanelFor(NOW))).toBeNull();
    vi.stubEnv("JIRA_CLIENT_ID", "jIrAcLiEnT0123");
    expect(await runWith(orgTestContext({ config: config(), client: fake.client, orgId: ORG }), () => jiraPanelFor(NOW))).toBeNull();
    expect(fake.requests).toEqual([]);
  });

  it("reads only Jira's entries for its figures, and the connection's site for its notice line", async () => {
    on();
    const fake = fakeSupabase((sent) => {
      if (sent.path === "/rest/v1/accounting_connections") return { body: [row] };
      if (sent.path === "/rest/v1/rpc/jira_connector_ready") return { body: true };
      if (sent.path === "/rest/v1/jira_sites" && sent.params.get("connection_id") === "eq.conn-jira") {
        return {
          body: [
            {
              connection_id: "conn-jira", org_id: ORG, cloud_id: CLOUD, site_url: "https://fernhill.atlassian.net", webhook_ids: [], retired_webhook_ids: [], retired_until: null,
              webhook_jql: null, webhook_expires_at: null, webhook_registered_at: null, webhook_checked_at: null, webhook_error: null, last_delivery_at: null, missed_change_at: null,
              site_missing_at: null, updated_at: "2026-11-09T08:00:00Z",
            },
          ],
        };
      }
      return { body: [] };
    });
    const view = await runWith(orgTestContext({ config: config(), client: fake.client, orgId: ORG }), () => jiraPanelFor(NOW));
    expect(view).toMatchObject({ state: "connection", siteHost: "fernhill.atlassian.net", counts: { linked: 0 }, noticeLine: null });
    const ledger = fake.requests.find((sent) => sent.path === "/rest/v1/ledger_entries");
    expect(ledger?.params.get("action")).toBe("in.(jira_work_accepted,jira_acceptance_withdrawn,milestone_release,milestone_hold)");
    // The open milestones, by the webhook's own statuses (JR14).
    const milestones = fake.requests.find((sent) => sent.path === "/rest/v1/milestones");
    expect(milestones?.params.get("status")).toBe("in.(verified,held,pending)");
    // Nothing is asked of Atlassian, and no token is read.
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_tokens")).toBe(false);
  });

  it("says not set up before migration 0149, and offers no Jira controls", async () => {
    on();
    const before = fakeSupabase((sent) =>
      sent.path === "/rest/v1/rpc/jira_connector_ready" ? { status: 404, body: { code: "PGRST202", message: "Could not find the function public.jira_connector_ready" } } : { body: [] }
    );
    expect(await runWith(orgTestContext({ config: config(), client: before.client, orgId: ORG }), () => jiraPanelFor(NOW))).toEqual({ state: "not_set_up" });
    const noSites = fakeSupabase((sent) => {
      if (sent.path === "/rest/v1/rpc/jira_connector_ready") return { body: true };
      if (sent.path === "/rest/v1/jira_sites") return { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.jira_sites' in the schema cache" } };
      return { body: [] };
    });
    expect(await runWith(orgTestContext({ config: config(), client: noSites.client, orgId: ORG }), () => jiraPanelFor(NOW))).toEqual({ state: "not_set_up" });
  });

  it("says not connected without a connection", async () => {
    on();
    const fake = fakeSupabase((sent) => (sent.path === "/rest/v1/rpc/jira_connector_ready" ? { body: true } : { body: [] }));
    expect(await runWith(orgTestContext({ config: config(), client: fake.client, orgId: ORG }), () => jiraPanelFor(NOW))).toEqual({ state: "not_connected" });
  });
});
