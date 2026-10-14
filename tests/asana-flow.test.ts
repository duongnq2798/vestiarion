import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { acceptMilestoneWork, checkAsanaTask, linkAsanaTask, setAcceptanceCriteria, unlinkAsanaTask } from "@/lib/commands/asana";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { paysOwnPayout } from "@/lib/asana/identities";
import { asanaProvider } from "@/lib/asana/provider";
import type { StoredWebhook } from "@/lib/asana/webhook-store";
import { recheckBeforeSending, refreshAsanaMilestones, rereadInScope, syncAsanaConnection } from "@/lib/asana/workspace";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Contractor work accepted from Asana, end to end over the real stores and commands
 * (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A4 to A12): the database is a recorded PostgREST whose
 * two functions, `accept_asana_task` and `hold_asana_acceptance`, answer as migration 0115's do (that SQL is tested on
 * its own in tests/asana-migration.test.ts); Asana is a fake API holding two tasks of a project, "Logo animation" and
 * "10 launch posts", as the partner's test data has them.
 */

const { ledger } = vi.hoisted(() => ({ ledger: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledger }));
vi.mock("@/lib/usage/record", () => ({ recordUsage: vi.fn(async () => undefined) }));
const { tokenRow } = vi.hoisted(() => ({ tokenRow: { current: null as null | { store: TokenStore } } }));
vi.mock("@/lib/connectors/token-store", async (original) => ({
  ...(await original<typeof import("@/lib/connectors/token-store")>()),
  connectionTokenStore: () => tokenRow.current?.store,
}));
vi.mock("@/lib/agent/cycle-soon", async (original) => ({ ...(await original<typeof import("@/lib/agent/cycle-soon")>()), runCycleSoon: vi.fn() }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a5a01";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a5a11";
const ADMIN = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a5a12";
const PAYEE_MEMBER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a5a13";
const LOGO = "aaaaaaaa-0000-4000-8000-00000000a5a1";
const POSTS = "aaaaaaaa-0000-4000-8000-00000000a5a2";
const FERNHILL = "cccccccc-0000-4000-8000-00000000a5a1";
const WORKSPACE = "1204081671801519";
const PROJECT = "1219477646404725";
const LOGO_TASK = "1219477646404728";
const POSTS_TASK = "1219477646404730";
const OWNER_ASANA = "4673218951";
const NOW = Date.parse("2026-10-14T09:00:00Z");
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const sha = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const LOGO_CRITERIA = "A 5-second logo animation in MP4 and GIF, on the brand palette.";

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

interface AsanaTask {
  name: string;
  notes: string;
  completed: boolean;
  completedAt: string | null;
  completedBy: { gid: string; name: string } | null;
  attachments: Array<{ gid: string; name: string; created_at: string }>;
  comments: Array<{ gid: string; text: string }>;
}

function world(options: { payeeEmail?: string | null; ownerAsanaIsPayee?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    accounting_connections: [
      {
        id: "conn-asana", org_id: ORG, provider: "asana", external_org_id: OWNER_ASANA, external_org_name: "Duong", status: "connected", scopes: [],
        connected_by: OWNER, connected_at: "2026-10-14T08:00:00Z", consent_version: "asana-2026-10-14", consented_at: "2026-10-14T08:00:00Z", revoked_at: null,
        window_from: "2026-07-16", last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null,
        payment_account: null, payment_account_at: null, created_at: "2026-10-14T08:00:00Z",
      },
    ],
    milestones: [
      { id: LOGO, org_id: ORG, title: "Logo animation", amount: "450", contractor_id: FERNHILL, status: "pending", verified: false, verification_method: "unverified", verification_source: null, acceptance_criteria: LOGO_CRITERIA, decision_claimed_at: null },
      { id: POSTS, org_id: ORG, title: "10 launch posts", amount: "800", contractor_id: FERNHILL, status: "pending", verified: false, verification_method: "unverified", verification_source: null, acceptance_criteria: null, decision_claimed_at: null },
    ],
    counterparties: [{ id: FERNHILL, org_id: ORG, name: "Fernhill Studio", notice_email: options.payeeEmail === undefined ? "mai@fernhill.example" : options.payeeEmail }],
    asana_task_links: [],
    payment_intents: [],
  };
  const members = [
    { user_id: OWNER, email: "owner@business.example", role: "owner", joined_at: "2026-10-01T00:00:00Z" },
    { user_id: ADMIN, email: "admin@business.example", role: "admin", joined_at: "2026-10-01T00:00:00Z" },
    { user_id: PAYEE_MEMBER, email: "Mai@Fernhill.example", role: "admin", joined_at: "2026-10-01T00:00:00Z" },
  ];
  const fail = (status: number, code: string, message: string): FakeReply => ({ status, body: { code, message, details: null, hint: null } });

  const acceptRpc = (body: Row): FakeReply => {
    const link = tables.asana_task_links.find((row) => row.id === body.p_link_id && row.org_id === body.p_org_id && row.unlinked_at == null);
    if (!link) return fail(400, "P0001", "link_not_found: no linked task");
    if (link.state === "accepted") return fail(400, "P0001", "already_accepted: x");
    if (link.after_payment) return fail(400, "P0001", "after_payment: x");
    if (!link.completed) return fail(400, "P0001", "not_completed: x");
    if (link.deliverable_fingerprint !== body.p_fingerprint) return fail(400, "P0001", "stale: x");
    const milestone = tables.milestones.find((row) => row.id === link.milestone_id) as Row;
    if (milestone.status !== "pending") return fail(400, "P0001", `milestone_not_open: the milestone is ${milestone.status} now`);
    if (!milestone.acceptance_criteria) return fail(400, "P0001", "no_criteria: x");
    if (sha(String(milestone.acceptance_criteria)) !== body.p_criteria_sha256) return fail(400, "P0001", "criteria_changed: x");
    Object.assign(milestone, { verified: true, status: "verified", verification_method: "asana", verification_status: "verified" });
    Object.assign(link, {
      state: "accepted", held_reason: null, accepted_by: body.p_by, accepted_at: new Date(NOW).toISOString(), accepted_fingerprint: link.deliverable_fingerprint,
      accepted_completed_at: link.completed_at, accepted_criteria_sha256: body.p_criteria_sha256, accepted_deliverables: link.deliverables,
    });
    return { body: link };
  };
  const holdRpc = (body: Row): FakeReply => {
    const link = tables.asana_task_links.find((row) => row.id === body.p_link_id && row.org_id === body.p_org_id && row.unlinked_at == null);
    if (!link || link.state !== "accepted") return { body: "not_accepted" };
    const milestone = tables.milestones.find((row) => row.id === link.milestone_id) as Row;
    const underway = milestone.status === "paid" || tables.payment_intents.some((intent) => intent.source_id === milestone.id && intent.status !== "failed");
    if (!underway && milestone.status !== "closed" && milestone.verification_method === "asana") {
      Object.assign(milestone, { verified: false, status: ["verified", "held"].includes(String(milestone.status)) ? "pending" : milestone.status, verification_status: "unverified" });
    }
    Object.assign(link, { state: "held", held_reason: body.p_reason, after_payment: underway });
    return { body: underway ? "held_after_payment" : "held" };
  };

  const fake = fakeSupabase((sent: RecordedRequest): FakeReply => {
    const table = sent.path.replace("/rest/v1/", "");
    if (table === "rpc/accept_asana_task") return acceptRpc(sent.body as Row);
    if (table === "rpc/hold_asana_acceptance") return holdRpc(sent.body as Row);
    if (table === "rpc/org_members") return { body: members };
    const rows = tables[table];
    if (!rows) return { body: [] };
    const single = (sent.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (sent.method === "GET") {
      // The limit a read asks for is kept, in the rows' own order: a read that stops early stops here too.
      const limit = Number(sent.params.get("limit") ?? "0");
      const found = rows.filter((row) => matches(row, sent.params)).slice(0, limit > 0 ? limit : undefined);
      return { body: single ? found[0] : found };
    }
    if (sent.method === "POST") {
      const inserted = (Array.isArray(sent.body) ? sent.body : [sent.body]) as Row[];
      for (const row of inserted) {
        if (table === "asana_task_links") {
          if (rows.some((other) => other.unlinked_at == null && other.task_gid === row.task_gid)) return fail(409, "23505", 'duplicate key value violates unique constraint "asana_task_links_task_key"');
          if (rows.some((other) => other.unlinked_at == null && other.milestone_id === row.milestone_id)) return fail(409, "23505", 'duplicate key value violates unique constraint "asana_task_links_milestone_key"');
          Object.assign(row, {
            id: crypto.randomUUID(), state: "waiting", held_reason: null, after_payment: false, held_at: null, completed: false, completed_at: null, completed_by_gid: null,
            completed_by_name: null, assignee_name: null, deliverables: [], deliverable_fingerprint: null, last_read_at: null, read_error: null, accepted_by: null,
            accepted_at: null, accepted_fingerprint: null, accepted_completed_at: null, accepted_deliverables: null, linked_at: new Date(NOW).toISOString(), unlinked_at: null, ...row,
          });
        }
        rows.push(row);
      }
      return { status: 201, body: inserted };
    }
    if (sent.method === "PATCH") {
      const changed = rows.filter((row) => matches(row, sent.params));
      for (const row of changed) Object.assign(row, sent.body as Row);
      return { body: changed };
    }
    return { body: [] };
  });

  const tasks = new Map<string, AsanaTask>([
    [LOGO_TASK, { name: "Logo animation", notes: "Acceptance: 5-second logo animation, MP4 and GIF.\nDeliverable: https://www.figma.com/file/AbC123/logo-motion", completed: false, completedAt: null, completedBy: null, attachments: [], comments: [] }],
    [POSTS_TASK, { name: "10 launch posts", notes: "Acceptance: ten posts, 1080 x 1350.\nDeliverable: https://drive.google.com/drive/folders/launch-posts", completed: false, completedAt: null, completedBy: null, attachments: [], comments: [] }],
  ]);
  const asanaUsers: Record<string, string> = { "mai@fernhill.example": options.ownerAsanaIsPayee ? OWNER_ASANA : "5550001", "admin@business.example": "5550002" };
  const asanaCalls: string[] = [];
  let validToken = "access-1";
  let down = false;
  let hung = false;
  const asanaFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asanaCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/-/oauth_token") {
      validToken = `access-${asanaCalls.length}`;
      return json({ access_token: validToken, expires_in: 3600, token_type: "bearer" });
    }
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${validToken}`) return json({ errors: [{ message: "Not Authorized" }] }, 401);
    if (down) return json({ errors: [{ message: "Server Error" }] }, 503);
    if (hung) return new Promise<Response>(() => undefined);
    const task = /^\/api\/1\.0\/tasks\/(\d+)$/.exec(url.pathname);
    if (task) {
      const one = tasks.get(task[1]);
      if (!one) return json({ errors: [] }, 404);
      return json({
        data: {
          gid: task[1], name: one.name, notes: one.notes, completed: one.completed, completed_at: one.completedAt, completed_by: one.completedBy,
          assignee: { gid: "5550001", name: "Mai Tran" }, modified_at: "2026-10-14T08:00:00Z",
          permalink_url: `https://app.asana.com/0/${PROJECT}/${task[1]}`, workspace: { gid: WORKSPACE }, projects: [{ gid: PROJECT }],
        },
      });
    }
    if (url.pathname === "/api/1.0/attachments") {
      const one = tasks.get(url.searchParams.get("parent") ?? "");
      return json({ data: (one?.attachments ?? []).map((item) => ({ ...item, host: "asana", permanent_url: `https://app.asana.com/app/asana/-/get_asset?asset_id=${item.gid}` })), next_page: null });
    }
    const stories = /^\/api\/1\.0\/tasks\/(\d+)\/stories$/.exec(url.pathname);
    if (stories) return json({ data: (tasks.get(stories[1])?.comments ?? []).map((item) => ({ ...item, resource_subtype: "comment_added" })), next_page: null });
    const user = /^\/api\/1\.0\/users\/(.+)$/.exec(url.pathname);
    if (user) {
      const gid = asanaUsers[decodeURIComponent(user[1])];
      return gid ? json({ data: { gid, name: "someone" } }) : json({ errors: [] }, 404);
    }
    return json({ errors: [] }, 404);
  }) as unknown as typeof fetch;
  const provider = asanaProvider({ clientId: "1211111111111111", clientSecret: "secret" }, { fetchImpl: asanaFetch, now: () => NOW });

  let token: StoredTokens = { id: "token-1", version: 1, accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000, scopes: [] };
  let holder: string | null = null;
  tokenRow.current = {
    store: {
      read: async () => ({ ...token }),
      lease: async (who) => (holder && holder !== who ? null : ((holder = who), { ...token })),
      store: async (who, version, tokens) => {
        if (holder !== who || version !== token.version) return false;
        token = { ...token, ...tokens, version: token.version + 1 };
        holder = null;
        return true;
      },
      release: async (who) => {
        if (holder === who) holder = null;
      },
    },
  };

  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  const link = (milestoneId: string) => tables.asana_task_links.find((row) => row.milestone_id === milestoneId && row.unlinked_at == null) as Row;
  const milestone = (id: string) => tables.milestones.find((row) => row.id === id) as Row;
  const complete = (gid: string, by = { gid: "5550001", name: "Mai Tran" }) => Object.assign(tasks.get(gid) as AsanaTask, { completed: true, completedAt: "2026-10-14T08:30:00.000Z", completedBy: by });
  const accept = (milestoneId: string, userId = ADMIN, fields: { fingerprint?: string; criteriaSha256?: string } = {}) =>
    run(() =>
      acceptMilestoneWork(
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
  const expireToken = () => {
    token = { ...token, accessToken: "expired", expiresAt: 0 };
  };
  /** The task reads Asana answered or refused so far. */
  const asanaReads = () => asanaCalls.filter((call) => /^GET \/api\/1\.0\/tasks\/\d+$/.test(call)).length;
  const asanaDown = (value: boolean) => {
    down = value;
  };
  const asanaHung = (value: boolean) => {
    hung = value;
  };
  return { fake, tables, tasks, run, provider, link, milestone, complete, accept, asanaCalls, asanaReads, asanaDown, asanaHung, expireToken, token: () => token };
}

const entries = (action: string) => ledger.mock.calls.filter(([, input]) => input.action === action).map(([, input]) => input);

beforeEach(() => {
  ledger.mockReset();
});

describe("who may link, write criteria and accept", () => {
  it("is whoever verifies milestones by hand, from the console only", () => {
    for (const command of ["milestone.link_task", "milestone.unlink_task", "milestone.set_criteria", "milestone.accept", "milestone.check_task"] as const) {
      expect(COMMAND_PERMISSIONS[command]).toBe("records.write");
      for (const surface of ["telegram", "slack", "api", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(command);
    }
  });

  it("refuses an approver or a viewer before anything is read", async () => {
    const w = world();
    for (const role of ["approver", "viewer", "accountant"] as const) {
      const refused = await w.run(() => linkAsanaTask(actor(ADMIN, { role }), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }));
      expect(refused).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(w.fake.requests).toHaveLength(0);
  });
});

describe("two milestones accepted", () => {
  it("links each to its task, waits until each is completed, and verifies each only when a person accepts it", async () => {
    const w = world();
    const linked = await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}/f` }, { provider: w.provider }));
    expect(linked).toMatchObject({ ok: true, state: "waiting" });
    // Chosen in the picker: workspace, project, task.
    expect(await w.run(() => linkAsanaTask(actor(), { milestoneId: POSTS, pick: { workspaceGid: WORKSPACE, projectGid: PROJECT, taskGid: POSTS_TASK } }, { provider: w.provider }))).toMatchObject({ ok: true });
    expect(w.link(LOGO)).toMatchObject({ task_gid: LOGO_TASK, workspace_gid: WORKSPACE, project_gid: PROJECT, state: "waiting", task_url: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` });
    expect(entries("asana_task_linked")).toHaveLength(2);

    // Not completed yet: nothing to accept.
    expect(await w.accept(LOGO)).toMatchObject({ ok: false });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });

    // Completed in Asana: ready, never verified by that alone.
    w.complete(LOGO_TASK);
    w.complete(POSTS_TASK);
    await w.run(() => checkAsanaTask(actor(), { milestoneId: LOGO }, { provider: w.provider }));
    await w.run(() => checkAsanaTask(actor(), { milestoneId: POSTS }, { provider: w.provider }));
    expect(w.link(LOGO)).toMatchObject({ state: "ready", completed: true, completed_by_name: "Mai Tran" });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });
    expect(entries("asana_task_ready")).toHaveLength(1);
    // The posts have no criteria: held until a person writes them, then ready.
    expect(w.link(POSTS)).toMatchObject({ state: "held", held_reason: "no_criteria" });
    expect(await w.accept(POSTS, ADMIN, { criteriaSha256: sha("none") })).toMatchObject({ ok: false });
    expect(await w.run(() => setAcceptanceCriteria(actor(), { milestoneId: POSTS, criteria: "Ten posts, 1080 x 1350, captions in English." }))).toMatchObject({ ok: true });
    expect(w.link(POSTS)).toMatchObject({ state: "ready", held_reason: null });

    expect(await w.accept(LOGO)).toMatchObject({ ok: true, status: "verified" });
    expect(await w.accept(POSTS)).toMatchObject({ ok: true, status: "verified" });
    for (const id of [LOGO, POSTS]) expect(w.milestone(id)).toMatchObject({ status: "verified", verified: true, verification_method: "asana" });
    expect(w.link(LOGO)).toMatchObject({ state: "accepted", accepted_by: ADMIN });
    const accepted = entries("milestone_accepted");
    expect(accepted.map((entry) => entry.detail.milestoneId)).toEqual([LOGO, POSTS]);
    expect(accepted[0].detail).toMatchObject({ by: ADMIN, taskGid: LOGO_TASK, criteriaSha256: sha(LOGO_CRITERIA), payeeAsanaMapped: true });
    // Accepting twice is refused.
    expect(await w.accept(LOGO)).toMatchObject({ ok: false });
  });

  it("refuses a pasted link that is not an Asana task, and a task linked to another milestone", async () => {
    const w = world();
    expect(await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: "https://evil.example/0/1/2" }, { provider: w.provider }))).toMatchObject({ ok: false, code: "bad_task" });
    expect(w.asanaCalls).toHaveLength(0);
    await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }));
    expect(await w.run(() => linkAsanaTask(actor(), { milestoneId: POSTS, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }))).toMatchObject({ ok: false, code: "task_linked" });
  });
});

