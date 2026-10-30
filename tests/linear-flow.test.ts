import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { acceptLinearWork, checkLinearIssue, linkLinearIssue, setLinearAcceptanceCriteria, unlinkLinearIssue } from "@/lib/commands/linear";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { approvesOwnLinearPayout } from "@/lib/linear/identities";
import { linearProvider } from "@/lib/linear/provider";
import { markRevokedAtLinear, recheckLinearBeforeSending, refreshLinearMilestones, rereadForDelivery, rereadIssueInScope, syncLinearConnection } from "@/lib/linear/workspace";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Contractor work accepted from Linear, end to end over the real stores and commands
 * (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN4 to LN13): the database is a recorded PostgREST that
 * refuses what migration 0147's checks refuse, and whose two functions, `accept_linear_issue` and
 * `hold_linear_acceptance`, answer as 0147's do (that SQL is tested on its own in tests/linear-migration.test.ts);
 * Linear is a fake GraphQL API holding two issues of the Fernhill workspace, ENG-123 "Billing export" and ENG-124
 * "Docs site", which answers an expired token with 401 and rotates the refresh token on each refresh, as Linear does.
 */

const { ledger } = vi.hoisted(() => ({ ledger: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledger }));
vi.mock("@/lib/usage/record", () => ({ recordUsage: vi.fn(async () => undefined) }));
const { tokenRow, scope } = vi.hoisted(() => ({
  tokenRow: { current: null as null | { store: (connectionId: string) => TokenStore } },
  scope: { enter: null as null | (<T>(orgId: string, fn: () => Promise<T>) => Promise<T>) },
}));
vi.mock("@/lib/connectors/token-store", async (original) => ({
  ...(await original<typeof import("@/lib/connectors/token-store")>()),
  connectionTokenStore: (_orgId: string, connectionId: string) => tokenRow.current?.store(connectionId),
}));
// A delivery names no Vestiarion workspace: each one connected is entered in turn, here over the same recorded database.
vi.mock("@/lib/dal/scope", async (original) => ({
  ...(await original<typeof import("@/lib/dal/scope")>()),
  withOrg: <T,>(orgId: string, fn: () => Promise<T>) => (scope.enter ? scope.enter(orgId, fn) : Promise.reject(new Error("no scope"))),
}));
vi.mock("@/lib/agent/cycle-soon", async (original) => ({ ...(await original<typeof import("@/lib/agent/cycle-soon")>()), runCycleSoon: vi.fn() }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1a01";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1a02";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1a11";
const ADMIN = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1a12";
const PAYEE_MEMBER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1a13";
const EXPORT = "aaaaaaaa-0000-4000-8000-00000000c1a1";
const DOCS = "aaaaaaaa-0000-4000-8000-00000000c1a2";
const OTHER_EXPORT = "aaaaaaaa-0000-4000-8000-00000000c1a3";
const FERNHILL = "cccccccc-0000-4000-8000-00000000c1a1";
const LINEAR_ORG = "8c5d2f62-0a5b-4a8e-9c1e-2b7f0f6c1a01";
const OTHER_LINEAR_ORG = "8c5d2f62-0a5b-4a8e-9c1e-2b7f0f6c1a99";
const EXPORT_ISSUE = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01";
const DOCS_ISSUE = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c02";
const OWNER_LINEAR = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a01";
const MAI_LINEAR = "3b4c5d6e-7f8a-4b9c-8d0e-1f2a3b4c5d01";
const NOW = Date.parse("2026-10-31T09:00:00Z");
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const sha = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const EXPORT_CRITERIA = "The billing export screen, CSV and PDF, with tests, merged behind its flag.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const actor = (userId = ADMIN, fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId, role: "admin", mode: "live", surface: { kind: "console" }, ...fields });

type Row = Record<string, unknown>;

/** A tiny PostgREST over arrays: the filters supabase-js builds, enough for these stores. */
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "columns", "on_conflict"].includes(key)) continue;
    if (key === "or") {
      const parts = raw.replace(/^\(|\)$/g, "").split(",");
      if (!parts.some((part) => test(row, part.slice(0, part.indexOf(".")), part.slice(part.indexOf(".") + 1)))) return false;
      continue;
    }
    if (!test(row, key, raw)) return false;
  }
  return true;
}
function test(row: Row, column: string, filter: string): boolean {
  const value = row[column];
  const [op, ...rest] = filter.split(".");
  const arg = rest.join(".");
  switch (op) {
    case "eq":
      return String(value) === arg;
    case "neq":
      return String(value) !== arg;
    case "in":
      return arg.replace(/^\(|\)$/g, "").split(",").map((one) => one.replace(/^"|"$/g, "")).includes(String(value));
    case "is":
      return arg === "null" ? value === null || value === undefined : String(value) === arg;
    case "not":
      return !test(row, column, arg);
    case "lte":
      return value !== null && value !== undefined && String(value) <= arg;
    case "gte":
      return value !== null && value !== undefined && String(value) >= arg;
    default:
      throw new Error(`filter ${filter} not in this fake`);
  }
}

/**
 * Migration 0147's columns and checks on `linear_issue_links`, as Postgres holds them: an insert or an update that breaks
 * one is refused whole, as Postgres refuses it, and a column the table does not have is refused too.
 */
