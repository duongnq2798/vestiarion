import {
  actualCurrency,
  isActualMethod,
  METHOD_WORDS,
  NOTE_MAX,
  paidDay,
  REASON_MAX,
  REFERENCE_MAX,
  type ActualMethod,
  type ActualRecord,
} from "./actual-payment-fields";
import type { ActualsFacts } from "./actual-payments-compare";
import { matchActualsCsv, parseActualsCsv, type MatchBill, type PreviewRow } from "./actual-payments-csv";
import { billAmount, billDigits } from "./bill-amount";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { assertLedgerCanSign } from "./ledger";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * What the business paid outside Vestiarion (docs/superpowers/specs/2026-10-10-actual-payments-design.md A1–A3, A6,
 * A10): a member records, per payable, the day, amount, currency and method it paid, or that it did not pay it and why.
 * Each record is a row in `payment_actuals` (0090), which the tenant role can only add to, and a signed
 * `actual_payment_recorded` or `actual_payment_corrected` entry naming the payable as its subject. A change appends a
 * correction to the bill's newest record; the history stays. Every export runs inside an organization scope; who may
 * record (`records.write`) is the command's check.
 *
 * Until migration 0090 runs, reading says so and recording refuses with `not_ready`: the report never fails for it.
 */

export const ACTUAL_ACTIONS = { recorded: "actual_payment_recorded", corrected: "actual_payment_corrected" } as const;

export type ActualPaymentErrorCode =
  | "not_ready"
  | "not_a_payable"
  | "already_recorded"
  | "not_current"
  | "changed"
  | "paid_day"
  | "amount"
  | "currency"
  | "method"
  | "reference_too_long"
  | "note_too_long"
  | "reason_required"
  | "reason_too_long";

const MESSAGES: Record<ActualPaymentErrorCode, string> = {
  not_ready: "Recording what your business paid is not set up on this deployment yet.",
  not_a_payable: "That is not a payable in this workspace.",
  already_recorded: "What your business did about this bill is recorded already. Correct it instead.",
  not_current: "That record was corrected since. Reload the page and correct the newest one.",
  changed: "Someone recorded this bill a moment before. Reload the page to see it.",
  paid_day: "Choose the day it was paid, on or before tomorrow.",
  amount: "Type the amount as it was paid, above zero, such as 1,250.00.",
  currency: "Type the currency as a three-letter code, such as EUR, or USDC or EURC.",
  method: "Choose how it was paid: bank transfer, card, cash or other.",
  reference_too_long: `Keep the reference to ${REFERENCE_MAX} characters.`,
  note_too_long: `Keep the note to ${NOTE_MAX} characters.`,
  reason_required: "Say why it was not paid, in a few words.",
  reason_too_long: `Keep the reason to ${REASON_MAX} characters.`,
};

export class ActualPaymentError extends Error {
  constructor(readonly code: ActualPaymentErrorCode) {
    super(MESSAGES[code]);
    this.name = "ActualPaymentError";
  }
}

export type ActualInput =
  | {
      invoiceId: string;
      outcome: "paid";
      paidOn: string;
      amount: string;
      currency: string;
      method: string;
      reference?: string;
      note?: string;
      replaces?: string | null;
    }
  | { invoiceId: string; outcome: "not_paid"; reason: string; note?: string; replaces?: string | null };

type PostgrestError = { code?: string; message?: string } | null;

/** PostgREST's "no such table" (PGRST205) or Postgres's (42P01): migration 0090 has not run here yet. */
function missingTable(error: PostgrestError): boolean {
  if (!error) return false;
  return error.code === "PGRST205" || error.code === "42P01" || (/payment_actuals/.test(error.message ?? "") && /schema cache|does not exist/.test(error.message ?? ""));
}

const COLUMNS = "id, invoice_id, outcome, paid_on, amount, currency, method, reference, note, reason, replaces, source, recorded_by, recorded_at";

type ActualRow = {
  id: string;
  invoice_id: string;
  outcome: "paid" | "not_paid";
  paid_on: string | null;
  amount: number | string | null;
  currency: string | null;
  method: string | null;
  reference: string | null;
  note: string | null;
  reason: string | null;
  replaces: string | null;
  source: string | null;
  recorded_by: string | null;
  recorded_at: string;
};

