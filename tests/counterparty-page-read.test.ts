import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { pageGrants } from "@/lib/counterparties/page-grants";
import { DRAFTS_SHOWN, ENTRY_ID_CHUNK, HISTORY_SHOWN, readCounterpartyPage, type PageReadOptions } from "@/lib/counterparties/page-read";
import { PAYMENTS_SHOWN } from "@/lib/counterparties/page-view";
import { listInvoicesOf, listMilestonesOf, payeeAddressBook, readCounterparty, type CounterpartyRow } from "@/lib/queries";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What a counterparty's page reads (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL2, CL3, CL4, CL13):
 * through the workspace's scope, platform reads naming the workspace and this counterparty, no secret in any select, no
 * payee link read for a member who may not send one, each part best effort, and the entries 25 ids a read. Over a
 * recorded database; Asana, Linear, Jira, the evidence link check and the payee chain choice are stood in for.
 */

const { checkLinksMock, choosableMock, heldMock, asanaMock, linearMock, jiraMock } = vi.hoisted(() => ({
  checkLinksMock: vi.fn(),
  choosableMock: vi.fn(),
  heldMock: vi.fn(),
  asanaMock: vi.fn(),
  linearMock: vi.fn(),
  jiraMock: vi.fn(),
}));
vi.mock("@/lib/asana/contractors", () => ({ asanaOnContractors: asanaMock }));
vi.mock("@/lib/linear/contractors", () => ({ linearOnContractors: linearMock }));
vi.mock("@/lib/jira/contractors", () => ({ jiraOnContractors: jiraMock }));
vi.mock("@/lib/evidence-links/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidence-links/check")>()),
  checkEvidenceLinks: checkLinksMock,
}));
vi.mock("@/lib/payee-chain-choice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payee-chain-choice")>()),
  choosablePayeeChains: choosableMock,
  payeesHeldToTheirChain: heldMock,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0d";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003cc";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003dd";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const NAME = "Northstar Studio";
const ADDRESS = "0x8F3a6b1C2d4E5f60718293a4B5c6D7e8F9012345";
/** The same first 6 and last 4 hex digits: the pattern address poisoning uses (PL6). */
const ALIKE = `0x8F3a6b${"0".repeat(30)}2345`;
const EARLIER = `0x8f3a6b${"1".repeat(30)}2345`;
const NOW = Date.parse("2026-11-09T12:00:00Z");
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const invoiceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const milestoneId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

const counterparty = (over: Partial<CounterpartyRow> = {}): CounterpartyRow => ({
  id: CP,
  name: NAME,
  role: "contractor",
  address: ADDRESS,
  chain: "ARC-TESTNET",
  jurisdiction: null,
  risk_level: "clear",
  risk_notes: null,
  payment_limit: 500,
  baseline_payment_limit: 500,
  last_screened_at: null,
  performance_score: null,
  performance_inputs: null,
  address_changed_at: null,
  address_confirmed_at: null,
  sample: false,
  ...over,
});

const invoice = (n: number, over: Record<string, unknown> = {}) => ({
  id: invoiceId(n),
  org_id: ORG,
  direction: "payable",
  counterparty_id: CP,
  amount: "10.000000",
  memo: null,
  po_reference: null,
  goods_received: false,
  due_date: `2026-10-${String((n % 28) + 1).padStart(2, "0")}`,
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: null,
  currency: "USDC",
  created_at: "2026-10-01T00:00:00Z",
  counterparties: { name: NAME },
  ...over,
});

const milestone = (n: number, over: Record<string, unknown> = {}) => ({
  id: milestoneId(n),
  org_id: ORG,
  contractor_id: CP,
  title: `Milestone ${n}`,
  amount: "25",
  verification_source: null,
  verification_method: "manual",
  verification_status: "unverified",
  verification_checked_at: null,
  verified_at: null,
  verification_detail: {},
  verified: false,
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  created_at: "2026-10-01T00:00:00Z",
  counterparties: { name: NAME },
  ...over,
});

const entry = (seq: number, detail: Record<string, unknown>) => ({
  seq,
  id: `e${seq}`,
  ts: "2026-10-02T00:00:00Z",
  actor: "agent",
  domain: "ap",
  action: "ap_pay",
  summary: "PAY",
  detail,
  body_hash: "b",
  signature: "s",
  prev_hash: "p",
  hash: "h",
  signing_key_id: null,
});

