import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { evidenceRequest, readEvidence } from "@/lib/evidence-read";
import { NOT_CHECKED_WORDS } from "@/lib/evidence-links/allow-list";
import { forgetLinkChecks, LINK_WORDS } from "@/lib/evidence-links/check";
import type { LedgerEntryInput } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { chainById } from "@/lib/payee-chains";
import { forgetMinedReceipts } from "@/lib/receipts/onchain";
import { buildChain } from "./support/ledger-chain";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What the evidence page reads (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E5): the record, its
 * counterparty and every entry the chain rests on, through `db()` in the workspace's scope; the screening check at the
 * time of the decision the chain rests on; the members' emails, best effort; then each entry's signature and Arc's
 * record of the transaction. Over a recorded database and a stood-in RPC.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: publicKey, retired: [] }),
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001aa";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002bb";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003cc";
const RECEIPT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000004dd";
const PAYEE = "0x221B000000000000000000000000000000001bc3";
const WALLET = "0x97F85033bBD83870a841cF7153F35b387746B6b6";
const TX = `0x${"79".repeat(32)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const DECIDED_AT = "2026-01-01T00:03:00.000Z";
const inputs: LedgerEntryInput[] = [
  { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Northstar", detail: { by: USER, counterpartyId: CP, address: PAYEE } },
  { actor: "human", domain: "compliance", action: "counterparty_address_confirmed", summary: "Confirmed", detail: { by: USER, counterpartyId: CP, address: PAYEE } },
  {
    actor: "human",
    domain: "ap",
    action: "create_invoice",
    summary: "Added a bill",
    detail: { by: USER, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", poReference: "PO-1", goodsReceived: true },
  },
  {
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: "PAY",
    detail: { invoiceId: INVOICE, counterpartyId: CP, decision: { action: "pay" }, decisionMode: "heuristic", guardrailBlocked: false, observed: { amount: 12.5 }, execution: { txRef: TX, resultingStatus: "paid" } },
  },
];
const firstFour = buildChain(inputs, privateKey, ledgerKeyId(publicKey));
const RECEIPT_ENTRY: LedgerEntryInput = {
  actor: "human",
  domain: "ap",
  action: "receipt_shared",
  summary: "Receipt: 12.5 USDC paid on Arc testnet",
  detail: { receipt: { txHash: TX }, records: { seq: 4, hash: firstFour[3].hash } },
};
const ROWS = buildChain([...inputs, RECEIPT_ENTRY], privateKey, ledgerKeyId(publicKey)).map((row) => ({ ...row, org_id: ORG }));
const [ADDRESS, CONFIRMED, CREATED, PAID, SHARED] = ROWS;

const INVOICE_ROW = {
  id: INVOICE,
  org_id: ORG,
  direction: "payable",
  counterparty_id: CP,
  amount: "12.500000",
  currency: "USDC",
  memo: "October retainer",
  po_reference: "PO-1",
  goods_received: true,
  due_date: "2026-01-10T00:00:00Z",
  status: "paid",
  tx_ref: TX,
};
const COUNTERPARTY_ROW = { id: CP, org_id: ORG, name: "Northstar Studio", address: PAYEE, chain: "ARC-TESTNET", risk_level: "clear", purchase_order_required: true, sample: false };
const INTENT = {
  status: "confirmed",
  provider: "circle",
  provider_mode: "live",
  token: "USDC",
  amount: "12.500000",
  destination: PAYEE,
  tx_hash: TX,
  chain: "ARC-TESTNET",
  destination_chain: null,
  mint_tx_hash: null,
  bridge_fee: null,
  payout_route: null,
  confirmed_at: "2026-01-01T00:03:30Z",
  network: "arc-testnet",
};

interface World {
  invoice?: Record<string, unknown> | null;
  milestone?: Record<string, unknown> | null;
  receipt?: Record<string, unknown> | null;
  members?: "fail" | Array<{ user_id: string; email: string; role: string; joined_at: string }>;
  revokes?: typeof ROWS;
  intent?: Record<string, unknown> | null;
  targets?: typeof ROWS;
}

function database(world: World = {}) {
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const many = (rows: unknown[]) => ({ body: rows });
    const one = (row: unknown) => ({ body: row ? [row] : [] });
    switch (request.path) {
      case "/rest/v1/invoices":
        return one(world.invoice === undefined ? INVOICE_ROW : world.invoice);
      case "/rest/v1/milestones":
        return one(world.milestone ?? null);
      case "/rest/v1/counterparties":
        return one(COUNTERPARTY_ROW);
      case "/rest/v1/rpc/ledger_entries_for_targets":
        return many(world.targets ?? [PAID, CREATED]);
      case "/rest/v1/ledger_entries": {
        if (request.params.get("action") === "eq.decision_verdict") return many([]);
        if (request.params.get("domain") === "eq.compliance") return many([CONFIRMED, ADDRESS]);
        if (request.params.get("seq") === `eq.${SHARED.seq}`) return many([SHARED]);
        if (request.params.get("detail->>receiptId") === `eq.${RECEIPT}`) return many(world.revokes ?? []);
        throw new Error(`unexpected ledger read ${request.params.toString()}`);
      }
      case "/rest/v1/payment_intents":
        return one(world.intent === undefined ? INTENT : world.intent);
      case "/rest/v1/payment_receipts":
        return one(world.receipt === undefined ? { id: RECEIPT, entry_seq: SHARED.seq, created_at: "2026-01-01T00:04:00Z", revoked_at: null, created_by: USER } : world.receipt);
      case "/rest/v1/compliance_checks":
        return one({ risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-01-01T00:02:00Z" });
      case "/rest/v1/rpc/org_members":
        if (world.members === "fail") return { status: 500, body: { message: "members unavailable" } };
        return many(world.members ?? [{ user_id: USER, email: "alice@northstar.test", role: "owner", joined_at: "2026-01-01T00:00:00Z" }]);
      default:
        throw new Error(`unexpected request ${request.method} ${request.path}`);
    }
  });
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

/** Arc's answer for the transaction: a transfer of 12.5 USDC to the payee, in block 0x40. */
const arcFetch = vi.fn(async () =>
  Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: {
      status: "0x1",
      blockNumber: "0x40",
      logs: [
        {
          address: chainById("ARC-TESTNET").usdc,
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            `0x${WALLET.slice(2).toLowerCase().padStart(64, "0")}`,
            `0x${PAYEE.slice(2).toLowerCase().padStart(64, "0")}`,
          ],
          data: `0x${(12_500_000).toString(16).padStart(64, "0")}`,
        },
      ],
    },
  })
);

beforeEach(() => {
  forgetMinedReceipts();
  arcFetch.mockClear();
});

describe("which records have evidence", () => {
  it("takes a payable or a milestone by its UUID, and nothing else", () => {
    expect(evidenceRequest("invoice", INVOICE)).toEqual({ kind: "invoice", id: INVOICE });
    expect(evidenceRequest("milestone", MILESTONE.toUpperCase())).toEqual({ kind: "milestone", id: MILESTONE });
    expect(evidenceRequest("receipt", INVOICE)).toBeNull();
    expect(evidenceRequest("invoice", "not-a-uuid")).toBeNull();
    expect(evidenceRequest("invoice", `${INVOICE}' or 1=1`)).toBeNull();
    expect(evidenceRequest(undefined, INVOICE)).toBeNull();
  });
});