const LINK_COLUMNS = new Set(
  "id org_id milestone_id connection_id issue_id identifier team_id team_key issue_title issue_url state held_reason after_payment held_at state_type state_name completed completed_at completed_by_id completed_by_name assignee_id assignee_name archived deliverables deliverable_fingerprint attachments_read comments_read more_unread issue_updated_at last_read_at read_error accepted_by accepted_at accepted_fingerprint accepted_completed_at accepted_criteria_sha256 accepted_deliverables linked_by linked_at unlinked_by unlinked_at updated_at".split(
    " "
  )
);
const HEX64 = /^[0-9a-f]{64}$/;
/** A jsonb value as Postgres writes it out (`::text`): a space after each colon and each comma between items. */
const jsonbText = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).filter(([, one]) => one !== undefined);
    return `{${fields.map(([key, one]) => `${JSON.stringify(key)}: ${jsonbText(one)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
};
/** `jsonb_typeof(v) = 'array' and octet_length(v::text) <= 32000`, 0147's check on both lists of deliverables. */
const listOk = (value: unknown) => Array.isArray(value) && Buffer.byteLength(jsonbText(value), "utf8") <= 32_000;
const nameOk =(value: unknown) => value === null || value === undefined || (typeof value === "string" && value.length >= 1 && value.length <= 200);
const uuidOk = (value: unknown) => value === null || value === undefined || (typeof value === "string" && UUID.test(value));
function brokenCheck(row: Row): string | null {
  if (typeof row.issue_id !== "string" || !UUID.test(row.issue_id)) return "linear_issue_links_issue_id_check";
  if (typeof row.identifier !== "string" || !/^[A-Z][A-Z0-9_]{0,9}-[0-9]{1,9}$/.test(row.identifier)) return "linear_issue_links_identifier_check";
  if (!uuidOk(row.team_id)) return "linear_issue_links_team_id_check";
  if (!(row.team_key === null || row.team_key === undefined || /^[A-Z][A-Z0-9_]{0,9}$/.test(String(row.team_key)))) return "linear_issue_links_team_key_check";
  if (typeof row.issue_title !== "string" || row.issue_title.length < 1 || row.issue_title.length > 200) return "linear_issue_links_issue_title_check";
  if (!(row.issue_url === null || row.issue_url === undefined || (String(row.issue_url).startsWith("https://linear.app/") && String(row.issue_url).length <= 500))) return "linear_issue_links_issue_url_check";
  if (!["waiting", "ready", "accepted", "held"].includes(String(row.state))) return "linear_issue_links_state_check";
  if (!(row.held_reason === null || ["reopened", "canceled", "deliverable_changed", "archived", "issue_unreachable", "no_criteria", "unlinked"].includes(String(row.held_reason)))) {
    return "linear_issue_links_held_reason_check";
  }
  if (!(row.state_type === null || row.state_type === undefined || /^[a-z_]{1,40}$/.test(String(row.state_type)))) return "linear_issue_links_state_type_check";
  for (const column of ["state_name", "completed_by_name", "assignee_name"]) if (!nameOk(row[column])) return `linear_issue_links_${column}_check`;
  for (const column of ["completed_by_id", "assignee_id"]) if (!uuidOk(row[column])) return `linear_issue_links_${column}_check`;
  if (!(row.deliverable_fingerprint === null || HEX64.test(String(row.deliverable_fingerprint)))) return "linear_issue_links_fingerprint_check";
  if (!(Number(row.attachments_read) >= 0 && Number(row.attachments_read) <= 50)) return "linear_issue_links_attachments_read_check";
  if (!(Number(row.comments_read) >= 0 && Number(row.comments_read) <= 100)) return "linear_issue_links_comments_read_check";
  if (!(row.read_error === null || (String(row.read_error).length >= 1 && String(row.read_error).length <= 300))) return "linear_issue_links_read_error_check";
  if (!listOk(row.deliverables)) return "linear_issue_links_deliverables_check";
  if (!(row.accepted_deliverables === null || row.accepted_deliverables === undefined || listOk(row.accepted_deliverables))) return "linear_issue_links_accepted_deliverables_check";
  if ((row.state === "held") !== (row.held_reason !== null)) return "linear_issue_links_held_check";
  if (row.state === "accepted" && !(row.accepted_at && row.accepted_fingerprint)) return "linear_issue_links_accepted_check";
  if (!row.completed && row.completed_at !== null) return "linear_issue_links_completed_check";
  return null;
}

interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateType: string;
  stateName: string;
  completedAt: string | null;
  completedBy: string | null;
  assignee: string | null;
  archivedAt: string | null;
  trashed: boolean;
  attachments: Array<{ id: string; url: string; title: string; updatedAt: string }>;
  comments: Array<{ id: string; body: string; createdAt: string }>;
}

