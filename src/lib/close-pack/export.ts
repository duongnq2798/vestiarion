import { SIGNED_ENTRY_PROVES } from "../evidence-chain";
import { CHECK_AN_ENTRY, type EvidenceKey } from "../evidence-export";
import { csvCell } from "../ledger-export";
import type { Network } from "../network";
import type { ClosePackMonth } from "./month";
import {
  CLOSE_PACK_FORMAT,
  type ClosePack,
  type ClosePackCheckKind,
  type ClosePackEntry,
  type ClosePackEscrowMove,
  type ClosePackOpenPayment,
  type ClosePackRow,
  type ClosePackTotals,
} from "./types";
import { approvedLines, booksWords, checkCell, CHECK_KIND_MEANINGS, CHECK_KIND_WORDS, decidedLines, paidToWords, whoWords } from "./words";

/**
 * The close pack's files (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP12, CP18): the signed JSON in
 * the evidence export's shape, and one table, which the CSV guards cell by cell and a Google Sheet writes as it is. Pure:
 * the route reads, gates, hashes and records.
 *
 * The file is not signed with the ledger key, which signs ledger entries only. What makes it checkable is its entries,
 * each carried in full with the workspace's public keys, and the download's own `close_pack_exported`, which signs the
 * file's SHA-256 (CP13).
 */

export type ClosePackDocument = {
  format: typeof CLOSE_PACK_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  month: ClosePackMonth & { ended: boolean };
  ledgerHead: { seq: number; hash: string } | null;
  cut: boolean;
  unread: Array<"members" | "screening">;
  totals: ClosePackTotals;
  rows: Array<ClosePackRow & { evidenceUrl: string }>;
  notSettled: Array<ClosePackOpenPayment & { evidenceUrl: string }>;
  escrow: ClosePackEscrowMove[];
  /** Each check kind's words and what it means. */
  labels: Record<ClosePackCheckKind, { words: string; meaning: string }>;
  signedEntryProves: string;
  checkAnEntry: readonly string[];
  keys: EvidenceKey[];
  entries: ClosePackEntry[];
};

const KINDS = Object.keys(CHECK_KIND_WORDS) as ClosePackCheckKind[];

/** The origin without a trailing slash, so `${origin}${path}` is one address. */
const base = (origin: string) => origin.replace(/\/+$/, "");

export function closePackDocument(pack: ClosePack, options: { origin: string }): ClosePackDocument {
  const origin = base(options.origin);
  return {
    format: CLOSE_PACK_FORMAT,
    exportedAt: pack.readAt,
    workspace: { slug: pack.workspace.slug, name: pack.workspace.name },
    network: pack.network,
    month: { ...pack.month, ended: pack.ended },
    ledgerHead: pack.ledgerHead,
    cut: pack.cut,
    unread: [...pack.unread],
    totals: pack.totals,
    rows: pack.rows.map((row) => ({ ...row, evidenceUrl: `${origin}${row.evidencePath}` })),
    notSettled: pack.notSettled.map((payment) => ({ ...payment, evidenceUrl: `${origin}${payment.evidencePath}` })),
    escrow: pack.escrow,
    labels: Object.fromEntries(KINDS.map((kind) => [kind, { words: CHECK_KIND_WORDS[kind], meaning: CHECK_KIND_MEANINGS[kind] }])) as ClosePackDocument["labels"],
    signedEntryProves: SIGNED_ENTRY_PROVES,
    checkAnEntry: CHECK_AN_ENTRY,
    keys: pack.keys,
    entries: pack.entries,
  };
}

/** The exact text the route serves and hashes: JSON.stringify(closePackDocument(...), null, 2). */
export function closePackJson(pack: ClosePack, options: { origin: string }): string {
  return JSON.stringify(closePackDocument(pack, options), null, 2);
}

/** The table's columns, in order: the CSV's header and a Google Sheet's first row. */
export const CLOSE_PACK_COLUMNS = [
  "paid_at",
  "payment_id",
  "record",
  "record_id",
  "payee",
  "payee_id",
  "paid_to",
  "chain",
  "invoice_number",
  "milestone",
  "bill_amount",
  "bill_currency",
  "amount_paid",
  "token",
  "discount",
  "due_date",
  "po_reference",
  "document_sha256",
  "vendor_document_sha256",
  "simulated",
  "shadow",
  "decided",
  "approvals",
  "authorized_by",
  "address_given_by",
  "address_confirmed_by",
  "second_person",
  "guardrails",
  "guardrail_notes",
  "screening",
  "wallet_list",
  "payee_lock",
  "pay_to",
  "milestone_verification",
  "route",
  "tx_hash",
  "tx_url",
  "burn_tx_hash",
  "network_fee_usd",
  "network_fee_source",
  "route_fee_usdc",
  "earlier_attempts",
  "books",
  "booked_in",
  "entry_seq",
  "entry_hash",
  "signature",
  "signing_key_id",
  "entry_verified",
  "evidence_url",
  "entries",
] as const;