function toRecord(row: ActualRow): ActualRecord {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    outcome: row.outcome,
    paidOn: row.paid_on,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    method: isActualMethod(row.method) ? row.method : null,
    reference: row.reference,
    note: row.note,
    reason: row.reason,
    replaces: row.replaces,
    source: row.source === "csv" ? "csv" : "form",
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

/** Text as typed, trimmed; blank is none. Too long is refused with its own code. */
function optionalText(typed: string | undefined, max: number, code: ActualPaymentErrorCode): string | null {
  const text = (typed ?? "").trim();
  if (text.length > max) throw new ActualPaymentError(code);
  return text === "" ? null : text;
}

type Checked = Pick<ActualRow, "outcome" | "paid_on" | "currency" | "method" | "reference" | "note" | "reason"> & { amount: number | null };

/** Every field, checked before anything is read or written. */
function checkedFields(input: ActualInput, today: string): Checked {
  const note = optionalText(input.note, NOTE_MAX, "note_too_long");
  if (input.outcome === "not_paid") {
    const reason = optionalText(input.reason, REASON_MAX, "reason_too_long");
    if (!reason) throw new ActualPaymentError("reason_required");
    return { outcome: "not_paid", paid_on: null, amount: null, currency: null, method: null, reference: null, note, reason };
  }
  const paidOn = paidDay(input.paidOn, today);
  if (!paidOn) throw new ActualPaymentError("paid_day");
  const currency = actualCurrency(input.currency);
  if (!currency) throw new ActualPaymentError("currency");
  const amount = billAmount(input.amount, currency);
  if (amount === null) throw new ActualPaymentError("amount");
  if (!isActualMethod(input.method)) throw new ActualPaymentError("method");
  const reference = optionalText(input.reference, REFERENCE_MAX, "reference_too_long");
  return { outcome: "paid", paid_on: paidOn, amount, currency, method: input.method, reference, note, reason: null };
}

const amountWords = (amount: number, currency: string) =>
  `${amount.toLocaleString("en-US", { minimumFractionDigits: billDigits(currency), maximumFractionDigits: billDigits(currency) })} ${currency}`;
const methodWords = (method: ActualMethod) => (method === "other" ? "another method" : METHOD_WORDS[method].toLowerCase());

/** The bill's newest record: the one no other replaces. Throws `not_ready` before migration 0090 runs. */
async function newestRecordOf(invoiceId: string): Promise<string | null> {
  const read = await db().from("payment_actuals").select("id, replaces").eq("invoice_id", invoiceId);
  if (read.error) {
    if (missingTable(read.error)) throw new ActualPaymentError("not_ready");
    throw new Error(read.error.message);
  }
  const rows = (read.data ?? []) as Array<{ id: string; replaces: string | null }>;
  const replaced = new Set(rows.flatMap((row) => (row.replaces ? [row.replaces] : [])));
  return rows.find((row) => !replaced.has(row.id))?.id ?? null;
}

export async function recordActual(
  input: ActualInput & { actorId: string; source: "form" | "csv"; today?: string }
): Promise<{ record: ActualRecord; corrected: boolean }> {
  const fields = checkedFields(input, input.today ?? new Date().toISOString().slice(0, 10));

  const invoice = (unwrap(await db().from("invoices").select("id, direction").eq("id", input.invoiceId).limit(1)) as Array<{ id: string; direction: string }>)[0];
  if (!invoice || invoice.direction !== "payable") throw new ActualPaymentError("not_a_payable");

  const newest = await newestRecordOf(invoice.id);
  const replaces = input.replaces ?? null;
  if (replaces === null && newest !== null) throw new ActualPaymentError("already_recorded");
  if (replaces !== null && replaces !== newest) throw new ActualPaymentError("not_current");
  // An unreadable signing key refuses the record before its row is written, rather than leave it unsigned.
  assertLedgerCanSign();

  const write = await db()
    .from("payment_actuals")
    .insert({ invoice_id: invoice.id, ...fields, replaces, source: input.source, recorded_by: input.actorId })
    .select(COLUMNS)
    .single<ActualRow>();
  if (write.error) {
    // One first record per bill and one correction per record: someone else's came first.
    if (write.error.code === "23505") throw new ActualPaymentError("changed");
    if (write.error.code === "23503") throw new ActualPaymentError("not_a_payable");
    if (missingTable(write.error)) throw new ActualPaymentError("not_ready");
    throw new Error(write.error.message);
  }
  const record = toRecord(write.data);
  const corrected = replaces !== null;
  const verb = corrected ? "Corrected" : "Recorded";

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: corrected ? ACTUAL_ACTIONS.corrected : ACTUAL_ACTIONS.recorded,
    summary:
      record.outcome === "paid" && record.amount !== null && record.currency && record.method
        ? `${verb} what the business paid outside Vestiarion: ${amountWords(record.amount, record.currency)} on ${record.paidOn} by ${methodWords(record.method)}`
        : `${verb} that the business did not pay it: ${record.reason}`,
    // The payable is its subject, never its invoiceId: its card on Bills & receivables keeps showing the agent's decision.
    detail: {
      by: input.actorId,
      actualId: record.id,
      subject: "invoice",
      subjectId: invoice.id,
      outcome: record.outcome,
      paidOn: record.paidOn,
      amount: record.amount,
      currency: record.currency,
      method: record.method,
      reference: record.reference,
      note: record.note,
      reason: record.reason,
      ...(corrected ? { replaces } : {}),
      ...(input.source === "csv" ? { via: "csv" } : {}),
    },
  });
  return { record, corrected };
}

