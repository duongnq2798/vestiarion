import { describe, expect, it } from "vitest";
import { buildReceipt, receiptSummary, type ReceiptIntent } from "@/lib/receipts/facts";
import { generateReceiptToken, receiptTokenHash } from "@/lib/receipts/token";
import type { LedgerEntry } from "@/lib/ledger";

/**
 * What a shared receipt states (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P1, P2): the
 * public facts of a live payment on the payee's chain, and the entry that recorded it.
 */

const PAYEE = "0x221B000000000000000000000000000000001bc3";
const tx = (n: number) => `0x${String(n).repeat(64).slice(0, 64)}`;
const INVOICE = { id: "inv-1", status: "paid", direction: "payable" };

function intent(overrides: Partial<ReceiptIntent> = {}): ReceiptIntent {
  return {
    status: "confirmed",
    provider_mode: "live",
    token: "USDC",
    amount: "2.000000",
    destination: PAYEE,
    tx_hash: tx(1),
    chain: "ARC-TESTNET",
    destination_chain: null,
    mint_tx_hash: null,
    bridge_fee: null,
    payout_route: null,
    confirmed_at: "2026-10-01T08:28:26.857Z",
    ...overrides,
  };
}

function entry(seq: number, action: string, detail: Record<string, unknown>): LedgerEntry {
  return {
    seq, id: `e${seq}`, ts: "2026-10-01T08:28:28.000Z", actor: "agent", domain: "ap", action, summary: "", detail,
    bodyHash: "b".repeat(64), signature: "s", prevHash: "p".repeat(64), hash: `${seq}`.padStart(64, "h"), signingKeyId: "k1",
  };
}