describe("reading a paid payable's evidence", () => {
  it("reads only through the workspace's scope: every request names it", async () => {
    const db = database();
    const read = await db.run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch }));
    expect(read).not.toBeNull();
    expect(db.fake.requests.length).toBeGreaterThan(8);
    for (const request of db.fake.requests) expect(carriesOrg(request, ORG), `${request.method} ${request.path}`).toBe(true);
  });

  it("asks for the newest complete screening check at the time of the decision the chain rests on", async () => {
    const db = database();
    await db.run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch }));
    const [check] = db.fake.requests.filter((request) => request.path === "/rest/v1/compliance_checks");
    expect(check.params.get("counterparty_id")).toBe(`eq.${CP}`);
    expect(check.params.get("status")).toBe("eq.complete");
    expect(check.params.get("created_at")).toBe(`lte.${PAID.ts}`);
    expect(check.params.get("order")).toBe("created_at.desc");
    expect(check.params.get("limit")).toBe("1");
    expect(PAID.ts).toBe(DECIDED_AT);
  });

  it("checks every entry's signature and Arc's record, and builds the chain on them", async () => {
    const db = database();
    const read = await db.run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch, rpcUrl: () => "https://rpc.test" }));
    const chain = read!.chain;
    expect(arcFetch).toHaveBeenCalledWith("https://rpc.test", expect.objectContaining({ method: "POST" }));
    expect(chain.entries.map((row) => [row.seq, row.check])).toEqual([1, 2, 3, 4, 5].map((seq) => [seq, { ok: true }]));
    expect(chain.steps.find((s) => s.id === "payment")?.facts[0]).toMatchObject({ kind: "verified" });
    expect(chain.steps.find((s) => s.id === "receipt")?.facts[0]).toMatchObject({ kind: "checked", seqs: [5, 4] });
    expect(chain.steps.find((s) => s.id === "payee")?.facts.at(-1)).toMatchObject({ kind: "verified", text: "Northstar Studio was screened clear by OpenSanctions." });
    expect(chain.steps.find((s) => s.id === "agreed")?.facts[0].who).toBe("alice@northstar.test");
    expect(read!.publicKeys).toEqual({ [ledgerKeyId(publicKey)]: publicKey.export({ type: "spki", format: "pem" }).toString() });
    expect(read!.receipt).toEqual({ state: "shared" });
  });

  it("finds the receipt's own entries by its seq and by the receipt, never the workspace's other receipts", async () => {
    const revoke = { ...SHARED, seq: 9, action: "receipt_revoked", detail: { by: USER, receiptId: RECEIPT } };
    const db = database({ receipt: { id: RECEIPT, entry_seq: SHARED.seq, created_at: "2026-01-01T00:04:00Z", revoked_at: "2026-01-02T00:00:00Z", created_by: USER }, revokes: [revoke] });
    const read = await db.run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch }));
    expect(read!.receipt).toEqual({ state: "stopped" });
    expect(read!.chain.steps.find((s) => s.id === "receipt")?.facts[0]).toMatchObject({ kind: "unreachable", seqs: [5, 9] });
  });

  it("says a receipt nobody shared is not shared", async () => {
    const read = await database({ receipt: null }).run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch }));
    expect(read!.receipt).toEqual({ state: "none" });
  });

  it("says a bill with no payment on chain has no receipt to share: not paid yet, or paid in a simulation", async () => {
    const open = await database({ invoice: { ...INVOICE_ROW, status: "held", tx_ref: null }, intent: null, receipt: null, targets: [CREATED] }).run(() => readEvidence("invoice", INVOICE));
    expect(open!.receipt).toEqual({ state: "unavailable" });
    const simulated = await database({ invoice: { ...INVOICE_ROW, tx_ref: "sim_1" }, intent: { ...INTENT, provider: "sim", provider_mode: "simulate", tx_hash: null }, receipt: null }).run(() =>
      readEvidence("invoice", INVOICE)
    );
    expect(simulated!.chain.subject).toMatchObject({ paid: true, simulated: true, onChain: false });
    expect(simulated!.receipt).toEqual({ state: "unavailable" });
    expect(arcFetch).not.toHaveBeenCalled();
  });

  it("reads what a bill paid early carried, as a figure, beside the bill's amount", async () => {
    const read = await database({ invoice: { ...INVOICE_ROW, paid_amount: "12.250000" } }).run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch }));
    expect(read!.chain.subject).toMatchObject({ amount: 12.5, paidAmount: 12.25 });
    const whole = await database({ invoice: { ...INVOICE_ROW, paid_amount: null } }).run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch }));
    expect(whole!.chain.subject.paidAmount).toBeNull();
  });

  it("names a person a member, not a former one, when the members cannot be read", async () => {
    const read = await database({ members: "fail" }).run(() => readEvidence("invoice", INVOICE, { fetch: arcFetch as unknown as typeof fetch }));
    expect(read!.chain.steps.find((s) => s.id === "agreed")?.facts[0].who).toBe("a member");
  });
});