export type ClosePackColumn = (typeof CLOSE_PACK_COLUMNS)[number];

/** `yes`, `no`, or empty when not known. */
const yesNo = (value: boolean | null | undefined) => (value === true ? "yes" : value === false ? "no" : "");
/** Lines join with `; `. */
const lines = (values: readonly string[]) => values.join("; ");

function cellsOf(row: ClosePackRow, origin: string): Record<ClosePackColumn, string> {
  const bill = row.bill;
  const invoice = bill.kind === "invoice" ? bill : null;
  const address = row.approval.address;
  const transaction = row.transaction;
  const record = row.record;
  const booked = row.books.booked;
  return {
    paid_at: row.paidAt,
    payment_id: row.paymentId,
    record: row.source.kind,
    record_id: row.source.id,
    payee: row.payee.name ?? "",
    payee_id: row.payee.counterpartyId,
    paid_to: paidToWords(row),
    chain: transaction.chainLabel ?? "",
    invoice_number: invoice?.number ?? "",
    milestone: bill.kind === "milestone" ? bill.title : "",
    bill_amount: bill.amount,
    bill_currency: bill.currency,
    amount_paid: row.amount,
    token: row.token,
    discount: row.discount ?? "",
    due_date: invoice?.dueDate ?? "",
    po_reference: invoice?.poReference ?? "",
    document_sha256: invoice?.document?.sha256 ?? "",
    vendor_document_sha256: lines(invoice?.vendorDocuments.map((document) => document.sha256) ?? []),
    simulated: yesNo(row.simulated),
    shadow: yesNo(row.shadow),
    decided: lines(decidedLines(row)),
    approvals: lines(approvedLines(row)),
    authorized_by: row.approval.authorizedBy ?? "",
    address_given_by: address?.mirror ? "Vestiarion, a mirror address in shadow mode" : address?.givenBy ? whoWords(address.givenBy) : "",
    address_confirmed_by: address?.confirmedBy ? whoWords(address.confirmedBy) : "",
    second_person: yesNo(address?.secondPerson),
    guardrails: checkCell(row.checks.guardrails),
    guardrail_notes: lines(row.checks.guardrails.notes),
    screening: checkCell(row.checks.screening),
    wallet_list: checkCell(row.checks.walletList),
    payee_lock: checkCell(row.checks.payeeLock),
    pay_to: checkCell(row.checks.payTo),
    milestone_verification: checkCell(row.checks.milestone),
    route: transaction.route,
    tx_hash: transaction.txHash ?? "",
    tx_url: transaction.explorerUrl ?? "",
    burn_tx_hash: transaction.sourceTxHash ?? "",
    network_fee_usd: transaction.networkFeeUsd ?? "",
    network_fee_source: transaction.networkFeeSource ?? "",
    route_fee_usdc: transaction.routeFeeUsdc ?? "",
    earlier_attempts: String(transaction.earlierAttempts),
    books: booksWords(row),
    booked_in: booked ? `${booked.tool}: ${booked.state}${booked.paymentId ? ` (payment ${booked.paymentId})` : ""}` : "",
    entry_seq: record ? String(record.seq) : "",
    entry_hash: record?.hash ?? "",
    signature: record?.signature ?? "",
    signing_key_id: record?.signingKeyId ?? "",
    entry_verified: record ? (record.check.ok === true ? "yes" : record.check.ok === false ? "no" : "not checked") : "",
    evidence_url: `${origin}${row.evidencePath}`,
    entries: row.entries.join(" "),
  };
}

/** One row per settled payment, plain unguarded text: the CSV guards each cell; Sheets writes it RAW (CP18). */
export function closePackTable(pack: ClosePack, options: { origin: string }): { columns: readonly ClosePackColumn[]; rows: string[][] } {
  const origin = base(options.origin);
  return {
    columns: CLOSE_PACK_COLUMNS,
    rows: pack.rows.map((row) => {
      const cells = cellsOf(row, origin);
      return CLOSE_PACK_COLUMNS.map((column) => cells[column]);
    }),
  };
}

/**
 * A byte-order mark, the header, then the table, CRLF, every cell through `csvCell` (CP12, CP17): Excel on Windows reads
 * it as UTF-8, and no cell runs as a formula. Not-settled payments and escrow moves are on the page and in the JSON.
 */
export function closePackCsv(pack: ClosePack, options: { origin: string }): string {
  const table = closePackTable(pack, options);
  const body = [[...table.columns], ...table.rows].map((cells) => cells.map(csvCell).join(",")).join("\r\n");
  return `${String.fromCharCode(0xfeff)}${body}\r\n`;
}

/** vestiarion-close-pack-pinecrest-studio-2026-10.csv; "-so-far" before the extension for a month not ended. */
export function closePackFileName(slug: string, month: ClosePackMonth, ended: boolean, extension: "json" | "csv"): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "workspace";
  return `vestiarion-close-pack-${safe}-${month.key}${ended ? "" : "-so-far"}.${extension}`;
}
