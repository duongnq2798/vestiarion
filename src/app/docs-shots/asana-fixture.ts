import type { AcceptanceEvent } from "@/lib/asana/acceptance";
import type { TaskLink } from "@/lib/asana/links";
import type { Connection } from "@/lib/connectors/connections";

/**
 * Sample data for /docs-shots/asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md, Screens): a workspace
 * connected to its owner's Asana, and two milestones for Fernhill Studio linked to the tasks of the project "Fernhill
 * Studio · Social media kit", as the partner's test data has them. Every view is built from these by the pages' own
 * functions. Sample names and links only.
 */

export const ASANA_NOW = Date.parse("2026-10-14T10:30:00.000Z");

export const ASANA_CONNECTION: Connection = {
  id: "docs-asana-connection",
  orgId: "docs-sample-org",
  provider: "asana",
  externalOrgId: "4673218951",
  externalOrgName: "Olivia",
  status: "connected",
  scopes: [],
  connectedBy: "docs-sample-owner",
  connectedAt: "2026-10-14T08:00:00.000Z",
  consentVersion: "asana-2026-10-14",
  consentedAt: "2026-10-14T08:00:00.000Z",
  revokedAt: null,
  windowFrom: "2026-07-16",
  lastSyncedAt: "2026-10-14T10:25:00.000Z",
  lastError: null,
  lastErrorAt: null,
  failures: 0,
  nextSyncAfter: null,
  syncLeaseUntil: null,
  paymentAccount: null,
  paymentAccountAt: null,
};

export const LOGO_CRITERIA = "A 5-second logo animation, delivered as MP4 and GIF.\nOn the brand palette, with the wordmark legible at 320 px wide.";
export const POSTS_CRITERIA = "Ten launch posts at 1080 x 1350, each with its caption.\nThe brand palette and type, and the product named as on the site.";

const DELIVERABLES: TaskLink["deliverables"] = [
  { kind: "attachment", id: "1219477646404801", label: "fernhill-logo-motion.mp4", href: "https://app.asana.com/app/asana/-/get_asset?asset_id=1219477646404801", version: "2026-10-14T09:10:00.000Z" },
  { kind: "attachment", id: "1219477646404802", label: "fernhill-logo-motion.gif", href: "https://app.asana.com/app/asana/-/get_asset?asset_id=1219477646404802", version: "2026-10-14T09:10:00.000Z" },
  { kind: "link", id: "https://www.figma.com/file/AbC123/fernhill-logo-motion", label: "figma.com/file/AbC123/fernhill-logo-motion", href: "https://www.figma.com/file/AbC123/fernhill-logo-motion" },
];

const base: TaskLink = {
  id: "docs-asana-link-logo",
  milestoneId: "docs-milestone-logo",
  connectionId: ASANA_CONNECTION.id,
  workspaceGid: "1204081671801519",
  projectGid: "1219477646404725",
  taskGid: "1219477646404728",
  taskName: "Logo animation",
  taskUrl: "https://app.asana.com/0/1219477646404725/1219477646404728",
  state: "ready",
  heldReason: null,
  afterPayment: false,
  heldAt: null,
  completed: true,
  completedAt: "2026-10-14T09:12:00.000Z",
  completedByGid: "5550001",
  completedByName: "Mai Tran",
  assigneeName: "Mai Tran",
  deliverables: DELIVERABLES,
  fingerprint: "6f1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091",
  lastReadAt: "2026-10-14T10:25:00.000Z",
  readError: null,
  acceptedBy: null,
  acceptedAt: null,
  acceptedFingerprint: null,
  acceptedCompletedAt: null,
  acceptedDeliverables: null,
  linkedAt: "2026-10-14T08:05:00.000Z",
};

export const LINK_READY: TaskLink = base;

export const LINK_ACCEPTED: TaskLink = {
  ...base,
  state: "accepted",
  acceptedBy: "docs-sample-admin",
  acceptedAt: "2026-10-14T10:02:00.000Z",
  acceptedFingerprint: base.fingerprint,
  acceptedCompletedAt: base.completedAt,
  acceptedDeliverables: DELIVERABLES,
};

export const LINK_HELD: TaskLink = {
  ...LINK_ACCEPTED,
  state: "held",
  heldReason: "reopened",
  heldAt: "2026-10-14T10:20:00.000Z",
  completed: false,
  completedAt: null,
  completedByGid: null,
  completedByName: null,
};

export const LINK_POSTS_WAITING: TaskLink = {
  ...base,
  id: "docs-asana-link-posts",
  milestoneId: "docs-milestone-posts",
  taskGid: "1219477646404730",
  taskName: "10 launch posts",
  taskUrl: "https://app.asana.com/0/1219477646404725/1219477646404730",
  state: "waiting",
  completed: false,
  completedAt: null,
  completedByGid: null,
  completedByName: null,
  deliverables: [{ kind: "link", id: "https://drive.google.com/drive/folders/fernhill-launch-posts", label: "drive.google.com/drive/folders/fernhill-launch-posts", href: "https://drive.google.com/drive/folders/fernhill-launch-posts" }],
};

export const MEMBER_EMAILS: Record<string, string> = { "docs-sample-owner": "olivia@northstar.example", "docs-sample-admin": "adam@northstar.example" };

export const ASANA_EVENTS: AcceptanceEvent[] = [
  { action: "milestone_accepted", ts: "2026-10-09T10:00:00.000Z", milestoneId: "m-1" },
  { action: "milestone_release", ts: "2026-10-09T10:01:00.000Z", milestoneId: "m-1" },
  { action: "milestone_accepted", ts: "2026-10-11T15:30:00.000Z", milestoneId: "m-2" },
  { action: "milestone_release", ts: "2026-10-11T15:32:00.000Z", milestoneId: "m-2" },
  { action: "milestone_accepted", ts: "2026-10-14T10:02:00.000Z", milestoneId: "docs-milestone-logo" },
  { action: "milestone_acceptance_withdrawn", ts: "2026-10-14T10:20:00.000Z", milestoneId: "docs-milestone-logo" },
];

/** What Settings' card reads: the logo held, the posts waiting, and one accepted earlier. */
export const ASANA_PANEL_LINKS: TaskLink[] = [LINK_HELD, LINK_POSTS_WAITING, { ...LINK_READY, id: "docs-asana-link-3", taskGid: "1219477646404731", state: "ready" }];