function world(options: { payeeEmail?: string | null; ownerLinearIsPayee?: boolean } = {}) {
  const connectionRow = (id: string, orgId: string, externalOrgId: string, connectedBy: string) => ({
    id, org_id: orgId, provider: "linear", external_org_id: externalOrgId, external_org_name: "Fernhill", status: "connected", scopes: ["read"],
    connected_by: connectedBy, connected_at: "2026-10-31T08:00:00Z", consent_version: "linear-2026-10-31", consented_at: "2026-10-31T08:00:00Z", revoked_at: null,
    window_from: "2026-08-02", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
    payment_account: null, payment_account_at: null, created_at: "2026-10-31T08:00:00Z",
  });
  const milestoneRow = (id: string, orgId: string, title: string, criteria: string | null) => ({
    id, org_id: orgId, title, amount: "450", contractor_id: FERNHILL, status: "pending", verified: false, verification_method: "unverified", verification_status: "unverified",
    verification_source: null, acceptance_criteria: criteria, decision_claimed_at: null, created_at: "2026-10-30T00:00:00Z",
  });
  const tables: Record<string, Row[]> = {
    accounting_connections: [connectionRow("conn-linear", ORG, LINEAR_ORG, OWNER), connectionRow("conn-linear-2", OTHER_ORG, LINEAR_ORG, OWNER)],
    milestones: [milestoneRow(EXPORT, ORG, "Billing export", EXPORT_CRITERIA), milestoneRow(DOCS, ORG, "Docs site", null), milestoneRow(OTHER_EXPORT, OTHER_ORG, "Billing export", EXPORT_CRITERIA)],
    counterparties: [{ id: FERNHILL, org_id: ORG, name: "Fernhill Studio", notice_email: options.payeeEmail === undefined ? "mai@fernhill.example" : options.payeeEmail }],
    linear_issue_links: [],
    asana_task_links: [],
    payment_intents: [],
  };
  const members = [
    { user_id: OWNER, email: "owner@business.example", role: "owner", joined_at: "2026-10-01T00:00:00Z" },
    { user_id: ADMIN, email: "admin@business.example", role: "admin", joined_at: "2026-10-01T00:00:00Z" },
    { user_id: PAYEE_MEMBER, email: "Mai@Fernhill.example", role: "admin", joined_at: "2026-10-01T00:00:00Z" },
  ];
  const fail = (status: number, code: string, message: string): FakeReply => ({ status, body: { code, message, details: null, hint: null } });
  const refusedCheck = (name: string) => fail(400, "23514", `new row for relation "linear_issue_links" violates check constraint "${name}"`);

  const acceptRpc = (body: Row): FakeReply => {
    const link = tables.linear_issue_links.find((row) => row.id === body.p_link_id && row.org_id === body.p_org_id && row.unlinked_at == null);
    if (!link) return fail(400, "P0001", "link_not_found: no linked issue");
    if (link.state === "accepted") return fail(400, "P0001", "already_accepted: x");
    if (link.after_payment) return fail(400, "P0001", "after_payment: x");
    if (!link.completed) return fail(400, "P0001", "not_completed: x");
    if (link.archived) return fail(400, "P0001", "archived: x");
    if (link.deliverable_fingerprint !== body.p_fingerprint) return fail(400, "P0001", "stale: x");
    const milestone = tables.milestones.find((row) => row.id === link.milestone_id && row.org_id === body.p_org_id) as Row;
    if (milestone.status !== "pending") return fail(400, "P0001", `milestone_not_open: the milestone is ${milestone.status} now`);
    if (!milestone.acceptance_criteria) return fail(400, "P0001", "no_criteria: x");
    if (sha(String(milestone.acceptance_criteria)) !== body.p_criteria_sha256) return fail(400, "P0001", "criteria_changed: x");
    const accepted = {
      state: "accepted", held_reason: null, held_at: null, accepted_by: body.p_by, accepted_at: new Date(NOW).toISOString(), accepted_fingerprint: link.deliverable_fingerprint,
      accepted_completed_at: link.completed_at, accepted_criteria_sha256: body.p_criteria_sha256, accepted_deliverables: link.deliverables,
    };
    // The function's update is held to the table's checks, and one refused rolls back the milestone's too.
    const broken = brokenCheck({ ...link, ...accepted });
    if (broken) return refusedCheck(broken);
    Object.assign(milestone, {
      verified: true, status: "verified", verification_method: "linear", verification_status: "verified",
      verification_detail: { linearIssue: link.issue_url, issueId: link.issue_id, identifier: link.identifier, acceptedBy: body.p_by },
    });
    Object.assign(link, accepted);
    return { body: link };
  };
  const holdRpc = (body: Row): FakeReply => {
    if (!["reopened", "canceled", "deliverable_changed", "archived", "issue_unreachable", "unlinked"].includes(String(body.p_reason))) return fail(400, "P0001", `bad_reason: ${body.p_reason}`);
    const link = tables.linear_issue_links.find((row) => row.id === body.p_link_id && row.org_id === body.p_org_id && row.unlinked_at == null);
    if (!link || link.state !== "accepted") return { body: "not_accepted" };
    const milestone = tables.milestones.find((row) => row.id === link.milestone_id) as Row;
    const underway = milestone.status === "paid" || tables.payment_intents.some((intent) => intent.source_id === milestone.id && intent.status !== "failed");
    // A person claimed the milestone's decision in the last ten minutes, by this database's clock: nothing changes.
    const claimed = milestone.decision_claimed_at ? Date.parse(String(milestone.decision_claimed_at)) : null;
    if (!underway && milestone.status !== "closed" && claimed !== null && claimed > NOW - 10 * 60_000) return { body: "deferred" };
    if (!underway && milestone.status !== "closed" && milestone.verification_method === "linear") {
      Object.assign(milestone, { verified: false, status: ["verified", "held"].includes(String(milestone.status)) ? "pending" : milestone.status, verification_status: "unverified" });
    }
    Object.assign(link, { state: "held", held_reason: body.p_reason, held_at: new Date(NOW).toISOString(), after_payment: underway });
    return { body: underway ? "held_after_payment" : "held" };
  };

  const fake = fakeSupabase((sent: RecordedRequest): FakeReply => {
    const table = sent.path.replace("/rest/v1/", "");
    if (table === "rpc/accept_linear_issue") return acceptRpc(sent.body as Row);
    if (table === "rpc/hold_linear_acceptance") return holdRpc(sent.body as Row);
    if (table === "rpc/linear_connector_ready") return { body: true };
    if (table === "rpc/org_members") return { body: members };
    if (table === "rpc/accounting_connections_by_external") {
      const body = sent.body as { p_provider: string; p_external_org_ids: string[] };
      return {
        body: tables.accounting_connections
          .filter((row) => row.provider === body.p_provider && body.p_external_org_ids.includes(String(row.external_org_id)) && row.status !== "revoked")
          .map((row) => ({ org_id: row.org_id, connection_id: row.id, external_org_id: row.external_org_id, status: row.status, next_sync_after: row.next_sync_after })),
      };
    }
    const rows = tables[table];
    if (!rows) return { body: [] };
    const single = (sent.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (sent.method === "GET") {
      const limit = Number(sent.params.get("limit") ?? "0");
      const found = rows.filter((row) => matches(row, sent.params)).slice(0, limit > 0 ? limit : undefined);
      return { body: single ? found[0] : found };
    }
    if (sent.method === "POST") {
      const inserted = (Array.isArray(sent.body) ? sent.body : [sent.body]) as Row[];
      const made: Row[] = [];
      for (const given of inserted) {
        let row = given;
        if (table === "linear_issue_links") {
          const unknown = Object.keys(given).find((column) => !LINK_COLUMNS.has(column));
          if (unknown) return fail(400, "PGRST204", `Could not find the '${unknown}' column of 'linear_issue_links' in the schema cache`);
          if (rows.some((other) => other.unlinked_at == null && other.org_id === given.org_id && other.issue_id === given.issue_id)) {
            return fail(409, "23505", 'duplicate key value violates unique constraint "linear_issue_links_issue_key"');
          }
          if (rows.some((other) => other.unlinked_at == null && other.org_id === given.org_id && other.milestone_id === given.milestone_id)) {
            return fail(409, "23505", 'duplicate key value violates unique constraint "linear_issue_links_milestone_key"');
          }
          row = {
            id: crypto.randomUUID(), state: "waiting", held_reason: null, after_payment: false, held_at: null, state_type: null, state_name: null, completed: false, completed_at: null,
            completed_by_id: null, completed_by_name: null, assignee_id: null, assignee_name: null, archived: false, deliverables: [], deliverable_fingerprint: null,
            attachments_read: 0, comments_read: 0, more_unread: false, issue_updated_at: null, last_read_at: null, read_error: null, accepted_by: null, accepted_at: null,
            accepted_fingerprint: null, accepted_completed_at: null, accepted_criteria_sha256: null, accepted_deliverables: null, team_id: null, team_key: null, issue_url: null,
            linked_at: new Date(NOW).toISOString(), unlinked_at: null, unlinked_by: null, ...given,
          };
          const broken = brokenCheck(row);
          if (broken) return refusedCheck(broken);
        }
        made.push(row);
      }
      rows.push(...made);
      return { status: 201, body: made };
    }
    if (sent.method === "PATCH") {
      const changed = rows.filter((row) => matches(row, sent.params));
      const values = sent.body as Row;
      if (table === "linear_issue_links") {
        const unknown = Object.keys(values).find((column) => !LINK_COLUMNS.has(column));
        if (unknown) return fail(400, "PGRST204", `Could not find the '${unknown}' column of 'linear_issue_links' in the schema cache`);
        // One statement: every row it would change is checked before any is.
        for (const row of changed) {
          const broken = brokenCheck({ ...row, ...values });
          if (broken) return refusedCheck(broken);
        }
      }
      for (const row of changed) Object.assign(row, values);
      return { body: changed };
    }
    return { body: [] };
  });

  // The Linear workspace's users, one per email as Linear keeps them. With `ownerLinearIsPayee`, the owner connected
  // Linear with the Linear account that has the payee's notice email, and Mai works under another one.
  const emails: Record<string, string> = {
    [MAI_LINEAR]: options.ownerLinearIsPayee ? "mai.tran@fernhill.example" : "mai@fernhill.example",
    [OWNER_LINEAR]: options.ownerLinearIsPayee ? "Mai@Fernhill.example" : "owner@business.example",
  };
  const names: Record<string, string> = { [MAI_LINEAR]: "Mai Tran", [OWNER_LINEAR]: "Duong" };
  const issue = (id: string, identifier: string, title: string, description: string): FakeIssue => ({
    id, identifier, title, description, stateType: "started", stateName: "In Progress", completedAt: null, completedBy: null, assignee: MAI_LINEAR, archivedAt: null, trashed: false, attachments: [], comments: [],
  });
  const issues = new Map<string, FakeIssue>([
    [EXPORT_ISSUE, issue(EXPORT_ISSUE, "ENG-123", "Billing export", "Acceptance: CSV and PDF.\nSpec: https://www.figma.com/file/AbC123/billing")],
    [DOCS_ISSUE, issue(DOCS_ISSUE, "ENG-124", "Docs site", "Deliverable: https://docs.fernhill.example/preview")],
  ]);
  const linearCalls: string[] = [];
  let validToken = "lin_oauth_access_1";
  let refreshToken = "lin_refresh_1";
  let refreshes = 0;
  let down = false;
  let hung = false;
  let revoked = false;
  const peopleAsked: Array<Record<string, unknown>> = [];
  const person = (id: string | null) => (id ? { id, name: names[id] } : null);
  const node = (one: FakeIssue) => ({
    id: one.id,
    identifier: one.identifier,
    title: one.title,
    url: `https://linear.app/fernhill/issue/${one.identifier}/${one.title.toLowerCase().replace(/\s+/g, "-")}`,
    description: one.description,
    trashed: one.trashed,
    archivedAt: one.archivedAt,
    updatedAt: "2026-10-31T08:59:00.000Z",
    completedAt: one.completedAt,
    state: { type: one.stateType, name: one.stateName },
    team: { id: "6e7f8a9b-0c1d-4e2f-9a3b-4c5d6e7f8a01", key: "ENG" },
    assignee: person(one.assignee),
    attachments: { nodes: one.attachments, pageInfo: { hasNextPage: false } },
    comments: { nodes: one.comments, pageInfo: { hasNextPage: false } },
    history: { nodes: one.completedBy ? [{ createdAt: one.completedAt, actor: person(one.completedBy), toState: { type: "completed" } }] : [] },
  });
  // `users(filter: { email: { eqIgnoreCase } })`, as Linear answers it: the workspace's users with that email, any case.
  const usersWith = (email: unknown) =>
    Object.entries(emails)
      .filter(([, address]) => typeof email === "string" && address.toLowerCase() === email.toLowerCase())
      .map(([id, address]) => ({ id, email: address }));
  // Linear validates a query before it answers: a variable declared and not used, used and not declared, or not given, is
  // refused whole.
  const invalid = (query: string, variables: Record<string, unknown>) => {
    const declared = [...(/^query \w+\(([^)]*)\)/.exec(query)?.[1] ?? "").matchAll(/\$(\w+)/g)].map((match) => match[1]).sort();
    const used = [...new Set([...query.slice(query.indexOf("{")).matchAll(/\$(\w+)/g)].map((match) => match[1]))].sort();
    return declared.join() !== used.join() || declared.some((name) => typeof variables[name] !== "string");
  };
  const linearFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.href === "https://api.linear.app/oauth/token") {
      const form = new URLSearchParams(String(init?.body));
      linearCalls.push("POST /oauth/token");
      if (revoked || form.get("refresh_token") !== refreshToken) return json({ error: "invalid_grant", error_description: "The refresh token is invalid" }, 400);
      refreshes += 1;
      validToken = `lin_oauth_access_${refreshes + 1}`;
      refreshToken = `lin_refresh_${refreshes + 1}`;
      return json({ access_token: validToken, token_type: "Bearer", expires_in: 86399, scope: ["read"], refresh_token: refreshToken });
    }
    if (url.href !== "https://api.linear.app/graphql") return json({}, 404);
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> & { id?: string } };
    const operation = /query (\w+)/.exec(query)?.[1] ?? "?";
    linearCalls.push(`${operation} ${variables.id ?? ""}`.trim());
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${validToken}`) {
      return json({ errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", userError: true } }] }, 401);
    }
    if (down) return json({ errors: [{ message: "Internal server error" }] }, 503);
    if (hung) return new Promise<Response>(() => undefined);
    const ref = String(variables.id ?? "");
    const one = issues.get(ref) ?? [...issues.values()].find((candidate) => candidate.identifier === ref);
    const notFound = json({ data: null, errors: [{ message: "Entity not found: Issue", extensions: { type: "invalid input", code: "INPUT_ERROR", userError: true } }] }, 400);
    if (invalid(query, variables)) return json({ errors: [{ message: "Variable is not defined or not used", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, 400);
    if (operation === "Issue") return one ? json({ data: { issue: node(one) } }) : notFound;
    if (operation === "AcceptancePeople") {
      peopleAsked.push({ ...variables, viewer: /\bviewer \{ id \}/.test(query) });
      return json({
        data: {
          ...(/\bviewer \{/.test(query) ? { viewer: { id: OWNER_LINEAR } } : {}),
          ...(/\bpayee: users\(/.test(query) ? { payee: { nodes: usersWith(variables.payee) } } : {}),
          ...(/\bmember: users\(/.test(query) ? { member: { nodes: usersWith(variables.member) } } : {}),
        },
      });
    }
    if (operation === "Viewer") return json({ data: { viewer: { id: OWNER_LINEAR, name: "Duong", organization: { id: LINEAR_ORG, name: "Fernhill" } } } });
    return json({ errors: [{ message: "Unknown query" }] }, 400);
  }) as unknown as typeof fetch;
  const provider = linearProvider({ clientId: "5f0c2b0d8d6a4c1f9e0a7b3c2d1e4f5a", clientSecret: "secret", webhookSecret: "lin_wh" }, { fetchImpl: linearFetch, now: () => NOW });

  const tokens = new Map<string, StoredTokens>();
  const holders = new Map<string, string | null>();
  const tokenOf = (connectionId: string) => tokens.get(connectionId) ?? { id: `token-${connectionId}`, version: 1, accessToken: "lin_oauth_access_1", refreshToken: "lin_refresh_1", expiresAt: NOW + 3_600_000, scopes: ["read"] };
  tokenRow.current = {
    store: (connectionId) => ({
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
    }),
  };

  const runIn = <T,>(orgId: string, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId }), fn);
  const run = <T,>(fn: () => Promise<T>) => runIn(ORG, fn);
  // The webhook route's own scope: no workspace yet, as a delivery names none.
  const platform = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  scope.enter = runIn;
  const link = (milestoneId: string) => tables.linear_issue_links.find((row) => row.milestone_id === milestoneId && row.unlinked_at == null) as Row;
  const milestone = (id: string) => tables.milestones.find((row) => row.id === id) as Row;
  const connection = (id = "conn-linear") => tables.accounting_connections.find((row) => row.id === id) as Row;
  // `by` null: done by an integration, so no person is in the issue's history.
  const done = (id: string, by: string | null = MAI_LINEAR) => Object.assign(issues.get(id) as FakeIssue, { stateType: "completed", stateName: "Done", completedAt: "2026-10-31T08:30:00.000Z", completedBy: by });
  const reopen = (id: string) => Object.assign(issues.get(id) as FakeIssue, { stateType: "started", stateName: "In Progress", completedAt: null, completedBy: null });
  const accept = (milestoneId: string, userId = ADMIN, fields: { fingerprint?: string; criteriaSha256?: string } = {}) =>
    run(() =>
      acceptLinearWork(
        actor(userId),
        {
          milestoneId,
          fingerprint: fields.fingerprint ?? String(link(milestoneId).deliverable_fingerprint),
          criteriaSha256: fields.criteriaSha256 ?? sha(String(milestone(milestoneId).acceptance_criteria)),
          confirmed: true,
        },
        { provider }
      )
    );
  const issueReads = () => linearCalls.filter((call) => call.startsWith("Issue ")).length;
  return {
    fake, tables, issues, run, runIn, platform, provider, link, milestone, connection, done, reopen, accept, linearCalls, issueReads, peopleAsked,
    linearDown: (value: boolean) => void (down = value),
    linearHung: (value: boolean) => void (hung = value),
    revokeAtLinear: () => void (revoked = true),
    expireAtLinear: () => void (validToken = "lin_oauth_access_rotated_elsewhere"),
    token: (connectionId = "conn-linear") => tokenOf(connectionId),
  };
}

const entries = (action: string) => ledger.mock.calls.filter(([, input]) => input.action === action).map(([, input]) => input);

beforeEach(() => {
  ledger.mockReset();
});

async function acceptedExport(w: ReturnType<typeof world>) {
  await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "https://linear.app/fernhill/issue/ENG-123/billing-export" }, { provider: w.provider }));
  w.done(EXPORT_ISSUE);
  await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }));
  expect(await w.accept(EXPORT)).toMatchObject({ ok: true });
}

describe("who may link, write criteria and accept (Linear acceptance LN4, LN8)", () => {
  it("is whoever verifies milestones by hand, from the console only, as with Asana", () => {
    for (const command of ["milestone.link_issue", "milestone.unlink_issue", "milestone.set_issue_criteria", "milestone.accept_issue", "milestone.check_issue"] as const) {
      expect(COMMAND_PERMISSIONS[command]).toBe("records.write");
      for (const surface of ["telegram", "slack", "api", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(command);
    }
  });

  it("refuses an approver, a viewer or an accountant before anything is read", async () => {
    const w = world();
    for (const role of ["approver", "viewer", "accountant"] as const) {
      expect(await w.run(() => linkLinearIssue(actor(ADMIN, { role }), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await w.run(() => acceptLinearWork(actor(ADMIN, { role }), { milestoneId: EXPORT, fingerprint: "a".repeat(64), criteriaSha256: "b".repeat(64), confirmed: true }, { provider: w.provider }))).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(w.fake.requests).toHaveLength(0);
    expect(w.linearCalls).toHaveLength(0);
  });
});

describe("two milestones accepted (LN4 to LN8)", () => {
  it("links each to its issue, waits until each is done, and verifies each only when a person accepts it", async () => {
    const w = world();
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "https://linear.app/fernhill/issue/ENG-123/billing-export" }, { provider: w.provider }))).toMatchObject({ ok: true, state: "waiting" });
    // The ID alone, as typed.
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: DOCS, issue: "eng-124" }, { provider: w.provider }))).toMatchObject({ ok: true });
    expect(w.link(EXPORT)).toMatchObject({ issue_id: EXPORT_ISSUE, identifier: "ENG-123", team_key: "ENG", state: "waiting", state_name: "In Progress", completed: false, issue_url: "https://linear.app/fernhill/issue/ENG-123/billing-export" });
    expect(entries("linear_issue_linked")).toHaveLength(2);
    expect(entries("linear_issue_linked")[0].detail).toMatchObject({ milestoneId: EXPORT, issueId: EXPORT_ISSUE, identifier: "ENG-123", completed: false });

    // Not done yet: nothing to accept.
    expect(await w.accept(EXPORT)).toMatchObject({ ok: false });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });

    // Done in Linear: ready, never verified by that alone.
    w.done(EXPORT_ISSUE);
    w.done(DOCS_ISSUE);
    await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }));
    await w.run(() => checkLinearIssue(actor(), { milestoneId: DOCS }, { provider: w.provider }));
    expect(w.link(EXPORT)).toMatchObject({ state: "ready", completed: true, completed_by_id: MAI_LINEAR, completed_by_name: "Mai Tran", state_type: "completed", state_name: "Done" });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(entries("linear_issue_ready")).toHaveLength(1);
    // The docs have no criteria: held until a person writes them, then ready.
    expect(w.link(DOCS)).toMatchObject({ state: "held", held_reason: "no_criteria" });
    expect(await w.accept(DOCS, ADMIN, { criteriaSha256: sha("none") })).toMatchObject({ ok: false });
    expect(await w.run(() => setLinearAcceptanceCriteria(actor(), { milestoneId: DOCS, criteria: "The docs site, five pages, deployed to the preview." }))).toMatchObject({ ok: true });
    expect(w.link(DOCS)).toMatchObject({ state: "ready", held_reason: null });

    expect(await w.accept(EXPORT)).toMatchObject({ ok: true, status: "verified" });
    expect(await w.accept(DOCS)).toMatchObject({ ok: true, status: "verified" });
    for (const id of [EXPORT, DOCS]) expect(w.milestone(id)).toMatchObject({ status: "verified", verified: true, verification_method: "linear" });
    expect(w.link(EXPORT)).toMatchObject({ state: "accepted", accepted_by: ADMIN });
    const accepted = entries("linear_work_accepted");
    expect(accepted.map((entry) => entry.detail.milestoneId)).toEqual([EXPORT, DOCS]);
    expect(accepted[0].detail).toMatchObject({ by: ADMIN, issueId: EXPORT_ISSUE, identifier: "ENG-123", criteriaSha256: sha(EXPORT_CRITERIA), payeeLinearMapped: true });
    // Asana's acceptance entries are Asana's: none is written for Linear.
    expect(entries("milestone_accepted")).toHaveLength(0);
    expect(await w.accept(EXPORT)).toMatchObject({ ok: false });
  });

  it("refuses what is not a Linear issue, an issue of another Linear workspace, one linked already, one Linear does not show, and a milestone linked in Asana", async () => {
    const w = world();
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "https://evil.example/fernhill/issue/ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "bad_issue" });
    expect(w.linearCalls).toHaveLength(0);
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "https://linear.app/someone-else/issue/ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "other_workspace" });
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-999" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "issue_not_found" });
    expect(w.tables.linear_issue_links).toHaveLength(0);
    await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: DOCS, issue: "ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "issue_linked" });
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-124" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "milestone_linked" });
    w.tables.asana_task_links.push({
      id: crypto.randomUUID(), org_id: ORG, milestone_id: DOCS, connection_id: "conn-asana", workspace_gid: "1204081671801519", project_gid: null, task_gid: "1219477646404728",
      task_name: "Docs site", task_url: null, state: "waiting", held_reason: null, after_payment: false, held_at: null, completed: false, completed_at: null, completed_by_gid: null,
      completed_by_name: null, assignee_name: null, deliverables: [], deliverable_fingerprint: null, last_read_at: null, read_error: null, accepted_by: null, accepted_at: null,
      accepted_fingerprint: null, accepted_completed_at: null, accepted_deliverables: null, linked_at: "2026-10-31T08:00:00Z", unlinked_at: null,
    });
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: DOCS, issue: "ENG-124" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "asana" });
  });

  it("links only a milestone waiting for verification, and none a GitHub pull request verifies, before asking Linear anything (Linear acceptance LN4)", async () => {
    for (const status of ["verified", "paid", "closed"]) {
      const w = world();
      w.milestone(EXPORT).status = status;
      expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider })), status).toMatchObject({ ok: false, code: "milestone_not_open" });
      expect(w.tables.linear_issue_links).toHaveLength(0);
      expect(w.linearCalls).toHaveLength(0);
    }
    // One milestone is not verified two ways: a pending one whose pull request verifies it stays GitHub's.
    const w = world();
    w.milestone(EXPORT).verification_source = "https://github.com/fernhill/app/pull/42";
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "github" });
    expect(w.tables.linear_issue_links).toHaveLength(0);
    expect(w.linearCalls).toHaveLength(0);
  });
});

describe("accepting (LN8)", () => {
  it("reads the issue again first, and refuses an acceptance of a version other than the one Linear shows now", async () => {
    const w = world();
    await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    w.done(EXPORT_ISSUE);
    await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }));
    const shown = String(w.link(EXPORT).deliverable_fingerprint);
    // The contractor adds a link in a comment while the page is open; nothing has read the issue since.
    (w.issues.get(EXPORT_ISSUE) as FakeIssue).comments.push({ id: "5d6e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f02", body: "Final: https://vercel.example/preview/3", createdAt: "2026-10-31T09:00:00.000Z" });
    const reads = w.issueReads();
    expect(await w.accept(EXPORT, ADMIN, { fingerprint: shown })).toMatchObject({ ok: false, code: "stale" });
    expect(w.issueReads() - reads).toBe(1);
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(w.link(EXPORT)).toMatchObject({ state: "ready" });
    expect(w.link(EXPORT).deliverable_fingerprint).not.toBe(shown);
    expect(entries("linear_work_accepted")).toHaveLength(0);
    // Against the version Linear shows now, it is accepted.
    expect(await w.accept(EXPORT)).toMatchObject({ ok: true });
  });

  it("keeps an issue's deliverables within what Postgres takes, however many long links its comments carry (Linear acceptance LN6)", async () => {
    const w = world();
    // Anyone in the Linear workspace can post links of 470 characters in comments, the contractor included: fifty, ten
    // to a comment (a comment is read to its first 10,000 characters).
    const hrefs = Array.from({ length: 50 }, (_, n) => `https://files.example/${String(n).padStart(2, "0")}/${"a".repeat(440)}`);
    for (let n = 0; n < 5; n += 1) {
      const body = hrefs.slice(n * 10, n * 10 + 10).join("\n");
      (w.issues.get(EXPORT_ISSUE) as FakeIssue).comments.push({ id: `5d6e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f1${n}`, body, createdAt: "2026-10-31T08:40:00.000Z" });
    }
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: true });
    w.done(EXPORT_ISSUE);
    expect(await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }))).toMatchObject({ ok: true });
    const kept = w.link(EXPORT).deliverables as unknown[];
    // The description's link and the first comment links, not all 51.
    expect(kept.length).toBeGreaterThan(20);
    expect(kept.length).toBeLessThan(51);
    expect(Buffer.byteLength(jsonbText(kept), "utf8")).toBeLessThanOrEqual(32_000);
    expect(await w.accept(EXPORT)).toMatchObject({ ok: true });
    expect(w.link(EXPORT)).toMatchObject({ state: "accepted", accepted_deliverables: kept });
    // Read again unchanged, the acceptance stands: the links left out count by number, the same each time.
    expect(await w.run(() => refreshLinearMilestones(w.provider))).toMatchObject({ checked: 1, withdrawn: 0 });
  });
});

