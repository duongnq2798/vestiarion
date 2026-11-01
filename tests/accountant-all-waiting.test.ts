import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { TENANT_TABLES } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

vi.mock("server-only", () => ({}));

import { buildHandoff, handoffCsvChunks, handoffPeriod } from "@/lib/accountant/handoff";
import { inboxEmailsToDecide } from "@/lib/email-inbox/list";
import { readPortfolio } from "@/lib/accountant/read";
import {
  applyFilter,
  countByKind,
  KIND_TITLES,
  kindWords,
  permissionFor,
  routeTo,
  sortTriage,
  TRIAGE_KINDS,
  triageFilter,
  type TriageItem,
  type TriageKind,
} from "@/lib/accountant/triage";
import type { OrgRole } from "@/lib/auth/roles";

/**
 * Everything waiting, across every workspace (docs/superpowers/specs/2026-11-01-accountant-all-waiting-design.md AW1 to
 * AW10): decisions waiting for a shadow-mode verdict, invoices to review, contractor work to accept and last month's
 * close, each read in its own workspace through that workspace's tenant token, as the person, each its own part. The
 * fake answers as PostgREST would: by the token's workspace, by the filters sent, and with only the columns asked for.
 */

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const HARBOR = { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01", slug: "harbor-bakery", name: "Harbor Bakery" };
const LUMEN = { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c02", slug: "lumen-studio", name: "Lumen Studio" };
// The viewer is no member here: nothing of it is ever read.
const NORTH = { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c04", slug: "north-garage", name: "North Garage" };
const WORKSPACES = [HARBOR, LUMEN, NORTH];
// Last month is October 2026.
const NOW = new Date("2026-11-03T09:00:00.000Z");

function claimsOf(request: RecordedRequest): Record<string, unknown> | null {
  const parts = (request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "").split(".");
  if (parts.length !== 3) return null;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

type Row = Record<string, unknown>;

/** A value by a column or a JSON path (`read->>amount`), as PostgREST reads `->>`: text, or null. */
function valueAt(row: Row, path: string): unknown {
  const [column, key] = path.split("->>");
  if (!key) return row[column];
  const inner = (row[column] as Row | null | undefined)?.[key];
  return inner === undefined || inner === null ? null : String(inner);
}

/** Whether a row passes one PostgREST filter: the operators these reads send. */
function passes(row: Row, path: string, filter: string): boolean {
  const value = valueAt(row, path);
  if (filter === "is.null") return value === null || value === undefined;
  if (filter.startsWith("eq.")) return value !== null && value !== undefined && String(value) === filter.slice(3);
  if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").includes(String(value));
  throw new Error(`a filter the fake does not model: ${path}=${filter}`);
}

const NOT_FILTERS = new Set(["select", "order", "limit", "offset", "org_id", "or"]);

/** A select's columns: `alias:path`, `column`, or an embed `counterparties(name)`, which answers the embedded row whole. */
function columnsOf(select: string): Array<{ alias: string; path: string }> {
  return (select.match(/[^,()]+(?:\([^)]*\))?/g) ?? []).map((token) => {
    const embed = /^(\w+)\(/.exec(token);
    if (embed) return { alias: embed[1], path: embed[1] };
    const [alias, path] = token.includes(":") ? token.split(":") : [token.split("->>").pop() as string, token];
    return { alias, path };
  });
}

const compare = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? "")));

/** The rows that pass every filter sent, in the order asked, at most the limit, and only the columns asked for. */
function answer(rows: Row[], sent: RecordedRequest): FakeReply {
  const select = sent.params.get("select") ?? "*";
  const columns = select === "*" ? null : columnsOf(select);
  for (const { path } of columns ?? []) {
    const column = path.split("->>")[0];
    // A column the table does not have yet: PostgREST refuses the read.
    if (rows.length > 0 && !(column in rows[0])) return { status: 400, body: { code: "42703", message: `column ${sent.path.replace("/rest/v1/", "")}.${column} does not exist` } };
  }
  let found = rows.filter((row) => [...sent.params.entries()].every(([key, filter]) => NOT_FILTERS.has(key) || passes(row, key, filter)));
  const [orderBy, direction] = (sent.params.get("order") ?? "").split(".");
  if (orderBy) found = [...found].sort((a, b) => compare(a[orderBy], b[orderBy]) * (direction === "desc" ? -1 : 1));
  const limit = Number(sent.params.get("limit") ?? Number.POSITIVE_INFINITY);
  return { body: found.slice(0, limit).map((row) => (columns ? Object.fromEntries(columns.map(({ alias, path }) => [alias, valueAt(row, path)])) : row)) };
}

/** Harbor Bakery's data; Lumen Studio has none. */
const PAYABLES: Row[] = [
  { id: "waits", status: "held", due_date: "2026-11-20", name: "Coastal Flour Mill" },
  { id: "late", status: "held", due_date: "2026-10-30", name: "Brightline Ovens" },
  { id: "against", status: "held", due_date: "2026-11-25", name: "Pixel Print Co" },
  { id: "plain", status: "flagged", due_date: "2026-11-21", name: "Seaside Linen" },
].map((bill) => ({
  id: bill.id,
  amount: "1250",
  currency: "USDC",
  due_date: bill.due_date,
  status: bill.status,
  decided_at: "2026-10-28T08:00:00Z",
  created_at: "2026-10-27T08:00:00Z",
  early_pay_discount_pct: null,
  discount_due_date: null,
  counterparty_id: `cp-${bill.id}`,
  counterparties: { name: bill.name, risk_level: "low", address: "0xabc0000000000000000000000000000000000001" },
}));

const shadowHeld = (seq: number, invoiceId: string): Row => ({
  seq,
  ts: "2026-10-28T08:00:00Z",
  actor: "agent",
  action: "ap_pay",
  detail: { invoiceId, execution: { heldBecause: "shadow_verdict", resultingStatus: "held" } },
});
const DECISIONS: Row[] = [
  { seq: 5, ts: "2026-10-27T08:00:00Z", actor: "agent", action: "ap_hold", detail: { invoiceId: "waits" } },
  shadowHeld(10, "waits"),
  shadowHeld(11, "late"),
  shadowHeld(12, "against"),
  { seq: 13, ts: "2026-10-28T08:00:00Z", actor: "agent", action: "ap_flag_fraud", detail: { invoiceId: "plain" } },
];

const SENDERS = ["accounts@coastalflour.example", "billing@pixelprint.example", "noreply@scanner.example"];
const SUBJECTS = ["Invoice 4471 for October", "Your bill", "Scan 0042"];
const INBOX: Row[] = [
  {
    id: "e1", source: "email", file_name: null, from_address: SENDERS[0], subject: SUBJECTS[0], received_at: "2026-10-30T10:00:00Z", status: "ready", reasons: [],
    read: { counterpartyName: "Coastal Flour Mill", vendorName: "Coastal Flour Mill Ltd", amount: "480.00", currency: "USDC", memo: "Thanks for your order" },
  },
  {
    id: "e2", source: "email", file_name: null, from_address: SENDERS[1], subject: SUBJECTS[1], received_at: "2026-10-31T10:00:00Z", status: "needs_details",
    reasons: ["No due date was read. Ask billing@pixelprint.example for it."], read: { counterpartyName: null, vendorName: "billing@pixelprint.example", amount: "95.5", currency: null },
  },
  { id: "e3", source: "email", file_name: null, from_address: SENDERS[2], subject: SUBJECTS[2], received_at: "2026-11-01T10:00:00Z", status: "unreadable", reasons: ["The invoice could not be read."], read: null },
  {
    id: "g1", source: "google_drive", file_name: "INV-2207.pdf", from_address: "ma***@harbor.example", subject: null, received_at: "2026-11-02T10:00:00Z", status: "needs_details",
    reasons: ["No amount was read."], read: { counterpartyName: null, vendorName: null, amount: null, currency: null },
  },
  // Still being read, and one already dismissed: neither waits for a person.
  { id: "e4", source: "email", file_name: null, from_address: SENDERS[0], subject: SUBJECTS[0], received_at: "2026-11-03T08:00:00Z", status: "received", reasons: [], read: null },
  { id: "e5", source: "email", file_name: null, from_address: SENDERS[0], subject: SUBJECTS[0], received_at: "2026-10-01T08:00:00Z", status: "dismissed", reasons: [], read: null },
];

const draft = (id: string, state: string, source: string, fields: Partial<Row>, read: Row | null = null): Row => ({
  id, state, source, supplier_name: null, invoice_number: null, amount: null, currency: null, due_date: null,
  captured_at: "2026-10-29T09:00:00Z", sent_at: state === "draft" ? null : "2026-10-29T09:05:00Z", read, raw_text: "Invoice text with jane@brightline.example", ...fields,
});
const DRAFTS: Row[] = [
  draft("c1", "sent", "selection", { supplier_name: "Northwind Packaging", invoice_number: "NW-88", amount: "1250.00", currency: "USDC", due_date: "2026-11-15" }, { counterpartyName: "Northwind Packaging" }),
  draft("c2", "sent", "payee_link", { supplier_name: "Brightline Ovens", amount: "300", currency: "EURC", due_date: "2026-11-30", sent_at: "2026-10-30T09:05:00Z" }, { counterpartyName: "Brightline Ovens", via: "payee_link", note: "Pay to jane@brightline.example" }),
  draft("c3", "sent", "file", { sent_at: "2026-10-31T09:05:00Z" }),
  // Added, dismissed, or never sent: none waits.
  draft("c4", "confirmed", "selection", { supplier_name: "Done Co" }),
  draft("c5", "discarded", "selection", { supplier_name: "Gone Co" }),
  draft("c6", "draft", "selection", { supplier_name: "Unsent Co" }),
];

const link = (id: string, milestone: string, state: string, over: Partial<Row> = {}): Row => ({
  id, milestone_id: milestone, state, held_reason: null, held_at: null, completed_at: null, after_payment: false, unlinked_at: null, linked_at: "2026-10-20T08:00:00Z", ...over,
});
const ASANA: Row[] = [
  link("a1", "ms-a1", "ready", { completed_at: "2026-10-30T12:00:00Z" }),
  link("a2", "ms-a2", "held", { held_reason: "reopened", held_at: "2026-10-31T08:00:00Z" }),
  // Changed after its payment was sent; ready on a milestone already paid; accepted; unlinked: no work to accept.
  link("a3", "ms-a3", "held", { held_reason: "reopened", held_at: "2026-10-31T08:00:00Z", after_payment: true }),
  link("a4", "ms-a4", "ready", { completed_at: "2026-10-30T12:00:00Z" }),
  link("a5", "ms-a5", "accepted"),
  link("a6", "ms-a6", "ready", { unlinked_at: "2026-10-25T08:00:00Z" }),
];
const LINEAR: Row[] = [
  link("l1", "ms-l1", "ready", { identifier: "ENG-12", completed_at: "2026-11-01T15:00:00Z" }),
  link("l2", "ms-l2", "held", { identifier: "ENG-14", held_reason: "no_criteria", held_at: "2026-11-02T10:00:00Z" }),
];
const MILESTONES: Row[] = [
  { id: "ms-a1", title: "Logo design", amount: "800", status: "pending", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Studio North" } },
  { id: "ms-a2", title: "Website copy", amount: "450", status: "pending", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Ink and Quill" } },
  { id: "ms-a3", title: "Menu photos", amount: "300", status: "paid", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Studio North" } },
  { id: "ms-a4", title: "Signage", amount: "900", status: "paid", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Studio North" } },
  { id: "ms-a5", title: "Brand book", amount: "700", status: "verified", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Studio North" } },
  { id: "ms-a6", title: "Old task", amount: "100", status: "pending", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Studio North" } },
  { id: "ms-l1", title: "Checkout flow", amount: "2400", status: "pending", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Kite Labs" } },
  { id: "ms-l2", title: "API docs", amount: "600", status: "pending", decided_at: null, created_at: "2026-10-01T08:00:00Z", counterparties: { name: "Kite Labs" } },
];

type Options = {
  /** The viewer's role in Harbor Bakery; a viewer in Lumen Studio. */
  role?: OrgRole;
  /** The month's close pack entries in Harbor's ledger. */
  exports?: Row[];
  /** How many payments Harbor's last month holds. */
  payments?: number;
  /** A path whose reads fail in Harbor, and how. */
  failing?: { path: string; reply: FakeReply };
  /** Answers that win over the world's own. */
  extra?: (sent: RecordedRequest) => FakeReply | null;
};

function world(options: Options = {}) {
  const role = options.role ?? "owner";
  const memberships = [
    { org: HARBOR, role },
    { org: LUMEN, role: "viewer" },
  ];
  const fake = fakeSupabase((sent): FakeReply => {
    const extra = options.extra?.(sent);
    if (extra) return extra;
    if (sent.path === "/rest/v1/memberships") {
      if (sent.params.get("user_id") !== `eq.${VIEWER}`) return { body: [] };
      return { body: memberships.map((row) => ({ role: row.role, orgs: { id: row.org.id, slug: row.org.slug, name: row.org.name, mode: "live", network: "arc-testnet", last_active_at: null } })) };
    }
    if (sent.path === "/rest/v1/orgs") {
      const org = WORKSPACES.find((candidate) => `eq.${candidate.id}` === sent.params.get("id"));
      return org ? { body: orgs.orgRow(org.id, { slug: org.slug, name: org.name, mode: "live", network: "arc-testnet" }) } : { status: 406, body: { code: "PGRST116", message: "no rows" } };
    }
    const inHarbor = claimsOf(sent)?.org_id === HARBOR.id;
    if (options.failing && inHarbor && sent.path === options.failing.path) return options.failing.reply;
    if (sent.method === "HEAD") {
      // Last month's payments, counted (AW5); any other count is none.
      const paid = sent.path === "/rest/v1/payment_intents" && inHarbor ? (options.payments ?? 3) : 0;
      return { body: [], headers: { "content-range": `*/${paid}` } };
    }
    if (!inHarbor) return { body: [] };
    switch (sent.path) {
      case "/rest/v1/invoices":
        return { body: sent.params.get("direction") === "eq.payable" ? PAYABLES : [] };
      case "/rest/v1/shadow_modes":
        return { body: [{ currency: "USDC", started_at: "2026-10-01T00:00:00Z", started_by: VIEWER }] };
      case "/rest/v1/decision_verdicts":
        return answer([{ entry_seq: 12, verdict: "disagree" }], sent);
      case "/rest/v1/ledger_entries":
        // The agent's decisions on the bills a verdict may hold, and the close pack's exports: no other entry here.
        if (sent.params.get("actor") === "eq.agent" && sent.params.has("detail->>invoiceId")) return answer(DECISIONS, sent);
        if (sent.params.get("action") === "eq.close_pack_exported") return answer(options.exports ?? [], sent);
        return { body: [] };
      case "/rest/v1/inbox_emails":
        return answer(INBOX, sent);
      case "/rest/v1/google_drive_folders":
        return answer([{ folder_name: "Bills to pay" }], sent);
      case "/rest/v1/invoice_drafts":
        return answer(DRAFTS, sent);
      case "/rest/v1/asana_task_links":
        return answer(ASANA, sent);
      case "/rest/v1/linear_issue_links":
        return answer(LINEAR, sent);
      case "/rest/v1/milestones":
        return answer(MILESTONES, sent);
      default:
        return { body: [] };
    }
  });
  const read = () => runWith({ config, db: fake.client, fetch: fake.fetch }, () => readPortfolio(VIEWER, NOW));
  return { fake, read };
}

const harborItems = (items: TriageItem[]) => items.filter((item) => item.workspace.slug === HARBOR.slug);
const ofKind = (items: TriageItem[], kind: TriageKind) => harborItems(items).filter((item) => item.kind === kind);
const unreadOf = (portfolio: Awaited<ReturnType<ReturnType<typeof world>["read"]>>, slug = HARBOR.slug) => portfolio.workspaces.find((workspace) => workspace.slug === slug)?.unread;

beforeEach(() => {
  // A deployment that reads a Google Drive folder lists the review list's documents, as Bills & receivables does.
  vi.stubEnv("GOOGLE_DRIVE_CLIENT_ID", "123456789-abc123.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_DRIVE_CLIENT_SECRET", "test-drive-client-secret");
  // And one where Asana and Linear are set up, so Contractors shows their cards.
  vi.stubEnv("ASANA_CLIENT_ID", "1209876543210987");
  vi.stubEnv("ASANA_CLIENT_SECRET", "test-asana-client-secret");
  vi.stubEnv("LINEAR_CLIENT_ID", "5f0c2b0d8d6a4c1f9e0a7b3c2d1e4f5a");
  vi.stubEnv("LINEAR_CLIENT_SECRET", "test-linear-client-secret");
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "test-linear-webhook-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("all waiting: the kinds and their words (AW6, AW7)", () => {
  it("orders the queue past its day, decisions, verdicts, co-signs, addresses, work, invoices, customers, bookings, the month, receivables, connectors, limits (all waiting AW6)", () => {
    expect(TRIAGE_KINDS).toEqual([
      "past_decide_by",
      "decision",
      "verdict",
      "cosign",
      "confirm_address",
      "accept_work",
      "to_review",
      "customer_says_paid",
      "disputed",
      "to_book",
      "month_close",
      "receivable_overdue",
      "connector",
      "limit",
    ]);
    const item = (kind: TriageKind, canAct: boolean, since = "2026-10-01"): TriageItem => ({
      key: `harbor:${kind}:${since}:${canAct}`, kind, workspace: { slug: "harbor", name: "Harbor" }, title: kind, detail: "", amount: null, since, href: "/o/harbor/x", canAct, who: "",
    });
    const sorted = sortTriage([item("month_close", false), item("to_review", true), item("verdict", false), item("accept_work", true, "2026-09-01"), item("decision", false), item("month_close", true)]);
    // What the viewer can act on first (A3), then by kind, then the oldest.
    expect(sorted.map((entry) => [entry.kind, entry.canAct])).toEqual([
      ["accept_work", true],
      ["to_review", true],
      ["month_close", true],
      ["decision", false],
      ["verdict", false],
      ["month_close", false],
    ]);
  });

  it("names each new kind, one and many (all waiting AW7)", () => {
    expect(KIND_TITLES.verdict).toEqual({ one: "Waiting for a verdict", many: "Decisions waiting for a verdict" });
    expect(KIND_TITLES.to_review).toEqual({ one: "Invoice to review", many: "Invoices to review" });
    expect(KIND_TITLES.accept_work).toEqual({ one: "Work to accept", many: "Milestones to accept" });
    expect(KIND_TITLES.month_close).toEqual({ one: "Month to close", many: "Months to close" });
    expect(kindWords("verdict", 2)).toBe("2 decisions waiting for a verdict");
    // A count a card can say: never "2 work to accept".
    expect(kindWords("accept_work", 2)).toBe("2 milestones to accept");
    expect(kindWords("to_review", 2)).toBe("2 invoices to review");
    expect(kindWords("month_close", 1)).toBe("1 month to close");
    // The kind filter reads them from the address, and the cards count them in the queue's order.
    for (const kind of ["verdict", "to_review", "accept_work", "month_close"] as const) expect(triageFilter({ kind }).kind).toBe(kind);
  });

  it("routes each new kind by the permission its own action checks, for every role (all waiting AW2 to AW5, AW7)", () => {
    // giveVerdictAction: approval.decide; the review list's add and dismiss, and the accept commands: records.write; the
    // close pack's download: workspace.read.
    expect([permissionFor("verdict"), permissionFor("to_review"), permissionFor("accept_work"), permissionFor("month_close")]).toEqual([
      "approval.decide",
      "records.write",
      "records.write",
      "workspace.read",
    ]);
    const routes = (role: OrgRole) => (["verdict", "to_review", "accept_work", "month_close"] as const).map((kind) => routeTo(role, kind));
    expect(routes("owner")).toEqual([
      { canAct: true, who: "You can give a verdict" },
      { canAct: true, who: "You can review and add it" },
      { canAct: true, who: "You can check it and accept it" },
      { canAct: true, who: "You can download the close pack" },
    ]);
    expect(routes("admin").map((route) => route.canAct)).toEqual([true, true, true, true]);
    expect(routes("approver")).toEqual([
      { canAct: true, who: "You can give a verdict" },
      { canAct: false, who: "Waiting on an owner or admin of this workspace" },
      { canAct: false, who: "Waiting on an owner or admin of this workspace" },
      { canAct: true, who: "You can download the close pack" },
    ]);
    for (const role of ["accountant", "viewer"] as const) {
      expect(routes(role), role).toEqual([
        { canAct: false, who: "Waiting on an owner, admin or approver of this workspace" },
        { canAct: false, who: "Waiting on an owner or admin of this workspace" },
        { canAct: false, who: "Waiting on an owner or admin of this workspace" },
        { canAct: true, who: "You can download the close pack" },
      ]);
    }
  });
});

describe("all waiting: read in each workspace, as the person (AW1)", () => {
  it("reads each new kind in its own workspace, through a tenant token naming that workspace and the person, and never a workspace they are not in (all waiting AW1, AW10)", async () => {
    const { fake, read } = world();
    const portfolio = await read();
    const NEW_KIND_TABLES = ["shadow_modes", "decision_verdicts", "ledger_entries", "inbox_emails", "google_drive_folders", "invoice_drafts", "asana_task_links", "linear_issue_links", "milestones", "payment_intents"];
    const reads = fake.requests.filter((sent) => NEW_KIND_TABLES.includes(sent.path.replace("/rest/v1/", "")));
    for (const sent of reads) {
      // Each a tenant table, read as the person in one workspace, never as the platform.
      expect((TENANT_TABLES as readonly string[]).includes(sent.path.replace("/rest/v1/", "")), sent.path).toBe(true);
      const claims = claimsOf(sent);
      expect(claims?.role, sent.path).toBe("vestiarion_tenant");
      expect(claims?.sub, sent.path).toBe(VIEWER);
      expect([HARBOR.id, LUMEN.id], sent.path).toContain(claims?.org_id);
      // The DAL's own filter names the same workspace as the token, on a count as on a read.
      expect(sent.params.get("org_id"), sent.path).toBe(`eq.${String(claims?.org_id)}`);
    }
    for (const org of [HARBOR, LUMEN]) {
      const paths = new Set(reads.filter((sent) => claimsOf(sent)?.org_id === org.id).map((sent) => `${sent.method} ${sent.path}`));
      for (const path of ["GET /rest/v1/inbox_emails", "GET /rest/v1/invoice_drafts", "GET /rest/v1/asana_task_links", "GET /rest/v1/linear_issue_links", "HEAD /rest/v1/payment_intents", "GET /rest/v1/ledger_entries"]) {
        expect(paths.has(path), `${org.slug}: ${path}`).toBe(true);
      }
    }
    expect(fake.requests.some((sent) => claimsOf(sent)?.org_id === NORTH.id)).toBe(false);
    // Only Harbor's token finds Harbor's data: Lumen lists nothing, and nothing was left unread.
    expect(portfolio.items.filter((item) => item.workspace.slug === LUMEN.slug)).toEqual([]);
    expect(new Set(harborItems(portfolio.items).map((item) => item.kind))).toEqual(new Set(["past_decide_by", "decision", "verdict", "accept_work", "to_review", "month_close"]));
    expect(portfolio.workspaces.map((workspace) => workspace.unread)).toEqual([[], []]);
  });

  it("calls no outside service: every request is one to the workspace's own database (all waiting AW1)", async () => {
    const outside = vi.spyOn(globalThis, "fetch");
    const { fake, read } = world();
    await read();
    expect(fake.requests.every((sent) => sent.path.startsWith("/rest/v1/"))).toBe(true);
    expect(outside).not.toHaveBeenCalled();
  });
});

describe("all waiting: decisions waiting for a verdict (AW2)", () => {
  it("makes a bill waiting for a verdict a verdict item in place of its decision item, never both, saying the agent decided to pay it and that agreeing pays it", async () => {
    const { fake, read } = world({ role: "approver" });
    const items = (await read()).items;
    expect(ofKind(items, "verdict")).toEqual([
      expect.objectContaining({
        key: "harbor-bakery:verdict:waits",
        title: "Coastal Flour Mill",
        // Every bill a verdict holds is one the agent decided to pay: never the words of a hold the agent chose (all waiting AW2).
        detail: "The agent decided to pay it, and shadow mode pays nothing until a person agrees. Agree and pay it, or disagree. Decide by Nov 20, 2026.",
        amount: { value: 1250, currency: "USDC" },
        since: "2026-10-28T08:00:00Z",
        href: "/o/harbor-bakery/approvals#payable-waits",
        canAct: true,
        who: "You can give a verdict",
      }),
    ]);
    // One item per bill.
    const keys = harborItems(items).filter((item) => item.key.match(/:(waits|late|against|plain)$/)).map((item) => item.key);
    expect(keys.map((key) => key.split(":").pop()).sort()).toEqual(["against", "late", "plain", "waits"]);
    expect(keys).not.toContain("harbor-bakery:decision:waits");
    // Asked once, for the held bills only: a verdict holds a bill only while it is held.
    const asked = fake.requests.filter((sent) => sent.path === "/rest/v1/ledger_entries" && sent.params.has("detail->>invoiceId"));
    expect(asked).toHaveLength(1);
    expect(asked[0].params.get("detail->>invoiceId")).toBe("in.(waits,late,against)");
  });

  it("keeps a bill past its decide-by day there, and says it also waits for a verdict", async () => {
    const { read } = world({ role: "approver" });
    expect(harborItems((await read()).items).find((item) => item.key.endsWith(":late"))).toMatchObject({
      kind: "past_decide_by",
      detail: "Held for a person. Its decide-by day was Oct 30, 2026. It also waits for a verdict in shadow mode.",
      since: "2026-10-30",
    });
  });

  it("keeps a bill someone disagreed on a decision item, which says to return or reject it", async () => {
    const { read } = world({ role: "approver" });
    const items = harborItems((await read()).items);
    expect(items.find((item) => item.key.endsWith(":against"))).toMatchObject({
      kind: "decision",
      detail: "Held for a person. Someone disagreed with the agent in shadow mode: return or reject it. Decide by Nov 25, 2026.",
    });
    expect(items.find((item) => item.key.endsWith(":plain"))).toMatchObject({ kind: "decision", detail: "Flagged for review. Decide by Nov 21, 2026." });
  });

  it("says a verdict once to a co-signing accountant, in the verdict's words, where it blocks the co-sign (all waiting AW2, accountant queue AQ3)", async () => {
    const { read } = world({
      role: "accountant",
      extra: (sent) =>
        sent.path === "/rest/v1/approval_policies" && claimsOf(sent)?.org_id === HARBOR.id
          ? { body: [{ two_approvals_above: "500", accountant_cosigns: true, payee_lock: false, payee_lock_cooling_hours: 0 }] }
          : sent.path === "/rest/v1/rpc/approvers_among"
            ? { body: (sent.body as { p_users: string[] }).p_users }
            : sent.path === "/rest/v1/rpc/approvers_besides" || sent.path === "/rest/v1/rpc/cosigners_besides"
              ? { body: 1 }
              : null,
    });
    const portfolio = await read();
    // The co-sign facts were read, and nothing was left unread.
    expect(unreadOf(portfolio)).toEqual([]);
    const items = harborItems(portfolio.items);
    expect(items.find((item) => item.key.endsWith(":plain"))?.kind).toBe("cosign");
    expect(items.find((item) => item.key.endsWith(":waits"))).toMatchObject({
      kind: "verdict",
      detail: "The agent decided to pay it, and shadow mode pays nothing until a person agrees. Agree and pay it, or disagree. Decide by Nov 20, 2026.",
      canAct: false,
      who: "Waiting on an owner, admin or approver of this workspace",
    });
    expect(items.find((item) => item.key.endsWith(":against"))).toMatchObject({
      kind: "decision",
      detail: "Held for a person. Someone disagreed with the agent in shadow mode: return or reject it. Decide by Nov 25, 2026.",
    });
  });

  it("lists nothing as a verdict outside shadow mode", async () => {
    const { read } = world({ role: "approver", extra: (sent) => (sent.path === "/rest/v1/shadow_modes" ? { body: [] } : null) });
    const items = harborItems((await read()).items);
    expect(ofKind(items, "verdict")).toEqual([]);
    expect(items.find((item) => item.key.endsWith(":waits"))).toMatchObject({ kind: "decision", detail: "Held for a person. Decide by Nov 20, 2026." });
  });
});

describe("all waiting: invoices to review (AW3)", () => {
  it("lists each emailed invoice, Drive file and open captured draft once, with no email address, subject or email words", async () => {
    const { fake, read } = world();
    const items = ofKind((await read()).items, "to_review");
    expect(items.map((item) => [item.key, item.title, item.detail, item.amount, item.since, item.href])).toEqual([
      ["harbor-bakery:to_review:c1", "Northwind Packaging", "Captured in Chrome. Ready to add.", { value: 1250, currency: "USDC" }, "2026-10-29T09:05:00Z", "/o/harbor-bakery/invoices?review=captured"],
      [
        "harbor-bakery:to_review:c2",
        "Brightline Ovens",
        "Sent through the payee's invoice link. Needs details: No invoice number was read. Add it, so a repeat of this invoice can be told apart.",
        { value: 300, currency: "EURC" },
        "2026-10-30T09:05:00Z",
        "/o/harbor-bakery/invoices?review=captured",
      ],
      ["harbor-bakery:to_review:e1", "Coastal Flour Mill", "Emailed to the workspace's address. Ready to add.", { value: 480, currency: "USDC" }, "2026-10-30T10:00:00Z", "/o/harbor-bakery/invoices?review=email"],
      ["harbor-bakery:to_review:c3", "A captured invoice", "Captured in Chrome. Needs details: No supplier was read. Type who sent the invoice.", null, "2026-10-31T09:05:00Z", "/o/harbor-bakery/invoices?review=captured"],
      [
        "harbor-bakery:to_review:e2",
        "bi***@pixelprint.example",
        "Emailed to the workspace's address. Needs details: No due date was read. Ask bi***@pixelprint.example for it.",
        null,
        "2026-10-31T10:00:00Z",
        "/o/harbor-bakery/invoices?review=email",
      ],
      ["harbor-bakery:to_review:e3", "An emailed invoice", "Emailed to the workspace's address. Could not be read.", null, "2026-11-01T10:00:00Z", "/o/harbor-bakery/invoices?review=email"],
      ["harbor-bakery:to_review:g1", "INV-2207.pdf", "Added to the Google Drive folder Bills to pay. Needs details: No amount was read.", null, "2026-11-02T10:00:00Z", "/o/harbor-bakery/invoices?review=email"],
    ]);
    expect(items.every((item) => item.canAct && item.who === "You can review and add it")).toBe(true);
    // Personal data (AW3): no sender, no subject, no email's words, no full address anywhere on an item.
    const shown = JSON.stringify(items);
    for (const words of [...SENDERS, ...SUBJECTS, "Thanks for your order", "jane@brightline.example", "Pay to"]) expect(shown).not.toContain(words);
    expect(shown).not.toMatch(/[a-z0-9._%+-]{3,}@[a-z0-9.-]+\.[a-z]{2,}/i);
    // Nor are they read: the sender, the subject, the captured text and the payee's note are never asked for.
    for (const path of ["/rest/v1/inbox_emails", "/rest/v1/invoice_drafts"]) {
      const select = fake.requests.find((sent) => sent.path === path && claimsOf(sent)?.org_id === HARBOR.id)?.params.get("select") ?? "";
      expect(select, path).not.toMatch(/from_address|subject|raw_text|(^|,)read(,|$)|note/);
    }
  });

  it("reads the review list's own window, its newest 50 of each list, and keeps the documents waiting for a person (all waiting AW3)", async () => {
    const { fake, read } = world();
    await read();
    const inbox = fake.requests.find((sent) => sent.path === "/rest/v1/inbox_emails")!;
    // As `inboxEmailsToDecide` reads it, one still being read included; that one is then left out (e4 above).
    expect([inbox.params.get("status"), inbox.params.get("order"), inbox.params.get("limit")]).toEqual(["in.(received,ready,needs_details,unreadable)", "received_at.desc", "50"]);
    const drafts = fake.requests.find((sent) => sent.path === "/rest/v1/invoice_drafts")!;
    expect([drafts.params.get("state"), drafts.params.get("order"), drafts.params.get("limit")]).toEqual(["eq.sent", "sent_at.desc", "50"]);
  });

  it("lists no invoice its Open link would not find: past 50 waiting, only those Bills & receivables lists (all waiting AW3)", async () => {
    const hour = (index: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + index * 3_600_000).toISOString();
    // 62 emailed invoices, the two newest still being read; and 55 captured drafts sent for review.
    const emails: Row[] = Array.from({ length: 62 }, (_, index) => ({
      id: `m${String(index).padStart(2, "0")}`, source: "email", file_name: null, from_address: SENDERS[0], subject: SUBJECTS[0], received_at: hour(index),
      status: index >= 60 ? "received" : "ready", reasons: [], read: { counterpartyName: "Coastal Flour Mill", vendorName: null, amount: "10", currency: "USDC" }, authentication: null,
    }));
    const drafts: Row[] = Array.from({ length: 55 }, (_, index) =>
      draft(`d${String(index).padStart(2, "0")}`, "sent", "selection", { supplier_name: "Northwind Packaging", sent_at: hour(index) })
    );
    const inHarbor = (sent: RecordedRequest) => claimsOf(sent)?.org_id === HARBOR.id;
    const { fake, read } = world({
      extra: (sent) =>
        inHarbor(sent) && sent.path === "/rest/v1/inbox_emails" ? answer(emails, sent) : inHarbor(sent) && sent.path === "/rest/v1/invoice_drafts" ? answer(drafts, sent) : null,
    });
    const items = ofKind((await read()).items, "to_review");
    const idsOf = (review: string) => items.filter((item) => item.href.endsWith(`review=${review}`)).map((item) => item.key.split(":").pop()).sort();
    // What the Bills page's review list holds, read by its own read in the same workspace.
    const shown = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(HARBOR.id, () => inboxEmailsToDecide(), { userId: VIEWER }));
    expect(idsOf("email")).toEqual(shown.filter((email) => email.status !== "received").map((email) => email.id).sort());
    expect(idsOf("email")).toHaveLength(48);
    expect(idsOf("email")[0]).toBe("m12");
    // The 50 newest drafts, as `capturedDraftsToReview` lists them (REVIEW_LIMIT).
    expect(idsOf("captured")).toEqual(drafts.slice(5).map((row) => row.id).sort());
  });

  it("routes them to an owner or admin, and an accountant sees who adds them", async () => {
    const { read } = world({ role: "accountant" });
    const items = ofKind((await read()).items, "to_review");
    expect(items).toHaveLength(7);
    expect(new Set(items.map((item) => `${item.canAct} ${item.who}`))).toEqual(new Set(["false Waiting on an owner or admin of this workspace"]));
  });

  it("reads the emails without the Drive columns before migration 0148, each one an email", async () => {
    // The rows as they stood before 0148 added `source` and `file_name`.
    const before = INBOX.filter((row) => row.source === "email").map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== "source" && column !== "file_name")));
    const { fake, read } = world({ extra: (sent) => (sent.path === "/rest/v1/inbox_emails" && claimsOf(sent)?.org_id === HARBOR.id ? answer(before, sent) : null) });
    const portfolio = await read();
    const asked = fake.requests.filter((sent) => sent.path === "/rest/v1/inbox_emails" && claimsOf(sent)?.org_id === HARBOR.id);
    expect(asked.map((sent) => sent.params.get("select")?.includes("file_name"))).toEqual([true, false]);
    expect(ofKind(portfolio.items, "to_review").filter((item) => item.href.endsWith("review=email")).map((item) => item.key.split(":").pop())).toEqual(["e1", "e2", "e3"]);
    expect(unreadOf(portfolio)).toEqual([]);
  });

  it("reads no emailed invoice on a deployment that neither receives them nor reads a Drive folder, and still lists captured ones", async () => {
    vi.unstubAllEnvs();
    const { fake, read } = world();
    const items = ofKind((await read()).items, "to_review");
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/inbox_emails")).toBe(false);
    expect(items.map((item) => item.key.split(":").pop())).toEqual(["c1", "c2", "c3"]);
  });

  it("lists nothing captured before migration 0121, and names nothing unread", async () => {
    const { read } = world({ failing: { path: "/rest/v1/invoice_drafts", reply: { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.invoice_drafts' in the schema cache" } } } });
    const portfolio = await read();
    expect(ofKind(portfolio.items, "to_review").map((item) => item.key.split(":").pop())).toEqual(["e1", "e2", "e3", "g1"]);
    expect(unreadOf(portfolio)).toEqual([]);
  });
});

describe("all waiting: work to accept (AW4)", () => {
  const READY_ASANA = {
    key: "harbor-bakery:accept_work:a1",
    title: "Studio North: Logo design",
    detail: "Completed in Asana. Accept it against its criteria.",
    amount: { value: 800, currency: "USDC" },
    since: "2026-10-30T12:00:00Z",
    href: "/o/harbor-bakery/contractors",
  };

  it("lists ready and held Asana and Linear links of milestones waiting for verification, in the Contractors card's words", async () => {
    const { fake, read } = world();
    const items = ofKind((await read()).items, "accept_work");
    expect(items).toEqual([
      expect.objectContaining({ ...READY_ASANA, canAct: true, who: "You can check it and accept it" }),
      expect.objectContaining({
        key: "harbor-bakery:accept_work:a2",
        title: "Ink and Quill: Website copy",
        detail:
          "Held: The task was reopened in Asana after the work was accepted, so the acceptance was taken back before any payment. Accept it again once it is completed.",
        amount: { value: 450, currency: "USDC" },
        since: "2026-10-31T08:00:00Z",
        // A held link may not be accepted as it stands: whoever may accept reviews it first (all waiting AW4).
        canAct: true,
        who: "You can review it",
      }),
      expect.objectContaining({
        key: "harbor-bakery:accept_work:l1",
        title: "Kite Labs: Checkout flow",
        detail: "Completed in Linear (ENG-12). Accept it against its criteria.",
        amount: { value: 2400, currency: "USDC" },
        since: "2026-11-01T15:00:00Z",
        canAct: true,
        who: "You can check it and accept it",
      }),
      expect.objectContaining({
        key: "harbor-bakery:accept_work:l2",
        title: "Kite Labs: API docs",
        detail: "Held: The issue is done, but the milestone has no acceptance criteria. Add the criteria from the agreement, then accept the work.",
        since: "2026-11-02T10:00:00Z",
        canAct: true,
        who: "You can review it",
      }),
    ]);
    // Live links only, ready or held, never one held after its payment; and only milestones still waiting for verification.
    for (const path of ["/rest/v1/asana_task_links", "/rest/v1/linear_issue_links"]) {
      const asked = fake.requests.find((sent) => sent.path === path && claimsOf(sent)?.org_id === HARBOR.id)!;
      expect([asked.params.get("unlinked_at"), asked.params.get("state"), asked.params.get("after_payment"), asked.params.get("limit")], path).toEqual(["is.null", "in.(ready,held)", "eq.false", "200"]);
    }
    const milestones = fake.requests.filter((sent) => sent.path === "/rest/v1/milestones" && sent.params.get("id"));
    expect(milestones.map((sent) => sent.params.get("status"))).toEqual(["eq.pending"]);
  });

  it("routes work to an owner or admin, and an accountant sees who accepts it, held or ready", async () => {
    const { read } = world({ role: "accountant" });
    const items = ofKind((await read()).items, "accept_work");
    expect(items[0]).toMatchObject({ ...READY_ASANA, canAct: false, who: "Waiting on an owner or admin of this workspace" });
    expect(new Set(items.map((item) => `${item.canAct} ${item.who}`))).toEqual(new Set(["false Waiting on an owner or admin of this workspace"]));
  });

  it("lists a tool's work only on a deployment where Contractors shows its card, and reads nothing of a tool that is off (all waiting AW4)", async () => {
    // Linear's settings removed while its links remain: Contractors shows no Linear card, so no item points there.
    vi.stubEnv("LINEAR_CLIENT_ID", "");
    const linearOff = world();
    expect(ofKind((await linearOff.read()).items, "accept_work").map((item) => item.key.split(":").pop())).toEqual(["a1", "a2"]);
    expect(linearOff.fake.requests.some((sent) => sent.path === "/rest/v1/linear_issue_links")).toBe(false);
    // Neither set up: nothing read, nothing listed, nothing named unread.
    vi.stubEnv("ASANA_CLIENT_SECRET", "");
    const bothOff = world();
    const portfolio = await bothOff.read();
    expect(ofKind(portfolio.items, "accept_work")).toEqual([]);
    expect(bothOff.fake.requests.some((sent) => sent.path === "/rest/v1/asana_task_links" || (sent.path === "/rest/v1/milestones" && sent.params.get("id")))).toBe(false);
    expect(unreadOf(portfolio)).toEqual([]);
  });

  it("adds nothing, and names nothing unread, before migrations 0115 and 0147", async () => {
    const { fake, read } = world({
      extra: (sent) =>
        sent.path === "/rest/v1/asana_task_links"
          ? { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.asana_task_links' in the schema cache" } }
          : sent.path === "/rest/v1/linear_issue_links"
            ? { status: 400, body: { code: "42P01", message: 'relation "public.linear_issue_links" does not exist' } }
            : null,
    });
    const portfolio = await read();
    expect(ofKind(portfolio.items, "accept_work")).toEqual([]);
    expect(portfolio.workspaces.map((workspace) => workspace.unread)).toEqual([[], []]);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/milestones" && sent.params.get("id"))).toBe(false);
  });

  it("still lists one tool's work when only the other is set up", async () => {
    const { read } = world({ extra: (sent) => (sent.path === "/rest/v1/linear_issue_links" ? { status: 400, body: { code: "42P01", message: 'relation "public.linear_issue_links" does not exist' } } : null) });
    expect(ofKind((await read()).items, "accept_work").map((item) => item.key.split(":").pop())).toEqual(["a1", "a2"]);
  });
});

describe("all waiting: last month's close (AW5)", () => {
  const exported = (month: string, over: Row = {}): Row => ({ seq: 900, action: "close_pack_exported", detail: { by: VIEWER, month, ended: true, format: "csv", payments: 3, notSettled: 0, ...over } });

  it("lists last month while it holds payments and no one downloaded or exported its close pack, for every member", async () => {
    const { fake, read } = world({ role: "viewer" });
    expect(ofKind((await read()).items, "month_close")).toEqual([
      {
        key: "harbor-bakery:month_close:2026-10",
        kind: "month_close",
        workspace: { slug: "harbor-bakery", name: "Harbor Bakery" },
        title: "October 2026",
        detail: "3 payments. The close pack has not been downloaded or exported yet.",
        amount: null,
        since: "2026-11-01",
        href: "/o/harbor-bakery/evidence/close-pack?month=2026-10",
        canAct: true,
        who: "You can download the close pack",
      },
    ]);
    // A count, with no rows: the payments the pack reads, confirmed, created or sent in the month.
    const counted = fake.requests.find((sent) => sent.path === "/rest/v1/payment_intents" && claimsOf(sent)?.org_id === HARBOR.id)!;
    expect(counted.method).toBe("HEAD");
    const month = (column: string) => `and(${column}.gte.2026-10-01T00:00:00.000Z,${column}.lt.2026-11-01T00:00:00.000Z)`;
    expect(counted.params.get("or")).toBe(`(${month("confirmed_at")},${month("created_at")},${month("submitted_at")})`);
    const asked = fake.requests.find((sent) => sent.path === "/rest/v1/ledger_entries" && sent.params.get("action") === "eq.close_pack_exported")!;
    expect([asked.params.get("detail->>month"), asked.params.get("detail->>ended"), asked.params.get("limit")]).toEqual(["eq.2026-10", "eq.true", "1"]);
  });

  it("says one payment in the singular", async () => {
    const { read } = world({ payments: 1 });
    expect(ofKind((await read()).items, "month_close")[0].detail).toBe("1 payment. The close pack has not been downloaded or exported yet.");
  });

  it("goes once anyone downloads or exports that month, and not for another month's export or one of the month so far", async () => {
    const listed = async (exports: Row[]) => ofKind((await world({ exports }).read()).items, "month_close").length;
    expect(await listed([exported("2026-10")])).toBe(0);
    expect(await listed([exported("2026-10", { format: "google_sheets", spreadsheetId: "sheet-1" })])).toBe(0);
    expect(await listed([exported("2026-09")])).toBe(1);
    expect(await listed([exported("2026-10", { ended: false })])).toBe(1);
  });

  it("lists nothing for a month with no payments", async () => {
    const { read } = world({ payments: 0 });
    expect(ofKind((await read()).items, "month_close")).toEqual([]);
  });
});

describe("all waiting: parts, the accountant's view and the order (AW1, AW6, AW10)", () => {
  it("names a part that fails on the workspace's card, and the rest still show", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = { status: 500, body: { message: "down" } };
    const inHarbor = (sent: RecordedRequest) => claimsOf(sent)?.org_id === HARBOR.id;
    const cases: Array<[(sent: RecordedRequest) => boolean, string, TriageKind]> = [
      [(sent) => sent.path === "/rest/v1/shadow_modes", "decisions waiting for a verdict", "verdict"],
      [(sent) => sent.path === "/rest/v1/invoice_drafts", "invoices to review", "to_review"],
      [(sent) => sent.path === "/rest/v1/linear_issue_links", "work to accept", "accept_work"],
      [(sent) => sent.path === "/rest/v1/ledger_entries" && sent.params.get("action") === "eq.close_pack_exported", "last month's close", "month_close"],
    ];
    for (const [failing, label, kind] of cases) {
      const portfolio = await world({ extra: (sent) => (inHarbor(sent) && failing(sent) ? down : null) }).read();
      expect(unreadOf(portfolio), label).toEqual([label]);
      expect(ofKind(portfolio.items, kind), label).toEqual([]);
      // The rest still show.
      expect(harborItems(portfolio.items).length, label).toBeGreaterThan(5);
    }
    // A bill whose verdict was not read stays a decision item, and says nothing of one.
    const unread = await world({ failing: { path: "/rest/v1/shadow_modes", reply: down } }).read();
    expect(harborItems(unread.items).find((item) => item.key.endsWith(":waits"))).toMatchObject({ kind: "decision", detail: "Held for a person. Decide by Nov 20, 2026." });
    expect(harborItems(unread.items).find((item) => item.key.endsWith(":late"))?.detail).not.toContain("verdict");
  });

  it("shows an accountant every new kind, with only the month to close theirs to act on", async () => {
    const { read } = world({ role: "accountant" });
    const portfolio = await read();
    const items = harborItems(portfolio.items);
    expect(countByKind(items).map(({ kind }) => kind)).toEqual(["past_decide_by", "decision", "verdict", "accept_work", "to_review", "month_close"]);
    expect(applyFilter(portfolio.items, triageFilter({ mine: "1" })).map((item) => item.kind)).toEqual(["month_close"]);
    expect(ofKind(items, "verdict")[0]).toMatchObject({ canAct: false, who: "Waiting on an owner, admin or approver of this workspace" });
    expect(applyFilter(portfolio.items, triageFilter({ kind: "accept_work", workspace: HARBOR.slug }))).toHaveLength(4);
  });

  it("orders an owner's queue by kind, then the oldest first", async () => {
    const { read } = world();
    const items = harborItems((await read()).items);
    expect(items.every((item) => item.canAct)).toBe(true);
    const ranks = items.map((item) => TRIAGE_KINDS.indexOf(item.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect([...new Set(items.map((item) => item.kind))]).toEqual(["past_decide_by", "decision", "verdict", "accept_work", "to_review", "month_close"]);
    for (const kind of TRIAGE_KINDS) {
      const since = items.filter((item) => item.kind === kind).map((item) => item.since);
      expect(since, kind).toEqual([...since].sort());
    }
  });
});

describe("all waiting: the hand-off's open items (AW8)", () => {
  it("carries the new kinds into a hand-off's open items under their titles, each with its link", async () => {
    const { fake } = world();
    const membership = { orgId: HARBOR.id, slug: HARBOR.slug, name: HARBOR.name, mode: "live" as const, role: "owner" as const, network: "arc-testnet" as const };
    const doc = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(HARBOR.id, () => buildHandoff(membership, handoffPeriod("2026-10", NOW)!, { now: NOW, origin: "https://www.vestiarion.xyz" }), { userId: VIEWER })
    );
    expect(new Set(doc.openItems.map((item) => item.kind))).toEqual(
      new Set(["Past its decide-by day", "Payment waiting for a decision", "Waiting for a verdict", "Work to accept", "Invoice to review", "Month to close"])
    );
    expect(doc.openItems.find((item) => item.kind === "Month to close")).toEqual({
      kind: "Month to close",
      title: "October 2026",
      detail: "3 payments. The close pack has not been downloaded or exported yet.",
      amount: null,
      currency: null,
      since: "2026-11-01",
      link: "https://www.vestiarion.xyz/o/harbor-bakery/evidence/close-pack?month=2026-10",
    });
    const lines = [...handoffCsvChunks(doc)].join("").split("\r\n");
    expect(lines.some((line) => line.startsWith("open_item,,2026-11-01,Month to close,open,October 2026,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("open_item,,2026-10-28T08:00:00Z,Waiting for a verdict,open,Coastal Flour Mill,1250,USDC,"))).toBe(true);
  });
});
