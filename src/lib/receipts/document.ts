import { SIGNED_ENTRY_PROVES } from "../evidence-chain";
import { CHECK_AN_ENTRY, type EvidenceKey, type SignedEntry } from "../evidence-export";
import { networkProfile, type Network } from "../network";
import { receiptNotReady, type BuiltReceipt, type ReceiptFacts, type ReceiptNotReady } from "./facts";
import type { OnChainCheck } from "./onchain";
import type { EntryCheck } from "./verify";

/**
 * A payable's receipt as a document (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA4): what a receipt states for the payment, as Share receipt would state it now; the entry that recorded its
 * transaction; when it was shared and whether its link opens; its two checks; and every entry it rests on in full with
 * the workspace's public keys, so the SDK can check it offline. Never the link, its token or its hash. Pure: the reader
 * (`./document-read`) reads, checks and gates.
 */

export const RECEIPT_FORMAT = "vestiarion-receipt/1";

/** A change to a shared receipt's link since it was shared. */
export interface ReceiptLinkChange {
  action: "receipt_link_renewed" | "receipt_revoked";
  at: string;
  entry: number;
}

export interface ReceiptDocument {
  format: typeof RECEIPT_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  invoiceId: string;
  /** Paid, confirmed, on chain, and a signed entry records its transaction: what Share receipt needs. */
  ready: boolean;
  /** Why not, when not ready: the builder's own sentence, and its name. */
  notReady: { code: ReceiptNotReady; reason: string } | null;
  /** What a receipt states for this payment now; null when not ready. */
  facts: ReceiptFacts | null;
  /** The entry that recorded the transaction; null when not ready. */
  records: { seq: number; hash: string } | null;
  /** The entry the bill was added with (`create_invoice`, `import_invoice` or `recurring_invoice_created`), or null. */
  invoiceEntry: number | null;
  /** When a member shared it: first shared at, the `receipt_shared` entry that signed its statement, and its link's changes. */
  shared: { at: string; entry: number; linkOpen: boolean; changes: ReceiptLinkChange[] } | null;
  /** The recording entry checked alone and holding the transaction, and the transaction on its chain; null when not ready. */
  checks: { recorded: EntryCheck; onChain: OnChainCheck } | null;
  signedEntryProves: string;
  checkAnEntry: string[];
  keys: EvidenceKey[];
  entries: SignedEntry[];
}

/** The entries a bill is added with: the one its number comes from. */
const CREATION = new Set(["create_invoice", "import_invoice", "recurring_invoice_created"]);
const LINK_CHANGES = new Set(["receipt_link_renewed", "receipt_revoked"]);

/** The entry the bill was added with, among an invoice's entries: the oldest that creates it. */
export function invoiceEntryOf<T extends { seq: number; action: string; detail: Record<string, unknown> | null }>(entries: readonly T[], invoiceId: string): T | null {
  return [...entries].sort((a, b) => a.seq - b.seq).find((entry) => CREATION.has(entry.action) && entry.detail?.invoiceId === invoiceId) ?? null;
}

export function receiptDocument(input: {
  workspace: { slug: string; name: string };
  network: Network;
  invoiceId: string;
  built: BuiltReceipt;
  /** The `payment_receipts` row, or null when never shared. */
  receipt: { created_at: string; entry_seq: number; revoked_at: string | null } | null;
  /** Every entry read for it, each with its check: the invoice's own, the receipt's and its link's changes. */
  entries: readonly SignedEntry[];
  checks: ReceiptDocument["checks"];
  keys: EvidenceKey[];
  now: Date;
}): ReceiptDocument {
  const bySeq = new Map<number, SignedEntry>();
  for (const entry of input.entries) bySeq.set(entry.seq, entry);
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const { built, receipt } = input;
  const created = invoiceEntryOf(entries, input.invoiceId);
  return {
    format: RECEIPT_FORMAT,
    exportedAt: input.now.toISOString(),
    workspace: input.workspace,
    network: { id: input.network, label: networkProfile(input.network).label },
    invoiceId: input.invoiceId,
    ready: built.ok,
    notReady: built.ok ? null : { code: receiptNotReady(built.reason), reason: built.reason },
    facts: built.ok ? built.facts : null,
    records: built.ok ? built.records : null,
    invoiceEntry: created?.seq ?? null,
    shared: receipt
      ? {
          at: receipt.created_at,
          entry: receipt.entry_seq,
          linkOpen: receipt.revoked_at === null,
          changes: entries
            .filter((entry) => LINK_CHANGES.has(entry.action) && entry.seq > receipt.entry_seq)
            .map((entry) => ({ action: entry.action as ReceiptLinkChange["action"], at: entry.ts, entry: entry.seq })),
        }
      : null,
    checks: built.ok ? input.checks : null,
    signedEntryProves: SIGNED_ENTRY_PROVES,
    checkAnEntry: [...CHECK_AN_ENTRY],
    keys: input.keys,
    entries,
  };
}
