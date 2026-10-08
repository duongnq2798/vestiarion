import { db, unwrap } from "../dal";
import { appendLedgerEntry, ledgerPublicKeyPems, ledgerVerificationKeyring, listLedgerEntriesForTargets } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { currentOrgId } from "../context";
import { buildReceipt, receiptSummary, type ReceiptIntent } from "./facts";
import { generateReceiptToken } from "./token";

/**
 * Sharing a payment's receipt (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P2, P3), in
 * the workspace in scope. The first share appends the signed `receipt_shared` entry and stores the
 * receipt with its link; every later share only replaces the link (R3). Stopping revokes the link.
 */

export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

const INTENT_COLUMNS =
  "status, provider_mode, token, amount, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, confirmed_at, network";

interface ReceiptRow {
  id: string;
  revoked_at: string | null;
}

async function receiptOf(invoiceId: string): Promise<ReceiptRow | null> {
  const found = await db().from("payment_receipts").select("id, revoked_at").eq("invoice_id", invoiceId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  return (found.data as ReceiptRow | null) ?? null;
}

/** The public halves of every key this workspace has signed with, by id: they verify the receipt and the entry it names. */
const publicKeys = () => ledgerPublicKeyPems(ledgerVerificationKeyring());

export async function shareReceipt(input: { actorId: string; invoiceId: string }): Promise<{ token: string; receiptId: string; renewed: boolean }> {
  const { token, secretHash } = generateReceiptToken();
  const existing = await receiptOf(input.invoiceId);

  if (existing) {
    // The facts were stated once; a new share is a new link to them.
    const renewed = await db()
      .from("payment_receipts")
      .update({ token_hash: secretHash, link_created_at: new Date().toISOString(), revoked_at: null })
      .eq("id", existing.id);
    if (renewed.error) throw new Error(renewed.error.message);
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "human",
      domain: "ap",
      action: "receipt_link_renewed",
      summary: "A new link was made for a shared receipt; any earlier link no longer opens it",
      // The receipt, not the invoice: an entry naming the invoice would stand in for its decision on the card (review #1).
      detail: { by: input.actorId, receiptId: existing.id },
    });
    return { token, receiptId: existing.id, renewed: true };
  }

  const invoice = (await db().from("invoices").select("id, status, direction").eq("id", input.invoiceId).maybeSingle()).data as {
    id: string;
    status: string;
    direction: string;
  } | null;
  if (!invoice) throw new ReceiptError("That invoice is not in this workspace.");
  const intent = unwrap(
    await db().from("payment_intents").select(INTENT_COLUMNS).eq("source_type", "invoice").eq("source_id", invoice.id).limit(1)
  ) as ReceiptIntent[];
  const built = buildReceipt({ invoice, intent: intent[0] ?? null, entries: await listLedgerEntriesForTargets({ invoiceIds: [invoice.id] }) });
  if (!built.ok) throw new ReceiptError(built.reason);

  // The statement is public in full (R1): the facts and the entry that recorded them, and no names or ids of people.
  const entry = await appendLedgerEntry({
    actor: "human",
    domain: "ap",
    action: "receipt_shared",
    summary: receiptSummary(built.facts),
    detail: { receipt: built.facts, records: built.records },
  });
  const stored = await db()
    .from("payment_receipts")
    .insert({ invoice_id: invoice.id, entry_seq: entry.seq, public_keys: publicKeys(), token_hash: secretHash, created_by: input.actorId })
    .select("id")
    .single<{ id: string }>();
  if (stored.error) {
    // Two people sharing the same payment at once: the other one's receipt stands.
    if (/payment_receipts_invoice_key/.test(stored.error.message)) throw new ReceiptError("Someone shared this receipt a moment ago. Reload the page.");
    throw new Error(stored.error.message);
  }
  return { token, receiptId: stored.data.id, renewed: false };
}

export async function stopSharingReceipt(input: { actorId: string; invoiceId: string }): Promise<void> {
  const existing = await receiptOf(input.invoiceId);
  if (!existing || existing.revoked_at) throw new ReceiptError("This receipt is not shared.");
  const revoked = await db().from("payment_receipts").update({ revoked_at: new Date().toISOString() }).eq("id", existing.id);
  if (revoked.error) throw new Error(revoked.error.message);
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: "receipt_revoked",
    summary: "A shared receipt's link was revoked",
    detail: { by: input.actorId, receiptId: existing.id },
  });
}

/**
 * Which of these invoices have a receipt whose link is live. The workspace's live receipts are read whole:
 * they are few, and naming every invoice in the request could outgrow a URL (review #7).
 */
export async function sharedReceipts(invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const rows = unwrap(await db().from("payment_receipts").select("invoice_id").is("revoked_at", null)) as Array<{ invoice_id: string }>;
  const wanted = new Set(invoiceIds);
  return new Set(rows.map((row) => row.invoice_id).filter((id) => wanted.has(id)));
}
