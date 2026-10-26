import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { LedgerEntryInput, LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What the close pack reads (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md, "Data it reads and writes",
 * CP14, CP15, CP19): the month's payments, their bills, payees and entries, a hundred ids at a time, through `db()` in
 * the workspace's scope; each settled payment's screening check at the time of its decision; the escrow moves, the
 * first sweep that checked payout addresses and the ledger's head; then each cited entry's signature with the
 * workspace's keys, the retired one included. It writes nothing.
 *
 * Read at once (docs/superpowers/specs/2026-10-26-close-pack-page-speed-design.md CS1, CS3, CS7): the screening is one
 * read per hundred payees, picked per payment in memory to the microsecond, and one read per payee and time, ten at
 * once, only when that read fills its page or fails; the pack, and every input it is built from, are the reader's
 * before (`tests/support/close-pack-read-before.ts`); and each read logs one timing line.
 */

const retired = crypto.generateKeyPairSync("ed25519");
const active = crypto.generateKeyPairSync("ed25519");
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: active.publicKey, retired: [retired.publicKey] }),
}));
const { verifySpy, buildSpy } = vi.hoisted(() => ({ verifySpy: vi.fn(), buildSpy: vi.fn() }));
vi.mock("@/lib/receipts/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipts/verify")>();
  return {
    ...actual,
    verifyEntry: (...args: Parameters<typeof actual.verifyEntry>) => {
      verifySpy(args[0].seq);
      return actual.verifyEntry(...args);
    },
  };
});
// What the pack is built from, each time it is built: the same inputs as before, not only the same pack.
vi.mock("@/lib/close-pack/build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/close-pack/build")>();
  return {
    ...actual,
    buildClosePack: (input: Parameters<typeof actual.buildClosePack>[0]) => {
      buildSpy(input);
      return actual.buildClosePack(input);
    },
  };
});