async function acceptedLogo(w: ReturnType<typeof world>) {
  await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }));
  w.complete(LOGO_TASK);
  await w.run(() => checkAsanaTask(actor(), { milestoneId: LOGO }, { provider: w.provider }));
  expect(await w.accept(LOGO)).toMatchObject({ ok: true });
}

describe("a task reopened after acceptance", () => {
  it("is held for review by the cycle's read, before the contractor stage, and the milestone loses its verification", async () => {
    const w = world();
    await acceptedLogo(w);
    Object.assign(w.tasks.get(LOGO_TASK) as AsanaTask, { completed: false, completedAt: null, completedBy: null });
    const summary = await w.run(() => refreshAsanaMilestones(w.provider));
    expect(summary).toMatchObject({ checked: 1, withdrawn: 1 });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false, verification_status: "unverified" });
    expect(w.link(LOGO)).toMatchObject({ state: "held", held_reason: "reopened", after_payment: false });
    expect(entries("milestone_acceptance_withdrawn")[0].detail).toMatchObject({ milestoneId: LOGO, reason: "reopened", afterPayment: false });
    // Completed again: still held until a person accepts again, against what Asana shows now.
    w.complete(LOGO_TASK);
    await w.run(() => checkAsanaTask(actor(), { milestoneId: LOGO }, { provider: w.provider }));
    expect(w.link(LOGO)).toMatchObject({ state: "held", held_reason: "reopened" });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });
    expect(await w.accept(LOGO)).toMatchObject({ ok: true });
    expect(w.milestone(LOGO)).toMatchObject({ status: "verified", verified: true });
  });

  it("is read by the cycle and by the sweeper however many milestones accepted from Asana were paid before it", async () => {
    // Paid milestones keep their accepted links, as their history: 120 of them, linked before this one.
    const paidLinks = (w: ReturnType<typeof world>) => {
      for (let n = 0; n < 120; n += 1) {
        const id = crypto.randomUUID();
        w.tables.milestones.push({ id, org_id: ORG, title: `Paid ${n}`, amount: "10", contractor_id: FERNHILL, status: "paid", verified: true, verification_method: "asana", verification_source: null, acceptance_criteria: "Done.", decision_claimed_at: null });
        w.tables.asana_task_links.push({
          id: crypto.randomUUID(), org_id: ORG, milestone_id: id, connection_id: "conn-asana", workspace_gid: WORKSPACE, project_gid: PROJECT, task_gid: String(1300000000000000 + n),
          task_name: `Paid ${n}`, task_url: null, state: "accepted", held_reason: null, after_payment: false, held_at: null, completed: true, completed_at: "2026-09-01T00:00:00.000Z",
          completed_by_gid: null, completed_by_name: null, assignee_name: null, deliverables: [], deliverable_fingerprint: "f".repeat(64), last_read_at: null, read_error: null,
          accepted_by: OWNER, accepted_at: "2026-09-01T00:00:00.000Z", accepted_fingerprint: "f".repeat(64), accepted_completed_at: "2026-09-01T00:00:00.000Z", accepted_deliverables: [],
          linked_at: "2026-09-01T00:00:00.000Z", unlinked_at: null,
        });
      }
    };
    const cycle = world();
    paidLinks(cycle);
    await acceptedLogo(cycle);
    Object.assign(cycle.tasks.get(LOGO_TASK) as AsanaTask, { completed: false, completedAt: null, completedBy: null });
    expect(await cycle.run(() => refreshAsanaMilestones(cycle.provider))).toMatchObject({ checked: 1, withdrawn: 1 });
    expect(cycle.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });

    const sweep = world();
    paidLinks(sweep);
    await acceptedLogo(sweep);
    Object.assign(sweep.tasks.get(LOGO_TASK) as AsanaTask, { completed: false, completedAt: null, completedBy: null });
    expect(await sweep.run(() => syncAsanaConnection("conn-asana", sweep.provider, { now: () => NOW }))).toMatchObject({ outcome: "synced", summary: { withdrawn: 1 } });
    expect(sweep.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });
  });

  it("is held by the read right before the release is sent, when it was reopened after the cycle's read", async () => {
    // As on Arc testnet on Oct 14: the cycle read the task completed, and it was reopened while the stage decided.
    const w = world();
    await acceptedLogo(w);
    expect(await w.run(() => refreshAsanaMilestones(w.provider))).toMatchObject({ checked: 1, withdrawn: 0 });
    expect(w.milestone(LOGO)).toMatchObject({ status: "verified", verified: true });
    Object.assign(w.tasks.get(LOGO_TASK) as AsanaTask, { completed: false, completedAt: null, completedBy: null });
    // Only the milestones about to be paid are read: the other one, not accepted, is not.
    const reads = w.asanaReads();
    expect(await w.run(() => recheckBeforeSending([LOGO, POSTS], w.provider))).toMatchObject({ checked: 1, read: 1, withdrawn: 1, complete: true });
    expect(w.asanaReads() - reads).toBe(1);
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false, verification_status: "unverified" });
    expect(w.link(LOGO)).toMatchObject({ state: "held", held_reason: "reopened", after_payment: false });
    // None to send, or none accepted from Asana: nothing is read.
    expect(await w.run(() => recheckBeforeSending([], w.provider))).toMatchObject({ checked: 0, complete: true });
    expect(await w.run(() => recheckBeforeSending([POSTS], w.provider))).toMatchObject({ checked: 0, complete: true });
    expect(w.asanaReads() - reads).toBe(1);
  });

  it("is left accepted by the read right before sending when Asana cannot be read, as the acceptance stands", async () => {
    const w = world();
    await acceptedLogo(w);
    w.asanaDown(true);
    expect(await w.run(() => recheckBeforeSending([LOGO], w.provider))).toMatchObject({ checked: 1, failed: 1, withdrawn: 0, complete: false });
    expect(w.milestone(LOGO)).toMatchObject({ status: "verified", verified: true });
    expect(w.link(LOGO)).toMatchObject({ state: "accepted" });
  });

  it("does not hold the payment past its deadline when Asana does not answer, and leaves the acceptance as it was", async () => {
    const w = world();
    await acceptedLogo(w);
    w.asanaHung(true);
    const started = Date.now();
    expect(await w.run(() => recheckBeforeSending([LOGO], w.provider, { deadlineMs: 50 }))).toMatchObject({ withdrawn: 0, complete: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.milestone(LOGO)).toMatchObject({ status: "verified", verified: true });
    expect(w.link(LOGO)).toMatchObject({ state: "accepted" });
  });

  it("after its payment was sent, holds only the link, as a dispute, and leaves the payment alone", async () => {
    const w = world();
    await acceptedLogo(w);
    w.tables.payment_intents.push({ org_id: ORG, source_type: "milestone", source_id: LOGO, status: "pending" });
    Object.assign(w.tasks.get(LOGO_TASK) as AsanaTask, { completed: false, completedAt: null });
    await w.run(() => refreshAsanaMilestones(w.provider));
    expect(w.link(LOGO)).toMatchObject({ state: "held", after_payment: true });
    expect(w.milestone(LOGO)).toMatchObject({ status: "verified", verified: true });
  });
});

