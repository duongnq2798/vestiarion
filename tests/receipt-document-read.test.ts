import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { LedgerEntryInput, LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { chainById } from "@/lib/payee-chains";
import { readReceiptDocument } from "@/lib/receipts/document-read";
import { forgetMinedReceipts } from "@/lib/receipts/onchain";
import { buildChain } from "./support/ledger-chain";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What a payable's receipt document reads (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA4, "Data it reads and writes"): the invoice, its payment, its entries, its receipt row and the receipt's entries, in
 * the workspace's scope through `db()`; then each entry checked with the workspace's keys, the retired one included,
 * and the transaction on its chain. It writes nothing, and never reads a receipt's link.
 */

const active = crypto.generateKeyPairSync("ed25519");
const retired = crypto.generateKeyPairSync("ed25519");
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: active.publicKey, retired: [retired.publicKey] }),
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001aa";
const RECEIPT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000004dd";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003cc";
const PAYEE = "0x221B000000000000000000000000000000001bc3";
const WALLET = "0x97F85033bBD83870a841cF7153F35b387746B6b6";
const TX = `0x${"79".repeat(32)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const created: LedgerEntryInput = {
  actor: "human",
  domain: "ap",
  action: "create_invoice",
  summary: "Added a bill",
  detail: { by: USER, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", invoiceNumber: "NS-1042" },
};
const paid: LedgerEntryInput = {
  actor: "human",
  domain: "ap",
  action: "approval_paid",
  summary: "Paid",
  detail: { by: USER, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, amountPaid: 12.5, currency: "USDC", txRef: TX, status: "paid" },
};
// The bill's entry was signed before the key's rotation; the payment after it.
const [CREATED] = buildChain([created], retired.privateKey, ledgerKeyId(retired.publicKey));
const SIGNED = buildChain([created, paid], active.privateKey, ledgerKeyId(active.publicKey));
const PAID: LedgerRow = SIGNED[1];
const SHARED = buildChain(
  [created, paid, { actor: "human", domain: "ap", action: "receipt_shared", summary: "Receipt: 12.5 USDC paid on Arc testnet", detail: { receipt: { txHash: TX }, records: { seq: 2, hash: PAID.hash } } }],
  active.privateKey,
  ledgerKeyId(active.publicKey)
)[2];
const REVOKED = buildChain(
  [created, paid, { actor: "human", domain: "ap", action: "x", summary: "x", detail: {} }, { actor: "human", domain: "ap", action: "receipt_revoked", summary: "A shared receipt's link was revoked", detail: { by: USER, receiptId: RECEIPT } }],
  active.privateKey,
  ledgerKeyId(active.publicKey)
)[3];
const org = (row: LedgerRow) => ({ ...row, org_id: ORG });

const INVOICE_ROW = { id: INVOICE, status: "paid", direction: "payable", amount: "12.500000" };
const INTENT = {
  status: "confirmed",
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
  receipt?: Record<string, unknown> | null;
  changes?: LedgerRow[];
}

function database(world: World = {}) {
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const one = (row: unknown) => ({ body: row ? [row] : [] });
    switch (request.path) {
      case "/rest/v1/invoices":
        return one(world.invoice === undefined ? INVOICE_ROW : world.invoice);
      case "/rest/v1/payment_intents":
        return one(INTENT);
      case "/rest/v1/rpc/ledger_entries_for_targets":
        return { body: [org(PAID), org(CREATED)] };
      case "/rest/v1/payment_receipts":
        return one(world.receipt === undefined ? { id: RECEIPT, entry_seq: SHARED.seq, created_at: "2026-01-01T00:04:00Z", revoked_at: null } : world.receipt);
      case "/rest/v1/ledger_entries":
        if (request.params.get("seq") === `eq.${SHARED.seq}`) return { body: [org(SHARED)] };
        if (request.params.get("detail->>receiptId") === `eq.${RECEIPT}`) return { body: (world.changes ?? []).map(org) };
        throw new Error(`unexpected ledger read ${request.params.toString()}`);
      default:
        throw new Error(`unexpected request ${request.method} ${request.path}`);
    }
  });
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

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

const WORKSPACE = { slug: "northstar-studio", name: "Northstar Studio" };
const read = (db: ReturnType<typeof database>, invoiceId = INVOICE) =>
  db.run(() => readReceiptDocument({ invoiceId, workspace: WORKSPACE, fetch: arcFetch as unknown as typeof fetch, rpcUrl: () => "https://rpc.test", now: new Date("2026-10-25T09:00:00Z") }));

beforeEach(() => {
  forgetMinedReceipts();
  arcFetch.mockClear();
});

describe("readReceiptDocument (evidence API EA4)", () => {
  it("reads the invoice, its payment, its entries and its receipt's, every request in the workspace's scope", async () => {
    const db = database();
    const doc = await read(db);
    expect(doc).not.toBeNull();
    const paths = db.fake.requests.map((request) => request.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/rest/v1/invoices", "/rest/v1/payment_intents", "/rest/v1/rpc/ledger_entries_for_targets", "/rest/v1/payment_receipts", "/rest/v1/ledger_entries"])
    );
    for (const request of db.fake.requests) expect(carriesOrg(request, ORG), `${request.method} ${request.path}`).toBe(true);
    const targets = db.fake.requests.find((request) => request.path === "/rest/v1/rpc/ledger_entries_for_targets");
    expect(targets?.body).toMatchObject({ p_invoice_ids: [INVOICE], p_milestone_ids: [] });
    const changes = db.fake.requests.find((request) => request.params.get("detail->>receiptId"));
    expect(changes?.params.get("action")).toBe("in.(receipt_link_renewed,receipt_revoked)");
  });

  it("checks each entry with the active and the retired key, and the transaction on its chain", async () => {
    const doc = (await read(database()))!;
    expect(doc.ready).toBe(true);
    expect(doc.entries.map((entry) => [entry.seq, entry.action, entry.check])).toEqual([
      [1, "create_invoice", { ok: true }],
      [2, "approval_paid", { ok: true }],
      [3, "receipt_shared", { ok: true }],
    ]);
    expect(doc.checks).toEqual({ recorded: { ok: true }, onChain: { state: "matches", block: 64, received: 12.5 } });
    expect(arcFetch).toHaveBeenCalledWith("https://rpc.test", expect.objectContaining({ method: "POST" }));
    expect(doc.keys.map((key) => [key.id, key.status])).toEqual([
      [ledgerKeyId(active.publicKey), "active"],
      [ledgerKeyId(retired.publicKey), "retired"],
    ]);
    expect(doc.records).toEqual({ seq: 2, hash: PAID.hash });
    expect(doc.invoiceEntry).toBe(1);
    expect(doc.shared).toEqual({ at: "2026-01-01T00:04:00Z", entry: 3, linkOpen: true, changes: [] });
    expect(doc.workspace).toEqual(WORKSPACE);
  });

  it("carries a revoked link's entry, and says the link no longer opens", async () => {
    const doc = (await read(database({ receipt: { id: RECEIPT, entry_seq: SHARED.seq, created_at: "2026-01-01T00:04:00Z", revoked_at: "2026-01-02T00:00:00Z" }, changes: [REVOKED] })))!;
    expect(doc.shared).toEqual({ at: "2026-01-01T00:04:00Z", entry: 3, linkOpen: false, changes: [{ action: "receipt_revoked", at: REVOKED.ts, entry: 4 }] });
    expect(doc.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("never asks for a receipt's link or who shared it", async () => {
    const db = database();
    const doc = await read(db);
    const select = db.fake.requests.find((request) => request.path === "/rest/v1/payment_receipts")?.params.get("select") ?? "";
    expect(select).toBe("id,entry_seq,created_at,revoked_at");
    expect(select).not.toContain("token_hash");
    // A link is `vxr_` and its secret; the stored hash is never selected, so neither can be in the answer.
    expect(JSON.stringify(doc)).not.toMatch(/vxr_|token_hash|tokenHash/);
  });

  it("is null for a receivable, an unknown id, or an id that is not a UUID, which is never asked for", async () => {
    expect(await read(database({ invoice: { ...INVOICE_ROW, direction: "receivable" } }))).toBeNull();
    expect(await read(database({ invoice: null }))).toBeNull();
    const db = database();
    expect(await read(db, "not-a-uuid")).toBeNull();
    expect(db.fake.requests).toEqual([]);
  });

  it("writes nothing: no row, no ledger entry", async () => {
    const db = database();
    await read(db);
    for (const request of db.fake.requests) {
      expect(request.method === "GET" || request.path === "/rest/v1/rpc/ledger_entries_for_targets", `${request.method} ${request.path}`).toBe(true);
    }
    expect(db.fake.requests.some((request) => request.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });
});