const LINK = {
  id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1",
  created_at: "2026-11-08T12:00:00.123456+00:00",
  expires_at: "2026-11-15T12:00:00.123456+00:00",
  used_at: null,
  revoked_at: null,
  created_by: USER,
  asks_invoice: false,
  invoice_at: null,
  invoice_closed_at: null,
};

interface World {
  invoices?: Array<Record<string, unknown>> | "fail";
  milestones?: Array<Record<string, unknown>> | "fail";
  /** The entries the targets RPC answers for the ids it is asked. */
  targets?: (body: { p_invoice_ids: string[]; p_milestone_ids: string[] }) => unknown[];
  intents?: Array<Record<string, unknown>>;
  receipts?: Array<{ invoice_id: string; revoked_at: string | null }>;
  book?: Array<Record<string, unknown>> | "fail";
  addressEntries?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>> | "fail";
  drafts?: Array<Record<string, unknown>> | "missing";
  /** The address checks (AC5) fail to read. */
  checks?: "fail";
}

/** A failure whose message names the counterparty, as a database error may: logs must not repeat it (CL4). */
const FAIL: FakeReply = { status: 500, body: { message: `down while reading ${NAME} at ${ADDRESS}` } };

const ids = (request: RecordedRequest, column: string) => (request.params.get(column) ?? "").replace(/^in\.\(|\)$/g, "").split(",");

function database(world: World = {}) {
  const page = (rows: unknown[], request: RecordedRequest): FakeReply => {
    const offset = Number(request.params.get("offset") ?? 0);
    const limit = Number(request.params.get("limit") ?? rows.length);
    return { body: rows.slice(offset, offset + limit) };
  };
  const fake = fakeSupabase((request): FakeReply => {
    const select = request.params.get("select") ?? "";
    switch (request.path) {
      case "/rest/v1/invoices":
        // The document requests read their bills' facts too: none here, as no request is open.
        if (!select.startsWith("*")) return { body: [] };
        return world.invoices === "fail" ? FAIL : page(world.invoices ?? [], request);
      case "/rest/v1/milestones":
        return world.milestones === "fail" ? FAIL : page(world.milestones ?? [], request);
      case "/rest/v1/rpc/ledger_entries_for_targets":
        return { body: world.targets ? world.targets(request.body as { p_invoice_ids: string[]; p_milestone_ids: string[] }) : [] };
      case "/rest/v1/payment_intents": {
        const type = request.params.get("source_type")?.replace("eq.", "");
        const asked = new Set(ids(request, "source_id"));
        return { body: (world.intents ?? []).filter((intent) => intent.source_type === type && asked.has(String(intent.source_id))) };
      }
      case "/rest/v1/payment_receipts": {
        const asked = new Set(ids(request, "invoice_id"));
        return { body: (world.receipts ?? []).filter((receipt) => asked.has(receipt.invoice_id)) };
      }
      case "/rest/v1/counterparties":
        if (select === "id,name,address,chain") return world.book === "fail" ? FAIL : page(world.book ?? [], request);
        return { body: [] };
      case "/rest/v1/ledger_entries":
        if (select.startsWith("seq,")) return world.history === "fail" ? FAIL : { body: world.history ?? [] };
        if (select.includes("from_address")) return page(world.addressEntries ?? [], request);
        throw new Error(`unexpected ledger read ${request.params.toString()}`);
      case "/rest/v1/invoice_drafts":
        return world.drafts === "missing" ? { status: 404, body: { code: "PGRST205", message: "relation invoice_drafts does not exist" } } : { body: world.drafts ?? [] };
      case "/rest/v1/payee_links":
        return { body: request.params.get("order") === "created_at.desc" ? [LINK] : request.params.get("asks_invoice") ? [] : [{ id: LINK.id, counterparty_id: CP, expires_at: LINK.expires_at }] };
      case "/rest/v1/address_change_checks":
        return world.checks === "fail" ? FAIL : { body: [] };
      case "/rest/v1/rpc/org_members":
        return { body: [{ user_id: USER, email: "owner@northstar.test", role: "owner", joined_at: "2026-01-01T00:00:00Z" }] };
      default:
        // The payee lock, shadow mode, the address checks, the document requests' setting, bank accounts: none here.
        return { body: [] };
    }
  });
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

const options = (over: Partial<PageReadOptions> & { role?: "owner" | "viewer" | "approver" } = {}): PageReadOptions => {
  const { role = "owner", ...rest } = over;
  return { orgId: ORG, grants: pageGrants(role, { cosigns: false, live: true, bankPayouts: false }), network: "arc-testnet", now: NOW, history: false, bankPayouts: false, ...rest };
};

const read = (world: World, row: CounterpartyRow = counterparty(), over: Parameters<typeof options>[0] = {}) => {
  const db = database(world);
  return { db, result: db.run(() => readCounterpartyPage(row, options(over))) };
};

const paths = (requests: RecordedRequest[]) => requests.map((request) => request.path);
const records = (requests: RecordedRequest[], path: string) => requests.filter((request) => request.path === path && request.params.get("select")?.startsWith("*"));

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  checkLinksMock.mockReset().mockResolvedValue(new Map());
  choosableMock.mockReset().mockResolvedValue([]);
  heldMock.mockReset().mockResolvedValue(new Set());
  for (const tool of [asanaMock, linearMock, jiraMock]) tool.mockReset().mockResolvedValue(null);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});