describe("a deliverable changed after acceptance", () => {
  it("is held for review when a webhook delivery has the task read again", async () => {
    const w = world();
    await acceptedLogo(w);
    (w.tasks.get(LOGO_TASK) as AsanaTask).attachments.push({ gid: "301", name: "logo-v2.mp4", created_at: "2026-10-14T10:00:00Z" });
    const webhook: StoredWebhook = { id: crypto.randomUUID(), orgId: ORG, connectionId: "conn-asana", linkId: String(w.link(LOGO).id), resourceGid: LOGO_TASK, webhookGid: "8800001", state: "active", secret: "s", createdAt: new Date(NOW).toISOString() };
    await w.run(() => rereadInScope(webhook, w.provider));
    expect(w.link(LOGO)).toMatchObject({ state: "held", held_reason: "deliverable_changed" });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });
  });

  it("is held by the sweeper's read too, under the connection's sync lease", async () => {
    const w = world();
    await acceptedLogo(w);
    (w.tasks.get(LOGO_TASK) as AsanaTask).comments.push({ gid: "77", text: "Final cut: https://vimeo.com/123456" });
    const swept = await w.run(() => syncAsanaConnection("conn-asana", w.provider, { now: () => NOW }));
    expect(swept).toMatchObject({ outcome: "synced", summary: { withdrawn: 1 } });
    expect(w.link(LOGO)).toMatchObject({ state: "held", held_reason: "deliverable_changed" });
    expect(w.tables.accounting_connections[0]).toMatchObject({ sync_lease_until: null, last_synced_at: expect.any(String) });
  });

  it("refuses an acceptance of a version other than the one Asana shows now", async () => {
    const w = world();
    await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }));
    w.complete(LOGO_TASK);
    await w.run(() => checkAsanaTask(actor(), { milestoneId: LOGO }, { provider: w.provider }));
    const shown = String(w.link(LOGO).deliverable_fingerprint);
    // The contractor swaps the file while the page is open.
    (w.tasks.get(LOGO_TASK) as AsanaTask).attachments.push({ gid: "302", name: "other.mp4", created_at: "2026-10-14T10:00:00Z" });
    expect(await w.accept(LOGO, ADMIN, { fingerprint: shown })).toMatchObject({ ok: false, code: "stale" });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });
  });
});

