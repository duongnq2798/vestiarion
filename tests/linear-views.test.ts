import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Connection } from "@/lib/connectors/connections";
import type { IssueLink } from "@/lib/linear/links";
import { linearPanelFor } from "@/lib/linear/panel";
import { criteriaHash, linearMilestoneView, linearNeedsPerson, linearPanelView } from "@/lib/linear/views";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * What the Contractors card and the Settings card are given of Linear (docs/superpowers/specs/2026-10-31-linear-
 * acceptance-design.md LN8, LN15, LN16): words, links and the hashes the acceptance is held to, built on the server, never
 * a token or an email; the figures count Linear's acceptances only.
 */

const NOW = Date.parse("2026-10-31T12:00:00Z");
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1c01";
const CRITERIA = "The billing export screen, CSV and PDF.";

const link = (fields: Partial<IssueLink> = {}): IssueLink => ({
  id: "link-1", milestoneId: "m-1", connectionId: "conn-linear", issueId: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01", identifier: "ENG-123", teamKey: "ENG",
  issueTitle: "Billing export", issueUrl: "https://linear.app/fernhill/issue/ENG-123/billing-export", state: "ready", heldReason: null, afterPayment: false, heldAt: null,
  stateType: "completed", stateName: "Done", completed: true, completedAt: "2026-10-31T08:30:00.000Z", completedById: null, completedByName: "Mai Tran", assigneeName: "Mai Tran",
  archived: false, deliverables: [{ kind: "attachment", id: "a-1", label: "PR #42", href: "https://github.com/fernhill/app/pull/42", version: "https://github.com/fernhill/app/pull/42" }],
  fingerprint: "f".repeat(64), attachmentsRead: 1, commentsRead: 0, moreUnread: false, lastReadAt: "2026-10-31T09:00:00.000Z", readError: null, acceptedBy: null, acceptedAt: null,
  acceptedFingerprint: null, acceptedCompletedAt: null, acceptedDeliverables: null, linkedAt: "2026-10-31T08:00:00.000Z", ...fields,
});

const connection = (fields: Partial<Connection> = {}): Connection => ({
  id: "conn-linear", orgId: ORG, provider: "linear", externalOrgId: "8c5d2f62-0a5b-4a8e-9c1e-2b7f0f6c1a01", externalOrgName: "Fernhill", status: "connected", scopes: ["read"],
  connectedBy: null, connectedAt: "2026-10-31T08:00:00Z", consentVersion: "x", consentedAt: "2026-10-31T08:00:00Z", revokedAt: null, windowFrom: "2026-08-02",
  lastSyncedAt: "2026-10-31T11:55:00Z", lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null, syncLeaseUntil: null, paymentAccount: null, paymentAccountAt: null, ...fields,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a milestone's Linear card (Linear acceptance LN8, LN16)", () => {
  it("offers acceptance of a done issue with criteria, with the deliverables and the hashes the acceptance is held to", () => {
    const view = linearMilestoneView({ milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA }, link: link(), connected: true, canWrite: true });
    expect(view).toMatchObject({
      linked: true,
      identifier: "ENG-123",
      issueTitle: "Billing export",
      linearStatus: "Done",
      state: "ready",
      label: "Ready for acceptance",
      canAccept: true,
      canEditCriteria: true,
      fingerprint: "f".repeat(64),
      criteriaSha256: criteriaHash(CRITERIA),
      deliverables: [{ kind: "attachment", label: "PR #42", href: "https://github.com/fernhill/app/pull/42", note: null, given: true }],
    });
    if (!view.linked) throw new Error("not linked");
    expect(view.facts).toEqual(["Done in Linear on Oct 31, 2026 by Mai Tran.", "Assigned to Mai Tran.", "Read from Linear Oct 31, 2026, 09:00 UTC."]);
    expect(JSON.stringify(view)).not.toMatch(/@/);
  });

  it("offers none for an archived or canceled issue, or without the connection, and says so", () => {
    const archived = linearMilestoneView({ milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA }, link: link({ archived: true, state: "held", heldReason: "archived" }), connected: true, canWrite: true });
    expect(archived).toMatchObject({ canAccept: false, label: "Held for review" });
    if (!archived.linked) throw new Error("not linked");
    expect(archived.facts[0]).toBe("Archived or deleted in Linear.");
    const canceled = linearMilestoneView({
      milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA },
      link: link({ completed: false, completedAt: null, stateType: "canceled", stateName: "Canceled", state: "held", heldReason: "canceled" }),
      connected: true,
      canWrite: true,
    });
    if (!canceled.linked) throw new Error("not linked");
    expect(canceled.facts[0]).toBe("Canceled in Linear (Canceled).");
    expect(canceled.canAccept).toBe(false);
    expect(linearMilestoneView({ milestone: { id: "m-1", status: "pending", acceptance_criteria: CRITERIA }, link: link(), connected: false, canWrite: true })).toMatchObject({ canAccept: false });
    expect(linearMilestoneView({ milestone: { id: "m-1", status: "pending" }, link: null, connected: true, canWrite: false })).toEqual({ linked: false, connected: true, criteria: null, canWrite: false });
  });

  it("shows an accepted issue as accepted, with the version a person accepted and who, and says when Linear has more than is read", () => {
    const view = linearMilestoneView({
      milestone: { id: "m-1", status: "verified", acceptance_criteria: CRITERIA },
      link: link({ state: "accepted", acceptedBy: "u-1", acceptedAt: "2026-10-31T09:30:00.000Z", acceptedDeliverables: [], moreUnread: true }),
      connected: true,
      canWrite: true,
      memberEmails: { "u-1": "admin@business.example" },
    });
    expect(view).toMatchObject({ state: "accepted", canAccept: false, canEditCriteria: false, acceptedBy: "admin@business.example", deliverables: [] });
    if (!view.linked) throw new Error("not linked");
    expect(view.facts).toContain("Linear has more than Vestiarion reads: the first 50 attachments and 100 comments were checked.");
    expect(linearNeedsPerson(link({ state: "held", heldReason: "reopened" }))).toBe(true);
    expect(linearNeedsPerson(link({ state: "accepted" }))).toBe(false);
  });
});

