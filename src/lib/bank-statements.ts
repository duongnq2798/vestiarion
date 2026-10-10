import { createHash } from "node:crypto";
import { pages, readNewestRecords, recordActual, rowsOrThrow, type StatementLineDetail } from "./actual-payments";
import { lineIdentity, readStatement, statementAccount, type StatementChoices, type StatementLine, type StatementRead } from "./bank-statement/lines";
import { matchStatement, type LineMatch, type StatementBill, type UsedLine } from "./bank-statement/match";
import { billDigits } from "./bill-amount";
import { db, type OrgDb } from "./dal";
import { assertLedgerCanSign } from "./ledger";

/**
 * What the business paid, from its bank statement (docs/superpowers/specs/2026-10-10-bank-statement-design.md B6, B8,
 * B9, B11): the statement is read with the person's choices (src/lib/bank-statement), its money-out lines matched
 * against the payables the report counts, and each pair the person ticks saved as a record of what was paid, naming
 * the line, kept in `bank_statement_lines` (0094). Only the lines used are kept, so a re-import finds them by their
 * hash. Every export runs inside an organization scope; who may import (`records.write`) is the command's check.
 *
 * Until migration 0094 runs, reading says so and saving refuses with `not_ready`: the report never fails for it.
 */

export const STATEMENT_NOT_READY = "Importing a bank statement is not set up on this deployment yet.";

export type StatementImportErrorCode = "not_ready" | "account";

const MESSAGES: Record<StatementImportErrorCode, string> = {
  not_ready: STATEMENT_NOT_READY,
  account: "Name the account the statement is from, in at most 80 characters.",
};

export class StatementImportError extends Error {
  constructor(readonly code: StatementImportErrorCode) {
    super(MESSAGES[code]);
    this.name = "StatementImportError";
  }
}

type PostgrestError = { code?: string; message?: string } | null;

/** The lines table, or the column naming a record's line, is not there: migration 0094 has not run here yet. */
function notThere(error: PostgrestError): boolean {
  if (!error) return false;
  if (["PGRST205", "PGRST204", "42P01", "42703"].includes(error.code ?? "")) return true;
  const message = error.message ?? "";
  return /bank_statement_lines|statement_line_id/.test(message) && /schema cache|does not exist/.test(message);
}

/** The line's key, unique per workspace: SHA-256 of what makes it itself (`lineIdentity`). */
export function statementLineHash(account: string, line: StatementLine): string {
  return createHash("sha256").update(lineIdentity(account, line), "utf8").digest("hex");
}

/** Throws `not_ready` unless both the lines table and the column naming a record's line are there. */
async function assertReady(orgDb: OrgDb): Promise<void> {
  const [lines, column] = await Promise.all([
    orgDb.from("bank_statement_lines").select("id").limit(1),
    orgDb.from("payment_actuals").select("statement_line_id").limit(1),
  ]);
  for (const read of [lines, column]) {
    if (notThere(read.error)) throw new StatementImportError("not_ready");
    if (read.error) throw new Error(read.error.message);
  }
}

/** Whether the import is set up (B11), and the accounts named before, newest first, for the person to pick again. */
export async function readStatementSetup(orgDb: OrgDb): Promise<{ available: boolean; accounts: string[] }> {
  const [lines, column] = await Promise.all([
    orgDb.from("bank_statement_lines").select("account").order("imported_at", { ascending: false }).limit(500),
    orgDb.from("payment_actuals").select("statement_line_id").limit(1),
  ]);
  if (notThere(lines.error) || notThere(column.error)) return { available: false, accounts: [] };
  if (lines.error) throw new Error(lines.error.message);
  if (column.error) throw new Error(column.error.message);
  const accounts = [...new Set(((lines.data ?? []) as Array<{ account: string }>).map((row) => row.account))];
  return { available: true, accounts };
}

