import type { Connection } from "@/lib/connectors/connections";
import { ACCEPTED_ACTION, WITHDRAWN_ACTION, type AcceptanceEvent } from "@/lib/jira/acceptance";
import type { IssueLink } from "@/lib/jira/links";
import { JIRA_SCOPES } from "@/lib/jira/settings";
import type { StoredSite } from "@/lib/jira/sites";

/**
 * Sample data for /docs-shots/jira (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR22), as Linear's
 * fixture: a workspace connected to the Jira site northstar.atlassian.net, and two milestones for Kestrel Labs linked to
 * issues of its ENG project. Every view is built from these by the pages' own functions. Sample names and links only.
 */

export const JIRA_NOW = Date.parse("2026-11-09T10:30:00.000Z");

const CLOUD_ID = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const SITE = "https://northstar.atlassian.net";

export const JIRA_CONNECTION: Connection = {
  id: "docs-jira-connection",
  orgId: "docs-sample-org",
  provider: "jira",
  externalOrgId: CLOUD_ID,
  externalOrgName: "Northstar",
  status: "connected",
  scopes: [...JIRA_SCOPES],
  connectedBy: "docs-sample-owner",
  connectedAt: "2026-11-09T08:00:00.000Z",
  consentVersion: "jira-2026-11-09",
  consentedAt: "2026-11-09T08:00:00.000Z",
  revokedAt: null,
  windowFrom: "2026-08-11",
  lastSyncedAt: "2026-11-09T10:25:00.000Z",
  lastError: null,
  lastErrorAt: null,
  failures: 0,
  nextSyncAfter: null,
  syncLeaseUntil: null,
  paymentAccount: null,
  paymentAccountAt: null,
};

/** The connection's site, with its one webhook, and the last notice Jira sent. */
export const JIRA_SITE: StoredSite = {
  connectionId: JIRA_CONNECTION.id,
  orgId: JIRA_CONNECTION.orgId,
  cloudId: CLOUD_ID,
  siteUrl: SITE,
  webhookIds: [10021],
  retiredWebhookIds: [],
  retiredUntil: null,
  webhookJql: "project in (10000)",
  webhookExpiresAt: "2026-12-09T08:05:00.000Z",
  webhookRegisteredAt: "2026-11-09T08:05:00.000Z",
  webhookCheckedAt: "2026-11-09T10:25:00.000Z",
  webhookError: null,
  lastDeliveryAt: "2026-11-09T10:20:00.000Z",
  missedChangeAt: null,
  siteMissingAt: null,
  updatedAt: "2026-11-09T10:25:00.000Z",
};

export const RETRIES_CRITERIA =
  "Failed webhook deliveries are retried 5 times with exponential backoff, over at most 24 hours.\nThe pull request is merged with its tests, and the retry policy is in the API docs.";

const PULL_REQUEST = "https://github.com/northstar-example/api/pull/318";
const DESIGN_NOTE = `${SITE}/secure/attachment/10042/webhook-retries-design.pdf`;
const DOCS_PREVIEW = "https://docs-preview.northstar.example/webhooks/retries";
const RUNBOOK = "https://docs-preview.northstar.example/runbooks/webhook-retries";

const DELIVERABLES: IssueLink["deliverables"] = [
  { kind: "attachment", id: "file:10042", label: "webhook-retries-design.pdf", href: DESIGN_NOTE, version: "2026-11-09T09:02:00.000Z" },
  { kind: "attachment", id: "remotelink:10007", label: "Retry failed webhook deliveries with backoff #318", href: PULL_REQUEST, version: PULL_REQUEST },
  { kind: "link", id: DOCS_PREVIEW, label: "docs-preview.northstar.example/webhooks/retries", href: DOCS_PREVIEW },
  { kind: "comment_link", id: RUNBOOK, label: "docs-preview.northstar.example/runbooks/webhook-retries", href: RUNBOOK },
];

