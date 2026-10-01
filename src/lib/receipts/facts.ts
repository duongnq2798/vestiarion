import type { LedgerEntry } from "../ledger";
import { payeeChain } from "../payee-chains";

/**
 * What a shared receipt states (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P1, P2):
 * the public facts of a live payment on the payee's chain, read from its payment intent, and the ledger
 * entry that recorded it. No names, no reasoning, no ids of people: the whole statement is meant to be
 * shown to anyone the workspace gives the link to.
 */

export type ReceiptRoute = "direct" | "cctp" | "gateway";

export interface ReceiptFacts {
  amount: number;
  token: "USDC" | "EURC";
  /** When the payment was confirmed. */
  paidAt: string;
  /** The address paid. */
  payee: string;
  /** The chain the payee was paid on. */
  chain: string;
  /** The transaction that paid the payee: the transfer on Arc testnet, or the mint on the payee's chain. */
  txHash: string;
  route: ReceiptRoute;
  /** CCTP only: the burn on Arc testnet. */
  sourceTxHash?: string;
  /** CCTP and Gateway: the route's fee, in USDC. */
  feeUsdc?: number;
}

/** The payment intent's columns a receipt is built from. */
export interface ReceiptIntent {
  status: string;
  provider_mode: string;
  token: string | null;
  amount: string | number;
  destination: string;
  tx_hash: string | null;
  chain: string | null;
  destination_chain: string | null;
  mint_tx_hash: string | null;
  bridge_fee: string | number | null;
  payout_route: string | null;
  confirmed_at: string | null;
}

export type BuiltReceipt = { ok: true; facts: ReceiptFacts; records: { seq: number; hash: string } } | { ok: false; reason: string };

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The entries that record a payment's transaction: the agent's decision, a person's approval, a later reconcile. */
export const RECORDING_ACTIONS: ReadonlySet<string> = new Set(["ap_pay", "approval_paid", "ap_reconcile"]);

const refuse = (reason: string): BuiltReceipt => ({ ok: false, reason });

export function buildReceipt(input: {
  invoice: { id: string; status: string; direction: string };
  intent: ReceiptIntent | null;
  entries: LedgerEntry[];
}): BuiltReceipt {
  const { invoice, intent } = input;
  if (invoice.direction !== "payable") return refuse("Only a payment the workspace made has a receipt.");
  if (invoice.status !== "paid" || !intent || intent.status !== "confirmed") return refuse("This invoice is not paid yet.");
  if (intent.provider_mode !== "live") return refuse("A simulated payment has nothing on chain to show.");

  const crossChain = intent.destination_chain !== null && intent.destination_chain !== "ARC-TESTNET";
  const route: ReceiptRoute = intent.payout_route === "gateway" ? "gateway" : crossChain ? "cctp" : "direct";
  // The payee is paid by the mint on their chain, once there is one; a CCTP burn alone is not their payment (R4).
  if (route === "cctp" && !intent.mint_tx_hash) return refuse("The payee's chain has not minted this payout yet.");
  const txHash = route === "direct" ? intent.tx_hash : (intent.mint_tx_hash ?? intent.tx_hash);
  const sourceTxHash = route === "cctp" ? intent.tx_hash : null;
  if (!txHash || !TX_HASH.test(txHash) || (sourceTxHash !== null && !TX_HASH.test(sourceTxHash)) || !ADDRESS.test(intent.destination)) {
    return refuse("This payment has no transaction on chain to show.");
  }

  const records = recordingEntry(invoice.id, input.entries, txHash, sourceTxHash);
  if (!records) return refuse("No ledger entry records this payment's transaction.");

  const fee = intent.bridge_fee == null ? null : Number(intent.bridge_fee);
  const facts: ReceiptFacts = {
    amount: Number(intent.amount),
    token: intent.token === "EURC" ? "EURC" : "USDC",
    paidAt: intent.confirmed_at ?? "",
    payee: intent.destination,
    chain: route === "direct" ? (intent.chain ?? "ARC-TESTNET") : (intent.destination_chain as string),
    txHash,
    route,
    ...(sourceTxHash ? { sourceTxHash } : {}),
    ...(route !== "direct" && fee !== null && Number.isFinite(fee) ? { feeUsdc: fee } : {}),
  };
  return { ok: true, facts, records: { seq: records.seq, hash: records.hash } };
}

/**
 * The newest of the invoice's recording entries whose detail contains the payee's transaction; failing
 * that, the newest that contains the CCTP burn. Hashes are compared without regard to case.
 */
function recordingEntry(invoiceId: string, entries: LedgerEntry[], txHash: string, sourceTxHash: string | null): LedgerEntry | null {
  const recording = entries
    .filter((entry) => entry.detail.invoiceId === invoiceId && RECORDING_ACTIONS.has(entry.action))
    .sort((a, b) => b.seq - a.seq);
  const contains = (entry: LedgerEntry, hash: string) => JSON.stringify(entry.detail).toLowerCase().includes(hash.toLowerCase());
  return recording.find((entry) => contains(entry, txHash)) ?? (sourceTxHash ? recording.find((entry) => contains(entry, sourceTxHash)) : undefined) ?? null;
}

/**
 * Whether Invoices offers a receipt for a payable (P6): paid, with a transaction on chain — the transfer, or
 * the mint on the payee's chain. A simulated payment has neither. The share itself checks the payment again.
 */
export function receiptShareable(invoice: { status: string; direction: string }, decision: { txHash?: string | null; mint?: { txHash: string } | null }): boolean {
  return invoice.direction === "payable" && invoice.status === "paid" && Boolean(decision.txHash || decision.mint);
}

/** The receipt entry's summary: the amount and the chain, and no names. */
export function receiptSummary(facts: ReceiptFacts): string {
  return `Receipt: ${facts.amount} ${facts.token} paid on ${payeeChain(facts.chain).label}`;
}