describe("what has no evidence page", () => {
  it("is a receivable", async () => {
    const read = await database({ invoice: { ...INVOICE_ROW, direction: "receivable" } }).run(() => readEvidence("invoice", INVOICE));
    expect(read).toBeNull();
  });

  it("is an id the workspace does not hold, which reads nothing more", async () => {
    const db = database({ invoice: null });
    expect(await db.run(() => readEvidence("invoice", INVOICE))).toBeNull();
    expect(db.fake.requests.map((request) => request.path)).toEqual(["/rest/v1/invoices"]);
  });

  it("is an id that is not one, which reads nothing at all", async () => {
    const db = database();
    expect(await db.run(() => readEvidence("invoice", "../members"))).toBeNull();
    expect(db.fake.requests).toEqual([]);
  });
});

describe("a milestone's evidence", () => {
  it("reads its own entries, its payment and no receipt", async () => {
    const db = database({
      milestone: {
        id: MILESTONE,
        org_id: ORG,
        contractor_id: CP,
        title: "Fix the login redirect",
        amount: "25",
        status: "pending",
        verified: false,
        verification_method: "manual",
        verification_status: "unverified",
        verification_source: null,
        verification_checked_at: null,
        verified_at: null,
        verification_detail: {},
        tx_ref: null,
      },
      intent: null,
      targets: [],
    });
    const read = await db.run(() => readEvidence("milestone", MILESTONE));
    expect(read!.chain.subject).toMatchObject({ kind: "milestone", title: "Fix the login redirect", amount: 25, paid: false });
    expect(read!.receipt).toBeNull();
    const paths = db.fake.requests.map((request) => request.path);
    expect(paths).not.toContain("/rest/v1/payment_receipts");
    expect(paths).not.toContain("/rest/v1/invoices");
    const targets = db.fake.requests.find((request) => request.path === "/rest/v1/rpc/ledger_entries_for_targets");
    expect(targets?.body).toMatchObject({ p_invoice_ids: [], p_milestone_ids: [MILESTONE] });
    const intent = db.fake.requests.find((request) => request.path === "/rest/v1/payment_intents");
    expect(intent?.params.get("source_type")).toBe("eq.milestone");
    // Not paid and never decided: the newest check stands, with no time to read it at.
    const check = db.fake.requests.find((request) => request.path === "/rest/v1/compliance_checks");
    expect(check?.params.get("created_at")).toBeNull();
  });
});