describe("the Settings card (LN15, LN16)", () => {
  it("counts the linked issues by state, and the last 30 days' figures", () => {
    const view = linearPanelView({
      connection: connection(),
      links: [link(), link({ id: "l-2", state: "accepted" }), link({ id: "l-3", state: "held", heldReason: "reopened" })],
      events: [
        { action: "linear_work_accepted", ts: "2026-10-31T10:00:00Z", milestoneId: "m-1" },
        { action: "milestone_release", ts: "2026-10-31T10:05:00Z", milestoneId: "m-1" },
        { action: "linear_acceptance_withdrawn", ts: "2026-10-31T11:00:00Z", milestoneId: "m-3" },
      ],
      nowMs: NOW,
    });
    expect(view).toMatchObject({
      state: "connection",
      connected: true,
      revoked: false,
      workspaceName: "Fernhill",
      counts: { linked: 3, ready: 1, accepted: 1, held: 1 },
      figures: { manualChecks: 1, disputes: 1, timeToProposal: "5 minutes", window: "the last 30 days" },
      status: { tone: "ok", title: "Connected to the Fernhill workspace in Linear" },
    });
    expect(linearPanelView({ connection: null, links: [], events: [], nowMs: NOW })).toEqual({ state: "not_connected" });
  });

  it("is not there without Linear's three settings, and reads only Linear's entries for its figures", async () => {
    expect(await linearPanelFor(NOW)).toBeNull();
    vi.stubEnv("LINEAR_CLIENT_ID", "5f0c2b0d8d6a4c1f9e0a7b3c2d1e4f5a");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "s");
    vi.stubEnv("LINEAR_WEBHOOK_SECRET", "w");
    const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
    const row = {
      id: "conn-linear", org_id: ORG, provider: "linear", external_org_id: "8c5d2f62-0a5b-4a8e-9c1e-2b7f0f6c1a01", external_org_name: "Fernhill", status: "connected", scopes: ["read"],
      connected_by: null, connected_at: "2026-10-31T08:00:00Z", consent_version: "x", consented_at: "2026-10-31T08:00:00Z", revoked_at: null, window_from: "2026-08-02",
      last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
    };
    const fake = fakeSupabase((sent) => {
      if (sent.path === "/rest/v1/accounting_connections") return { body: [row] };
      if (sent.path === "/rest/v1/rpc/linear_connector_ready") return { body: true };
      return { body: [] };
    });
    const view = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => linearPanelFor(NOW));
    expect(view).toMatchObject({ state: "connection", counts: { linked: 0 } });
    const ledger = fake.requests.find((sent) => sent.path === "/rest/v1/ledger_entries");
    expect(ledger?.params.get("action")).toBe("in.(linear_work_accepted,linear_acceptance_withdrawn,milestone_release,milestone_hold)");
    // Before migration 0147: not set up, and no Linear controls.
    const before = fakeSupabase((sent) =>
      sent.path === "/rest/v1/rpc/linear_connector_ready" ? { status: 404, body: { code: "PGRST202", message: "Could not find the function public.linear_connector_ready" } } : { body: sent.path === "/rest/v1/accounting_connections" ? [] : [] }
    );
    expect(await runWith(orgTestContext({ config, client: before.client, orgId: ORG }), () => linearPanelFor(NOW))).toEqual({ state: "not_set_up" });
  });
});
