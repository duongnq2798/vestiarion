import { db, unwrap } from "../dal";
import type { SignedEntry } from "../evidence-export";
import { ledgerPublicKeyPems, ledgerVerificationKeyring, type LedgerEntry, type LedgerRow } from "../ledger";
import { exportKeys } from "../ledger-export";
import { workspaceNetwork } from "../workspace-network";
import { invoiceEntryOf, receiptDocument, type ReceiptDocument } from "./document";
import { buildReceipt, type ReceiptIntent } from "./facts";
import { readOnChain } from "./onchain";
import { recordsTransaction, verifyEntry, type EntryCheck } from "./verify";

/**
 * Reads one payable's receipt document for the workspace in scope
 * (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md EA4, "Data it reads and writes"):
 * the invoice, its payment, its entries, its receipt row and the receipt's own entries, through `db()`; then each entry
 * checked alone with the workspace's keys, retired ones included, and, when it is ready, the transaction on its chain.
 *
 * It never selects a receipt's `token_hash` or who shared it, and writes nothing: no row, no ledger entry.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTENT_COLUMNS =
  "status, provider_mode, token, amount, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, confirmed_at, network";
/** Never `token_hash`, which opens the receipt's public page, and never `created_by`: a receipt names no one (R1). */
const RECEIPT_COLUMNS = "id, entry_seq, created_at, revoked_at";
const LINK_CHANGES = ["receipt_link_renewed", "receipt_revoked"];
const NOT_RECORDED = "The entry this receipt names does not record its transaction.";

type Read = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Row = Record<string, unknown>;

async function maybeOne(query: Read): Promise<Row | null> {
  const rows = unwrap(await query) as Row[] | Row | null;
  if (Array.isArray(rows)) return rows[0] ?? null;
  return rows ?? null;
}

const ledgerRows = async (query: Read) => unwrap(await query) as LedgerRow[];

/** The shape `buildReceipt` reads: the camelCase entry the ledger module hands out. */
function asEntry(row: LedgerRow): LedgerEntry {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    domain: row.domain,
    action: row.action,
    summary: row.summary,
    detail: row.detail ?? {},
    bodyHash: row.body_hash,
    signature: row.signature,
    prevHash: row.prev_hash,
    hash: row.hash,
    signingKeyId: row.signing_key_id ?? null,
  };
}

function signedOf(row: LedgerRow, check: EntryCheck): SignedEntry {
  return {
    seq: row.seq,
    id: row.id ?? null,
    ts: row.ts,
    actor: row.actor,
    domain: row.domain,
    action: row.action,
    summary: row.summary,
    detail: row.detail ?? {},
    body_hash: row.body_hash,
    signature: row.signature,
    prev_hash: row.prev_hash,
    hash: row.hash,
    signing_key_id: row.signing_key_id ?? null,
    check,
  };
}

/** Null when the workspace holds no payable by that id: a receivable, an unknown id, another workspace's, one that is not a UUID. */
export async function readReceiptDocument(input: {
  invoiceId: string;
  workspace: { slug: string; name: string };
  now?: Date;
  fetch?: typeof fetch;
  rpcUrl?: (chain: string) => string;
}): Promise<ReceiptDocument | null> {
  if (!UUID.test(input.invoiceId)) return null;
  const invoiceId = input.invoiceId.toLowerCase();
  const invoice = await maybeOne(db().from("invoices").select("id, status, direction, amount").eq("id", invoiceId).limit(1));
  if (!invoice || invoice.direction !== "payable") return null;

  const [intentRow, own, receiptRow] = await Promise.all([
    maybeOne(db().from("payment_intents").select(INTENT_COLUMNS).eq("source_type", "invoice").eq("source_id", invoiceId).limit(1)),
    ledgerRows(db().rpc("ledger_entries_for_targets", { p_invoice_ids: [invoiceId], p_milestone_ids: [] })),
    maybeOne(db().from("payment_receipts").select(RECEIPT_COLUMNS).eq("invoice_id", invoiceId).limit(1)),
  ]);
  const receipt = receiptRow
    ? { id: String(receiptRow.id), created_at: String(receiptRow.created_at), entry_seq: Number(receiptRow.entry_seq), revoked_at: typeof receiptRow.revoked_at === "string" ? receiptRow.revoked_at : null }
    : null;
  // The receipt's own entries: the one that signed its statement, by its seq, and those that renewed or revoked its
  // link, which name the receipt rather than the invoice.
  const receiptEntries = receipt
    ? (
        await Promise.all([
          ledgerRows(db().from("ledger_entries").select("*").eq("seq", receipt.entry_seq).limit(1)),
          ledgerRows(db().from("ledger_entries").select("*").eq("detail->>receiptId", receipt.id).in("action", LINK_CHANGES).order("seq", { ascending: true })),
        ])
      ).flat()
    : [];

  const built = buildReceipt({
    invoice: { id: String(invoice.id), status: String(invoice.status), direction: String(invoice.direction), amount: invoice.amount as string | number | undefined },
    intent: intentRow as unknown as ReceiptIntent | null,
    entries: own.map(asEntry),
  });

  // The entries it rests on: the bill's, the recording one, and the receipt's.
  const cited = new Set([invoiceEntryOf(own, invoiceId)?.seq ?? null, built.ok ? built.records.seq : null].filter((seq): seq is number => seq !== null));
  const bySeq = new Map<number, LedgerRow>();
  for (const row of [...own.filter((row) => cited.has(row.seq)), ...receiptEntries]) bySeq.set(row.seq, row);

  const keyring = ledgerVerificationKeyring();
  const publicKeys = ledgerPublicKeyPems(keyring);
  const checked = await Promise.all(
    [...bySeq.values()].map(async (row): Promise<SignedEntry> => {
      try {
        return signedOf(row, await verifyEntry({ ...row, detail: row.detail ?? {}, signing_key_id: row.signing_key_id ?? null }, publicKeys));
      } catch {
        return signedOf(row, { ok: null, reason: "The signature could not be checked here." });
      }
    })
  );

  let checks: ReceiptDocument["checks"] = null;
  if (built.ok) {
    const recording = checked.find((entry) => entry.seq === built.records.seq);
    const transactions = [built.facts.txHash, ...(built.facts.sourceTxHash ? [built.facts.sourceTxHash] : [])];
    const recorded: EntryCheck =
      !recording || recording.check === null
        ? { ok: false, reason: NOT_RECORDED }
        : recording.check.ok !== true
          ? recording.check
          : recordsTransaction(recording, built.records.hash, transactions)
            ? { ok: true }
            : { ok: false, reason: NOT_RECORDED };
    checks = { recorded, onChain: await readOnChain(built.facts, input) };
  }

  return receiptDocument({
    workspace: input.workspace,
    network: workspaceNetwork().id,
    invoiceId,
    built,
    receipt,
    entries: checked,
    checks,
    keys: exportKeys(keyring),
    now: input.now ?? new Date(),
  });
}