describe("buildReceipt", () => {
  it("states a direct payment on Arc testnet, and the entry that recorded its transaction", () => {
    const built = buildReceipt({
      invoice: INVOICE,
      intent: intent(),
      entries: [entry(570, "create_invoice", { invoiceId: "inv-1" }), entry(580, "ap_pay", { invoiceId: "inv-1", execution: { txRef: tx(1) } })],
    });
    expect(built).toEqual({
      ok: true,
      facts: { amount: 2, token: "USDC", paidAt: "2026-10-01T08:28:26.857Z", payee: PAYEE, chain: "ARC-TESTNET", txHash: tx(1), route: "direct" },
      records: { seq: 580, hash: "580".padStart(64, "h") },
    });
  });

  it("states a payment in EURC in EURC", () => {
    const built = buildReceipt({ invoice: INVOICE, intent: intent({ token: "EURC", amount: "1.900000" }), entries: [entry(587, "approval_paid", { invoiceId: "inv-1", txRef: tx(1) })] });
    expect(built).toMatchObject({ ok: true, facts: { amount: 1.9, token: "EURC", route: "direct" } });
  });

  it("states a CCTP payout by its mint on the payee's chain, with the burn and the fee", () => {
    const built = buildReceipt({
      invoice: INVOICE,
      intent: intent({ destination_chain: "BASE-SEPOLIA", mint_tx_hash: tx(2), bridge_fee: "0.054604", payout_route: "cctp" }),
      entries: [entry(590, "ap_reconcile", { invoiceId: "inv-1", execution: { mintTxHash: tx(2) } }), entry(588, "approval_paid", { invoiceId: "inv-1", txRef: tx(1) })],
    });
    expect(built).toEqual({
      ok: true,
      facts: { amount: 2, token: "USDC", paidAt: "2026-10-01T08:28:26.857Z", payee: PAYEE, chain: "BASE-SEPOLIA", txHash: tx(2), route: "cctp", sourceTxHash: tx(1), feeUsdc: 0.054604 },
      records: { seq: 590, hash: "590".padStart(64, "h") },
    });
  });

  it("refuses a CCTP payout the payee's chain has not minted yet: the burn is not the payee's payment", () => {
    const built = buildReceipt({ invoice: INVOICE, intent: intent({ destination_chain: "BASE-SEPOLIA", payout_route: "cctp" }), entries: [entry(588, "approval_paid", { invoiceId: "inv-1", txRef: tx(1) })] });
    expect(built).toEqual({ ok: false, reason: "The payee's chain has not minted this payout yet." });
  });

  it("states a Gateway payout by its mint, with Gateway's fee", () => {
    const built = buildReceipt({
      invoice: INVOICE,
      intent: intent({ tx_hash: tx(3), chain: "ARB-SEPOLIA", destination_chain: "ARB-SEPOLIA", mint_tx_hash: tx(3), bridge_fee: "0.107811", payout_route: "gateway" }),
      entries: [entry(580, "ap_pay", { invoiceId: "inv-1", execution: { txRef: tx(3), mintTxHash: tx(3) } })],
    });
    expect(built).toMatchObject({ ok: true, facts: { chain: "ARB-SEPOLIA", txHash: tx(3), route: "gateway", feeUsdc: 0.107811 }, records: { seq: 580 } });
    expect(built.ok && built.facts).not.toHaveProperty("sourceTxHash");
  });

  it("names the entry that recorded the payee's transaction before one that recorded only the burn", () => {
    const built = buildReceipt({
      invoice: INVOICE,
      intent: intent({ destination_chain: "BASE-SEPOLIA", mint_tx_hash: tx(2), payout_route: "cctp" }),
      entries: [entry(595, "ap_reconcile", { invoiceId: "inv-1", note: "nothing about it" }), entry(590, "ap_pay", { invoiceId: "inv-1", execution: { txRef: tx(1) } }), entry(592, "ap_reconcile", { invoiceId: "inv-1", execution: { mintTxHash: tx(2).toUpperCase().replace("0X", "0x") } })],
    });
    expect(built).toMatchObject({ ok: true, records: { seq: 592 } });
    const burnOnly = buildReceipt({ invoice: INVOICE, intent: intent({ destination_chain: "BASE-SEPOLIA", mint_tx_hash: tx(2), payout_route: "cctp" }), entries: [entry(590, "ap_pay", { invoiceId: "inv-1", execution: { txRef: tx(1) } })] });
    expect(burnOnly).toMatchObject({ ok: true, records: { seq: 590 } });
  });

  it.each([
    ["a receivable", { invoice: { ...INVOICE, direction: "receivable" } }, "Only a payment the workspace made has a receipt."],
    ["an unpaid invoice", { invoice: { ...INVOICE, status: "matched" } }, "This invoice is not paid yet."],
    ["no payment", { intent: null }, "This invoice is not paid yet."],
    ["a payment not confirmed", { intent: intent({ status: "pending" }) }, "This invoice is not paid yet."],
    ["a simulated payment", { intent: intent({ provider_mode: "simulate", tx_hash: "sim_1" }) }, "A simulated payment has nothing on chain to show."],
    ["a payment with no transaction", { intent: intent({ tx_hash: null }) }, "This payment has no transaction on chain to show."],
    ["no entry recording it", { entries: [entry(570, "create_invoice", { invoiceId: "inv-1" })] }, "No ledger entry records this payment's transaction."],
  ] as Array<[string, Partial<Parameters<typeof buildReceipt>[0]>, string]>)("refuses %s", (_what, change, reason) => {
    const built = buildReceipt({ invoice: INVOICE, intent: intent(), entries: [entry(580, "ap_pay", { invoiceId: "inv-1", execution: { txRef: tx(1) } })], ...change });
    expect(built).toEqual({ ok: false, reason });
  });

  it("is summarised with no names", () => {
    expect(receiptSummary({ amount: 2, token: "USDC", paidAt: "", payee: PAYEE, chain: "ARB-SEPOLIA", txHash: tx(3), route: "gateway" })).toBe("Receipt: 2 USDC paid on Arbitrum Sepolia");
  });
});

describe("receipt links", () => {
  it("are vxr_ and 43 base64url characters, stored as the SHA-256 of the secret", () => {
    const { token, secretHash } = generateReceiptToken((n) => Buffer.alloc(n, 7));
    expect(token).toMatch(/^vxr_[A-Za-z0-9_-]{43}$/);
    expect(receiptTokenHash(token)).toBe(secretHash);
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never looks up a malformed token", () => {
    expect(receiptTokenHash("vxp_" + "a".repeat(43))).toBeNull();
    expect(receiptTokenHash("vxr_short")).toBeNull();
    expect(receiptTokenHash("")).toBeNull();
  });
});
