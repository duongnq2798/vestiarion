import type { StatementChoices } from "../bank-statement/lines";
import { StatementReadError } from "../bank-statement/table";
import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { ActualPaymentError, readNewestRecords } from "../actual-payments";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { networkOf } from "../network";
import { chainById, homeChain } from "../payee-chains";
import { invoiceNumberInDetail } from "../receipts/facts";
import { matchStatement, type BookBill, type BookPayment, type StatementCheck } from "./match";
import { readVendorStatement, vendorLines } from "./read";

/**
 * Checking a vendor's statement in the workspace in scope (docs/superpowers/specs/2026-10-22-vendor-statement-design.md
 * VS2-VS6): the statement read again here with the person's choices, the vendor's bills, their numbers and the payments
 * made to them read in scope, matched, and the check signed with its counts only. Nothing of the file is kept, and
 * nothing is paid or changed.
 */

export class VendorStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorStatementError";
  }
}

export interface VendorStatementResult extends StatementCheck {
  vendorName: string;
}

/** At most this many ids in one read, to keep each request's address short. */
const ID_CHUNK = 100;
/** Rows a read returns at most, under the project's row cap; bills are read in pages of it. */
const PAGE = 1000;
/** A vendor with more bills than this is refused, rather than checked against some of them. */
const MOST_BILLS = 10_000;
const chunks = <T>(items: readonly T[]) => Array.from({ length: Math.ceil(items.length / ID_CHUNK) }, (_, index) => items.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK));
const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

interface InvoiceRow {
  id: string;
  amount: string | number;
  currency: string | null;
  status: string;
  memo: string | null;
  created_at: string;
  original_amount?: string | number | null;
  original_currency?: string | null;
}

interface IntentRow {
  source_id: string;
  amount: string | number;
  token: string | null;
  confirmed_at: string | null;
  tx_hash: string | null;
  mint_tx_hash: string | null;
  chain: string | null;
  destination_chain: string | null;
  network: string | null;
  provider: string | null;
  provider_mode: string | null;
}

/**
 * Where a payment can be seen, to send the vendor: the mint on the payee's chain for a payout across chains, else the
 * transfer. Only on Arc mainnet: a payment on Arc testnet moved no real money, so it is no proof to send (review 3).
 */
function paymentUrl(row: IntentRow): string | null {
  try {
    if (networkOf(row.network) !== "arc-mainnet") return null;
    if (row.mint_tx_hash && row.destination_chain) return `${chainById(row.destination_chain).explorerTx}${row.mint_tx_hash}`;
    if (!row.tx_hash) return null;
    return `${chainById(row.chain ?? homeChain(networkOf(row.network)).id).explorerTx}${row.tx_hash}`;
  } catch {
    return null;
  }
}