describe("isolation and secrets (CL2, CL4)", () => {
  it("CL2: every read keeps to the workspace, and every platform read names it and this counterparty's own id", async () => {
    const { db, result } = read({ invoices: [invoice(1)], milestones: [milestone(1)] });
    const page = await result;
    expect(page.invoices.read && page.milestones?.read && page.payeeLinks?.read).toBe(true);
    for (const request of db.fake.requests) expect(carriesOrg(request, ORG), `${request.method} ${request.path}`).toBe(true);
    const links = db.fake.requests.filter((request) => request.path === "/rest/v1/payee_links");
    expect(links).toHaveLength(3);
    for (const request of links) {
      expect(request.params.get("org_id")).toBe(`eq.${ORG}`);
      expect(request.params.get("counterparty_id")).toBe(`eq.${CP}`);
    }
    const [invoices] = records(db.fake.requests, "/rest/v1/invoices");
    expect(invoices.params.get("counterparty_id")).toBe(`eq.${CP}`);
    const [milestones] = records(db.fake.requests, "/rest/v1/milestones");
    expect(milestones.params.get("contractor_id")).toBe(`eq.${CP}`);
    expect(errors).not.toHaveBeenCalled();
  });

  it("CL4: no read selects a token's hash, and the payee links, receipts, drafts and History name their columns, History no detail", async () => {
    const { db, result } = read({ invoices: [invoice(1, { status: "paid", tx_ref: `0x${"7".repeat(64)}` })], milestones: [milestone(1)] });
    await result;
    for (const request of db.fake.requests) {
      expect(request.params.get("select") ?? "", request.path).not.toContain("token_hash");
    }
    const named = db.fake.requests.filter((request) => ["/rest/v1/payee_links", "/rest/v1/payment_receipts", "/rest/v1/invoice_drafts", "/rest/v1/ledger_entries"].includes(request.path));
    expect(new Set(paths(named))).toEqual(new Set(["/rest/v1/payee_links", "/rest/v1/payment_receipts", "/rest/v1/invoice_drafts", "/rest/v1/ledger_entries"]));
    for (const request of named) expect(request.params.get("select"), request.path).not.toMatch(/\*/);
    const ledger = db.fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries");
    // The whole detail is never read: History reads none of it, the address entries their three addresses only.
    for (const request of ledger) expect(request.params.get("select")).not.toMatch(/(^|,)detail(,|$)/);
    expect(ledger.find((request) => request.params.get("select")?.startsWith("seq,"))?.params.get("select")).toBe("seq,ts,actor,action,summary");
    expect(db.fake.requests.find((request) => request.path === "/rest/v1/payment_receipts")?.params.get("select")).toBe("invoice_id,revoked_at");
  });

  it("CL4: logs a part that failed by its name and the error's name, never the counterparty's name or address", async () => {
    const { result } = read({ invoices: "fail" });
    await result;
    expect(errors).toHaveBeenCalledWith("counterparty page: invoices not read", "Error");
    for (const call of errors.mock.calls) {
      const said = call.map(String).join(" ");
      expect(said).not.toContain(NAME);
      expect(said).not.toContain(ADDRESS);
      expect(said).not.toContain("down while reading");
    }
  });
});

