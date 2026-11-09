import crypto from "node:crypto";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import type { JiraPause } from "@/lib/jira/http";
import { insertLink, liveLinks, type IssueLink } from "@/lib/jira/links";
import { jiraProvider } from "@/lib/jira/provider";
import type { FakeReply, RecordedRequest } from "./fake-supabase";
import { orgTestContext } from "./fake-supabase";
import { memoryPostgrest, type Row } from "./memory-postgrest";

/**
 * A workspace's Jira, end to end over the real stores (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md): the
 * database is an in-memory PostgREST that refuses what migration 0149's checks and its two partial unique indexes refuse,
 * and whose functions `accept_jira_issue` and `hold_jira_acceptance` answer as 0149's do (that SQL is tested on its own
 * in tests/jira-migration.test.ts); Jira is a fake Atlassian holding the Northstar site (northstar.atlassian.net) and,
 * for a site connected later, Southwind, with the issues ENG-142 "Webhook retries with backoff" and ENG-143 "Billing
 * export" in project ENG (10000) and OPS-7 "Status page" in project OPS (10001). It answers an expired token with 401,
 * rotates the refresh token on each refresh as Atlassian does, keeps the app's dynamic webhooks per site, and can spend
 * Atlassian's shared rate limit.
 *
 * A test file mocks `@/lib/connectors/token-store` and `@/lib/dal/scope` through `WorldHooks`, as tests/linear-flow does.
 */

export const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1a01";
export const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1a02";
export const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1a11";
export const ADMIN = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1a12";
export const PAYEE_MEMBER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1a13";
export const CONN = "dddddddd-0000-4000-8000-00000000d1a1";
export const OTHER_CONN = "dddddddd-0000-4000-8000-00000000d1a2";
export const NEW_CONN = "dddddddd-0000-4000-8000-00000000d1a3";
export const EXPORT = "aaaaaaaa-0000-4000-8000-00000000d1a1";
export const DOCS = "aaaaaaaa-0000-4000-8000-00000000d1a2";
export const STATUS = "aaaaaaaa-0000-4000-8000-00000000d1a3";
export const OTHER_EXPORT = "aaaaaaaa-0000-4000-8000-00000000d1a4";
export const FERNHILL = "cccccccc-0000-4000-8000-00000000d1a1";
/** Northstar's cloudId, and Southwind's, a site connected later. */
export const CLOUD = "4f6c3a2e-8b1d-4e7a-9c2f-1a0b3c4d5e6f";
export const NEW_CLOUD = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const SITE_URL = "https://northstar.atlassian.net";
export const NEW_SITE_URL = "https://southwind.atlassian.net";
export const ENG_142 = "10042";
export const ENG_143 = "10043";
export const OPS_7 = "10107";
export const ENG = "10000";
export const OPS = "10001";
/** The Atlassian accounts: the owner, who connected Jira, and Mai, the contractor. Compared in memory, never kept. */
export const OWNER_ATLASSIAN = "5b10ac8d82e05b22cc7d4ef5";
export const MAI_ATLASSIAN = "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077";
export const NOW = Date.parse("2026-11-09T09:00:00Z");
export const ORIGIN = "https://www.vestiarion.xyz";
export const WEBHOOK_URL = `${ORIGIN}/api/integrations/jira/webhook`;
export const CRITERIA = "Webhook deliveries retried with exponential backoff, with tests, merged behind its flag.";
export const sha = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;

/** What a test file's mocks call into: the token row of a connection, and a workspace's scope entered. */
export interface WorldHooks {
  tokens: null | ((connectionId: string) => TokenStore);
  enter: null | (<T>(orgId: string, fn: () => Promise<T>) => Promise<T>);
}

/** A jsonb value as Postgres writes it out (`::text`), for 0149's 32,000-byte checks. */
const jsonbText = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).filter(([, one]) => one !== undefined);
    return `{${fields.map(([key, one]) => `${JSON.stringify(key)}: ${jsonbText(one)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
};
const listOk = (value: unknown) => Array.isArray(value) && Buffer.byteLength(jsonbText(value), "utf8") <= 32_000;
const absent = (value: unknown) => value === null || value === undefined;
const textOk = (value: unknown, max: number) => absent(value) || (typeof value === "string" && value.length >= 1 && value.length <= max);
const matchOk = (value: unknown, pattern: RegExp) => absent(value) || (typeof value === "string" && pattern.test(value));
const countOk = (value: unknown) => absent(value) || (Number(value) >= 0 && Number(value) <= 50);