describe("self-acceptance", () => {
  it("is refused to the payee, by their email as a member", async () => {
    const w = world();
    await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }));
    w.complete(LOGO_TASK);
    await w.run(() => checkAsanaTask(actor(), { milestoneId: LOGO }, { provider: w.provider }));
    expect(await w.accept(LOGO, PAYEE_MEMBER)).toMatchObject({ ok: false, code: "self_acceptance" });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });
    expect(w.link(LOGO)).toMatchObject({ state: "ready" });
  });

  it("is refused to a member whose Asana account is the payee's, by Asana's user mapping", async () => {
    // The owner connected Asana as themselves, and Asana's user with the payee's email is that same user.
    const w = world({ ownerAsanaIsPayee: true });
    await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }));
    w.complete(LOGO_TASK);
    await w.run(() => checkAsanaTask(actor(), { milestoneId: LOGO }, { provider: w.provider }));
    expect(await w.accept(LOGO, OWNER)).toMatchObject({ ok: false, code: "self_acceptance", message: expect.stringMatching(/Asana account/) });
    // Someone else accepts it.
    expect(await w.accept(LOGO, ADMIN)).toMatchObject({ ok: true });
  });

  it("refuses the payee's own Pay now on such a milestone, and no one else's", async () => {
    const w = world();
    await acceptedLogo(w);
    expect(await w.run(() => paysOwnPayout({ orgId: ORG, userId: PAYEE_MEMBER }, LOGO))).toBe(true);
    expect(await w.run(() => paysOwnPayout({ orgId: ORG, userId: ADMIN }, LOGO))).toBe(false);
    // A milestone with no Asana link is left to the existing checks.
    expect(await w.run(() => paysOwnPayout({ orgId: ORG, userId: PAYEE_MEMBER }, POSTS))).toBe(false);
  });
});