import { closePackJson } from "@/lib/close-pack/export";
import { closePackMonth } from "@/lib/close-pack/month";
import { readClosePack } from "@/lib/close-pack/read";
import { readClosePackBefore } from "./support/close-pack-read-before";

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const CP1 = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003c1";
const CP2 = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003c2";
const INV1 = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const INV2 = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a2";
const MS1 = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002b1";
const PAYEE1 = "0x1111111111111111111111111111111111111111";
const PAYEE2 = "0x2222222222222222222222222222222222222222";
const TX1 = `0x${"1".repeat(64)}`;
const TX2 = `0x${"2".repeat(64)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const NOW = new Date("2026-02-05T09:00:00Z");
const JANUARY = closePackMonth("2026-01", NOW)!;

/** The older entries, signed with the key since retired; the newer ones with the active key. */
const OLD: LedgerEntryInput[] = [
  { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Northwind", detail: { by: USER, counterpartyId: CP1, address: PAYEE1 } },
  { actor: "human", domain: "ap", action: "create_invoice", summary: "Added a bill", detail: { by: USER, invoiceId: INV1, counterpartyId: CP1, amount: 10, currency: "USDC", invoiceNumber: "INV-1" } },
  {
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: "PAY",
    detail: { invoiceId: INV1, counterpartyId: CP1, decision: { action: "pay" }, decisionMode: "anthropic", guardrailBlocked: false, observed: { amount: 10, riskLevel: "clear" }, execution: { txRef: TX1, resultingStatus: "paid" } },
  },
];
const NEW: LedgerEntryInput[] = [
  { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Harbor", detail: { by: USER, counterpartyId: CP2, address: PAYEE2 } },
  { actor: "human", domain: "ap", action: "create_invoice", summary: "Added a bill", detail: { by: USER, invoiceId: INV2, counterpartyId: CP2, amount: 20, currency: "USDC" } },
  { actor: "human", domain: "ap", action: "approval_paid", summary: "Approved and paid", detail: { by: USER, invoiceId: INV2, counterpartyId: CP2, txRef: TX2, status: "paid" } },
  { actor: "human", domain: "contractor", action: "escrow_funded", summary: "Locked", detail: { by: USER, milestoneId: MS1, amountUsdc: 50, fundTxHash: `0x${"5".repeat(64)}` } },
  { actor: "human", domain: "ap", action: "invoice_reopened", summary: "Reopened", detail: { by: USER, invoiceId: INV1, counterpartyId: CP1 } },
];
const ROWS: Array<LedgerRow & { org_id: string }> = [
  ...buildChain(OLD, retired.privateKey, ledgerKeyId(retired.publicKey)),
  ...buildChain(NEW, active.privateKey, ledgerKeyId(active.publicKey)).map((row, index) => ({ ...row, seq: OLD.length + index + 1 })),
].map((row) => ({ ...row, org_id: ORG }));
const [ADDRESS1, CREATED1, PAID1, ADDRESS2, CREATED2, PAID2, ESCROW, REOPENED] = ROWS;

const intent = (id: string, sourceId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  org_id: ORG,
  source_type: "invoice",
  source_id: sourceId,
  status: "confirmed",
  provider: "circle",
  provider_mode: "live",
  provider_tx_id: `circle-${id}`,
  provider_state: "COMPLETE",
  failure_reason: null,
  last_error: null,
  amount: "10.000000",
  token: "USDC",
  destination: PAYEE1,
  tx_hash: TX1,
  chain: "ARC-TESTNET",
  destination_chain: null,
  mint_tx_hash: null,
  bridge_fee: null,
  payout_route: null,
  network: "arc-testnet",
  fee_usd: "0.004",
  fee_source: "chain_reported",
  transfer_attempt: 1,
  previous_attempts: [],
  batch_key: null,
  created_at: "2026-01-05T10:00:00Z",
  updated_at: "2026-01-05T10:00:05Z",
  submitted_at: "2026-01-05T10:00:00Z",
  executed_at: "2026-01-05T10:00:05Z",
  confirmed_at: "2026-01-05T10:00:05Z",
  ...overrides,
});
const invoiceRow = (id: string, counterparty: string, overrides: Record<string, unknown> = {}) => ({
  id,
  org_id: ORG,
  direction: "payable",
  counterparty_id: counterparty,
  amount: "10.000000",
  currency: "USDC",
  paid_amount: null,
  memo: null,
  po_reference: null,
  due_date: "2026-01-10",
  status: "paid",
  tx_ref: TX1,
  settled_at: "2026-01-05T10:00:06Z",
  ...overrides,
});

const INTENTS = [intent("pay-1", INV1), intent("pay-2", INV2, { amount: "20.000000", destination: PAYEE2, tx_hash: TX2, confirmed_at: "2026-01-06T10:00:05Z" })];
const INVOICES = [invoiceRow(INV1, CP1), invoiceRow(INV2, CP2, { amount: "20.000000", tx_ref: TX2 })];
const COUNTERPARTIES = [
  { id: CP1, org_id: ORG, name: "Northwind Supplies", address: PAYEE1, chain: "ARC-TESTNET", sample: false },
  { id: CP2, org_id: ORG, name: "Harbor Print", address: PAYEE2, chain: "ARC-TESTNET", sample: false },
];

const inList = (value: string | null) => (value?.startsWith("in.(") ? value.slice(4, -1).split(",").map((one) => one.replace(/^"|"$/g, "")) : []);
const page = <T,>(rows: readonly T[], request: RecordedRequest) => {
  const offset = Number(request.params.get("offset") ?? 0);
  const limit = Number(request.params.get("limit") ?? rows.length);
  return rows.slice(offset, offset + limit);
};

/** A screening check as `compliance_checks` holds it. */
interface Check {
  id: string;
  counterparty_id: string;
  status: string;
  risk_level: string;
  source: string;
  screening_mode: string;
  created_at: string;
}

/** A Postgres time to the microsecond, as the database compares and orders them: what the fake filters by. */
const instant = (ts: string) => {
  const [, base, fraction = "", zone] = /^(.+:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(ts) ?? [];
  return Date.parse(`${base}${zone}`) * 1000 + Number(fraction.padEnd(6, "0"));
};
const CLEAR = { status: "complete", risk_level: "clear", source: "opensanctions:yente", screening_mode: "live" };

/**
 * What PostgREST answers a screening read with, for one payee or many: their complete checks at or before the time,
 * newest first, a tie by the larger id when the read asks for it, a page at a time. With no checks given, every payee
 * has one clear check on New Year's Day.
 */
function screeningRows(request: RecordedRequest, payees: string[], checks?: Check[]) {
  const p = request.params;
  const until = instant((p.get("created_at") ?? "").replace(/^lte\./, ""));
  const byId = (p.get("order") ?? "").includes("id.desc");
  const all = checks ?? payees.map((payee, index) => ({ id: `0b6c1c9e-0000-4000-8000-${String(index).padStart(12, "0")}`, counterparty_id: payee, ...CLEAR, created_at: "2026-01-01T00:00:00Z" }));
  const rows = all
    .filter((check) => payees.includes(check.counterparty_id) && (p.get("status") !== "eq.complete" || check.status === "complete") && instant(check.created_at) <= until)
    .sort((a, b) => instant(b.created_at) - instant(a.created_at) || (byId ? b.id.localeCompare(a.id) : 0));
  return page(rows, request);
}

interface World {
  intents?: Array<Record<string, unknown>>;
  invoices?: Array<Record<string, unknown>>;
  counterparties?: Array<Record<string, unknown>>;
  rows?: typeof ROWS;
  members?: "fail";
  payTo?: "before-0136" | Record<string, string>;
  checks?: Check[];
  /** A read of one payee's check at one time. */
  screening?: (counterparty: string) => FakeReply;
  /** A read of many payees' checks: one that fails, or one that fills its page of 1000. */
  batch?: "fail" | "full";
}

function database(world: World = {}) {
  const intents = world.intents ?? INTENTS;
  const invoices = world.invoices ?? INVOICES;
  const counterparties = world.counterparties ?? COUNTERPARTIES;
  const rows = world.rows ?? ROWS;
  // One payee's reads in flight at once, the most there were.
  let screeningNow = 0;
  let screeningMost = 0;
  const fake = fakeSupabase(async (request: RecordedRequest): Promise<FakeReply> => {
    const p = request.params;
    switch (request.path) {
      case "/rest/v1/payment_intents":
        return { body: page(intents, request) };
      case "/rest/v1/invoices": {
        const ids = inList(p.get("id"));
        if ((p.get("select") ?? "").includes("document_pay_to")) {
          if (world.payTo === "before-0136") return { status: 400, body: { code: "42703", message: 'column invoices.document_pay_to does not exist' } };
          const asked = world.payTo ?? {};
          return { body: ids.filter((id) => asked[id]).map((id) => ({ id, document_pay_to: asked[id] })) };
        }
        return { body: invoices.filter((row) => ids.includes(String(row.id))) };
      }
      case "/rest/v1/milestones":
        return { body: [] };
      case "/rest/v1/counterparties": {
        const ids = inList(p.get("id"));
        return { body: counterparties.filter((row) => ids.includes(String(row.id))) };
      }
      case "/rest/v1/compliance_checks": {
        const asked = p.get("counterparty_id") ?? "";
        if (asked.startsWith("in.")) {
          if (world.batch === "fail") return { status: 500, body: { message: "upstream" } };
          if (world.batch === "full") return { body: Array.from({ length: 1000 }, () => ({ counterparty_id: inList(asked)[0], ...CLEAR, risk_level: "medium", created_at: "2025-06-01T00:00:00Z" })) };
          return { body: screeningRows(request, inList(asked), world.checks) };
        }
        screeningNow += 1;
        screeningMost = Math.max(screeningMost, screeningNow);
        await new Promise((resolve) => setTimeout(resolve, 2));
        screeningNow -= 1;
        const counterparty = asked.replace(/^eq\./, "");
        if (world.screening) return world.screening(counterparty);
        return { body: screeningRows(request, [counterparty], world.checks) };
      }
      case "/rest/v1/ledger_entries": {
        if (p.get("order") === "seq.desc") return { body: [{ seq: rows.length, hash: rows[rows.length - 1].hash }] };
        if (p.get("action") === "eq.compliance_sweep") return { body: [{ ts: "2025-12-01T00:00:00Z" }] };
        if (p.get("action") === "in.(escrow_funded,escrow_refunded)") return { body: page(rows.filter((row) => row.action.startsWith("escrow")), request) };
        if (p.get("action") === "eq.decision_verdict") {
          const subjects = inList(p.get("detail->>subjectId"));
          return { body: page(rows.filter((row) => row.action === "decision_verdict" && subjects.includes(String(row.detail.subjectId))), request) };
        }
        if (p.get("action") === "eq.payee_lock_changed") return { body: page(rows.filter((row) => row.action === "payee_lock_changed"), request) };
        const invoiceIds = inList(p.get("detail->>invoiceId"));
        if (invoiceIds.length > 0) return { body: page(rows.filter((row) => invoiceIds.includes(String(row.detail.invoiceId))), request) };
        const milestoneIds = inList(p.get("detail->>milestoneId"));
        if (milestoneIds.length > 0) return { body: page(rows.filter((row) => milestoneIds.includes(String(row.detail.milestoneId))), request) };
        const counterpartyIds = inList(p.get("detail->>counterpartyId"));
        if (counterpartyIds.length > 0) {
          const actions = inList(p.get("action"));
          return { body: page(rows.filter((row) => counterpartyIds.includes(String(row.detail.counterpartyId)) && actions.includes(row.action)), request) };
        }
        throw new Error(`unexpected ledger read ${p.toString()}`);
      }
      case "/rest/v1/rpc/org_members":
        if (world.members === "fail") return { status: 500, body: { message: "members unavailable" } };
        return { body: [{ user_id: USER, email: "owner@northwind.test", role: "owner", joined_at: "2025-01-01T00:00:00Z" }] };
      case "/rest/v1/orgs":
        return { body: [{ slug: "northwind-studio", name: "Northwind Studio" }] };
      default:
        throw new Error(`unexpected request ${request.method} ${request.path}`);
    }
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run, most: () => screeningMost };
}

const WORKSPACE = { slug: "northwind-studio", name: "Northwind Studio" };
const ledgerReads = (requests: RecordedRequest[]) => requests.filter((request) => request.path === "/rest/v1/ledger_entries");

/**
 * A month with more in it than the pack shows: an invoice to a customer paid in the month, with its own entry and a
 * verdict naming it (read, never built from); a verdict on the first bill; times written to the microsecond as Postgres
 * writes them; and each payee's checks around its payment's time.
 */
const INV3 = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a3";
/** The agent's decision on the first bill, to the microsecond. */
const AT_DECISION = "2026-01-05T10:00:00.123456+00:00";
const RICH_TIMES = [
  "2025-12-20T08:00:00+00:00",
  "2026-01-04T08:00:00.5+00:00",
  AT_DECISION,
  "2025-12-21T08:00:00+00:00",
  "2026-01-05T11:00:00+00:00",
  "2026-01-06T10:00:00+00:00",
  "2026-01-07T10:00:00+00:00",
  "2026-01-08T10:00:00+00:00",
  "2026-01-08T11:00:00+00:00",
  "2026-01-09T10:00:00+00:00",
  "2026-01-09T11:00:00+00:00",
];
const RICH_ROWS = buildChain(
  [
    ...OLD,
    ...NEW,
    { actor: "human", domain: "ar", action: "create_invoice", summary: "Added an invoice to a customer", detail: { by: USER, invoiceId: INV3, counterpartyId: CP2, amount: 30, currency: "USDC" } },
    { actor: "human", domain: "ap", action: "decision_verdict", summary: "Agreed with the agent: PAY", detail: { by: USER, entrySeq: 3, subject: "invoice", subjectId: INV1, agentAction: "ap_pay", verdict: "agree" } },
    { actor: "human", domain: "ap", action: "decision_verdict", summary: "Agreed with the agent", detail: { by: USER, entrySeq: 9, subject: "invoice", subjectId: INV3, verdict: "agree" } },
  ],
  active.privateKey,
  ledgerKeyId(active.publicKey)
).map((row, index) => ({ ...row, ts: RICH_TIMES[index], org_id: ORG }));
const checkRow = (n: number, counterparty: string, created: string, fields: Partial<Check> = {}): Check => ({
  id: `0b6c1c9e-0000-4000-8000-0000000c0${String(n).padStart(3, "0")}`,
  counterparty_id: counterparty,
  ...CLEAR,
  created_at: created,
  ...fields,
});
const RICH: World = {
  rows: RICH_ROWS,
  intents: [...INTENTS, intent("pay-3", INV3, { amount: "30.000000", destination: PAYEE2, tx_hash: `0x${"3".repeat(64)}`, confirmed_at: "2026-01-08T10:00:05Z" })],
  invoices: [...INVOICES, invoiceRow(INV3, CP2, { direction: "receivable", amount: "30.000000", tx_ref: `0x${"3".repeat(64)}` })],
  checks: [
    checkRow(1, CP1, "2025-12-01T00:00:00+00:00"),
    checkRow(2, CP1, AT_DECISION, { risk_level: "low" }),
    checkRow(3, CP1, "2026-01-05T10:00:00.123457+00:00", { risk_level: "high" }),
    checkRow(4, CP1, "2026-01-05T09:00:00+00:00", { status: "failed" }),
    checkRow(5, CP2, "2026-01-07T00:00:00+00:00"),
  ],
};

const screeningReads = (requests: RecordedRequest[]) => requests.filter((request) => request.path === "/rest/v1/compliance_checks");
/** The reads of many payees' checks at once, and of one payee's at one time. */
const manyAtOnce = (requests: RecordedRequest[]) => screeningReads(requests).filter((request) => request.params.get("counterparty_id")?.startsWith("in."));
const onePayee = (requests: RecordedRequest[]) => screeningReads(requests).filter((request) => request.params.get("counterparty_id")?.startsWith("eq."));

/** A hundred and fifty bills, each to its own payee, paid through January. */
function manyPayees(): World {
  const many = Array.from({ length: 150 }, (_, index) => {
    const n = String(index).padStart(3, "0");
    return { invoice: `0b6c1c9e-4a4f-4a7e-9b1e-000000010${n}`, counterparty: `0b6c1c9e-4a4f-4a7e-9b1e-000000020${n}` };
  });
  return {
    intents: many.map((one, index) => intent(`pay-${index}`, one.invoice, { confirmed_at: `2026-01-${String(1 + (index % 28)).padStart(2, "0")}T10:00:05Z` })),
    invoices: many.map((one) => invoiceRow(one.invoice, one.counterparty)),
    counterparties: many.map((one) => ({ id: one.counterparty, org_id: ORG, name: "A payee", address: PAYEE1, chain: "ARC-TESTNET", sample: false })),
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  verifySpy.mockClear();
  buildSpy.mockClear();
  vi.restoreAllMocks();
});

describe("reading the month (close pack CP2, CP14)", () => {
  it("reads the month's payments by when they were confirmed, created or sent, a page of 1000 at a time, in the workspace's scope", async () => {
    const db = database();
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(pack.rows.map((row) => row.paymentId)).toEqual(["pay-1", "pay-2"]);
    const [read] = db.fake.requests.filter((request) => request.path === "/rest/v1/payment_intents");
    const from = "2026-01-01T00:00:00.000Z";
    const to = "2026-02-01T00:00:00.000Z";
    expect(read.params.get("or")).toBe(
      `(and(confirmed_at.gte.${from},confirmed_at.lt.${to}),and(created_at.gte.${from},created_at.lt.${to}),and(submitted_at.gte.${from},submitted_at.lt.${to}))`
    );
    expect(read.params.get("order")).toBe("created_at.asc,id.asc");
    expect(read.params.get("offset")).toBe("0");
    expect(read.params.get("limit")).toBe("1000");
    for (const request of db.fake.requests.filter((one) => one.path !== "/rest/v1/orgs")) expect(carriesOrg(request, ORG), `${request.method} ${request.path}`).toBe(true);
    expect(db.fake.requests.some((request) => request.path === "/rest/v1/orgs")).toBe(false);
  });

  it("asks for bills, payees, entries and screening checks a hundred ids at a time", async () => {
    const db = database(manyPayees());
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(pack.rows).toHaveLength(150);
    const sizes = (path: string, key: string, select?: (request: RecordedRequest) => boolean) =>
      db.fake.requests.filter((request) => request.path === path && request.params.has(key) && (select ? select(request) : true)).map((request) => inList(request.params.get(key)).length);
    expect(sizes("/rest/v1/invoices", "id", (request) => !(request.params.get("select") ?? "").includes("document_pay_to"))).toEqual([100, 50]);
    expect(sizes("/rest/v1/invoices", "id", (request) => (request.params.get("select") ?? "").includes("document_pay_to"))).toEqual([100, 50]);
    expect(sizes("/rest/v1/counterparties", "id")).toEqual([100, 50]);
    expect(sizes("/rest/v1/ledger_entries", "detail->>invoiceId", (request) => request.params.get("action") === null)).toEqual([100, 50]);
    expect(sizes("/rest/v1/ledger_entries", "detail->>subjectId")).toEqual([100, 50]);
    expect(sizes("/rest/v1/ledger_entries", "detail->>counterpartyId")).toEqual([100, 50]);
    // Each settled payment's screening: one read per hundred payees, not one per payee and time (CS3).
    expect(manyAtOnce(db.fake.requests).map((request) => inList(request.params.get("counterparty_id")).length)).toEqual([100, 50]);
    expect(onePayee(db.fake.requests)).toHaveLength(0);
    expect(pack.rows.every((row) => row.checks.screening.kind === "verified")).toBe(true);
  });

  it("reads one payee and time at a time, never more than ten at once, when a hundred payees' checks fill a page", async () => {
    const db = database({ ...manyPayees(), batch: "full" });
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    // The page that filled is not taken: each payee's own read is.
    expect(pack.rows.every((row) => row.checks.screening.text === "A payee was screened clear by OpenSanctions.")).toBe(true);
    const each = onePayee(db.fake.requests);
    expect(each).toHaveLength(150);
    expect(db.most()).toBeLessThanOrEqual(10);
    expect(db.most()).toBeGreaterThan(1);
    expect(each[0].params.get("status")).toBe("eq.complete");
    expect(each[0].params.get("order")).toBe("created_at.desc,id.desc");
    expect(each[0].params.get("limit")).toBe("1");
    expect(each[0].params.get("select")).toBe("risk_level,source,screening_mode,created_at");
  });

  it("reads the payees' complete checks up to the latest payment's decision, newest first, a page of 1000", async () => {
    const db = database(RICH);
    await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const reads = screeningReads(db.fake.requests);
    expect(reads).toHaveLength(1);
    const [read] = reads;
    expect(inList(read.params.get("counterparty_id"))).toEqual([CP1, CP2]);
    expect(read.params.get("status")).toBe("eq.complete");
    // The later of the two payments' times: the approval that paid the second bill on January 6, when no decision of the
    // agent's is recorded; the first bill's is the agent's decision on January 5.
    expect(read.params.get("created_at")).toBe("lte.2026-01-06T10:00:00+00:00");
    expect(RICH_ROWS[PAID2.seq - 1].action).toBe("approval_paid");
    expect(read.params.get("order")).toBe("created_at.desc,id.desc");
    expect(read.params.get("offset")).toBe("0");
    expect(read.params.get("limit")).toBe("1000");
    expect(read.params.get("select")).toBe("counterparty_id,risk_level,source,screening_mode,created_at");
  });

  it("takes each payment's newest complete check at or before its own time, to the microsecond", async () => {
    const pack = await database(RICH).run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const [first, second] = pack.rows;
    // At its decision's very microsecond, not the one a microsecond later, nor the failed one, nor an older one.
    expect(first.checks.screening).toMatchObject({ kind: "verified", at: AT_DECISION, text: "Northwind Supplies was screened low risk by OpenSanctions." });
    // Its only check came after it was paid.
    expect(second.checks.screening.kind).toBe("missing");
  });

  it("takes the check with the larger id when two were made at the same moment, read at once or one at a time", async () => {
    const twins: Check[] = [
      { id: "0b6c1c9e-0000-4000-8000-00000000c0a1", counterparty_id: CP1, ...CLEAR, risk_level: "high", created_at: "2026-01-01T00:00:00+00:00" },
      { id: "0b6c1c9e-0000-4000-8000-00000000c0b2", counterparty_id: CP1, ...CLEAR, created_at: "2026-01-01T00:00:00+00:00" },
    ];
    for (const batch of [undefined, "full" as const]) {
      const pack = await database({ checks: twins, batch }).run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
      expect(pack.rows[0].checks.screening.text, String(batch)).toBe("Northwind Supplies was screened clear by OpenSanctions.");
    }
  });

  it("reads the month's escrow moves, the first sweep that checked the address list, and the head", async () => {
    const db = database();
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const reads = ledgerReads(db.fake.requests);
    const escrow = reads.find((request) => request.params.get("action") === "in.(escrow_funded,escrow_refunded)")!;
    expect(escrow.params.getAll("ts")).toEqual(["gte.2026-01-01T00:00:00.000Z", "lt.2026-02-01T00:00:00.000Z"]);
    const sweep = reads.find((request) => request.params.get("action") === "eq.compliance_sweep")!;
    expect(sweep.params.get("detail->sanctionedWallets")).toBe("not.is.null");
    expect(sweep.params.get("order")).toBe("seq.asc");
    expect(sweep.params.get("limit")).toBe("1");
    const head = reads.find((request) => request.params.get("order") === "seq.desc")!;
    expect(head.params.get("select")).toBe("seq,hash");
    expect(pack.escrow).toMatchObject([{ kind: "funded", milestoneId: MS1, amount: "50.000000", entry: ESCROW.seq }]);
    expect(pack.ledgerHead).toEqual({ seq: ROWS.length, hash: ROWS[ROWS.length - 1].hash });
    expect(pack.rows[0].checks.walletList.kind).toBe("checked");
    const milestones = db.fake.requests.filter((request) => request.path === "/rest/v1/milestones");
    expect(milestones.map((request) => inList(request.params.get("id")))).toEqual([[MS1]]);
  });

  it("checks only the cited entries, with the active and the retired key", async () => {
    const db = database();
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const cited = pack.entries.map((one) => one.seq);
    expect(cited).toEqual([ADDRESS1.seq, CREATED1.seq, PAID1.seq, ADDRESS2.seq, CREATED2.seq, PAID2.seq, ESCROW.seq]);
    expect(cited).not.toContain(REOPENED.seq);
    expect([...new Set(verifySpy.mock.calls.map(([seq]) => seq))].sort((a, b) => a - b)).toEqual(cited);
    expect(pack.entries.every((one) => one.check?.ok === true)).toBe(true);
    expect(pack.totals.entries).toEqual({ cited: 7, verified: 7, failed: 0, unchecked: 0 });
    expect(pack.rows[0].record).toMatchObject({ seq: PAID1.seq, signingKeyId: ledgerKeyId(retired.publicKey), check: { ok: true } });
    expect(pack.keys.map((key) => [key.id, key.status])).toEqual([
      [ledgerKeyId(active.publicKey), "active"],
      [ledgerKeyId(retired.publicKey), "retired"],
    ]);
  });

  it("names a tampered entry as not verified", async () => {
    const tampered = ROWS.map((row) => (row.seq === PAID1.seq ? { ...row, detail: { ...row.detail, observed: { amount: 99 } } } : row));
    const db = database({ rows: tampered });
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(pack.rows[0].record?.check).toEqual({ ok: false, reason: "The entry's content does not match its body hash." });
    expect(pack.totals.entries.failed).toBe(1);
  });
});

describe("reading the payee lock's changes (close pack CP8)", () => {
  it("reads the workspace's payee lock changes up to the month's end, a page of 1000 at a time by seq, and cites one that eased the lock before a payment", async () => {
    const inputs: LedgerEntryInput[] = [
      { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Northwind", detail: { by: USER, counterpartyId: CP1, address: PAYEE2 } },
      { actor: "human", domain: "compliance", action: "counterparty_address_changed", summary: "Changed Northwind's address", detail: { by: USER, counterpartyId: CP1, from: PAYEE2, to: PAYEE1 } },
      {
        actor: "human",
        domain: "compliance",
        action: "counterparty_address_confirmed",
        summary: "Confirmed Northwind's address",
        detail: { by: USER, counterpartyId: CP1, address: PAYEE1, via: "confirm", payeeLock: { coolingHours: 48 } },
      },
      { actor: "human", domain: "system", action: "payee_lock_changed", summary: "Turned off the payee lock", detail: { by: USER, from: { on: true, coolingHours: 48 }, to: { on: false, coolingHours: 48 } } },
      OLD[1],
      OLD[2],
    ];
    const rows = buildChain(inputs, active.privateKey, ledgerKeyId(active.publicKey)).map((row) => ({ ...row, org_id: ORG }));
    const db = database({ rows, intents: [INTENTS[0]], invoices: [INVOICES[0]] });
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const read = ledgerReads(db.fake.requests).find((request) => request.params.get("action") === "eq.payee_lock_changed")!;
    expect(read.params.get("ts")).toBe("lt.2026-02-01T00:00:00.000Z");
    expect(read.params.get("order")).toBe("seq.asc");
    expect(read.params.get("offset")).toBe("0");
    expect(read.params.get("limit")).toBe("1000");
    expect(carriesOrg(read, ORG)).toBe(true);
    expect(pack.rows[0].checks.payeeLock).toMatchObject({ kind: "stated", entries: [2, 3, 4], warn: true });
    expect(pack.entries.map((one) => one.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(pack.entries.find((one) => one.seq === 4)?.check).toEqual({ ok: true });
  });
});

describe("reading what may not be there (close pack CP19, CP7, CP8)", () => {
  it("works before 0136: the pay-to check does not apply, and nothing else changes", async () => {
    const after = database({ payTo: { [INV1]: PAYEE1 } });
    const withColumn = await after.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(withColumn.rows[0].checks.payTo.kind).toBe("checked");
    const before = database({ payTo: "before-0136" });
    const without = await before.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(without.rows[0].checks.payTo).toMatchObject({ kind: "not_applicable", text: "The bill's document named no address of its own." });
    expect({ ...without.rows[0], checks: { ...without.rows[0].checks, payTo: null } }).toEqual({ ...withColumn.rows[0], checks: { ...withColumn.rows[0].checks, payTo: null } });
  });

  it("names people by id when org_members fails, and says members are unread", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = database({ members: "fail" });
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(pack.unread).toEqual(["members"]);
    expect(pack.rows[1].approval.approvals[0].who).toEqual({ kind: "member", userId: USER, email: null, roleNow: null });
    expect(JSON.stringify(pack)).not.toContain("owner@northwind.test");
  });

  it("marks a payment whose screening read failed as could not open, and shows the others", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The read of both payees fails, so each is read on its own (CS3), and only the second payee's read fails too.
    const db = database({
      batch: "fail",
      screening: (counterparty) =>
        counterparty === CP2 ? { status: 500, body: { message: "upstream" } } : { body: [{ risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-01-01T00:00:00Z" }] },
    });
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(pack.rows[0].checks.screening.kind).toBe("verified");
    expect(pack.rows[1].checks.screening).toMatchObject({ kind: "unreachable", text: "The screening record could not be read just now." });
    expect(pack.unread).toEqual(["screening"]);
    expect(onePayee(db.fake.requests).map((request) => request.params.get("counterparty_id"))).toEqual([`eq.${CP1}`, `eq.${CP2}`]);
    expect(errors.mock.calls.map(([line]) => line)).toEqual(["close pack: screening records not read at once", "close pack: a screening record not read"]);
  });

  it("names people by email by default, and by id for the API", async () => {
    const byEmail = await database().run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(byEmail.people).toBe("email");
    expect(JSON.stringify(byEmail)).toContain("owner@northwind.test");
    const byId = await database().run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, people: "id", now: NOW }));
    expect(byId.people).toBe("id");
    expect(JSON.stringify(byId)).not.toContain("@");
  });
});

describe("whose pack it is (close pack CP14, CP18)", () => {
  it("reads the workspace's slug and name from orgs when none is given, by the scope's org id", async () => {
    const db = database();
    const pack = await db.run(() => readClosePack({ month: JANUARY, now: NOW }));
    expect(pack.workspace).toEqual({ slug: "northwind-studio", name: "Northwind Studio" });
    const [orgs] = db.fake.requests.filter((request) => request.path === "/rest/v1/orgs");
    expect(orgs.params.get("id")).toBe(`eq.${ORG}`);
    expect(orgs.params.get("select")).toBe("slug,name");
    expect(pack.rows[0].evidencePath).toBe(`/o/northwind-studio/evidence/invoice/${INV1}`);
  });

  it("refuses to read outside a workspace's scope", async () => {
    await expect(readClosePack({ month: JANUARY, now: NOW })).rejects.toThrow();
  });
});

describe("limits and writes (close pack CP15)", () => {
  it("stops at 2,000 payments and marks the pack cut", async () => {
    const intents = Array.from({ length: 2001 }, (_, index) =>
      intent(`pay-${String(index).padStart(4, "0")}`, INV1, { status: "created", submitted_at: null, provider_tx_id: null, confirmed_at: null, tx_hash: null })
    );
    const db = database({ intents });
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(pack.cut).toBe(true);
    expect(pack.notSettled).toHaveLength(2000);
    const reads = db.fake.requests.filter((request) => request.path === "/rest/v1/payment_intents").map((request) => [request.params.get("offset"), request.params.get("limit")]);
    expect(reads).toEqual([
      ["0", "1000"],
      ["1000", "1000"],
      ["2000", "1"],
    ]);
    const fewer = await database().run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(fewer.cut).toBe(false);
  });

  it("writes nothing: no insert, update, upsert, delete or ledger entry", async () => {
    const db = database();
    await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    for (const request of db.fake.requests) {
      const rpcRead = request.method === "POST" && request.path === "/rest/v1/rpc/org_members";
      expect(request.method === "GET" || rpcRead, `${request.method} ${request.path}`).toBe(true);
    }
    expect(db.fake.requests.some((request) => request.path.includes("append_ledger_entry"))).toBe(false);
  });
});

describe("the same pack as before (close pack page speed CS1)", () => {
  const read = async (world: World, reader: typeof readClosePack) => {
    buildSpy.mockClear();
    const pack = await database(world).run(() => reader({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    return { pack, inputs: buildSpy.mock.calls.map(([input]) => input) };
  };

  it.each([
    ["the plain month", {}],
    ["a month with a customer's invoice, verdicts and checks around each payment", RICH],
    ["a month whose payees' checks fill a page", { ...RICH, batch: "full" as const }],
    ["a hundred and fifty payees", manyPayees()],
  ])("builds %s from the same inputs, into the same bytes, as the reader before", async (_name, world) => {
    const after = await read(world, readClosePack);
    const before = await read(world, readClosePackBefore);
    expect(after.inputs).toHaveLength(2);
    expect(after.inputs).toEqual(before.inputs);
    expect(after.pack).toEqual(before.pack);
    expect(closePackJson(after.pack, { origin: "https://vestiarion.test" })).toBe(closePackJson(before.pack, { origin: "https://vestiarion.test" }));
  });

  it("reads the customer's invoice's entries with the bills', and builds from the bills' alone", async () => {
    const db = database(RICH);
    buildSpy.mockClear();
    await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const byInvoice = ledgerReads(db.fake.requests).find((request) => request.params.has("detail->>invoiceId"))!;
    expect(inList(byInvoice.params.get("detail->>invoiceId"))).toEqual([INV1, INV2, INV3]);
    const [input] = buildSpy.mock.calls.map(([one]) => one as { entries: Array<{ seq: number; detail: Record<string, unknown> }> });
    expect(input.entries.some((entry) => entry.detail.invoiceId === INV3 || entry.detail.subjectId === INV3)).toBe(false);
    expect(input.entries.some((entry) => entry.detail.subjectId === INV1)).toBe(true);
  });
});

describe("the timing line (close pack page speed CS7)", () => {
  it("logs one line a read, in whole milliseconds a stage, with counts and no workspace, person or record named", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await database().run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const lines = info.mock.calls.filter(([name]) => name === "close_pack_timing");
    expect(lines).toHaveLength(1);
    const line = String(lines[0][1]);
    const fields = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(["stage", "reads", "screening", "verify", "build", "total", "payments", "entries", "cited", "screeningReads"]);
    expect(fields).toMatchObject({ stage: "read", payments: 2, entries: ROWS.length, cited: 7, screeningReads: 1 });
    for (const stage of ["reads", "screening", "verify", "build", "total"]) expect(Number.isInteger(fields[stage]) && (fields[stage] as number) >= 0, stage).toBe(true);
    for (const named of [ORG, USER, WORKSPACE.slug, WORKSPACE.name, "owner@northwind.test", CP1, INV1, "pay-1"]) expect(line).not.toContain(named);
  });
});