const base: IssueLink = {
  id: "docs-jira-link-retries",
  milestoneId: "docs-milestone-retries",
  connectionId: JIRA_CONNECTION.id,
  cloudId: CLOUD_ID,
  issueId: "10142",
  identifier: "ENG-142",
  projectId: "10000",
  projectKey: "ENG",
  issueTitle: "Webhook retries with backoff",
  issueUrl: `${SITE}/browse/ENG-142`,
  state: "ready",
  heldReason: null,
  afterPayment: false,
  heldAt: null,
  statusCategory: "done",
  statusName: "Done",
  resolutionName: "Done",
  completed: true,
  completedAt: "2026-11-09T09:12:00.000Z",
  deliverables: DELIVERABLES,
  fingerprint: "3c5e7a9b1d2f4e6a8c0b1d3f5e7a9c2b4d6f8e0a1c3e5b7d9f2a4c6e8b0d1f3a",
  attachmentsRead: 1,
  remoteLinksRead: 1,
  commentsRead: 3,
  moreUnread: false,
  issueUpdatedAt: "2026-11-09T09:12:00.000Z",
  lastReadAt: "2026-11-09T10:25:00.000Z",
  readError: null,
  acceptedBy: null,
  acceptedAt: null,
  acceptedFingerprint: null,
  acceptedCompletedAt: null,
  acceptedDeliverables: null,
  linkedAt: "2026-11-09T08:05:00.000Z",
};

export const LINK_READY: IssueLink = base;

export const LINK_ACCEPTED: IssueLink = {
  ...base,
  state: "accepted",
  acceptedBy: "docs-sample-admin",
  acceptedAt: "2026-11-09T10:02:00.000Z",
  acceptedFingerprint: base.fingerprint,
  acceptedCompletedAt: base.completedAt,
  acceptedDeliverables: DELIVERABLES,
};

export const LINK_HELD: IssueLink = {
  ...LINK_ACCEPTED,
  state: "held",
  heldReason: "reopened",
  heldAt: "2026-11-09T10:20:00.000Z",
  statusCategory: "indeterminate",
  statusName: "In Progress",
  resolutionName: null,
  completed: false,
  completedAt: null,
  issueUpdatedAt: "2026-11-09T10:19:00.000Z",
};

export const LINK_DASHBOARD_WAITING: IssueLink = {
  ...base,
  id: "docs-jira-link-dashboard",
  milestoneId: "docs-milestone-dashboard",
  issueId: "10151",
  identifier: "ENG-151",
  issueTitle: "Delivery log in the dashboard",
  issueUrl: `${SITE}/browse/ENG-151`,
  state: "waiting",
  statusCategory: "indeterminate",
  statusName: "In Review",
  resolutionName: null,
  completed: false,
  completedAt: null,
  deliverables: [],
  fingerprint: null,
};

export const MEMBER_EMAILS: Record<string, string> = { "docs-sample-owner": "olivia@northstar.example", "docs-sample-admin": "adam@northstar.example" };

export const JIRA_EVENTS: AcceptanceEvent[] = [
  { action: ACCEPTED_ACTION, ts: "2026-11-04T10:00:00.000Z", milestoneId: "m-1" },
  { action: "milestone_release", ts: "2026-11-04T10:01:00.000Z", milestoneId: "m-1" },
  { action: ACCEPTED_ACTION, ts: "2026-11-06T15:30:00.000Z", milestoneId: "m-2" },
  { action: "milestone_release", ts: "2026-11-06T15:32:00.000Z", milestoneId: "m-2" },
  { action: ACCEPTED_ACTION, ts: "2026-11-09T10:02:00.000Z", milestoneId: "docs-milestone-retries" },
  { action: WITHDRAWN_ACTION, ts: "2026-11-09T10:20:00.000Z", milestoneId: "docs-milestone-retries" },
];

/** What Settings' card reads: the retries held, the dashboard waiting, and one ready for acceptance. All three are open. */
export const JIRA_PANEL_LINKS: IssueLink[] = [
  LINK_HELD,
  LINK_DASHBOARD_WAITING,
  { ...LINK_READY, id: "docs-jira-link-3", milestoneId: "docs-milestone-3", issueId: "10158", identifier: "ENG-158", issueUrl: `${SITE}/browse/ENG-158`, state: "ready" },
];