/** 0149's columns on `jira_issue_links`: a write naming another is refused, as before a migration that adds it. */
export const LINK_TABLE_COLUMNS = new Set(
  "id org_id milestone_id connection_id cloud_id issue_id identifier project_id project_key issue_title issue_url state held_reason after_payment held_at status_category status_name resolution_name completed completed_at deliverables deliverable_fingerprint attachments_read remote_links_read comments_read more_unread issue_updated_at last_read_at read_error accepted_by accepted_at accepted_fingerprint accepted_completed_at accepted_criteria_sha256 accepted_deliverables linked_by linked_at unlinked_by unlinked_at updated_at".split(
    " "
  )
);
const SITE_TABLE_COLUMNS = new Set(
  "connection_id org_id cloud_id site_url webhook_ids retired_webhook_ids retired_until webhook_jql webhook_expires_at webhook_registered_at webhook_checked_at webhook_error last_delivery_at missed_change_at site_missing_at updated_at".split(" ")
);

/** 0149's checks on `jira_issue_links`, by name. */
const LINK_CHECKS: Array<{ name: string; holds: (row: Row) => boolean }> = [
  { name: "jira_issue_links_cloud_id_check", holds: (row) => typeof row.cloud_id === "string" && UUID.test(row.cloud_id) },
  { name: "jira_issue_links_issue_id_check", holds: (row) => typeof row.issue_id === "string" && /^[0-9]{1,18}$/.test(row.issue_id) },
  { name: "jira_issue_links_identifier_check", holds: (row) => typeof row.identifier === "string" && /^[A-Z][A-Z0-9_]{0,49}-[0-9]{1,18}$/.test(row.identifier) },
  { name: "jira_issue_links_project_id_check", holds: (row) => matchOk(row.project_id, /^[0-9]{1,18}$/) },
  { name: "jira_issue_links_project_key_check", holds: (row) => matchOk(row.project_key, /^[A-Z][A-Z0-9_]{0,49}$/) },
  { name: "jira_issue_links_issue_title_check", holds: (row) => typeof row.issue_title === "string" && row.issue_title.length >= 1 && row.issue_title.length <= 255 },
  {
    name: "jira_issue_links_issue_url_check",
    holds: (row) => absent(row.issue_url) || (typeof row.issue_url === "string" && /^https:\/\/[^/\s]{3,253}\/browse\/[A-Z][A-Z0-9_]{0,49}-[0-9]{1,18}$/.test(row.issue_url) && row.issue_url.length <= 500),
  },
  { name: "jira_issue_links_state_check", holds: (row) => ["waiting", "ready", "accepted", "held"].includes(String(row.state)) },
  { name: "jira_issue_links_held_reason_check", holds: (row) => absent(row.held_reason) || ["reopened", "canceled", "deliverable_changed", "issue_unreachable", "no_criteria", "unlinked"].includes(String(row.held_reason)) },
  { name: "jira_issue_links_status_category_check", holds: (row) => matchOk(row.status_category, /^[a-z_-]{1,40}$/) },
  { name: "jira_issue_links_status_name_check", holds: (row) => textOk(row.status_name, 200) },
  { name: "jira_issue_links_resolution_name_check", holds: (row) => textOk(row.resolution_name, 200) },
  { name: "jira_issue_links_deliverables_check", holds: (row) => listOk(row.deliverables) },
  { name: "jira_issue_links_fingerprint_check", holds: (row) => matchOk(row.deliverable_fingerprint, HEX64) },
  { name: "jira_issue_links_attachments_read_check", holds: (row) => countOk(row.attachments_read) },
  { name: "jira_issue_links_remote_links_read_check", holds: (row) => countOk(row.remote_links_read) },
  { name: "jira_issue_links_comments_read_check", holds: (row) => countOk(row.comments_read) },
  { name: "jira_issue_links_read_error_check", holds: (row) => textOk(row.read_error, 300) },
  { name: "jira_issue_links_accepted_fingerprint_check", holds: (row) => matchOk(row.accepted_fingerprint, HEX64) },
  { name: "jira_issue_links_accepted_criteria_check", holds: (row) => matchOk(row.accepted_criteria_sha256, HEX64) },
  { name: "jira_issue_links_accepted_deliverables_check", holds: (row) => absent(row.accepted_deliverables) || listOk(row.accepted_deliverables) },
  { name: "jira_issue_links_held_check", holds: (row) => (row.state === "held") === !absent(row.held_reason) },
  { name: "jira_issue_links_accepted_check", holds: (row) => row.state !== "accepted" || (!absent(row.accepted_at) && !absent(row.accepted_fingerprint)) },
  { name: "jira_issue_links_completed_check", holds: (row) => row.completed === true || absent(row.completed_at) },
];

