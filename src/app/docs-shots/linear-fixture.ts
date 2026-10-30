import type { Connection } from "@/lib/connectors/connections";
import { ACCEPTED_ACTION, WITHDRAWN_ACTION, type AcceptanceEvent } from "@/lib/linear/acceptance";
import type { IssueLink } from "@/lib/linear/links";

/**
 * Sample data for /docs-shots/linear (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN16), as Asana's
 * fixture: a workspace connected to the Linear workspace "Northstar", and two milestones for Kestrel Labs linked to
 * issues of its ENG team. Every view is built from these by the pages' own functions. Sample names and links only.
 */

export const LINEAR_NOW = Date.parse("2026-10-31T10:30:00.000Z");

export const LINEAR_CONNECTION: Connection = {
  id: "docs-linear-connection",
  orgId: "docs-sample-org",
  provider: "linear",
  externalOrgId: "6b1f0c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e",
  externalOrgName: "Northstar",
  status: "connected",
  scopes: ["read"],
  connectedBy: "docs-sample-owner",
  connectedAt: "2026-10-31T08:00:00.000Z",
  consentVersion: "linear-2026-10-31",
  consentedAt: "2026-10-31T08:00:00.000Z",
  revokedAt: null,
  windowFrom: "2026-08-02",
  lastSyncedAt: "2026-10-31T10:25:00.000Z",
  lastError: null,
  lastErrorAt: null,
  failures: 0,
  nextSyncAfter: null,
  syncLeaseUntil: null,
  paymentAccount: null,
  paymentAccountAt: null,
};

export const RETRIES_CRITERIA =
  "Failed webhook deliveries are retried 5 times with exponential backoff, over at most 24 hours.\nThe pull request is merged with its tests, and the retry policy is in the API docs.";

const PULL_REQUEST = "https://github.com/northstar-example/api/pull/318";
const DESIGN_NOTE = "https://uploads.linear.app/6b1f0c2e/7c2d1e0f/webhook-retries-design.pdf";
const DOCS_PREVIEW = "https://docs-preview.northstar.example/webhooks/retries";

const DELIVERABLES: IssueLink["deliverables"] = [
  { kind: "attachment", id: "4f3e2d1c-0b9a-4876-9543-210fedcba987", label: "Retry failed webhook deliveries with backoff #318", href: PULL_REQUEST, version: PULL_REQUEST },
  { kind: "link", id: DESIGN_NOTE, label: "uploads.linear.app/6b1f0c2e/7c2d1e0f/webhook-retries-design.pdf", href: DESIGN_NOTE },
  { kind: "comment_link", id: DOCS_PREVIEW, label: "docs-preview.northstar.example/webhooks/retries", href: DOCS_PREVIEW },
];

const base: IssueLink = {
  id: "docs-linear-link-retries",
  milestoneId: "docs-milestone-retries",
  connectionId: LINEAR_CONNECTION.id,
  issueId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  identifier: "ENG-142",
  teamKey: "ENG",
  issueTitle: "Webhook retries with backoff",
  issueUrl: "https://linear.app/northstar/issue/ENG-142/webhook-retries-with-backoff",
  state: "ready",
  heldReason: null,
  afterPayment: false,
  heldAt: null,
  stateType: "completed",
  stateName: "Done",
  completed: true,
  completedAt: "2026-10-31T09:12:00.000Z",
  completedById: "docs-linear-user-mai",
  completedByName: "Mai Tran",
  assigneeName: "Mai Tran",
  archived: false,
  deliverables: DELIVERABLES,
  fingerprint: "8e2c4a6b1d3f5e7a9c0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d1f3a5c7e9b0d2f4a",
  attachmentsRead: 1,
  commentsRead: 3,
  moreUnread: false,
  lastReadAt: "2026-10-31T10:25:00.000Z",
  readError: null,
  acceptedBy: null,
  acceptedAt: null,
  acceptedFingerprint: null,
  acceptedCompletedAt: null,
  acceptedDeliverables: null,
  linkedAt: "2026-10-31T08:05:00.000Z",
};

export const LINK_READY: IssueLink = base;

export const LINK_ACCEPTED: IssueLink = {
  ...base,
  state: "accepted",
  acceptedBy: "docs-sample-admin",
  acceptedAt: "2026-10-31T10:02:00.000Z",
  acceptedFingerprint: base.fingerprint,
  acceptedCompletedAt: base.completedAt,
  acceptedDeliverables: DELIVERABLES,
};

export const LINK_HELD: IssueLink = {
  ...LINK_ACCEPTED,
  state: "held",
  heldReason: "reopened",
  heldAt: "2026-10-31T10:20:00.000Z",
  stateType: "started",
  stateName: "In Progress",
  completed: false,
  completedAt: null,
  completedById: null,
  completedByName: null,
};

export const LINK_DASHBOARD_WAITING: IssueLink = {
  ...base,
  id: "docs-linear-link-dashboard",
  milestoneId: "docs-milestone-dashboard",
  issueId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  identifier: "ENG-151",
  issueTitle: "Delivery log in the dashboard",
  issueUrl: "https://linear.app/northstar/issue/ENG-151/delivery-log-in-the-dashboard",
  state: "waiting",
  stateType: "started",
  stateName: "In Review",
  completed: false,
  completedAt: null,
  completedById: null,
  completedByName: null,
  deliverables: [{ kind: "attachment", id: "0a9b8c7d-6e5f-4a3b-8c1d-2e3f4a5b6c7d", label: "Delivery log page #324", href: "https://github.com/northstar-example/api/pull/324", version: "https://github.com/northstar-example/api/pull/324" }],
};

export const MEMBER_EMAILS: Record<string, string> = { "docs-sample-owner": "olivia@northstar.example", "docs-sample-admin": "adam@northstar.example" };

export const LINEAR_EVENTS: AcceptanceEvent[] = [
  { action: ACCEPTED_ACTION, ts: "2026-10-26T10:00:00.000Z", milestoneId: "m-1" },
  { action: "milestone_release", ts: "2026-10-26T10:01:00.000Z", milestoneId: "m-1" },
  { action: ACCEPTED_ACTION, ts: "2026-10-28T15:30:00.000Z", milestoneId: "m-2" },
  { action: "milestone_release", ts: "2026-10-28T15:32:00.000Z", milestoneId: "m-2" },
  { action: ACCEPTED_ACTION, ts: "2026-10-31T10:02:00.000Z", milestoneId: "docs-milestone-retries" },
  { action: WITHDRAWN_ACTION, ts: "2026-10-31T10:20:00.000Z", milestoneId: "docs-milestone-retries" },
];

/** What Settings' card reads: the retries held, the dashboard waiting, and one ready for acceptance. */
export const LINEAR_PANEL_LINKS: IssueLink[] = [LINK_HELD, LINK_DASHBOARD_WAITING, { ...LINK_READY, id: "docs-linear-link-3", issueId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", identifier: "ENG-158", state: "ready" }];