const PAGE = 1000;

/** Every row of a read, a page at a time, or the read's error. */
async function pages<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: PostgrestError }>): Promise<{ rows: T[]; error: PostgrestError }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await read(from, from + PAGE - 1);
    if (page.error) return { rows, error: page.error };
    const data = (page.data ?? []) as T[];
    rows.push(...data);
    if (data.length < PAGE) return { rows, error: null };
  }
}

function rowsOrThrow<T>(read: { rows: T[]; error: PostgrestError }): T[] {
  if (read.error) throw new Error(read.error.message ?? "read failed");
  return read.rows;
}

/**
 * The workspace's records, with the ledger entry that recorded each and each verdict's own entry, for the comparison
 * and its links (A8). `available: false` before migration 0090 runs.
 */
export async function readActualsFacts(orgDb: OrgDb): Promise<{ available: false } | { available: true; facts: ActualsFacts }> {
  const records = await pages<ActualRow>((from, to) => orgDb.from("payment_actuals").select(COLUMNS).order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(from, to));
  if (missingTable(records.error)) return { available: false };
  const [entries, verdicts] = await Promise.all([
    pages<{ seq: number | string; actual_id: string | null }>((from, to) =>
      orgDb
        .from("ledger_entries")
        .select("seq, actual_id:detail->>actualId")
        .eq("actor", "human")
        .in("action", [ACTUAL_ACTIONS.recorded, ACTUAL_ACTIONS.corrected])
        .order("seq", { ascending: true })
        .range(from, to)
    ),
    pages<{ seq: number | string; entry_seq: number | string | null }>((from, to) =>
      orgDb.from("ledger_entries").select("seq, entry_seq:detail->>entrySeq").eq("action", "decision_verdict").order("seq", { ascending: true }).range(from, to)
    ),
  ]);
  return {
    available: true,
    facts: {
      records: rowsOrThrow(records).map(toRecord),
      entries: new Map(rowsOrThrow(entries).flatMap((row) => (row.actual_id ? [[row.actual_id, Number(row.seq)] as const] : []))),
      verdictEntries: new Map(rowsOrThrow(verdicts).flatMap((row) => (row.entry_seq != null && row.entry_seq !== "" ? [[Number(row.entry_seq), Number(row.seq)] as const] : []))),
    },
  };
}

type PayableRow = {
  id: string;
  memo: string | null;
  amount: number | string;
  currency: string | null;
  original_currency: string | null;
  original_amount: number | string | null;
  due_date: string | null;
  counterparties: { name: string } | null;
};

/** The workspace's payables as the CSV matches them, each with its newest record. Throws `not_ready` before 0090. */
export async function readMatchBills(orgDb: OrgDb): Promise<MatchBill[]> {
  const [payables, records] = await Promise.all([
    pages<PayableRow>((from, to) =>
      orgDb
        .from("invoices")
        .select("id, memo, amount, currency, original_currency, original_amount, due_date, counterparties(name)")
        .eq("direction", "payable")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    pages<ActualRow>((from, to) => orgDb.from("payment_actuals").select(COLUMNS).order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(from, to)),
  ]);
  if (missingTable(records.error)) throw new ActualPaymentError("not_ready");
  const all = rowsOrThrow(records).map(toRecord);
  const replaced = new Set(all.flatMap((record) => (record.replaces ? [record.replaces] : [])));
  const newest = new Map(all.filter((record) => !replaced.has(record.id)).map((record) => [record.invoiceId, record]));
  return rowsOrThrow(payables).map((row) => ({
    id: row.id,
    memo: row.memo,
    payee: row.counterparties?.name ?? "a supplier",
    amount: Number(row.amount),
    currency: row.currency ?? "USDC",
    bill: row.original_currency && row.original_amount != null ? { amount: Number(row.original_amount), currency: row.original_currency } : null,
    dueDate: row.due_date,
    current: newest.get(row.id) ?? null,
  }));
}

/** A CSV as it would be saved, row by row, read against the workspace's payables now; nothing is written. */
export async function previewActualsCsv(csv: string, today: string): Promise<PreviewRow[]> {
  const rows = parseActualsCsv(csv);
  return matchActualsCsv(rows, await readMatchBills(db()), today);
}