describe("an issue changed after acceptance (LN10, LN12)", () => {
  it("is held for review by the cycle's read when reopened, before the contractor stage, and stays held until accepted again", async () => {
    const w = world();
    await acceptedExport(w);
    w.reopen(EXPORT_ISSUE);
    expect(await w.run(() => refreshLinearMilestones(w.provider))).toMatchObject({ checked: 1, withdrawn: 1 });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false, verification_status: "unverified" });
    expect(w.link(EXPORT)).toMatchObject({ state: "held", held_reason: "reopened", after_payment: false, completed: false, completed_at: null });
    expect(entries("linear_acceptance_withdrawn")[0].detail).toMatchObject({ milestoneId: EXPORT, issueId: EXPORT_ISSUE, reason: "reopened", afterPayment: false });
    // Done again: still held until a person accepts again, against what Linear shows now.
    w.done(EXPORT_ISSUE);
    await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }));
    expect(w.link(EXPORT)).toMatchObject({ state: "held", held_reason: "reopened" });
    expect(await w.accept(EXPORT)).toMatchObject({ ok: true });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified", verified: true });
  });

  it("is held when canceled, by the sweeper's read under the connection's sync lease", async () => {
    const w = world();
    await acceptedExport(w);
    Object.assign(w.issues.get(EXPORT_ISSUE) as FakeIssue, { stateType: "canceled", stateName: "Canceled", completedAt: null, completedBy: null });
    expect(await w.run(() => syncLinearConnection("conn-linear", w.provider, { now: () => NOW }))).toMatchObject({ outcome: "synced", summary: { withdrawn: 1 } });
    expect(w.link(EXPORT)).toMatchObject({ state: "held", held_reason: "canceled", state_type: "canceled" });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(w.connection()).toMatchObject({ sync_lease_until: null, last_synced_at: expect.any(String) });
  });

  it("is held by the read right before the release is sent, when archived after the cycle's read", async () => {
    const w = world();
    await acceptedExport(w);
    expect(await w.run(() => refreshLinearMilestones(w.provider))).toMatchObject({ checked: 1, withdrawn: 0 });
    (w.issues.get(EXPORT_ISSUE) as FakeIssue).archivedAt = "2026-10-31T09:00:00.000Z";
    const reads = w.issueReads();
    expect(await w.run(() => recheckLinearBeforeSending([EXPORT, DOCS], w.provider))).toMatchObject({ checked: 1, read: 1, withdrawn: 1, complete: true });
    expect(w.issueReads() - reads).toBe(1);
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(w.link(EXPORT)).toMatchObject({ state: "held", held_reason: "archived", archived: true });
    // None to send, or none accepted from Linear: nothing is read.
    expect(await w.run(() => recheckLinearBeforeSending([], w.provider))).toMatchObject({ checked: 0, complete: true });
    expect(await w.run(() => recheckLinearBeforeSending([DOCS], w.provider))).toMatchObject({ checked: 0, complete: true });
    expect(w.issueReads() - reads).toBe(1);
  });

  it("is left accepted when Linear cannot be read right before sending, and never holds the payment past the deadline", async () => {
    const w = world();
    await acceptedExport(w);
    w.linearDown(true);
    expect(await w.run(() => recheckLinearBeforeSending([EXPORT], w.provider))).toMatchObject({ checked: 1, failed: 1, withdrawn: 0, complete: false });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified", verified: true });
    w.linearDown(false);
    w.linearHung(true);
    const started = Date.now();
    expect(await w.run(() => recheckLinearBeforeSending([EXPORT], w.provider, { deadlineMs: 50 }))).toMatchObject({ withdrawn: 0, complete: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.link(EXPORT)).toMatchObject({ state: "accepted" });
  });

  it("after its payment was sent, holds only the link, as a dispute, and leaves the payment alone", async () => {
    const w = world();
    await acceptedExport(w);
    w.tables.payment_intents.push({ org_id: ORG, source_type: "milestone", source_id: EXPORT, status: "pending" });
    w.reopen(EXPORT_ISSUE);
    await w.run(() => refreshLinearMilestones(w.provider));
    expect(w.link(EXPORT)).toMatchObject({ state: "held", after_payment: true });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified", verified: true });
  });

  it("is read by the cycle and by the sweeper however many milestones accepted from Linear were paid before it", async () => {
    // Paid milestones keep their accepted links, as their history: 120 of them, linked before this one.
    const paidLinks = (w: ReturnType<typeof world>) => {
      for (let n = 0; n < 120; n += 1) {
        const id = crypto.randomUUID();
        w.tables.milestones.push({
          id, org_id: ORG, title: `Paid ${n}`, amount: "10", contractor_id: FERNHILL, status: "paid", verified: true, verification_method: "linear", verification_status: "verified",
          verification_source: null, acceptance_criteria: "Done.", decision_claimed_at: null, created_at: "2026-09-01T00:00:00Z",
        });
        w.tables.linear_issue_links.push({
          id: crypto.randomUUID(), org_id: ORG, milestone_id: id, connection_id: "conn-linear", issue_id: crypto.randomUUID(), identifier: `ENG-${1000 + n}`, team_id: null, team_key: "ENG",
          issue_title: `Paid ${n}`, issue_url: null, state: "accepted", held_reason: null, after_payment: false, held_at: null, state_type: "completed", state_name: "Done", completed: true,
          completed_at: "2026-09-01T00:00:00.000Z", completed_by_id: null, completed_by_name: null, assignee_id: null, assignee_name: null, archived: false, deliverables: [],
          deliverable_fingerprint: "f".repeat(64), attachments_read: 0, comments_read: 0, more_unread: false, issue_updated_at: null, last_read_at: null, read_error: null,
          accepted_by: OWNER, accepted_at: "2026-09-01T00:00:00.000Z", accepted_fingerprint: "f".repeat(64), accepted_completed_at: "2026-09-01T00:00:00.000Z",
          accepted_criteria_sha256: sha("Done."), accepted_deliverables: [], linked_at: "2026-09-01T00:00:00.000Z", unlinked_at: null, unlinked_by: null,
        });
      }
    };
    const cycle = world();
    paidLinks(cycle);
    await acceptedExport(cycle);
    cycle.reopen(EXPORT_ISSUE);
    expect(await cycle.run(() => refreshLinearMilestones(cycle.provider))).toMatchObject({ checked: 1, withdrawn: 1 });
    expect(cycle.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });

    const sweep = world();
    paidLinks(sweep);
    await acceptedExport(sweep);
    sweep.reopen(EXPORT_ISSUE);
    expect(await sweep.run(() => syncLinearConnection("conn-linear", sweep.provider, { now: () => NOW }))).toMatchObject({ outcome: "synced", summary: { withdrawn: 1 } });
    expect(sweep.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
  });
});