/** 0149's checks on `jira_sites`. */
const SITE_CHECKS: Array<{ name: string; holds: (row: Row) => boolean }> = [
  { name: "jira_sites_cloud_id_check", holds: (row) => typeof row.cloud_id === "string" && UUID.test(row.cloud_id) },
  {
    name: "jira_sites_site_url_check",
    holds: (row) => typeof row.site_url === "string" && /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(row.site_url) && row.site_url.length <= 261,
  },
  { name: "jira_sites_webhook_ids_check", holds: (row) => Array.isArray(row.webhook_ids) && row.webhook_ids.length <= 5 },
  { name: "jira_sites_retired_webhook_ids_check", holds: (row) => Array.isArray(row.retired_webhook_ids) && row.retired_webhook_ids.length <= 5 },
  { name: "jira_sites_webhook_jql_check", holds: (row) => textOk(row.webhook_jql, 4000) },
  { name: "jira_sites_webhook_error_check", holds: (row) => textOk(row.webhook_error, 300) },
];

export interface FakeIssue {
  id: string;
  key: string;
  title: string;
  projectId: string;
  projectKey: string;
  category: "new" | "indeterminate" | "done";
  statusName: string;
  resolution: string | null;
  categoryChanged: string | null;
  resolved: string | null;
  updated: string;
  description: unknown;
  attachments: Array<{ id: string; filename: string; created: string }>;
  remoteLinks: Array<{ id: number; object: { url: string; title: string } }>;
  comments: Array<{ id: string; created: string; body: unknown }>;
}

interface FakeWebhook {
  id: number;
  jqlFilter: string;
  events: string[];
  expirationDate: number;
  url: string;
}

/** A paragraph of Atlassian's document format with one linked word. */
export const adfLink = (word: string, href: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: `${word} `, marks: [] }, { type: "text", text: word, marks: [{ type: "link", attrs: { href } }] }] }],
});