describe("grants (CL3)", () => {
  it("CL3: a viewer's page reads no payee link and no member, and offers neither a mirror address nor a chain to choose", async () => {
    const { db, result } = read({ invoices: [invoice(1)] }, counterparty({ address: null, role: "vendor" }), { role: "viewer" });
    const page = await result;
    expect(page.payeeLinks).toBeNull();
    expect(paths(db.fake.requests)).not.toContain("/rest/v1/payee_links");
    expect(paths(db.fake.requests)).not.toContain("/rest/v1/rpc/org_members");
    expect(paths(db.fake.requests)).not.toContain("/rest/v1/shadow_modes");
    expect(choosableMock).not.toHaveBeenCalled();
    expect(page.controls).toEqual({ shadow: false, chainChoices: [], bank: null });
    // History and the receipt states are every member's (CL3, CL9).
    expect(page.history.read).toBe(true);
    expect(page.receipts?.read).toBe(true);
  });

  it("CL6: a writer on a payee's page reads its latest five links, the one out, the one waiting for its invoice, and who made them", async () => {
    const { db, result } = read({});
    const page = await result;
    expect(page.payeeLinks).toEqual({
      read: true,
      value: { links: [LINK], active: { id: LINK.id, expiresAt: LINK.expires_at }, waiting: null, members: [{ userId: USER, email: "owner@northstar.test" }] },
    });
    const history = db.fake.requests.find((request) => request.path === "/rest/v1/payee_links" && request.params.get("order") === "created_at.desc");
    expect(history?.params.get("limit")).toBe("5");
    const members = db.fake.requests.find((request) => request.path === "/rest/v1/rpc/org_members");
    expect(members?.body).toEqual({ p_org_id: ORG });
  });

  it("CL6: a writer offers a vendor with no address the chains it may choose, unless something holds it to its chain", async () => {
    choosableMock.mockResolvedValue([{ label: "Arc Testnet" }, { label: "Base Sepolia" }]);
    const vendor = counterparty({ role: "vendor", address: null });
    expect((await read({}, vendor).result).controls.chainChoices).toEqual(["Arc Testnet", "Base Sepolia"]);
    expect(heldMock).toHaveBeenCalledWith([CP]);
    heldMock.mockResolvedValue(new Set([CP]));
    expect((await read({}, vendor).result).controls.chainChoices).toEqual([]);
    // As if held when that cannot be read, as Counterparties does.
    heldMock.mockRejectedValue(new Error("down"));
    expect((await read({}, vendor).result).controls.chainChoices).toEqual([]);
    // A contractor, or a vendor with an address, is offered none, and nothing is read for it.
    choosableMock.mockClear();
    expect((await read({}, counterparty()).result).controls.chainChoices).toEqual([]);
    expect(choosableMock).not.toHaveBeenCalled();
  });

  it("reads a vendor's bank account only where BlindPay pays, for every role, as Counterparties does", async () => {
    const vendor = counterparty({ role: "vendor" });
    const off = read({}, vendor);
    expect((await off.result).controls.bank).toBeNull();
    expect(paths(off.db.fake.requests)).not.toContain("/rest/v1/counterparty_bank_accounts");
    const on = read({}, vendor, { role: "viewer", bankPayouts: true });
    expect((await on.result).controls.bank).toEqual({ account: null, setUp: false });
    expect(paths(on.db.fake.requests)).toContain("/rest/v1/counterparty_bank_accounts");
    expect((await read({}, counterparty(), { bankPayouts: true }).result).controls.bank).toBeNull();
  });
});