describe("while a person decides the payment (LN10)", () => {
  // A person claimed the milestone's decision a minute ago: `hold_linear_acceptance` answers deferred for ten minutes.
  const claim = (w: ReturnType<typeof world>, minutesAgo: number) => void (w.milestone(EXPORT).decision_claimed_at = new Date(NOW - minutesAgo * 60_000).toISOString());

  it("leaves an issue reopened in that window accepted and its milestone verified, and holds it once the claim is old", async () => {
    const w = world();
    await acceptedExport(w);
    w.reopen(EXPORT_ISSUE);
    claim(w, 1);
    expect(await w.run(() => refreshLinearMilestones(w.provider))).toMatchObject({ checked: 1, read: 1, deferred: 1, withdrawn: 0 });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified", verified: true });
    // What Linear says now is written on the link, which stays accepted for the next read.
    expect(w.link(EXPORT)).toMatchObject({ state: "accepted", completed: false, completed_at: null });
    expect(entries("linear_acceptance_withdrawn")).toHaveLength(0);
    claim(w, 11);
    expect(await w.run(() => refreshLinearMilestones(w.provider))).toMatchObject({ checked: 1, withdrawn: 1, deferred: 0 });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(w.link(EXPORT)).toMatchObject({ state: "held", held_reason: "reopened" });
  });

  it("refuses to unlink an accepted issue in that window, and leaves the link and the milestone as they were", async () => {
    const w = world();
    await acceptedExport(w);
    claim(w, 1);
    expect(await w.run(() => unlinkLinearIssue(actor(), { milestoneId: EXPORT }))).toMatchObject({ ok: false, code: "deciding", message: expect.stringMatching(/deciding this milestone's payment/) });
    expect(w.link(EXPORT)).toMatchObject({ state: "accepted", unlinked_at: null });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "verified", verified: true });
    expect(entries("linear_issue_unlinked")).toHaveLength(0);
  });
});

describe("a signed webhook delivery (LN11)", () => {
  it("has the issue read again in every workspace connected to its Linear workspace, and holds a changed deliverable", async () => {
    const w = world();
    await acceptedExport(w);
    // A second workspace connected to the same Linear workspace, with the same issue linked to its own milestone.
    await w.runIn(OTHER_ORG, () => linkLinearIssue({ ...actor(), orgId: OTHER_ORG }, { milestoneId: OTHER_EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    expect(w.tables.linear_issue_links.filter((row) => row.issue_id === EXPORT_ISSUE)).toHaveLength(2);
    (w.issues.get(EXPORT_ISSUE) as FakeIssue).comments.push({ id: "5d6e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f01", body: "v2: https://vercel.example/preview/2", createdAt: "2026-10-31T09:00:00.000Z" });
    const reads = w.issueReads();
    expect(await w.platform(() => rereadForDelivery({ organizationId: LINEAR_ORG, issueId: EXPORT_ISSUE }, w.provider))).toBe(2);
    expect(w.issueReads() - reads).toBe(2);
    expect(w.link(EXPORT)).toMatchObject({ state: "held", held_reason: "deliverable_changed" });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    // Another Linear workspace's delivery, or an issue linked nowhere, reads nothing.
    expect(await w.platform(() => rereadForDelivery({ organizationId: OTHER_LINEAR_ORG, issueId: EXPORT_ISSUE }, w.provider))).toBe(0);
    expect(await w.platform(() => rereadForDelivery({ organizationId: LINEAR_ORG, issueId: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c99" }, w.provider))).toBe(0);
    expect(w.issueReads() - reads).toBe(2);
  });

  it("reads only in a workspace whose live connection is the one to that Linear workspace", async () => {
    const w = world();
    await acceptedExport(w);
    expect(await w.run(() => rereadIssueInScope({ connectionId: "conn-linear-2", issueId: EXPORT_ISSUE }, w.provider))).toBe(0);
    expect(await w.run(() => rereadIssueInScope({ connectionId: "conn-linear", issueId: EXPORT_ISSUE }, w.provider))).toBe(1);
  });

  it("marks every connection to a Linear workspace that revoked the app as needing to reconnect", async () => {
    const w = world();
    expect(await w.platform(() => markRevokedAtLinear(LINEAR_ORG, new Date(NOW).toISOString()))).toBe(2);
    expect(w.connection("conn-linear")).toMatchObject({ status: "needs_reconnect", last_error: expect.stringMatching(/Reconnect Linear to go on reading the issues linked to milestones/) });
    expect(w.connection("conn-linear-2")).toMatchObject({ status: "needs_reconnect" });
    // Once marked, a second delivery changes nothing.
    expect(await w.platform(() => markRevokedAtLinear(LINEAR_ORG))).toBe(0);
  });
});

describe("self-acceptance (LN9)", () => {
  it("is refused to the payee, by their email as a member", async () => {
    const w = world();
    await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    w.done(EXPORT_ISSUE);
    await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }));
    expect(await w.accept(EXPORT, PAYEE_MEMBER)).toMatchObject({ ok: false, code: "self_acceptance", message: expect.stringMatching(/You are this milestone's payee/) });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(w.link(EXPORT)).toMatchObject({ state: "ready" });
  });

  it("is refused to a member whose Linear account completed the issue with the payee's email", async () => {
    // The owner connected Linear as themselves, and that Linear user, whose email is the payee's, marked the issue done.
    const w = world({ ownerLinearIsPayee: true });
    await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    w.done(EXPORT_ISSUE, OWNER_LINEAR);
    await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }));
    expect(await w.accept(EXPORT, OWNER)).toMatchObject({ ok: false, code: "self_acceptance", message: expect.stringMatching(/Linear account/) });
    expect(w.linearCalls.some((call) => call.startsWith("AcceptancePeople"))).toBe(true);
    // Someone else accepts it.
    expect(await w.accept(EXPORT, ADMIN)).toMatchObject({ ok: true });
  });

  it("is refused to the member who connected Linear with the payee's Linear account, whoever is on the issue (Linear acceptance LN9, as Asana A9)", async () => {
    // The owner signed in to Vestiarion under another email, and connected Linear with the payee's Linear account. The
    // issue has no assignee and was moved to Done by an integration: no one on it is the payee.
    const w = world({ ownerLinearIsPayee: true });
    (w.issues.get(EXPORT_ISSUE) as FakeIssue).assignee = null;
    await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    w.done(EXPORT_ISSUE, null);
    await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }));
    expect(w.link(EXPORT)).toMatchObject({ state: "ready", assignee_id: null, completed_by_id: null });
    expect(await w.accept(EXPORT, OWNER)).toMatchObject({ ok: false, code: "self_acceptance", message: expect.stringMatching(/Your Linear account is this milestone's payee/) });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    // The connection's own user, and the Linear user with the payee's email, by email alone: the owner's own email is
    // not asked for, as they connected Linear.
    expect(w.peopleAsked).toEqual([{ payee: "mai@fernhill.example", viewer: true }]);
  });

  it("asks Linear for a member who did not connect it by their own email, and lets them accept when that is not the payee's account", async () => {
    const w = world();
    await acceptedExport(w);
    expect(w.peopleAsked).toEqual([{ payee: "mai@fernhill.example", member: "admin@business.example", viewer: false }]);
    expect(entries("linear_work_accepted")[0].detail).toMatchObject({ payeeLinearMapped: true });
  });

  it("asks Linear nothing about people for a payee with no notice email", async () => {
    const w = world({ payeeEmail: null });
    await acceptedExport(w);
    expect(w.peopleAsked).toEqual([]);
    expect(entries("linear_work_accepted")[0].detail).toMatchObject({ payeeLinearMapped: false });
  });

  it("refuses the payee's own Pay now on such a milestone, and no one else's", async () => {
    const w = world();
    await acceptedExport(w);
    expect(await w.run(() => approvesOwnLinearPayout({ orgId: ORG, userId: PAYEE_MEMBER }, EXPORT))).toBe(true);
    expect(await w.run(() => approvesOwnLinearPayout({ orgId: ORG, userId: ADMIN }, EXPORT))).toBe(false);
    // A milestone with no Linear link is left to the existing checks; Linear is not asked.
    const calls = w.linearCalls.length;
    expect(await w.run(() => approvesOwnLinearPayout({ orgId: ORG, userId: PAYEE_MEMBER }, DOCS))).toBe(false);
    expect(w.linearCalls).toHaveLength(calls);
  });
});

describe("the connection's token (LN2, LN12)", () => {
  it("refreshes under the lease when Linear answers 401, keeps the rotated pair, and reads again", async () => {
    const w = world();
    w.expireAtLinear();
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: true });
    expect(w.linearCalls.slice(0, 3)).toEqual(["Issue ENG-123", "POST /oauth/token", "Issue ENG-123"]);
    expect(w.token()).toMatchObject({ version: 2, accessToken: "lin_oauth_access_2", refreshToken: "lin_refresh_2" });
  });

  it("marks the connection to reconnect when Linear refuses the refresh token, and says so", async () => {
    const w = world();
    await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    w.expireAtLinear();
    w.revokeAtLinear();
    expect(await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }))).toMatchObject({ ok: false, code: "linear_unavailable", message: expect.stringMatching(/Reconnect Linear/) });
    expect(w.connection()).toMatchObject({ status: "needs_reconnect" });
    expect(w.link(EXPORT)).toMatchObject({ read_error: expect.stringMatching(/Reconnect Linear/) });
    // Then nothing is read until a person reconnects.
    expect(await w.run(() => checkLinearIssue(actor(), { milestoneId: EXPORT }, { provider: w.provider }))).toMatchObject({ ok: false, code: "not_connected" });
  });
});