describe("token refresh", () => {
  it("refreshes an expired token under the lease before reading Asana, and stores the new pair", async () => {
    const w = world();
    w.expireToken();
    expect(await w.run(() => linkAsanaTask(actor(), { milestoneId: LOGO, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }))).toMatchObject({ ok: true });
    expect(w.asanaCalls[0]).toBe("POST /-/oauth_token");
    expect(w.token()).toMatchObject({ version: 2, refreshToken: "refresh-1" });
    expect(w.token().accessToken).not.toBe("expired");
  });
});

describe("unlinking", () => {
  it("takes back an acceptance the agent has not paid, and frees the task", async () => {
    const w = world();
    await acceptedLogo(w);
    expect(await w.run(() => unlinkAsanaTask(actor(), { milestoneId: LOGO }, { provider: w.provider, defer: () => undefined }))).toMatchObject({ ok: true });
    expect(w.milestone(LOGO)).toMatchObject({ status: "pending", verified: false });
    expect(w.tables.asana_task_links.every((row) => row.unlinked_at)).toBe(true);
    expect(entries("asana_task_unlinked")[0].detail).toMatchObject({ milestoneId: LOGO, withdrewAcceptance: true });
    expect(await w.run(() => linkAsanaTask(actor(), { milestoneId: POSTS, taskUrl: `https://app.asana.com/0/${PROJECT}/${LOGO_TASK}` }, { provider: w.provider }))).toMatchObject({ ok: true });
  });
});

