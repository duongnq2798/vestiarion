import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { LedgerEntryInput, LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What the close pack reads (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md, "Data it reads and writes",
 * CP14, CP15, CP19): the month's payments, their bills, payees and entries, a hundred ids at a time, through `db()` in
 * the workspace's scope; each settled payment's screening check at the time of its decision, ten at once; the escrow
 * moves, the first sweep that checked payout addresses and the ledger's head; then each cited entry's signature with the
 * workspace's keys, the retired one included. It writes nothing.
 */

const retired = crypto.generateKeyPairSync("ed25519");
const active = crypto.generateKeyPairSync("ed25519");
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: active.publicKey, retired: [retired.publicKey] }),
}));
const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn() }));
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

import { readClosePack } from "@/lib/close-pack/read";
import { closePackMonth } from "@/lib/close-pack/month";

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

interface World {
  intents?: Array<Record<string, unknown>>;
  invoices?: Array<Record<string, unknown>>;
  counterparties?: Array<Record<string, unknown>>;
  rows?: typeof ROWS;
  members?: "fail";
  payTo?: "before-0136" | Record<string, string>;
  screening?: (counterparty: string) => FakeReply;
}

function database(world: World = {}) {
  const intents = world.intents ?? INTENTS;
  const invoices = world.invoices ?? INVOICES;
  const counterparties = world.counterparties ?? COUNTERPARTIES;
  const rows = world.rows ?? ROWS;
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
        screeningNow += 1;
        screeningMost = Math.max(screeningMost, screeningNow);
        await new Promise((resolve) => setTimeout(resolve, 2));
        screeningNow -= 1;
        const counterparty = (p.get("counterparty_id") ?? "").replace(/^eq\./, "");
        if (world.screening) return world.screening(counterparty);
        return { body: [{ risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-01-01T00:00:00Z" }] };
      }
      case "/rest/v1/ledger_entries": {
        if (p.get("order") === "seq.desc") return { body: [{ seq: rows.length, hash: rows[rows.length - 1].hash }] };
        if (p.get("action") === "eq.compliance_sweep") return { body: [{ ts: "2025-12-01T00:00:00Z" }] };
        if (p.get("action") === "in.(escrow_funded,escrow_refunded)") return { body: page(rows.filter((row) => row.action.startsWith("escrow")), request) };
        if (p.get("action") === "eq.decision_verdict") return { body: [] };
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

afterEach(() => {
  verifySpy.mockClear();
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

  it("asks for bills, payees and entries a hundred ids at a time", async () => {
    const many = Array.from({ length: 150 }, (_, index) => {
      const n = String(index).padStart(3, "0");
      return { invoice: `0b6c1c9e-4a4f-4a7e-9b1e-000000010${n}`, counterparty: `0b6c1c9e-4a4f-4a7e-9b1e-000000020${n}` };
    });
    const db = database({
      intents: many.map((one, index) => intent(`pay-${index}`, one.invoice, { confirmed_at: `2026-01-${String(1 + (index % 28)).padStart(2, "0")}T10:00:05Z` })),
      invoices: many.map((one) => invoiceRow(one.invoice, one.counterparty)),
      counterparties: many.map((one) => ({ id: one.counterparty, org_id: ORG, name: "A payee", address: PAYEE1, chain: "ARC-TESTNET", sample: false })),
    });
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
    // Each settled payment's screening, one read per distinct payee and time, never more than ten at once.
    expect(db.fake.requests.filter((request) => request.path === "/rest/v1/compliance_checks")).toHaveLength(150);
    expect(db.most()).toBeLessThanOrEqual(10);
    expect(db.most()).toBeGreaterThan(1);
  });

  it("reads each settled payment's screening check at or before its decision, newest first", async () => {
    const db = database();
    await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    const checks = db.fake.requests.filter((request) => request.path === "/rest/v1/compliance_checks");
    const first = checks.find((request) => request.params.get("counterparty_id") === `eq.${CP1}`)!;
    expect(first.params.get("status")).toBe("eq.complete");
    expect(first.params.get("created_at")).toBe(`lte.${PAID1.ts}`);
    expect(first.params.get("order")).toBe("created_at.desc");
    expect(first.params.get("limit")).toBe("1");
    expect(first.params.get("select")).toBe("risk_level,source,screening_mode,created_at");
    // The approval that paid the second bill, when no decision of the agent's is recorded.
    expect(checks.find((request) => request.params.get("counterparty_id") === `eq.${CP2}`)!.params.get("created_at")).toBe(`lte.${PAID2.ts}`);
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
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = database({
      screening: (counterparty) =>
        counterparty === CP2 ? { status: 500, body: { message: "upstream" } } : { body: [{ risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-01-01T00:00:00Z" }] },
    });
    const pack = await db.run(() => readClosePack({ month: JANUARY, workspace: WORKSPACE, now: NOW }));
    expect(pack.rows[0].checks.screening.kind).toBe("verified");
    expect(pack.rows[1].checks.screening).toMatchObject({ kind: "unreachable", text: "The screening record could not be read just now." });
    expect(pack.unread).toEqual(["screening"]);
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