describe("unlinking", () => {
  it("takes back an acceptance the agent has not paid, and frees the issue", async () => {
    const w = world();
    await acceptedExport(w);
    expect(await w.run(() => unlinkLinearIssue(actor(), { milestoneId: EXPORT }))).toMatchObject({ ok: true });
    expect(w.milestone(EXPORT)).toMatchObject({ status: "pending", verified: false });
    expect(w.tables.linear_issue_links.every((row) => row.unlinked_at)).toBe(true);
    expect(entries("linear_issue_unlinked")[0].detail).toMatchObject({ milestoneId: EXPORT, issueId: EXPORT_ISSUE, withdrewAcceptance: true });
    expect(await w.run(() => linkLinearIssue(actor(), { milestoneId: DOCS, issue: "ENG-123" }, { provider: w.provider }))).toMatchObject({ ok: true });
  });
});

describe("nothing from Linear sets an amount or a payee (LN13)", () => {
  it("writes a milestone only through the two functions and its criteria, and every request names the workspace", async () => {
    const w = world();
    await acceptedExport(w);
    w.reopen(EXPORT_ISSUE);
    await w.run(() => refreshLinearMilestones(w.provider));
    await w.run(() => setLinearAcceptanceCriteria(actor(), { milestoneId: DOCS, criteria: "Five pages." }));
    const milestoneWrites = w.fake.requests.filter((sent) => sent.path === "/rest/v1/milestones" && sent.method !== "GET");
    expect(milestoneWrites.length).toBeGreaterThan(0);
    for (const write of milestoneWrites) expect(Object.keys(write.body as Row).sort()).toEqual(["acceptance_criteria", "acceptance_criteria_at", "acceptance_criteria_by"]);
    for (const sent of w.fake.requests.filter((one) => one.path.startsWith("/rest/v1/rpc/") && one.path !== "/rest/v1/rpc/org_members")) {
      expect(JSON.stringify(sent.body)).not.toMatch(/amount|contractor|address/);
    }
    for (const sent of w.fake.requests.filter((one) => one.path !== "/rest/v1/rpc/org_members")) expect(carriesOrg(sent, ORG), `${sent.method} ${sent.path}`).toBe(true);
    expect(w.milestone(EXPORT)).toMatchObject({ amount: "450", contractor_id: FERNHILL });
  });

  it("is held to 0147's checks in this database as Postgres holds them", async () => {
    const w = world();
    await w.run(() => linkLinearIssue(actor(), { milestoneId: EXPORT, issue: "ENG-123" }, { provider: w.provider }));
    const id = String(w.link(EXPORT).id);
    const patch = (values: Row) => w.run(async () => (await import("@/lib/dal")).db().from("linear_issue_links").update(values).eq("id", id).select("id"));
    expect((await patch({ state: "held" })).error?.message).toMatch(/linear_issue_links_held_check/);
    expect((await patch({ comments_read: 101 })).error?.message).toMatch(/linear_issue_links_comments_read_check/);
    expect((await patch({ no_such_column: 1 })).error?.message).toMatch(/no_such_column/);
    // Deliverables over 32,000 bytes as Postgres writes them out, though their JSON alone is 31,781.
    const big = Array.from({ length: 30 }, (_, n) => ({ kind: "comment_link", id: `https://files.example/${n}/${"a".repeat(472)}`, label: "files.example", href: `https://files.example/${n}/${"a".repeat(472)}` }));
    expect(JSON.stringify(big).length).toBeLessThan(32_000);
    expect((await patch({ deliverables: big })).error?.message).toMatch(/linear_issue_links_deliverables_check/);
    expect(w.link(EXPORT)).toMatchObject({ state: "waiting", held_reason: null, comments_read: 0 });
    expect(w.link(EXPORT).deliverables).toHaveLength(1);
  });
});
