import { describe, expect, it } from "vitest";
import { SIGNED_ENTRY_PROVES } from "@/lib/evidence-chain";
import { CHECK_AN_ENTRY, type EvidenceKey, type SignedEntry } from "@/lib/evidence-export";
import type { LedgerEntry } from "@/lib/ledger";
import { buildReceipt, intentFacts, RECEIPT_REFUSALS, receiptNotReady, type BuiltReceipt, type ReceiptIntent } from "@/lib/receipts/facts";
import { RECEIPT_FORMAT, receiptDocument } from "@/lib/receipts/document";

/**
 * A payable's receipt as a document (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA4): what a receipt states, the entry that recorded it, its sharing and its checks, with every entry it rests on.
 * Pure: the reader reads, checks and gates.
 */

const INVOICE = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51";
const PAYEE = "0x221B000000000000000000000000000000001bc3";
const TX = `0x${"79".repeat(32)}`;
const KEYS: EvidenceKey[] = [
  { id: "a1b2c3d4e5f60718", status: "active", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nactive\n-----END PUBLIC KEY-----\n" },
  { id: "0f1e2d3c4b5a6978", status: "retired", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nretired\n-----END PUBLIC KEY-----\n" },
];
const NOW = new Date("2026-10-25T09:00:00Z");

function signed(seq: number, action: string, detail: Record<string, unknown>, ts = `2026-10-0${Math.min(seq, 9)}T10:00:00.000Z`): SignedEntry {
  return {
    seq,
    id: `e${seq}`,
    ts,
    actor: "human",
    domain: "ap",
    action,
    summary: action,
    detail,
    body_hash: "b".repeat(64),
    signature: "s".repeat(128),
    prev_hash: "p".repeat(64),
    hash: `${String(seq).padStart(4, "0")}${"h".repeat(60)}`,
    signing_key_id: "a1b2c3d4e5f60718",
    check: { ok: true },
  };
}

const CREATED = signed(3, "create_invoice", { invoiceId: INVOICE, invoiceNumber: "NS-1042" });
const PAID = signed(5, "approval_paid", { invoiceId: INVOICE, txRef: TX, status: "paid" });
const SHARED = signed(7, "receipt_shared", { receipt: { txHash: TX }, records: { seq: 5, hash: PAID.hash } });
const RENEWED = signed(8, "receipt_link_renewed", { by: "u-1", receiptId: "r-1" });
const REVOKED = signed(9, "receipt_revoked", { by: "u-1", receiptId: "r-1" });

const INTENT: ReceiptIntent = {
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
  confirmed_at: "2026-10-05T10:00:30Z",
  network: "arc-testnet",
};

const asLedger = (entry: SignedEntry) => ({ ...entry, bodyHash: entry.body_hash, prevHash: entry.prev_hash, signingKeyId: entry.signing_key_id }) as unknown as LedgerEntry;
const built = (): BuiltReceipt => buildReceipt({ invoice: { id: INVOICE, status: "paid", direction: "payable", amount: "12.5" }, intent: INTENT, entries: [CREATED, PAID].map(asLedger) });

const base = {
  workspace: { slug: "northstar-studio", name: "Northstar Studio" },
  network: "arc-testnet" as const,
  invoiceId: INVOICE,
  keys: KEYS,
  now: NOW,
};

describe("a receipt's refusals, by name (evidence API EA4)", () => {
  it("maps each of the builder's sentences to its code", () => {
    for (const [code, reason] of Object.entries(RECEIPT_REFUSALS)) expect(receiptNotReady(reason)).toBe(code);
    expect(receiptNotReady("Something else entirely.")).toBe("not_recorded");
  });

  it("keeps the sentences the builder and the evidence chain always gave", () => {
    expect(RECEIPT_REFUSALS).toEqual({
      not_payable: "Only a payment the workspace made has a receipt.",
      not_paid: "This invoice is not paid yet.",
      simulated: "A simulated payment has nothing on chain to show.",
      not_minted: "The payee's chain has not minted this payout yet.",
      no_transaction: "This payment has no transaction on chain to show.",
      not_recorded: "No ledger entry records this payment's transaction.",
    });
    const refuse = (invoice: { status: string; direction: string }, intent: ReceiptIntent | null, entries: SignedEntry[] = [CREATED, PAID]) =>
      buildReceipt({ invoice: { id: INVOICE, ...invoice }, intent, entries: entries.map(asLedger) });
    expect(refuse({ status: "paid", direction: "receivable" }, INTENT)).toEqual({ ok: false, reason: "Only a payment the workspace made has a receipt." });
    expect(refuse({ status: "held", direction: "payable" }, INTENT)).toEqual({ ok: false, reason: "This invoice is not paid yet." });
    expect(refuse({ status: "paid", direction: "payable" }, { ...INTENT, provider_mode: "simulate" })).toEqual({ ok: false, reason: "A simulated payment has nothing on chain to show." });
    expect(refuse({ status: "paid", direction: "payable" }, { ...INTENT, destination_chain: "BASE-SEPOLIA" })).toEqual({ ok: false, reason: "The payee's chain has not minted this payout yet." });
    expect(refuse({ status: "paid", direction: "payable" }, { ...INTENT, tx_hash: "0x1234" })).toEqual({ ok: false, reason: "This payment has no transaction on chain to show." });
    expect(refuse({ status: "paid", direction: "payable" }, INTENT, [CREATED])).toEqual({ ok: false, reason: "No ledger entry records this payment's transaction." });
    expect(intentFacts({ ...INTENT, status: "pending" })).toEqual({ ok: false, reason: "This invoice is not paid yet." });
  });
});

describe("receiptDocument", () => {
  it("states a ready receipt: its facts, the recording entry, the bill's entry, its sharing and its checks", () => {
    const receipt = built();
    expect(receipt.ok).toBe(true);
    const checks = { recorded: { ok: true as const }, onChain: { state: "matches" as const, block: 64, received: 12.5 } };
    const doc = receiptDocument({
      ...base,
      built: receipt,
      receipt: { created_at: "2026-10-07T10:00:05Z", entry_seq: 7, revoked_at: null },
      entries: [SHARED, PAID, CREATED, RENEWED],
      checks,
    });
    expect(doc.format).toBe(RECEIPT_FORMAT);
    expect(RECEIPT_FORMAT).toBe("vestiarion-receipt/1");
    expect(doc.exportedAt).toBe(NOW.toISOString());
    expect(doc.workspace).toEqual(base.workspace);
    expect(doc.network).toEqual({ id: "arc-testnet", label: "Arc testnet" });
    expect(doc.invoiceId).toBe(INVOICE);
    expect(doc.ready).toBe(true);
    expect(doc.notReady).toBeNull();
    expect(doc.facts).toEqual(receipt.ok ? receipt.facts : null);
    expect(doc.facts).toMatchObject({ amount: 12.5, token: "USDC", payee: PAYEE, txHash: TX, invoiceNumber: "NS-1042", feesPaidBy: "sender" });
    expect(doc.records).toEqual({ seq: 5, hash: PAID.hash });
    expect(doc.invoiceEntry).toBe(3);
    expect(doc.shared).toEqual({
      at: "2026-10-07T10:00:05Z",
      entry: 7,
      linkOpen: true,
      changes: [{ action: "receipt_link_renewed", at: RENEWED.ts, entry: 8 }],
    });
    expect(doc.checks).toEqual(checks);
    expect(doc.signedEntryProves).toBe(SIGNED_ENTRY_PROVES);
    expect(Array.isArray(doc.checkAnEntry)).toBe(true);
    expect(doc.checkAnEntry).toEqual([...CHECK_AN_ENTRY]);
    expect(doc.keys).toEqual(KEYS);
    // Oldest first, each once.
    expect(doc.entries.map((entry) => entry.seq)).toEqual([3, 5, 7, 8]);
    expect(doc.entries[1]).toEqual(PAID);
  });

  it("says a revoked link no longer opens, with its revoking entry among the changes", () => {
    const doc = receiptDocument({
      ...base,
      built: built(),
      receipt: { created_at: "2026-10-07T10:00:05Z", entry_seq: 7, revoked_at: "2026-10-09T10:00:00Z" },
      entries: [CREATED, PAID, SHARED, RENEWED, REVOKED],
      checks: { recorded: { ok: true }, onChain: { state: "unreadable" } },
    });
    expect(doc.shared).toEqual({
      at: "2026-10-07T10:00:05Z",
      entry: 7,
      linkOpen: false,
      changes: [
        { action: "receipt_link_renewed", at: RENEWED.ts, entry: 8 },
        { action: "receipt_revoked", at: REVOKED.ts, entry: 9 },
      ],
    });
  });

  it("says a receipt nobody shared is not shared", () => {
    const doc = receiptDocument({ ...base, built: built(), receipt: null, entries: [CREATED, PAID], checks: { recorded: { ok: true }, onChain: { state: "unreadable" } } });
    expect(doc.shared).toBeNull();
    expect(doc.entries.map((entry) => entry.seq)).toEqual([3, 5]);
  });

  it("names why a receipt is not ready, and states nothing else", () => {
    const doc = receiptDocument({
      ...base,
      built: { ok: false, reason: "A simulated payment has nothing on chain to show." },
      receipt: null,
      entries: [CREATED],
      checks: null,
    });
    expect(doc.ready).toBe(false);
    expect(doc.notReady).toEqual({ code: "simulated", reason: "A simulated payment has nothing on chain to show." });
    expect(doc.facts).toBeNull();
    expect(doc.records).toBeNull();
    expect(doc.checks).toBeNull();
    expect(doc.invoiceEntry).toBe(3);
    expect(doc.entries.map((entry) => entry.seq)).toEqual([3]);
  });

  it("finds the bill's entry whether it was typed in, imported or made by a recurring bill", () => {
    for (const action of ["create_invoice", "import_invoice", "recurring_invoice_created"]) {
      const doc = receiptDocument({ ...base, built: { ok: false, reason: "This invoice is not paid yet." }, receipt: null, entries: [signed(4, action, { invoiceId: INVOICE })], checks: null });
      expect(doc.invoiceEntry, action).toBe(4);
    }
    const other = receiptDocument({ ...base, built: { ok: false, reason: "This invoice is not paid yet." }, receipt: null, entries: [signed(4, "create_invoice", { invoiceId: "another" })], checks: null });
    expect(other.invoiceEntry).toBeNull();
  });

  it("survives a JSON round trip unchanged", () => {
    const doc = receiptDocument({
      ...base,
      built: built(),
      receipt: { created_at: "2026-10-07T10:00:05Z", entry_seq: 7, revoked_at: null },
      entries: [CREATED, PAID, SHARED],
      checks: { recorded: { ok: false, reason: "The entry this receipt names does not record its transaction." }, onChain: { state: "mismatch", reason: "No transfer." } },
    });
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