export async function checkVendorStatement(input: {
  actorId: string;
  counterpartyId: string;
  source: string;
  choices: StatementChoices;
  today: string;
}): Promise<VendorStatementResult> {
  const found = await db().from("counterparties").select("id, name, role").eq("id", input.counterpartyId).maybeSingle<{ id: string; name: string; role: string }>();
  if (found.error) throw new Error(found.error.message);
  const vendor = found.data;
  if (!vendor) throw new VendorStatementError("That vendor is not in this workspace.");
  if (vendor.role !== "vendor") throw new VendorStatementError("Only a vendor's statement is checked here.");

  // Read again here, from the same text and choices: what is matched is what the server read (VS2).
  let read;
  try {
    read = readVendorStatement(input.source, input.choices, input.today);
  } catch (error) {
    if (error instanceof StatementReadError) throw new VendorStatementError(error.message);
    throw error;
  }
  if (read.problems.length > 0) throw new VendorStatementError(read.problems[0]);
  if (read.questions.length > 0) throw new VendorStatementError("Say how the statement writes its dates and amounts first.");
  const lines = vendorLines(read.lines);
  if (lines.length === 0) throw new VendorStatementError("No line of the statement has a date and an amount.");
  const currencies = new Set(lines.map((line) => line.currency.toUpperCase()));
  if (currencies.size > 1) throw new VendorStatementError(`The statement is in more than one currency (${[...currencies].join(", ")}). Check one currency at a time.`);
  const currency = lines[0].currency.toUpperCase();

  // Every bill to the vendor, in pages: one read stops at the project's row cap (review 5).
  const invoices: InvoiceRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(
      await db()
        .from("invoices")
        .select("id, amount, currency, status, memo, created_at, original_amount, original_currency")
        .eq("counterparty_id", vendor.id)
        .eq("direction", "payable")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1)
    ) as InvoiceRow[];
    invoices.push(...page);
    if (page.length < PAGE) break;
    if (invoices.length >= MOST_BILLS) throw new VendorStatementError("This vendor has more than 10,000 bills, more than one check reads.");
  }
  const ids = invoices.map((row) => row.id);
  const [numbers, intents, recorded] = await Promise.all([
    // Each bill's own number, from its one create_invoice entry: a hundred bills read a hundred rows at most.
    Promise.all(
      chunks(ids).map(async (chunk) =>
        unwrap(
          await db().from("ledger_entries").select("detail").eq("action", "create_invoice").in("detail->>invoiceId", chunk)
        ) as Array<{ detail: Record<string, unknown> }>
      )
    ).then((parts) => new Map(parts.flat().flatMap(({ detail }) => (typeof detail.invoiceId === "string" ? [[detail.invoiceId, invoiceNumberInDetail(detail)] as const] : [])))),
    Promise.all(
      chunks(ids).map(async (chunk) =>
        unwrap(
          await db()
            .from("payment_intents")
            .select("source_id, amount, token, confirmed_at, tx_hash, mint_tx_hash, chain, destination_chain, network, provider, provider_mode")
            .eq("source_type", "invoice")
            .in("source_id", chunk)
            .eq("status", "confirmed")
        ) as IntentRow[]
      )
    ).then((parts) => parts.flat()),
    // What the business recorded it paid outside Vestiarion, as in shadow mode: each bill's newest record.
    readNewestRecords(db()).catch((error: unknown) => {
      if (error instanceof ActualPaymentError && error.code === "not_ready") return new Map();
      throw error;
    }),
  ]);

  const bills: BookBill[] = invoices.map((row) => ({
    id: row.id,
    number: numbers.get(row.id) ?? null,
    memo: row.memo,
    amount: Number(row.amount),
    currency: row.currency ?? "USDC",
    original: row.original_amount != null && row.original_currency ? { amount: Number(row.original_amount), currency: row.original_currency } : null,
    addedOn: dayOf(row.created_at),
    status: row.status,
  }));
  // How each bill was paid: as the business recorded it, where it did, which is how the vendor was really paid; else a
  // payment confirmed here, never a sandbox's simulated one (review 3).
  const vendorBills = new Set(ids);
  const actuals: BookPayment[] = [...recorded.values()]
    .filter((record) => vendorBills.has(record.invoiceId) && record.outcome === "paid" && record.paidOn && record.amount !== null && record.currency)
    .map((record) => ({ invoiceId: record.invoiceId, amount: record.amount as number, currency: record.currency as string, paidOn: record.paidOn as string, txUrl: null }));
  const recordedBills = new Set(actuals.map((payment) => payment.invoiceId));
  const payments: BookPayment[] = [
    ...actuals,
    ...intents
      .filter((row) => row.confirmed_at && (row.provider_mode ?? row.provider) !== "simulate" && !recordedBills.has(row.source_id))
      .map((row) => ({ invoiceId: row.source_id, amount: Number(row.amount), currency: row.token ?? "USDC", paidOn: dayOf(row.confirmed_at), txUrl: paymentUrl(row) })),
  ];

  const check = matchStatement({ lines, bills, payments, currency });

  // Signed with its counts and balances only, never the file or its lines (VS5); a check that cannot be signed still answers.
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: "vendor_statement_checked",
    summary: `Checked ${vendor.name}'s statement: ${check.missing.length} missing here, ${check.differs.length} amount${check.differs.length === 1 ? "" : "s"} differing, ${check.paidNotListed.length} payment${check.paidNotListed.length === 1 ? "" : "s"} not on it`,
    detail: {
      by: input.actorId,
      counterpartyId: vendor.id,
      period: check.period,
      currency,
      lines: check.counts.lines,
      charges: check.counts.charges,
      payments: check.counts.payments,
      matchedCharges: check.counts.matchedCharges,
      matchedPayments: check.counts.matchedPayments,
      missing: check.missing.length,
      rejected: check.rejected.length,
      twice: check.twice.length,
      differs: check.differs.length,
      notCompared: check.notCompared.length,
      paidNotListed: check.paidNotListed.length,
      unknownPayments: check.unknownPayments.length,
      notListed: check.notListed.length,
      theirBalance: check.balance.theirs,
      ourBalance: check.balance.ours,
    },
  });

  return { ...check, vendorName: vendor.name };
}
