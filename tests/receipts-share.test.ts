import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { ledgerKeyId } from "@/lib/ledger-keys";
import type { LedgerEntry } from "@/lib/ledger";
import { ReceiptError, sharedReceipts, shareReceipt, stopSharingReceipt } from "@/lib/receipts/share";
import { receiptTokenHash } from "@/lib/receipts/token";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Sharing a payment's receipt (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P2, P3): the
 * first share states the facts in a signed entry and stores the receipt with its link; a later share only
 * replaces the link; stopping revokes it. Over a recorded database, with the ledger's writes stood in for.
 */

const { appendLedgerEntry, appendBestEffort, entriesFor } = vi.hoisted(() => ({
  appendLedgerEntry: vi.fn(),
  appendBestEffort: vi.fn(async () => undefined),
  entriesFor: vi.fn(),
}));
const { publicKey } = crypto.generateKeyPairSync("ed25519");
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  appendLedgerEntry,
  listLedgerEntriesForTargets: entriesFor,
  ledgerVerificationKeyring: () => ({ active: publicKey, retired: [] }),
}));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendBestEffort }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001aa";
const PAYEE = "0x221B000000000000000000000000000000001bc3";
const MINT = `0x${"3".repeat(64)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const INTENT = {
  status: "confirmed", provider_mode: "live", token: "USDC", amount: "2.000000", destination: PAYEE, tx_hash: MINT, chain: "ARB-SEPOLIA",
  destination_chain: "ARB-SEPOLIA", mint_tx_hash: MINT, bridge_fee: "0.107811", payout_route: "gateway", confirmed_at: "2026-10-01T08:28:26.857Z",
};
const DECISION = {
  seq: 580, id: "e580", ts: "2026-10-01T08:28:28Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY invoice from STM for 2 USDC",
  detail: { invoiceId: INVOICE, counterpartyName: "STM", execution: { txRef: MINT, mintTxHash: MINT } },
  bodyHash: "b".repeat(64), signature: "s", prevHash: "p".repeat(64), hash: "h".repeat(64), signingKeyId: "k",
} as unknown as LedgerEntry;

function database(start: { receipt?: { id: string; revoked_at: string | null } | null; invoice?: Record<string, unknown>; insertError?: string } = {}) {
  let receipt = start.receipt ?? null;
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    const none: FakeReply = { status: 406, body: { code: "PGRST116", message: "no rows" } };
    if (request.path === "/rest/v1/invoices") {
      const invoice = start.invoice === undefined ? { id: INVOICE, status: "paid", direction: "payable" } : start.invoice;
      return wantsObject ? (invoice ? { body: invoice } : none) : { body: invoice ? [invoice] : [] };
    }
    if (request.path === "/rest/v1/payment_intents") return { body: [INTENT] };
    if (request.path === "/rest/v1/payment_receipts") {
      if (request.method === "GET") {
        if (request.params.get("invoice_id")?.startsWith("in.")) return { body: receipt && !receipt.revoked_at ? [{ invoice_id: INVOICE }] : [] };
        return wantsObject ? (receipt ? { body: receipt } : none) : { body: receipt ? [receipt] : [] };
      }
      if (request.method === "POST") {
        if (start.insertError) return { status: 409, body: { code: "23505", message: start.insertError } };
        receipt = { id: "rcpt-1", revoked_at: null };
        return { body: wantsObject ? { id: "rcpt-1" } : [{ id: "rcpt-1" }] };
      }
      if (request.method === "PATCH") {
        receipt = { ...(receipt as { id: string; revoked_at: string | null }), ...(request.body as { revoked_at?: string | null }) };
        return { body: [] };
      }
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run, receipt: () => receipt };
}

const writes = (requests: RecordedRequest[], method: string) => requests.filter((r) => r.path === "/rest/v1/payment_receipts" && r.method === method);

beforeEach(() => {
  appendLedgerEntry.mockReset();
  appendLedgerEntry.mockResolvedValue({ seq: 612 });
  appendBestEffort.mockClear();
  entriesFor.mockReset();
  entriesFor.mockResolvedValue([DECISION]);
});

describe("sharing a receipt the first time", () => {
  it("states the payment's facts in a signed entry with no names, then stores the receipt, its keys and its link's hash", async () => {
    const db = database();
    const shared = await db.run(() => shareReceipt({ actorId: USER, invoiceId: INVOICE }));

    expect(shared).toMatchObject({ receiptId: "rcpt-1", renewed: false });
    expect(shared.token).toMatch(/^vxr_[A-Za-z0-9_-]{43}$/);
    expect(appendLedgerEntry).toHaveBeenCalledWith({
      actor: "human",
      domain: "ap",
      action: "receipt_shared",
      summary: "Receipt: 2 USDC paid on Arbitrum Sepolia",
      detail: {
        receipt: { amount: 2, token: "USDC", paidAt: "2026-10-01T08:28:26.857Z", payee: PAYEE, chain: "ARB-SEPOLIA", txHash: MINT, route: "gateway", feeUsdc: 0.107811 },
        records: { seq: 580, hash: "h".repeat(64) },
      },
    });
    const stated = JSON.stringify(appendLedgerEntry.mock.calls[0][0]);
    expect(stated).not.toContain("STM");
    expect(stated).not.toContain(USER);
    expect(stated).not.toContain(INVOICE);

    const [insert] = writes(db.fake.requests, "POST");
    expect(insert.body).toMatchObject({
      org_id: ORG,
      invoice_id: INVOICE,
      entry_seq: 612,
      token_hash: receiptTokenHash(shared.token),
      created_by: USER,
      public_keys: { [ledgerKeyId(publicKey)]: publicKey.export({ type: "spki", format: "pem" }).toString() },
    });
    expect(JSON.stringify(insert.body)).not.toContain(shared.token.slice(4));
  });

  it("refuses a payment that cannot be shared, with the reason, and writes nothing", async () => {
    const db = database({ invoice: { id: INVOICE, status: "matched", direction: "payable" } });
    await expect(db.run(() => shareReceipt({ actorId: USER, invoiceId: INVOICE }))).rejects.toEqual(new ReceiptError("This invoice is not paid yet."));
    expect(appendLedgerEntry).not.toHaveBeenCalled();
    expect(writes(db.fake.requests, "POST")).toEqual([]);
  });

  it("refuses an invoice outside the workspace", async () => {
    const db = database({ invoice: null as unknown as Record<string, unknown> });
    await expect(db.run(() => shareReceipt({ actorId: USER, invoiceId: INVOICE }))).rejects.toEqual(new ReceiptError("That invoice is not in this workspace."));
  });

  it("leaves the other person's receipt standing when two share at once", async () => {
    const db = database({ insertError: 'duplicate key value violates unique constraint "payment_receipts_invoice_key"' });
    await expect(db.run(() => shareReceipt({ actorId: USER, invoiceId: INVOICE }))).rejects.toEqual(new ReceiptError("Someone shared this receipt a moment ago. Reload the page."));
  });
});

describe("sharing it again", () => {
  it("replaces only the link: no second statement, the old link stops working, and the change is recorded", async () => {
    const db = database({ receipt: { id: "rcpt-1", revoked_at: "2026-10-01T09:00:00Z" } });
    const shared = await db.run(() => shareReceipt({ actorId: USER, invoiceId: INVOICE }));
    expect(shared).toMatchObject({ receiptId: "rcpt-1", renewed: true });
    expect(appendLedgerEntry).not.toHaveBeenCalled();
    const [update] = writes(db.fake.requests, "PATCH");
    expect(update.body).toMatchObject({ token_hash: receiptTokenHash(shared.token), revoked_at: null });
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "receipt_link_renewed", detail: { by: USER, invoiceId: INVOICE, receiptId: "rcpt-1" } }));
  });
});

describe("stopping sharing", () => {
  it("revokes the link and records it", async () => {
    const db = database({ receipt: { id: "rcpt-1", revoked_at: null } });
    await db.run(() => stopSharingReceipt({ actorId: USER, invoiceId: INVOICE }));
    expect(writes(db.fake.requests, "PATCH")[0].body).toHaveProperty("revoked_at");
    expect(db.receipt()?.revoked_at).not.toBeNull();
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "receipt_revoked", detail: { by: USER, invoiceId: INVOICE, receiptId: "rcpt-1" } }));
  });

  it("says a receipt that is not shared is not shared", async () => {
    await expect(database().run(() => stopSharingReceipt({ actorId: USER, invoiceId: INVOICE }))).rejects.toEqual(new ReceiptError("This receipt is not shared."));
    await expect(
      database({ receipt: { id: "rcpt-1", revoked_at: "2026-10-01T09:00:00Z" } }).run(() => stopSharingReceipt({ actorId: USER, invoiceId: INVOICE }))
    ).rejects.toEqual(new ReceiptError("This receipt is not shared."));
  });
});

describe("sharedReceipts", () => {
  it("names the invoices whose receipt link is live", async () => {
    expect(await database({ receipt: { id: "rcpt-1", revoked_at: null } }).run(() => sharedReceipts([INVOICE]))).toEqual(new Set([INVOICE]));
    expect(await database().run(() => sharedReceipts([]))).toEqual(new Set());
  });
});