describe("a given link's access, checked before the page says it is verified (evidence access E1)", () => {
  const PR = "https://github.com/acme/app/pull/12";
  const merged = {
    id: MILESTONE,
    org_id: ORG,
    contractor_id: CP,
    title: "Fix the login redirect",
    amount: "25",
    status: "verified",
    verified: true,
    verification_method: "github",
    verification_status: "verified",
    verification_source: PR,
    verification_checked_at: "2026-01-01T00:01:00Z",
    verified_at: "2026-01-01T00:00:30Z",
    verification_detail: { pullRequest: PR, mergedAt: "2026-01-01T00:00:30Z" },
    tx_ref: null,
  };
  const github = (isPrivate: boolean | null) =>
    vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.github.com/repos/acme/app/pulls/12");
      return isPrivate === null ? new Response("{}", { status: 404 }) : Response.json({ base: { repo: { private: isPrivate } } });
    }) as unknown as typeof fetch;
  const links = (fetchImpl: typeof fetch, installation?: string) => ({
    fetch: fetchImpl,
    resolve: async () => [{ address: "140.82.112.6", family: 4 }],
    tokenFor: async () => installation,
    fallbackToken: null,
  });
  const delivered = (read: Awaited<ReturnType<typeof readEvidence>>) => read!.chain.steps.find((step) => step.id === "delivered")!;

  beforeEach(() => {
    forgetLinkChecks();
  });

  it("keeps a merged pull request GitHub shows publicly verified, its link checked", async () => {
    const read = await database({ milestone: merged, intent: null, targets: [] }).run(() => readEvidence("milestone", MILESTONE, { links: links(github(false)) }));
    expect(delivered(read).kind).toBe("verified");
    expect(delivered(read).facts[0].link).toMatchObject({ href: PR, state: "checked" });
  });

  it("keeps one in the workspace's own private repository verified, read through its own GitHub connection", async () => {
    const read = await database({ milestone: merged, intent: null, targets: [] }).run(() =>
      readEvidence("milestone", MILESTONE, { links: links(github(true), "installation-token") })
    );
    const step = delivered(read);
    expect(step.kind).toBe("verified");
    expect(step.facts[0]).toMatchObject({ kind: "verified", link: { href: PR, state: "checked" } });
  });

  it("never counts one in a private repository the workspace's connection does not reach as verified, and says why", async () => {
    const read = await database({ milestone: merged, intent: null, targets: [] }).run(() => readEvidence("milestone", MILESTONE, { links: links(github(true)) }));
    const step = delivered(read);
    expect(step.kind).toBe("unreachable");
    expect(step.facts[0].link).toMatchObject({ state: "cannot_open", reason: LINK_WORDS.notPublic });
    expect(step.facts[0].notes).toContain("Its link can't be opened, so it is not counted as verified.");
    expect(step.facts.some((fact) => fact.kind === "verified")).toBe(false);
  });

  it("says a deleted pull request can't be opened", async () => {
    const read = await database({ milestone: merged, intent: null, targets: [] }).run(() => readEvidence("milestone", MILESTONE, { links: links(github(null)) }));
    expect(delivered(read).facts[0].link).toMatchObject({ state: "cannot_open", reason: LINK_WORDS.notPublic });
  });

  it("never requests a link on another site: a hand verification's evidence is shown as not checked", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const byHand = { ...merged, verification_method: "manual", verification_status: "unverified", verification_source: "https://169.254.169.254/latest/meta-data/", verification_detail: {} };
    const read = await database({ milestone: byHand, intent: null, targets: [] }).run(() => readEvidence("milestone", MILESTONE, { links: links(fetchImpl) }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(delivered(read).facts[0]).toMatchObject({ kind: "stated", link: { state: "not_opened", reason: NOT_CHECKED_WORDS.address } });
  });
});
