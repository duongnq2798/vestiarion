import { platformDb } from "../dal";
import type { ReceiptFacts } from "../receipts/facts";
import { readOnChain, type OnChainCheck } from "../receipts/onchain";
import { receiptTokenHash } from "../receipts/token";
import { recordsTransaction, verifyEntry, type EntryCheck, type PublicLedgerRow } from "../receipts/verify";

/**
 * What the public receipt page reads for a link (docs/superpowers/specs/2026-10-01-payment-receipts-design.md
 * P5). No session: the link is the credential, looked up only by the SHA-256 of its secret through the
 * service role's `payment_receipt_by_token`. The receipt's own entry is shown in full; the entry it names
 * is checked here and never shown, because it holds names and reasoning (R1).
 */

export interface ReceiptChecks {
  /** The receipt entry's body hash, signature and chain hash, checked with the workspace's key. */
  signed: EntryCheck;
  /** The entry the receipt names: the same workspace's, signed, the hash the receipt states, and it records the transaction. */
  recorded: EntryCheck;
  onChain: OnChainCheck;
}

export interface ReceiptView {
  facts: ReceiptFacts;
  entry: PublicLedgerRow;
  publicKeys: Record<string, string>;
  records: { seq: number };
  checks: ReceiptChecks;
}

interface Found {
  publicKeys: Record<string, string>;
  entry: PublicLedgerRow;
  records: PublicLedgerRow | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The receipt's statement, as its entry holds it; null for anything that is not a receipt. */
function statement(entry: PublicLedgerRow): { facts: ReceiptFacts; records: { seq: number; hash: string } } | null {
  if (entry.action !== "receipt_shared" || !isRecord(entry.detail)) return null;
  const { receipt, records } = entry.detail as { receipt?: unknown; records?: unknown };
  if (!isRecord(receipt) || !isRecord(records)) return null;
  const facts = receipt as unknown as ReceiptFacts;
  if (typeof facts.amount !== "number" || typeof facts.txHash !== "string" || typeof facts.payee !== "string" || typeof facts.chain !== "string") return null;
  if (typeof records.seq !== "number" || typeof records.hash !== "string") return null;
  return { facts, records: { seq: records.seq, hash: records.hash } };
}

async function recordedCheck(found: Found, records: { seq: number; hash: string }, facts: ReceiptFacts): Promise<EntryCheck> {
  if (!found.records || found.records.seq !== records.seq) return { ok: false, reason: "The entry this receipt names is not in the workspace's ledger." };
  const signed = await verifyEntry(found.records, found.publicKeys);
  if (signed.ok !== true) return signed;
  const transactions = [facts.txHash, ...(facts.sourceTxHash ? [facts.sourceTxHash] : [])];
  if (!recordsTransaction(found.records, records.hash, transactions)) return { ok: false, reason: "The entry this receipt names does not record its transaction." };
  return { ok: true };
}

export async function readReceipt(
  token: string,
  options: { fetch?: typeof fetch; rpcUrl?: (chain: string) => string } = {}
): Promise<ReceiptView | null> {
  const tokenHash = receiptTokenHash(token);
  if (!tokenHash) return null;
  const answer = await platformDb().rpc("payment_receipt_by_token", { p_token_hash: tokenHash });
  if (answer.error) throw new Error(answer.error.message);
  const found = answer.data as Found | null;
  if (!found || !isRecord(found.entry)) return null;
  const stated = statement(found.entry);
  if (!stated) return null;

  const [signed, recorded, onChain] = await Promise.all([
    verifyEntry(found.entry, found.publicKeys ?? {}),
    recordedCheck(found, stated.records, stated.facts),
    readOnChain(stated.facts, options),
  ]);
  return {
    facts: stated.facts,
    entry: found.entry,
    publicKeys: found.publicKeys ?? {},
    records: { seq: stated.records.seq },
    checks: { signed, recorded, onChain },
  };
}