export function jiraWorld(hooks: WorldHooks, options: { payeeEmail?: string | null; ownerAtlassianIsPayee?: boolean; secondWorkspace?: boolean } = {}) {
  const clock = { now: NOW };
  const iso = (ms: number = clock.now) => new Date(ms).toISOString();

  const connectionRow = (id: string, orgId: string, connectedBy: string, cloudId = CLOUD, name = "Northstar") => ({
    id, org_id: orgId, provider: "jira", external_org_id: cloudId, external_org_name: name, status: "connected", scopes: ["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"],
    connected_by: connectedBy, connected_at: "2026-11-09T08:00:00Z", consent_version: "jira-2026-11-09", consented_at: "2026-11-09T08:00:00Z", revoked_at: null,
    window_from: "2026-08-11", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
    payment_account: null, payment_account_at: null, created_at: "2026-11-09T08:00:00Z",
  });
  const milestoneRow = (id: string, orgId: string, title: string, criteria: string | null, created: string) => ({
    id, org_id: orgId, title, amount: "450", contractor_id: FERNHILL, status: "pending", verified: false, verification_method: "unverified", verification_status: "unverified",
    verification_source: null, verification_detail: null, acceptance_criteria: criteria, decision_claimed_at: null, created_at: created,
  });

  const fail = (status: number, code: string, message: string): FakeReply => ({ status, body: { code, message, details: null, hint: null } });
  const links = () => database.rows("jira_issue_links");
  const milestones = () => database.rows("milestones");

  const acceptRpc = (body: Row): FakeReply => {
    const link = links().find((row) => row.id === body.p_link_id && row.org_id === body.p_org_id && absent(row.unlinked_at));
    if (!link) return fail(400, "P0001", "link_not_found: no linked issue with that id in this organization");
    if (link.state === "accepted") return fail(400, "P0001", "already_accepted: this work was accepted already");
    if (link.after_payment) return fail(400, "P0001", "after_payment: a payment for this milestone was sent before the issue changed");
    if (!link.completed) return fail(400, "P0001", "not_completed: the issue is not done in Jira");
    if (absent(link.deliverable_fingerprint) || link.deliverable_fingerprint !== body.p_fingerprint) return fail(400, "P0001", "stale: the deliverables changed since they were shown");
    const milestone = milestones().find((row) => row.id === link.milestone_id && row.org_id === body.p_org_id);
    if (!milestone) return fail(400, "P0001", "link_not_found: no milestone for that link");
    if (milestone.status !== "pending") return fail(400, "P0001", `milestone_not_open: the milestone is ${milestone.status} now`);
    if (absent(milestone.acceptance_criteria)) return fail(400, "P0001", "no_criteria: the milestone has no acceptance criteria");
    if (sha(String(milestone.acceptance_criteria)) !== body.p_criteria_sha256) return fail(400, "P0001", "criteria_changed: the acceptance criteria changed since they were shown");
    const accepted = {
      state: "accepted", held_reason: null, held_at: null, accepted_by: body.p_by, accepted_at: iso(), accepted_fingerprint: link.deliverable_fingerprint,
      accepted_completed_at: link.completed_at, accepted_criteria_sha256: body.p_criteria_sha256, accepted_deliverables: link.deliverables, updated_at: iso(),
    };
    const broken = LINK_CHECKS.find((check) => !check.holds({ ...link, ...accepted }));
    if (broken) return fail(400, "23514", `new row for relation "jira_issue_links" violates check constraint "${broken.name}"`);
    Object.assign(milestone, {
      verified: true, status: "verified", verification_method: "jira", verification_status: "verified",
      verification_detail: { note: body.p_note, jiraIssue: link.issue_url, issueId: link.issue_id, identifier: link.identifier, cloudId: link.cloud_id, completedAt: link.completed_at, fingerprint: link.deliverable_fingerprint, criteriaSha256: body.p_criteria_sha256, acceptedBy: body.p_by },
    });
    Object.assign(link, accepted);
    return { body: { ...link } };
  };
  const holdRpc = (body: Row): FakeReply => {
    if (!["reopened", "canceled", "deliverable_changed", "issue_unreachable", "unlinked"].includes(String(body.p_reason))) return fail(400, "P0001", `bad_reason: ${body.p_reason}`);
    const link = links().find((row) => row.id === body.p_link_id && row.org_id === body.p_org_id && absent(row.unlinked_at));
    if (!link || link.state !== "accepted") return { body: "not_accepted" };
    const milestone = milestones().find((row) => row.id === link.milestone_id && row.org_id === body.p_org_id) as Row;
    const underway = milestone.status === "paid" || database.rows("payment_intents").some((intent) => intent.source_type === "milestone" && intent.source_id === milestone.id && intent.status !== "failed");
    const claimed = absent(milestone.decision_claimed_at) ? null : Date.parse(String(milestone.decision_claimed_at));
    if (!underway && milestone.status !== "closed" && claimed !== null && claimed > clock.now - 10 * 60_000) return { body: "deferred" };
    if (!underway && milestone.status !== "closed" && milestone.verification_method === "jira") {
      Object.assign(milestone, {
        verified: false, status: ["verified", "held"].includes(String(milestone.status)) ? "pending" : milestone.status, verification_status: "unverified",
        verification_detail: { ...((milestone.verification_detail as Row | null) ?? {}), heldReason: body.p_reason, heldAt: iso() },
      });
    }
    Object.assign(link, { state: "held", held_reason: body.p_reason, held_at: iso(), after_payment: underway, updated_at: iso() });
    return { body: underway ? "held_after_payment" : "held" };
  };

  const members = [
    { user_id: OWNER, email: "owner@business.example", role: "owner", joined_at: "2026-10-01T00:00:00Z" },
    { user_id: ADMIN, email: "admin@business.example", role: "admin", joined_at: "2026-10-01T00:00:00Z" },
    { user_id: PAYEE_MEMBER, email: "Mai@Fernhill.example", role: "admin", joined_at: "2026-10-01T00:00:00Z" },
  ];

  const database = memoryPostgrest({
    specs: {
      jira_issue_links: {
        columns: LINK_TABLE_COLUMNS,
        checks: LINK_CHECKS,
        defaults: () => ({
          id: crypto.randomUUID(), state: "waiting", held_reason: null, after_payment: false, held_at: null, status_category: null, status_name: null, resolution_name: null,
          completed: false, completed_at: null, deliverables: [], deliverable_fingerprint: null, attachments_read: 0, remote_links_read: 0, comments_read: 0, more_unread: false,
          issue_updated_at: null, last_read_at: null, read_error: null, accepted_by: null, accepted_at: null, accepted_fingerprint: null, accepted_completed_at: null,
          accepted_criteria_sha256: null, accepted_deliverables: null, linked_by: null, linked_at: iso(), unlinked_by: null, unlinked_at: null, updated_at: iso(),
        }),
      },
      jira_sites: {
        columns: SITE_TABLE_COLUMNS,
        checks: SITE_CHECKS,
        unique: [["connection_id"]],
        defaults: () => ({ webhook_ids: [], retired_webhook_ids: [], retired_until: null, webhook_jql: null, webhook_expires_at: null, webhook_registered_at: null, webhook_checked_at: null, webhook_error: null, last_delivery_at: null, missed_change_at: null, site_missing_at: null, updated_at: iso() }),
      },
    },
    seed: {
      accounting_connections: [connectionRow(CONN, ORG, OWNER), ...(options.secondWorkspace ? [connectionRow(OTHER_CONN, OTHER_ORG, OWNER)] : [])],
      milestones: [
        milestoneRow(EXPORT, ORG, "Webhook retries", CRITERIA, "2026-11-01T00:00:00Z"),
        milestoneRow(DOCS, ORG, "Billing export", null, "2026-11-02T00:00:00Z"),
        milestoneRow(STATUS, ORG, "Status page", "The status page, live, with its three checks.", "2026-11-03T00:00:00Z"),
        milestoneRow(OTHER_EXPORT, OTHER_ORG, "Webhook retries", CRITERIA, "2026-11-01T00:00:00Z"),
      ],
      counterparties: [
        { id: FERNHILL, org_id: ORG, name: "Fernhill Studio", notice_email: options.payeeEmail === undefined ? "mai@fernhill.example" : options.payeeEmail },
        { id: FERNHILL, org_id: OTHER_ORG, name: "Fernhill Studio", notice_email: "mai@fernhill.example" },
      ],
      jira_issue_links: [],
      jira_sites: [],
      payment_intents: [],
    },
    rpc: {
      accept_jira_issue: acceptRpc,
      hold_jira_acceptance: holdRpc,
      jira_connector_ready: () => ({ body: true }),
      org_members: () => ({ body: members }),
    },
    // 0149's two partial unique indexes: one live link per milestone, and one per issue of a site.
    before: (request: RecordedRequest) => {
      if (request.method !== "POST" || request.path !== "/rest/v1/jira_issue_links") return;
      for (const given of (Array.isArray(request.body) ? request.body : [request.body]) as Row[]) {
        const live = links().filter((row) => absent(row.unlinked_at) && row.org_id === given.org_id);
        if (live.some((row) => row.milestone_id === given.milestone_id)) return fail(409, "23505", 'duplicate key value violates unique constraint "jira_issue_links_milestone_key"');
        if (live.some((row) => row.cloud_id === given.cloud_id && row.issue_id === given.issue_id)) return fail(409, "23505", 'duplicate key value violates unique constraint "jira_issue_links_issue_key"');
      }
    },
  });

  // Atlassian: the sites each token reaches, the issues of each site, and the app's webhooks there.
  const sites: Array<{ id: string; name: string; url: string; scopes: string[] }> = [{ id: CLOUD, name: "Northstar", url: SITE_URL, scopes: ["read:jira-work", "read:jira-user", "manage:jira-webhook"] }];
  const issue = (id: string, key: string, title: string, projectId: string, description: unknown): FakeIssue => ({
    id, key, title, projectId, projectKey: key.split("-")[0], category: "indeterminate", statusName: "In Progress", resolution: null, categoryChanged: "2026-11-08T10:00:00.000+0000",
    resolved: null, updated: "2026-11-08T10:00:00.000+0000", description, attachments: [], remoteLinks: [], comments: [],
  });
  const issues = new Map<string, Map<string, FakeIssue>>([
    [
      CLOUD,
      new Map([
        [ENG_142, issue(ENG_142, "ENG-142", "Webhook retries with backoff", ENG, adfLink("Spec", "https://www.figma.com/file/AbC123/webhooks"))],
        [ENG_143, issue(ENG_143, "ENG-143", "Billing export", ENG, adfLink("Preview", "https://docs.fernhill.example/preview"))],
        [OPS_7, issue(OPS_7, "OPS-7", "Status page", OPS, adfLink("Status", "https://status.fernhill.example"))],
      ]),
    ],
    // Southwind holds an issue with ENG-142's numeric id: it is never read for a Northstar link.
    [NEW_CLOUD, new Map([[ENG_142, issue(ENG_142, "SW-9", "Unrelated work", "10500", null)]])],
  ]);
  const webhooks = new Map<string, Map<number, FakeWebhook>>([
    [CLOUD, new Map()],
    [NEW_CLOUD, new Map()],
  ]);
  let nextWebhookId = 101;

  const jira = {
    /** Every request made to Atlassian, as `METHOD path`, with the depth of each issue read. */
    calls: [] as string[],
    /** The bodies sent to Atlassian, by request. */
    bodies: [] as Array<{ call: string; body: unknown }>,
    people: [] as string[],
    validTokens: new Set(["jira_access_1"]),
    refreshToken: "jira_refresh_1",
    refreshes: 0,
    revoked: false,
    down: false,
    /** The next registrations Jira refuses, in its words. */
    refuseRegistrations: 0,
    /** How `PUT /webhook/refresh`, then `PUT /webhook`, answer: an expiry far off, or this status. */
    refreshAnswer: "ok" as "ok" | 404 | 405 | "short",
    guideAnswer: "ok" as "ok" | 404 | "short",
    /** The change check refuses the whole search, as Jira does when an id was deleted or hidden. */
    searchRefused: false,
    /** Every REST call answers 429 for Atlassian's whole pool. */
    quotaSpent: false,
    /** The accounts with each email on the site, as user search answers them. */
    accounts: new Map<string, string[]>([
      ["mai@fernhill.example", [MAI_ATLASSIAN]],
      ["owner@business.example", [OWNER_ATLASSIAN]],
    ]),
  };
  if (options.ownerAtlassianIsPayee) {
    jira.accounts.set("mai@fernhill.example", [OWNER_ATLASSIAN]);
    jira.accounts.delete("owner@business.example");
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const issueJson = (cloud: string, one: FakeIssue, full: boolean) => ({
    id: one.id,
    key: one.key,
    self: `https://api.atlassian.com/ex/jira/${cloud}/rest/api/3/issue/${one.id}`,
    fields: {
      summary: one.title,
      status: { name: one.statusName, statusCategory: { key: one.category } },
      resolution: one.resolution ? { name: one.resolution } : null,
      resolutiondate: one.resolved,
      statuscategorychangedate: one.categoryChanged,
      updated: one.updated,
      project: { id: one.projectId, key: one.projectKey },
      ...(full
        ? {
            description: one.description,
            attachment: one.attachments.map((file) => ({ id: file.id, filename: file.filename, created: file.created })),
            comment: { comments: one.comments, total: one.comments.length, maxResults: 50, startAt: 0 },
          }
        : {}),
    },
  });

  const jiraFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    if (url.hostname === "auth.atlassian.com" && url.pathname === "/oauth/token") {
      jira.calls.push("POST /oauth/token");
      if (jira.revoked || body?.refresh_token !== jira.refreshToken) return json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403);
      jira.refreshes += 1;
      const access = `jira_access_${jira.refreshes + 1}`;
      jira.validTokens.add(access);
      jira.refreshToken = `jira_refresh_${jira.refreshes + 1}`;
      return json({ access_token: access, refresh_token: jira.refreshToken, expires_in: 3600, scope: "read:jira-work read:jira-user manage:jira-webhook offline_access", token_type: "Bearer" });
    }
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (url.pathname === "/oauth/token/accessible-resources") {
      jira.calls.push("GET /accessible-resources");
      if (!jira.validTokens.has(token)) return json({ code: 401, message: "Unauthorized" }, 401);
      return json(sites.map((site) => ({ ...site, avatarUrl: "https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png" })));
    }
    const route = /^\/ex\/jira\/([0-9a-f-]{36})\/rest\/api\/3(\/.*)$/.exec(url.pathname);
    if (!route) return json({}, 404);
    const [, cloud, path] = route;
    const fields = url.searchParams.get("fields") ?? "";
    const label =
      path.startsWith("/issue/") && !path.endsWith("/remotelink") && !path.endsWith("/comment")
        ? `${method} ${path} ${fields.includes("description") ? "full" : "status"}`
        : path === "/search/jql"
          ? `${method} ${path} ${url.searchParams.get("jql") ?? ""} ${fields}`
          : `${method} ${path}`;
    jira.calls.push(cloud === CLOUD ? label : `${label} @${cloud}`);
    if (body !== undefined) jira.bodies.push({ call: label, body });
    if (jira.quotaSpent) return json({ message: "Rate limited" }, 429, { "retry-after": "120", "ratelimit-reason": "jira-quota-global-based" });
    if (!jira.validTokens.has(token)) return json({ code: 401, message: "Client must be authenticated to access this resource." }, 401);
    if (jira.down) return json({ errorMessages: ["Internal server error"] }, 503);
    const onSite = issues.get(cloud) ?? new Map<string, FakeIssue>();
    const hooksOf = webhooks.get(cloud) ?? new Map<number, FakeWebhook>();

    const issueRoute = /^\/issue\/([^/]+)(\/remotelink|\/comment)?$/.exec(path);
    if (issueRoute) {
      const ref = issueRoute[1];
      const one = onSite.get(ref) ?? [...onSite.values()].find((candidate) => candidate.key === ref);
      if (!one) return json({ errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} }, 404);
      if (issueRoute[2] === "/remotelink") return json(one.remoteLinks);
      if (issueRoute[2] === "/comment") return json({ comments: one.comments, total: one.comments.length, startAt: 0, maxResults: 50 });
      return json(issueJson(cloud, one, fields.includes("description")));
    }
    if (path === "/search/jql") {
      const ids = (/^id in \(([^)]*)\)$/.exec(url.searchParams.get("jql") ?? "")?.[1] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      if (jira.searchRefused || ids.some((id) => !onSite.has(id))) return json({ errorMessages: ["An issue with key '10999' does not exist for field 'id'."] }, 400);
      return json({ issues: ids.map((id) => ({ id, fields: { updated: (onSite.get(id) as FakeIssue).updated } })), isLast: true });
    }
    if (path === "/myself") return json({ accountId: OWNER_ATLASSIAN, accountType: "atlassian", active: true });
    if (path === "/user/search") {
      const email = (url.searchParams.get("query") ?? "").toLowerCase();
      jira.people.push(email);
      return json((jira.accounts.get(email) ?? []).map((accountId) => ({ accountId, accountType: "atlassian", emailAddress: email, active: true })));
    }
    if (path === "/webhook" && method === "POST") {
      if (jira.refuseRegistrations > 0) {
        jira.refuseRegistrations -= 1;
        return json({ webhookRegistrationResult: [{ errors: ["The app already has the most webhooks allowed for this user."] }] });
      }
      const id = nextWebhookId++;
      hooksOf.set(id, { id, jqlFilter: body.webhooks[0].jqlFilter, events: body.webhooks[0].events, expirationDate: clock.now + 30 * DAY, url: body.url });
      return json({ webhookRegistrationResult: [{ createdWebhookId: id }] });
    }
    if (path === "/webhook" && method === "GET") return json({ values: [...hooksOf.values()], isLast: true, startAt: 0, maxResults: 100, total: hooksOf.size });
    if (path === "/webhook" && method === "DELETE") {
      for (const id of body.webhookIds as number[]) hooksOf.delete(id);
      return new Response(null, { status: 202 });
    }
    if ((path === "/webhook/refresh" || path === "/webhook") && method === "PUT") {
      const answer = path === "/webhook/refresh" ? jira.refreshAnswer : jira.guideAnswer;
      if (typeof answer === "number") return json({ errorMessages: ["Not found"] }, answer);
      const until = clock.now + (answer === "short" ? 2 * DAY : 30 * DAY);
      for (const id of body.webhookIds as number[]) {
        const hook = hooksOf.get(id);
        if (hook) hook.expirationDate = until;
      }
      return json({ expirationDate: until });
    }
    return json({ errorMessages: ["Unknown"] }, 404);
  }) as unknown as typeof fetch;

  const pause: JiraPause = { until: 0 };
  const provider = jiraProvider({ clientId: "jira-client-0001", clientSecret: "jira-secret" }, { fetchImpl: jiraFetch, now: () => clock.now, pause });

  // The token rows: good far past any test's clock, so a refresh happens only when Atlassian refuses the token.
  const tokens = new Map<string, StoredTokens>();
  const holders = new Map<string, string | null>();
  const tokenOf = (connectionId: string) =>
    tokens.get(connectionId) ?? { id: `token-${connectionId}`, version: 1, accessToken: "jira_access_1", refreshToken: "jira_refresh_1", expiresAt: Date.parse("2100-01-01T00:00:00Z"), scopes: ["read:jira-work"] };
  hooks.tokens = (connectionId) => ({
    read: async () => ({ ...tokenOf(connectionId) }),
    lease: async (who) => {
      const holder = holders.get(connectionId) ?? null;
      if (holder && holder !== who) return null;
      holders.set(connectionId, who);
      return { ...tokenOf(connectionId) };
    },
    store: async (who, version, next) => {
      const row = tokenOf(connectionId);
      if (holders.get(connectionId) !== who || version !== row.version) return false;
      tokens.set(connectionId, { ...row, ...next, version: row.version + 1 });
      holders.set(connectionId, null);
      return true;
    },
    release: async (who) => {
      if (holders.get(connectionId) === who) holders.set(connectionId, null);
    },
  });

  const runIn = <T,>(orgId: string, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: database.client, orgId }), fn);
  const run = <T,>(fn: () => Promise<T>) => runIn(ORG, fn);
  /** The webhook route's own scope: no workspace yet, as a delivery names none. */
  const platform = <T,>(fn: () => Promise<T>) => runWith({ config, db: database.client, fetch: database.fetch }, fn);
  hooks.enter = runIn;

  const fakeIssue = (id: string, cloud = CLOUD) => issues.get(cloud)?.get(id) as FakeIssue;
  /** Moves an issue on in Jira, `updated` with it, as Jira does. */
  const change = (id: string, fields: Partial<FakeIssue>, at: number = clock.now) => {
    Object.assign(fakeIssue(id), fields, { updated: jiraTime(at) });
  };
  const jiraTime = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");
  const done = (id: string, at: number = clock.now - 60 * 60_000, resolution: string | null = "Done") =>
    change(id, { category: "done", statusName: "Done", resolution, categoryChanged: jiraTime(at), resolved: jiraTime(at) }, at);
  const reopen = (id: string, at: number = clock.now) => change(id, { category: "indeterminate", statusName: "In Progress", resolution: null, resolved: null, categoryChanged: jiraTime(at) }, at);

  /** A link as the link command makes it, the issue as Jira says it now, and its first read not yet made. */
  const link = async (milestoneId: string, issueId: string, orgId = ORG, connectionId = orgId === ORG ? CONN : OTHER_CONN, cloudId = CLOUD): Promise<IssueLink> => {
    const one = fakeIssue(issueId, cloudId);
    const made = await runIn(orgId, () =>
      insertLink({
        milestoneId, connectionId, cloudId, issueId, identifier: one.key, projectId: one.projectId, projectKey: one.projectKey, issueTitle: one.title,
        issueUrl: `${cloudId === CLOUD ? SITE_URL : NEW_SITE_URL}/browse/${one.key}`, by: ADMIN,
      })
    );
    if (!made.ok) throw new Error(made.reason);
    return made.link;
  };
  const row = (milestoneId: string, orgId = ORG) => links().find((one) => one.milestone_id === milestoneId && one.org_id === orgId && absent(one.unlinked_at)) as Row;
  const live = (milestoneId: string, orgId = ORG) => runIn(orgId, async () => (await liveLinks({ milestoneIds: [milestoneId] }))[0]);
  const milestone = (id: string, orgId = ORG) => milestones().find((one) => one.id === id && one.org_id === orgId) as Row;
  const connection = (id = CONN) => database.rows("accounting_connections").find((one) => one.id === id) as Row;
  const site = (connectionId = CONN) => database.rows("jira_sites").find((one) => one.connection_id === connectionId) as Row | undefined;
  /** The site row as the connect flow's first upkeep leaves it, with a webhook already made for these projects. */
  const seedSite = (fields: Row = {}, connectionId = CONN, orgId = ORG) =>
    database.rows("jira_sites").push({
      connection_id: connectionId, org_id: orgId, cloud_id: CLOUD, site_url: SITE_URL, webhook_ids: [], retired_webhook_ids: [], retired_until: null, webhook_jql: null,
      webhook_expires_at: null, webhook_registered_at: null, webhook_checked_at: null, webhook_error: null, last_delivery_at: null, missed_change_at: null, site_missing_at: null,
      updated_at: iso(), ...fields,
    });
  /** A webhook Jira already has for this site, made by this app. */
  const seedWebhook = (jql: string, fields: Partial<FakeWebhook> = {}, cloud = CLOUD) => {
    const id = nextWebhookId++;
    webhooks.get(cloud)?.set(id, { id, jqlFilter: jql, events: ["jira:issue_updated"], expirationDate: clock.now + 30 * DAY, url: WEBHOOK_URL, ...fields });
    return id;
  };
  /** Issue reads, each one request for the issue itself (a full read also asks for its web links). */
  const issueReads = (id?: string) => jira.calls.filter((call) => /^GET \/issue\/[^/ ]+ (status|full)/.test(call) && (id === undefined || call.startsWith(`GET /issue/${id} `))).length;
  /** Requests to a site's REST API, the change check and webhooks included; the token endpoint and the site list are not. */
  const restCalls = () => jira.calls.filter((call) => !call.startsWith("POST /oauth/token") && call !== "GET /accessible-resources");

  return {
    clock, iso, database, provider, pause, jira, sites, issues, webhooks, run, runIn, platform, fakeIssue, change, done, reopen, link, row, live, milestone, connection, site,
    seedSite, seedWebhook, issueReads, restCalls, jiraTime,
    expireAtJira: () => void jira.validTokens.clear(),
    revokeAtAtlassian: () => {
      jira.validTokens.clear();
      jira.revoked = true;
    },
    token: (connectionId = CONN) => tokenOf(connectionId),
    /** Connects the site Southwind to the workspace in place of Northstar: a new connection, Northstar's revoked. */
    connectSouthwind: () => {
      Object.assign(connection(CONN), { status: "revoked", revoked_at: iso() });
      database.rows("accounting_connections").push(connectionRow(NEW_CONN, ORG, OWNER, NEW_CLOUD, "Southwind"));
      sites.splice(0, sites.length, { id: NEW_CLOUD, name: "Southwind", url: NEW_SITE_URL, scopes: ["read:jira-work", "read:jira-user", "manage:jira-webhook"] });
    },
  };
}

export type JiraWorld = ReturnType<typeof jiraWorld>;
