import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntryInput, LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import type { FakeReply, RecordedRequest } from "./support/fake-supabase";
import { API_ORG, apiWorld, callRoute, readKey, WORKSPACE, writesIn } from "./support/evidence-api";

/**
 * A payable's receipt through the API (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA4): what a receipt states, the entry that recorded it, its sharing and its two checks; not ready, a code and the
 * builder's sentence; never the link, its token or its hash.
 */

const active = crypto.generateKeyPairSync("ed25519");
const { onChainMock } = vi.hoisted(() => ({ onChainMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/api-keys")>()),
  authenticateApiKey: vi.fn(),
  touchApiKeyUsed: vi.fn(async () => {}),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: active.publicKey, retired: [] }),
}));
vi.mock("@/lib/receipts/onchain", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/receipts/onchain")>()), readOnChain: onChainMock }));

import { GET } from "@/app/api/v1/invoices/[id]/receipt/route";
import { authenticateApiKey } from "@/lib/platform/api-keys";
import { buildReceipt, type ReceiptIntent } from "@/lib/receipts/facts";

const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003d1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001d1";
const RECEIPT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000004d1";
const PAYEE = "0x221B000000000000000000000000000000001bc3";
const TX = `0x${"79".repeat(32)}`;

const INPUTS: LedgerEntryInput[] = [
  { actor: "human", domain: "ap", action: "create_invoice", summary: "Added a bill", detail: { by: USER, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", invoiceNumber: "HP-1" } },
  { actor: "human", domain: "ap", action: "approval_paid", summary: "Paid", detail: { by: USER, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, amountPaid: 12.5, currency: "USDC", txRef: TX, status: "paid" } },
  { actor: "human", domain: "ap", action: "receipt_shared", summary: "Receipt: 12.5 USDC", detail: { receipt: { txHash: TX }, records: { seq: 2 } } },
  { actor: "human", domain: "ap", action: "receipt_link_renewed", summary: "Renewed", detail: { by: USER, receiptId: RECEIPT } },
  { actor: "human", domain: "ap", action: "receipt_revoked", summary: "Revoked", detail: { by: USER, receiptId: RECEIPT } },
];
const ROWS = buildChain(INPUTS, active.privateKey, ledgerKeyId(active.publicKey)).map((row) => ({ ...row, org_id: API_ORG }));
const [CREATED, PAID, SHARED, RENEWED, REVOKED] = ROWS;

const INVOICE_ROW = { id: INVOICE, org_id: API_ORG, status: "paid", direction: "payable", amount: "12.500000" };
const INTENT: ReceiptIntent = {
  status: "confirmed", provider_mode: "live", token: "USDC", amount: "12.500000", destination: PAYEE, tx_hash: TX, chain: "ARC-TESTNET",
  destination_chain: null, mint_tx_hash: null, bridge_fee: null, payout_route: null, confirmed_at: "2026-01-01T00:03:30Z", network: "arc-testnet",
};
const SHARED_ROW = { id: RECEIPT, entry_seq: SHARED.seq, created_at: "2026-01-01T00:04:00Z", revoked_at: null };

interface World {
  invoice?: Record<string, unknown> | null;
  intent?: Record<string, unknown> | null;
  own?: LedgerRow[];
  receipt?: Record<string, unknown> | null;
  changes?: LedgerRow[];
}

function workspace(world: World = {}) {
  return apiWorld((request: RecordedRequest): FakeReply => {
    const list = (row: unknown) => ({ body: row ? [row] : [] });
    switch (request.path) {
      case "/rest/v1/invoices":
        return list(world.invoice === undefined ? INVOICE_ROW : world.invoice);
      case "/rest/v1/payment_intents":
        return list(world.intent === undefined ? INTENT : world.intent);
      case "/rest/v1/rpc/ledger_entries_for_targets":
        return { body: world.own ?? [PAID, CREATED] };
      case "/rest/v1/payment_receipts":
        return list(world.receipt === undefined ? SHARED_ROW : world.receipt);
      case "/rest/v1/ledger_entries":
        if (request.params.get("seq") === `eq.${SHARED.seq}`) return { body: [SHARED] };
        if (request.params.get("detail->>receiptId") === `eq.${RECEIPT}`) return { body: world.changes ?? [] };
        throw new Error(`unexpected ledger read ${request.params.toString()}`);
      default:
        throw new Error(`unexpected request ${request.method} ${request.path}`);
    }
  });
}

const receipt = (world: ReturnType<typeof workspace>, id = INVOICE) => callRoute(world, GET, `/api/v1/invoices/${id}/receipt`, { id });
type Answer = { data: Record<string, unknown> & { entries: Array<{ seq: number; action: string; check: unknown }> } };

beforeEach(() => {
  const key = readKey();
  vi.mocked(authenticateApiKey).mockReset();
  vi.mocked(authenticateApiKey).mockImplementation(async () => key);
  onChainMock.mockReset();
  onChainMock.mockResolvedValue({ state: "matches", block: 64, received: 12.5 });
});

describe("GET /api/v1/invoices/{id}/receipt (evidence API EA4)", () => {
  it("states a paid, shared receipt: its facts, records, the bill's entry, its sharing, its checks and its entries", async () => {
    const response = await receipt(workspace());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = (await response.json()) as Answer;
    const built = buildReceipt({
      invoice: INVOICE_ROW,
      intent: INTENT,
      entries: [CREATED, PAID].map((row) => ({ ...row, bodyHash: row.body_hash, prevHash: row.prev_hash, signingKeyId: row.signing_key_id ?? null })),
    });
    if (!built.ok) throw new Error(built.reason);
    expect(data).toMatchObject({
      format: "vestiarion-receipt/1",
      workspace: WORKSPACE,
      network: { id: "arc-testnet", label: "Arc testnet" },
      invoiceId: INVOICE,
      ready: true,
      notReady: null,
      facts: JSON.parse(JSON.stringify(built.facts)),
      records: { seq: PAID.seq, hash: PAID.hash },
      invoiceEntry: CREATED.seq,
      shared: { at: "2026-01-01T00:04:00Z", entry: SHARED.seq, linkOpen: true, changes: [] },
      checks: { recorded: { ok: true }, onChain: { state: "matches", block: 64, received: 12.5 } },
    });
    expect(data.entries.map((entry) => [entry.action, entry.check])).toEqual([
      ["create_invoice", { ok: true }],
      ["approval_paid", { ok: true }],
      ["receipt_shared", { ok: true }],
    ]);
    expect(onChainMock).toHaveBeenCalledTimes(1);
  });

  it("says a revoked link no longer opens, with its renewal and its revocation among the changes and the entries", async () => {
    const response = await receipt(workspace({ receipt: { ...SHARED_ROW, revoked_at: "2026-01-02T00:00:00Z" }, changes: [RENEWED, REVOKED] }));
    const { data } = (await response.json()) as Answer;
    expect(data.shared).toEqual({
      at: "2026-01-01T00:04:00Z",
      entry: SHARED.seq,
      linkOpen: false,
      changes: [
        { action: "receipt_link_renewed", at: RENEWED.ts, entry: RENEWED.seq },
        { action: "receipt_revoked", at: REVOKED.ts, entry: REVOKED.seq },
      ],
    });
    expect(data.entries.map((entry) => entry.action)).toEqual(["create_invoice", "approval_paid", "receipt_shared", "receipt_link_renewed", "receipt_revoked"]);
    // A revoked receipt still states its facts.
    expect(data.ready).toBe(true);
  });

  it("says a receipt nobody shared is not shared", async () => {
    const { data } = (await (await receipt(workspace({ receipt: null }))).json()) as Answer;
    expect(data.shared).toBeNull();
    expect(data.ready).toBe(true);
  });

  it.each([
    ["not_paid", "This invoice is not paid yet.", { invoice: { ...INVOICE_ROW, status: "held" } }],
    ["simulated", "A simulated payment has nothing on chain to show.", { intent: { ...INTENT, provider_mode: "simulate" } }],
    ["not_minted", "The payee's chain has not minted this payout yet.", { intent: { ...INTENT, destination_chain: "BASE-SEPOLIA" } }],
    ["no_transaction", "This payment has no transaction on chain to show.", { intent: { ...INTENT, tx_hash: "0x1234" } }],
    ["not_recorded", "No ledger entry records this payment's transaction.", { own: [CREATED] }],
  ] as Array<[string, string, World]>)("answers %s, not ready, with the builder's sentence and nothing it would state", async (code, reason, world) => {
    const response = await receipt(workspace({ receipt: null, ...world }));
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as Answer;
    expect(data).toMatchObject({ ready: false, notReady: { code, reason }, facts: null, records: null, checks: null });
    expect(onChainMock).not.toHaveBeenCalled();
  });

  it("never asks for a receipt's token hash or who shared it, and answers no link", async () => {
    const world = workspace();
    const text = await (await receipt(world)).text();
    const select = world.requests.find((request) => request.path === "/rest/v1/payment_receipts")?.params.get("select") ?? "";
    expect(select).toBe("id,entry_seq,created_at,revoked_at");
    expect(text).not.toMatch(/vxr_|token_hash|tokenHash|created_by/);
  });

  it("answers a receivable, an unknown id and one that is not a UUID with a 404", async () => {
    for (const world of [workspace({ invoice: { ...INVOICE_ROW, direction: "receivable" } }), workspace({ invoice: null })]) {
      const response = await receipt(world);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: `Payable invoice "${INVOICE}" was not found.` } });
    }
    const world = workspace();
    expect((await receipt(world, "r-1")).status).toBe(404);
    expect(world.requests).toEqual([]);
  });

  it("writes nothing", async () => {
    const world = workspace();
    await receipt(world);
    expect(writesIn(world.requests)).toEqual([]);
  });
});