describe("a client's page (CL1)", () => {
  it("CL1: reads no milestone, payee link, receipt, document request or draft for a client, even for an owner", async () => {
    const { db, result } = read({ invoices: [invoice(1, { direction: "receivable", status: "received" })] }, counterparty({ role: "client" }));
    const page = await result;
    expect(page.milestones).toBeNull();
    expect(page.payeeLinks).toBeNull();
    expect(page.receipts).toBeNull();
    expect(page.documents).toBeNull();
    expect(page.drafts).toBeNull();
    expect(page.evidence).toEqual({ asana: null, linear: null, jira: null, links: new Map() });
    for (const tool of [asanaMock, linearMock, jiraMock]) expect(tool).not.toHaveBeenCalled();
    for (const path of ["/rest/v1/milestones", "/rest/v1/payee_links", "/rest/v1/payment_receipts", "/rest/v1/invoice_drafts", "/rest/v1/document_requests"]) {
      expect(paths(db.fake.requests)).not.toContain(path);
    }
    expect(page.invoices.read && page.invoices.value.map((row) => row.id)).toEqual([invoiceId(1)]);
    expect(page.history.read && page.address.read).toBe(true);
  });
});

describe("parts, best effort (CL13)", () => {
  it("CL13: one part that fails leaves the rest, and what waits on it is not read either", async () => {
    const { result } = read({ invoices: "fail", milestones: [milestone(1)], history: [{ seq: 3, ts: "2026-10-03T00:00:00Z", actor: "human", action: "create_counterparty", summary: "Added a counterparty" }] });
    const page = await result;
    expect(page.invoices).toEqual({ read: false });
    expect(page.receipts).toEqual({ read: false });
    expect(page.documents).toEqual({ read: false });
    // Without its bills, what this payee was paid at is not known: no address is offered to copy on a guess (CL5).
    expect(page.address).toEqual({ read: false });
    expect(page.milestones?.read && page.milestones.value.map((row) => row.id)).toEqual([milestoneId(1)]);
    expect(page.entries.read && page.payments.read && page.drafts?.read && page.payeeLinks?.read).toBe(true);
    expect(page.history).toEqual({ read: true, value: [{ seq: 3, ts: "2026-10-03T00:00:00Z", actor: "human", action: "create_counterparty", summary: "Added a counterparty" }] });
  });

  it("CL13: says History was not read when it was not, and the drafts before migration 0121", async () => {
    const page = await read({ history: "fail", drafts: "missing" }).result;
    expect(page.history).toEqual({ read: false });
    expect(page.drafts).toEqual({ read: false });
    expect(errors).toHaveBeenCalledWith("counterparty page: drafts not read", "CaptureNotSetUpError");
  });

  it("CL10: reads the latest 20 drafts sent for review that name this counterparty, and the latest 25 lines of History", async () => {
    const { db, result } = read({ drafts: [{ id: "d1", source: "file", invoice_number: "INV-7", amount: "12.000000", currency: "USDC", sent_at: "2026-11-01T00:00:00Z" }] });
    const page = await result;
    expect(page.drafts).toEqual({ read: true, value: [{ id: "d1", source: "file", invoice_number: "INV-7", amount: "12.000000", currency: "USDC", sent_at: "2026-11-01T00:00:00Z" }] });
    const drafts = db.fake.requests.find((request) => request.path === "/rest/v1/invoice_drafts");
    expect(drafts?.params.get("select")).toBe("id,source,invoice_number,amount,currency,sent_at");
    expect(drafts?.params.get("state")).toBe("eq.sent");
    expect(drafts?.params.get("counterparty_id")).toBe(`eq.${CP}`);
    expect(drafts?.params.get("order")).toBe("sent_at.desc");
    expect(drafts?.params.get("limit")).toBe(String(DRAFTS_SHOWN));
    const history = db.fake.requests.find((request) => request.path === "/rest/v1/ledger_entries" && request.params.get("select")?.startsWith("seq,"));
    expect(history?.params.get("domain")).toBe("eq.compliance");
    expect(history?.params.get("detail->>counterpartyId")).toBe(`eq.${CP}`);
    expect(history?.params.get("limit")).toBe(String(HISTORY_SHOWN));
  });

  it("CL13: reads the entries 25 ids at a time, newest first, and names the ids of a chunk that came back full as maybe cut", async () => {
    const invoices = Array.from({ length: 30 }, (_, index) => invoice(index + 1));
    const milestones = Array.from({ length: 4 }, (_, index) => milestone(index + 1));
    const full = Array.from({ length: 1000 }, (_, index) => entry(index + 1, { invoiceId: invoiceId(1) }));
    const { db, result } = read({
      invoices,
      milestones,
      targets: (body) => (body.p_invoice_ids.includes(invoiceId(1)) ? full : [entry(2000, { milestoneId: milestoneId(1) }), entry(5, { invoiceId: invoiceId(26) })]),
    });
    const page = await result;
    const calls = db.fake.requests.filter((request) => request.path === "/rest/v1/rpc/ledger_entries_for_targets").map((request) => request.body as { p_invoice_ids: string[]; p_milestone_ids: string[] });
    expect(ENTRY_ID_CHUNK).toBe(25);
    expect(calls.map((call) => [call.p_invoice_ids.length, call.p_milestone_ids.length])).toEqual([[25, 0], [5, 4]]);
    if (!page.entries.read) throw new Error("entries not read");
    // Merged by number, newest first: the entry both chunks answered is there once.
    expect(page.entries.value.entries).toHaveLength(1001);
    expect(page.entries.value.entries[0].seq).toBe(2000);
    expect(page.entries.value.entries.map((row) => row.seq)).toEqual([...page.entries.value.entries.map((row) => row.seq)].sort((a, b) => b - a));
    expect(page.entries.value.cut).toEqual(new Set(invoices.slice(0, 25).map((row) => row.id)));
  });

  it("CL13: reads every one of a payee's records, a thousand a page", async () => {
    const invoices = Array.from({ length: 1001 }, (_, index) => invoice(index + 1));
    const { db, result } = read({ invoices });
    const page = await result;
    expect(page.invoices.read && page.invoices.value).toHaveLength(1001);
    const reads = records(db.fake.requests, "/rest/v1/invoices");
    expect(reads.map((request) => [request.params.get("offset"), request.params.get("limit")])).toEqual([["0", "1000"], ["1000", "1000"]]);
    expect(reads[0].params.get("order")).toBe("due_date.asc,id.asc");
  });

  it("CL9: reads the payment intents of every record, and the receipts of the paid bills Payments can show: the latest 10, or 500 with every payment asked for", async () => {
    const paid = Array.from({ length: 12 }, (_, index) => invoice(index + 1, { status: "paid", due_date: `2026-09-${String(index + 1).padStart(2, "0")}` }));
    const world: World = {
      invoices: [...paid, invoice(40)],
      milestones: [milestone(1, { status: "paid" })],
      intents: [{ source_type: "invoice", source_id: invoiceId(12), status: "confirmed", amount: "10", token: null, destination: ADDRESS }],
      receipts: [{ invoice_id: invoiceId(12), revoked_at: null }, { invoice_id: invoiceId(11), revoked_at: "2026-10-01T00:00:00Z" }],
    };
    const latest = read(world);
    const page = await latest.result;
    expect(page.receipts).toEqual({ read: true, value: new Map([[invoiceId(12), "shared"], [invoiceId(11), "stopped"]]) });
    const [receipts] = latest.db.fake.requests.filter((request) => request.path === "/rest/v1/payment_receipts");
    expect(new Set(ids(receipts, "invoice_id"))).toEqual(new Set(paid.slice(2).map((row) => row.id)));
    expect(ids(receipts, "invoice_id")).toHaveLength(PAYMENTS_SHOWN);
    const intents = latest.db.fake.requests.filter((request) => request.path === "/rest/v1/payment_intents");
    expect(intents.map((request) => [request.params.get("source_type"), ids(request, "source_id").length])).toEqual([["eq.invoice", 13], ["eq.milestone", 1]]);
    expect(page.payments.read && page.payments.value.destinations.get(invoiceId(12))).toBe(ADDRESS);

    const all = read(world, counterparty(), { history: true });
    await all.result;
    const [every] = all.db.fake.requests.filter((request) => request.path === "/rest/v1/payment_receipts");
    expect(ids(every, "invoice_id")).toHaveLength(12);
  });

  it("CL7: checks a payee's milestones' evidence links, the open milestones' first", async () => {
    const done = "https://github.com/acme/site/pull/1";
    const open = "https://github.com/acme/site/pull/2";
    await read({ milestones: [milestone(1, { status: "paid", verification_source: done }), milestone(2, { verification_source: open }), milestone(3, { verification_source: "http://example.test" })] }).result;
    expect(checkLinksMock).toHaveBeenCalledWith([open, done]);
  });

  it("CL7: checks the Asana, Linear and Jira deliverables' links too, as Contractors does (Jira acceptance JR20)", async () => {
    // Each tool's link to a milestone, with what it delivered: a link without an address is not checked.
    const linked = (tool: string, n: number) => ({
      connected: true,
      memberEmails: {},
      links: new Map([[milestoneId(n), { deliverables: [{ kind: "link", label: tool, href: `https://${tool}.example.test/${n}` }, { kind: "file", label: "Unnamed", href: null }] }]]),
    });
    asanaMock.mockResolvedValue(linked("asana", 1));
    linearMock.mockResolvedValue(linked("linear", 2));
    jiraMock.mockResolvedValue(linked("jira", 3));
    const own = "https://github.com/acme/site/pull/4";
    const page = await read({ milestones: [milestone(1), milestone(2, { status: "paid" }), milestone(3), milestone(4, { verification_source: own })] }).result;
    const asked = [1, 2, 3, 4].map(milestoneId);
    for (const tool of [asanaMock, linearMock, jiraMock]) expect(tool).toHaveBeenCalledWith(asked);
    // The open milestones' first, each with its own link and then its tools'.
    expect(checkLinksMock).toHaveBeenCalledWith(["https://asana.example.test/1", "https://jira.example.test/3", own, "https://linear.example.test/2"]);
    expect(page.evidence.jira?.links.has(milestoneId(3))).toBe(true);
  });
});