describe("nothing from Asana sets an amount or a payee", () => {
  it("writes a milestone only through the two functions and its criteria, and every request names the workspace", async () => {
    const w = world();
    await acceptedLogo(w);
    Object.assign(w.tasks.get(LOGO_TASK) as AsanaTask, { completed: false, completedAt: null });
    await w.run(() => refreshAsanaMilestones(w.provider));
    await w.run(() => setAcceptanceCriteria(actor(), { milestoneId: POSTS, criteria: "Ten posts." }));
    const milestoneWrites = w.fake.requests.filter((sent) => sent.path === "/rest/v1/milestones" && sent.method !== "GET");
    for (const write of milestoneWrites) expect(Object.keys(write.body as Row).sort()).toEqual(["acceptance_criteria", "acceptance_criteria_at", "acceptance_criteria_by"]);
    for (const sent of w.fake.requests.filter((one) => one.path.startsWith("/rest/v1/rpc/") && one.path !== "/rest/v1/rpc/org_members")) {
      expect(Object.keys(sent.body as Row)).not.toEqual(expect.arrayContaining(["p_amount"]));
      expect(JSON.stringify(sent.body)).not.toMatch(/amount|contractor|address/);
    }
    for (const sent of w.fake.requests.filter((one) => one.path !== "/rest/v1/rpc/org_members")) expect(carriesOrg(sent, ORG), `${sent.method} ${sent.path}`).toBe(true);
    expect(w.milestone(LOGO)).toMatchObject({ amount: "450", contractor_id: FERNHILL });
  });
});