type PayableRow = {
  id: string;
  memo: string | null;
  amount: number | string;
  currency: string | null;
  original_currency: string | null;
  original_amount: number | string | null;
  due_date: string | null;
  created_at: string;
  counterparties: { name: string; sample: boolean | null } | null;
};

/**
 * The payables a statement is matched against (B6): those the report counts, the real ones, or the sample data while
 * there is none; each in its own currency, with its newest record. And every payable's payee, by its id, for a line
 * an earlier import used.
 */
export async function readStatementBills(orgDb: OrgDb): Promise<{ bills: StatementBill[]; payees: Map<string, string> }> {
  const [payables, newest] = await Promise.all([
    pages<PayableRow>((from, to) =>
      orgDb
        .from("invoices")
        .select("id, memo, amount, currency, original_currency, original_amount, due_date, created_at, counterparties(name, sample)")
        .eq("direction", "payable")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    readNewestRecords(orgDb),
  ]);
  const rows = rowsOrThrow(payables);
  const real = rows.filter((row) => !row.counterparties?.sample);
  const scope = real.length === 0 ? rows : real;
  const bills = scope.map((row): StatementBill => {
    const own = row.original_currency && row.original_amount != null;
    return {
      id: row.id,
      payee: row.counterparties?.name ?? "a supplier",
      memo: row.memo,
      amount: own ? Number(row.original_amount) : Number(row.amount),
      currency: own ? row.original_currency! : (row.currency ?? "USDC"),
      createdAt: row.created_at,
      dueDate: row.due_date,
      current: newest.get(row.id) ?? null,
    };
  });
  return { bills, payees: new Map(rows.map((row) => [row.id, row.counterparties?.name ?? "a supplier"])) };
}

const CHUNK = 100;

/** The lines of a statement kept already, by their hash: each one's id, and the bill its record is for, if it has one. */
export async function readKeptLines(orgDb: OrgDb, hashes: readonly string[]): Promise<Map<string, { id: string; invoiceId: string | null }>> {
  const kept = new Map<string, { id: string; invoiceId: string | null }>();
  const unique = [...new Set(hashes)];
  for (let from = 0; from < unique.length; from += CHUNK) {
    const read = await orgDb.from("bank_statement_lines").select("id, line_hash").in("line_hash", unique.slice(from, from + CHUNK));
    if (notThere(read.error)) throw new StatementImportError("not_ready");
    if (read.error) throw new Error(read.error.message);
    for (const row of (read.data ?? []) as Array<{ id: string; line_hash: string }>) kept.set(row.line_hash, { id: row.id, invoiceId: null });
  }
  const byId = new Map([...kept.values()].map((line) => [line.id, line]));
  const ids = [...byId.keys()];
  for (let from = 0; from < ids.length; from += CHUNK) {
    const read = await orgDb.from("payment_actuals").select("statement_line_id, invoice_id").in("statement_line_id", ids.slice(from, from + CHUNK));
    if (notThere(read.error)) throw new StatementImportError("not_ready");
    if (read.error) throw new Error(read.error.message);
    for (const row of (read.data ?? []) as Array<{ statement_line_id: string; invoice_id: string }>) {
      const line = byId.get(row.statement_line_id);
      if (line) line.invoiceId = row.invoice_id;
    }
  }
  return kept;
}

export interface StatementMatched {
  read: StatementRead;
  /** Each line's match, in the order of `read.lines`; null while a question or a problem is open. */
  matches: LineMatch[] | null;
  /** Each line's hash, in the same order. */
  hashes: string[];
}

/**
 * The statement read and matched against the workspace's payables now; nothing is written. The text and the choices
 * come from the person; the lines are read here again, so what is matched is what the server read.
 */
export async function matchStatementNow(input: { account: string; text: string; choices: StatementChoices; today: string }): Promise<StatementMatched> {
  const read = readStatement(input.text, input.choices, input.today);
  if (read.questions.length > 0 || read.problems.length > 0) return { read, matches: null, hashes: [] };
  const account = statementAccount(input.account);
  if (!account) throw new StatementImportError("account");
  const orgDb = db();
  await assertReady(orgDb);
  const hashes = read.lines.map((line) => statementLineHash(account, line));
  const [{ bills, payees }, kept] = await Promise.all([readStatementBills(orgDb), readKeptLines(orgDb, hashes.filter((_, index) => read.lines[index].minor < 0))]);
  const used = hashes.map((hash): UsedLine | null => {
    const line = kept.get(hash);
    return line?.invoiceId ? { invoiceId: line.invoiceId, payee: payees.get(line.invoiceId) ?? "a bill" } : null;
  });
  return { read, matches: matchStatement(read.lines, bills, used), hashes };
}

/** As `matchStatementNow`, for the preview. */
export async function previewStatement(input: { account: string; text: string; choices: StatementChoices; today: string }): Promise<{ read: StatementRead; matches: LineMatch[] | null }> {
  const { read, matches } = await matchStatementNow(input);
  return { read, matches };
}

/** A minor-unit amount in the currency, as a number. */
const major = (minor: number, currency: string) => minor / 10 ** billDigits(currency);

/** Keeps the line, or finds it kept and not used yet (its record failed after it was written), and gives its id. */
async function keepLine(input: { actorId: string; account: string; line: StatementLine; hash: string }): Promise<string> {
  const { line } = input;
  const write = await db()
    .from("bank_statement_lines")
    .insert({
      account: input.account,
      booked_on: line.bookedOn,
      value_on: line.valueOn,
      amount: major(line.minor, line.currency),
      currency: line.currency,
      description: line.description,
      payee: line.payee || null,
      reference: line.reference || null,
      balance: line.balance === null ? null : major(line.balance, line.currency),
      file_line: line.line,
      line_hash: input.hash,
      imported_by: input.actorId,
    })
    .select("id")
    .single<{ id: string }>();
  if (!write.error) return write.data.id;
  if (notThere(write.error)) throw new StatementImportError("not_ready");
  if (write.error.code !== "23505") throw new Error(write.error.message);
  // Kept before: the same line of an earlier import whose record never came, or one saved a moment ago.
  const read = await db().from("bank_statement_lines").select("id").eq("line_hash", input.hash).limit(1);
  const id = ((read.data ?? []) as Array<{ id: string }>)[0]?.id;
  if (read.error || !id) throw new Error(read.error?.message ?? "kept line not found");
  return id;
}

/**
 * Records that the business paid the bill with this line (B8): the line kept first, then a record of a bank transfer on
 * its booking day, for its amount and currency, with its reference, naming the line; a correction when the bill has a
 * record. The signing key is checked before anything is written.
 */
export async function recordStatementLine(input: {
  actorId: string;
  account: string;
  line: StatementLine;
  invoiceId: string;
  replaces: string | null;
  today: string;
}): Promise<{ corrected: boolean }> {
  const account = statementAccount(input.account);
  if (!account) throw new StatementImportError("account");
  const { line } = input;
  assertLedgerCanSign();
  const id = await keepLine({ actorId: input.actorId, account, line, hash: statementLineHash(account, line) });
  const statementLine: StatementLineDetail = {
    id,
    account,
    line: line.line,
    bookedOn: line.bookedOn,
    valueOn: line.valueOn,
    amount: major(line.minor, line.currency),
    currency: line.currency,
    description: line.description,
    payee: line.payee || null,
    reference: line.reference || null,
    balance: line.balance === null ? null : major(line.balance, line.currency),
  };
  const { corrected } = await recordActual({
    actorId: input.actorId,
    today: input.today,
    source: "statement",
    statementLine,
    invoiceId: input.invoiceId,
    outcome: "paid",
    paidOn: line.bookedOn,
    amount: major(-line.minor, line.currency).toFixed(billDigits(line.currency)),
    currency: line.currency,
    method: "bank_transfer",
    reference: line.reference || undefined,
    replaces: input.replaces,
  });
  return { corrected };
}