describe("the payment address (CL5)", () => {
  it("CL5: finds another counterparty's lookalike on the same chain, an earlier address of this payee's it looks like, and the freeze on the row", async () => {
    const { db, result } = read(
      {
        book: [
          { id: OTHER, name: "Northwind", address: ALIKE, chain: "ARC-TESTNET" },
          // Its own row in the book as it was a moment before: the row the page read is the one compared.
          { id: CP, name: NAME, address: "0x0000000000000000000000000000000000000001", chain: "ARC-TESTNET" },
          { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000003ee", name: "Elsewhere", address: ALIKE, chain: "BASE-SEPOLIA" },
        ],
        addressEntries: [{ action: "counterparty_address_changed", from_address: EARLIER, to_address: ADDRESS, address: null }],
      },
      counterparty({ frozen_at: "2026-11-08T00:00:00Z", address_changed_at: "2026-11-07T00:00:00Z" })
    );
    const page = await result;
    expect(page.address).toEqual({ read: true, value: { lookalikes: [{ kind: "alike", id: OTHER, name: "Northwind" }], earlierLookalike: EARLIER, frozen: true } });
    const entries = db.fake.requests.find((request) => request.path === "/rest/v1/ledger_entries" && request.params.get("select")?.includes("from_address"));
    expect(entries?.params.get("detail->>counterpartyId")).toBe(`eq.${CP}`);
    expect(entries?.params.get("select")).toBe("action,from_address:detail->>from,to_address:detail->>to,address:detail->>address");
  });

  it("CL5: finds an earlier address it looks like among those this payee was paid at on its chain, and none on another chain", async () => {
    const paidAt = (chain: string | null) => ({
      invoices: [invoice(1, { status: "paid" })],
      intents: [{ source_type: "invoice", source_id: invoiceId(1), status: "confirmed", amount: "10", token: null, destination: EARLIER, destination_chain: chain }],
    });
    const own = await read(paidAt(null)).result;
    expect(own.address.read && own.address.value.earlierLookalike).toBe(EARLIER);
    const across = await read(paidAt("BASE-SEPOLIA")).result;
    expect(across.address.read && across.address.value.earlierLookalike).toBeNull();
  });

  it("CL5: with the address book or the address entries unread, the address part is not read, so nothing is copied on a guess", async () => {
    const page = await read({ book: "fail" }).result;
    expect(page.address).toEqual({ read: false });
    expect(errors).toHaveBeenCalledWith("counterparty page: address not read", "Error");
  });

  it("reads nothing for an address there is not, and keeps a freeze its checks could not be read for, for its notice and Unfreeze (AC5)", async () => {
    const frozen = counterparty({ address: null, frozen_at: "2026-11-08T00:00:00Z" });
    const { db, result } = read({ checks: "fail" }, frozen);
    const page = await result;
    expect(page.address).toEqual({ read: true, value: { lookalikes: [], earlierLookalike: null, frozen: true } });
    expect(db.fake.requests.some((request) => request.path === "/rest/v1/counterparties" && request.params.get("select") === "id,name,address,chain")).toBe(false);
    expect(page.addressCheck).toEqual({ frozen: true, check: null });
    expect(errors).toHaveBeenCalledWith("counterparty page: address checks not read", "Error");
    // Not frozen, and its checks unread: no notice.
    expect((await read({ checks: "fail" }, counterparty()).result).addressCheck).toBeNull();
  });
});

describe("this counterparty's own reads (queries.ts, CL2, CL13)", () => {
  it("CL2: reads one counterparty of the workspace by id, null for one it does not hold, its figures as numbers", async () => {
    const row = { ...counterparty(), payment_limit: "500.000000", baseline_payment_limit: null, performance_score: "0.9", sample: null };
    const fake = fakeSupabase((request) => ({ body: request.params.get("id") === `eq.${CP}` ? [row] : [] }));
    const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
    expect(await run(() => readCounterparty(CP))).toMatchObject({ id: CP, payment_limit: 500, baseline_payment_limit: null, performance_score: 0.9, sample: false });
    expect(await run(() => readCounterparty(OTHER))).toBeNull();
    const [request] = fake.requests;
    expect(request.params.get("select")).toBe("*");
    expect(carriesOrg(request, ORG)).toBe(true);
  });

  it("throws a counterparty that could not be read, which the page shows as held, never as a 404", async () => {
    const fake = fakeSupabase(() => FAIL);
    await expect(runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readCounterparty(CP))).rejects.toThrow("down");
  });

  it("CL13: reads one payee's invoices and milestones only, a thousand a page, mapped as the lists map them", async () => {
    const { fake, run } = database({ invoices: [invoice(1, { paid_amount: "9.5", currency: null })], milestones: [milestone(1)] });
    const [invoices, milestones] = await run(() => Promise.all([listInvoicesOf(CP), listMilestonesOf(CP)]));
    expect(invoices[0]).toMatchObject({ amount: 10, paid_amount: 9.5, currency: "USDC", counterparty_name: NAME });
    expect(milestones[0]).toMatchObject({ amount: 25, contractor_name: NAME });
    const [invoiceRead] = fake.requests.filter((request) => request.path === "/rest/v1/invoices");
    expect(invoiceRead.params.get("select")).toBe("*,counterparties(name)");
    expect(invoiceRead.params.get("counterparty_id")).toBe(`eq.${CP}`);
    const [milestoneRead] = fake.requests.filter((request) => request.path === "/rest/v1/milestones");
    expect(milestoneRead.params.get("contractor_id")).toBe(`eq.${CP}`);
    expect(milestoneRead.params.get("order")).toBe("created_at.asc,id.asc");
    expect(milestoneRead.params.get("limit")).toBe("1000");
  });

  it("CL5: reads every counterparty's address and chain, and only those, a thousand a page", async () => {
    const book = Array.from({ length: 1000 }, (_, index) => ({ id: `cp-${index}`, name: `Payee ${index}`, address: ADDRESS, chain: null }));
    const { fake, run } = database({ book: [...book, { id: OTHER, name: "Northwind", address: ALIKE, chain: "ARC-TESTNET" }] });
    expect(await run(() => payeeAddressBook())).toHaveLength(1001);
    const reads = fake.requests.filter((request) => request.path === "/rest/v1/counterparties");
    expect(reads).toHaveLength(2);
    expect(reads[0].params.get("select")).toBe("id,name,address,chain");
    expect(reads[0].params.get("address")).toBe("not.is.null");
    expect(reads[0].params.get("order")).toBe("id.asc");
  });
});
