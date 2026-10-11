import type { ActualRecord } from "../actual-payment-fields";
import { billDigits } from "../bill-amount";
import { utcDay } from "../copy";
import type { StatementLine } from "./lines";

/**
 * Which bill each money-out line of a statement paid (docs/superpowers/specs/2026-10-10-bank-statement-design.md B6,
 * B7). A bill is a candidate for a line in the same currency, booked from the day before the bill was added to 60 days
 * after its due day, for the same amount, or within 5% when the payee's name or an invoice number is in the line. One
 * line pays one bill: a line and a bill are paired when each is the other's single best, in rounds; what is left with
 * more than one best is for the person to choose. Pure: the server matches again before it saves anything.
 */

export interface StatementBill {
  id: string;
  payee: string;
  memo: string | null;
  /** The bill in its own currency: as written, when it was in a currency of its own, else the invoice's. */
  amount: number;
  currency: string;
  /** When it was added. */
  createdAt: string;
  dueDate: string | null;
  /** Its newest record of what the business paid, or null. */
  current: Pick<ActualRecord, "id" | "outcome" | "paidOn" | "amount" | "currency" | "source"> | null;
}

/** A line of the statement kept already, whose record is for this bill. */
export interface UsedLine {
  invoiceId: string;
  payee: string;
}

export interface Candidate {
  invoiceId: string;
  payee: string;
  bill: { amount: number; currency: string };
  dueDate: string | null;
  /** The same amount, in minor units. */
  exact: boolean;
  /** The payee's name in the line: 2 the whole of it, 1 one long word of it, 0 none. */
  name: 0 | 1 | 2;
  /** The invoice number found in the line. */
  number: string | null;
  /** The bill's newest record, which this would correct. */
  replaces: string | null;
  why: string[];
}

export type LineMatch =
  | { line: number; status: "money_in" }
  | { line: number; status: "used"; invoiceId: string; payee: string }
  | { line: number; status: "recorded"; invoiceId: string; payee: string }
  | { line: number; status: "matched"; candidate: Candidate; ticked: boolean }
  | { line: number; status: "choose"; candidates: Candidate[] }
  | { line: number; status: "none" };

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 60;
const NEAR = 0.05;
const dayNumber = (day: string) => Math.round(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / DAY_MS);
const minorOf = (amount: number, currency: string) => Math.round(amount * 10 ** billDigits(currency));

export function minorText(minor: number, currency: string): string {
  const digits = billDigits(currency);
  return `${(minor / 10 ** digits).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/** Words that name a company's legal form, left out of a payee's name. */
const LEGAL = new Set([
  "ltd", "limited", "pte", "pty", "inc", "incorporated", "llc", "llp", "lp", "plc", "gmbh", "ag", "kg", "ug", "co", "corp", "corporation",
  "company", "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "oy", "ab", "as", "kk", "jsc", "sdn", "bhd", "tbk", "the", "and",
]);

/** Words of a text, letters and digits only, accents dropped, in lower case; with each word as it was written. */
function wordsOf(text: string): Array<{ word: string; written: string }> {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((written) => ({ written, word: written.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase() }));
}

/**
 * The payee's name in a line: all its words there (legal words such as Ltd left out), or written together, is the whole
 * name; one word of four letters or more is a weaker find.
 */
export function nameFound(payee: string, lineText: string): { strength: 0 | 1 | 2; found: string | null } {
  const name = wordsOf(payee).filter((item) => !LEGAL.has(item.word));
  if (name.length === 0) return { strength: 0, found: null };
  const words = wordsOf(lineText).map((item) => item.word);
  const present = new Set(words);
  const together = name.map((item) => item.word).join("");
  if (name.every((item) => present.has(item.word)) || (name.length > 1 && together.length >= 5 && words.join("").includes(together))) {
    return { strength: 2, found: payee.trim() };
  }
  const word = name.find((item) => item.word.length >= 4 && present.has(item.word));
  return word ? { strength: 1, found: word.written } : { strength: 0, found: null };
}

/** An invoice number in a line: a word of the bill's memo with a digit in it, four characters or more, found whole. */
export function numberFound(memo: string | null, lineText: string): string | null {
  if (!memo) return null;
  const text = lineText.toLowerCase();
  for (const raw of memo.split(/[\s,;:()[\]]+/)) {
    const number = raw.replace(/^[#.\-/]+|[.\-/]+$/g, "");
    if (number.length < 4 || !/\d/.test(number)) continue;
    const at = new RegExp(`(^|[^\\p{L}\\p{N}])${number.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
    if (at.test(text)) return number;
  }
  return null;
}

const lineText = (line: StatementLine) => [line.description, line.payee, line.reference].filter(Boolean).join(" ");

/** The bill's newest record says what this line would record: paid on its day, its amount, in its currency. */
function recordSays(bill: StatementBill, line: StatementLine): boolean {
  const current = bill.current;
  return (
    current !== null &&
    current.outcome === "paid" &&
    current.paidOn === line.bookedOn &&
    current.currency === line.currency &&
    current.amount !== null &&
    minorOf(current.amount, line.currency) === -line.minor
  );
}

function dayWords(line: StatementLine, bill: StatementBill): string {
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  if (bill.dueDate) {
    const diff = dayNumber(line.bookedOn) - dayNumber(bill.dueDate);
    return diff === 0 ? "Paid on the due day" : `Paid ${days(Math.abs(diff))} ${diff < 0 ? "before" : "after"} the due day`;
  }
  const since = dayNumber(line.bookedOn) - dayNumber(bill.createdAt);
  return since <= 0 ? "Paid on the day the bill was added" : `Paid ${days(since)} after the bill was added`;
}

/** The bill as a candidate for the line, or null when it is not one (B6). */
function candidateFor(line: StatementLine, bill: StatementBill): Candidate | null {
  if (bill.currency !== line.currency) return null;
  const booked = dayNumber(line.bookedOn);
  if (booked < dayNumber(bill.createdAt) - 1 || booked > dayNumber(bill.dueDate ?? bill.createdAt) + WINDOW_DAYS) return null;
  const paid = -line.minor;
  const owed = minorOf(bill.amount, bill.currency);
  const exact = paid === owed;
  // The amount first: the text is searched only for a bill whose amount could be the line's.
  if (!exact && Math.abs(paid - owed) > owed * NEAR) return null;
  const text = lineText(line);
  const name = nameFound(bill.payee, text);
  const number = numberFound(bill.memo, text);
  if (!exact && !(name.strength > 0 || number)) return null;

  const current = bill.current;
  const why = [
    exact ? "Same amount" : `Amount differs: ${minorText(paid, line.currency)} paid, the bill is ${minorText(owed, bill.currency)}`,
    dayWords(line, bill),
    ...(name.strength === 2 ? [`Payee's name found: ${name.found}`] : name.strength === 1 ? [`Part of the payee's name found: ${name.found}`] : []),
    ...(number ? [`Invoice number found: ${number}`] : []),
    ...(current
      ? [
          current.outcome === "paid" && current.amount !== null && current.currency && current.paidOn
            ? `Corrects the record: ${minorText(minorOf(current.amount, current.currency), current.currency)} on ${utcDay(`${current.paidOn}T00:00:00Z`)}`
            : "Corrects the record: not paid",
        ]
      : []),
  ];
  return {
    invoiceId: bill.id,
    payee: bill.payee,
    bill: { amount: bill.amount, currency: bill.currency },
    dueDate: bill.dueDate,
    exact,
    name: name.strength,
    number,
    replaces: current?.id ?? null,
    why,
  };
}

/** How good a candidate is: an exact amount first, then the most found in the text. */
const score = (candidate: Candidate) => (candidate.exact ? 100 : 0) + (candidate.number ? 2 : 0) + candidate.name;

/**
 * Each line's match, in the order of the lines. `used` says, line by line, the bill whose record a kept line already
 * made (B9), or null for a line not used yet.
 */
export function matchStatement(lines: readonly StatementLine[], bills: readonly StatementBill[], used: ReadonlyArray<UsedLine | null>): LineMatch[] {
  const result: LineMatch[] = lines.map((line) => ({ line: line.line, status: "none" }));
  // Bills a line of this statement already stands for: used before, or said by the bill's newest record.
  const taken = new Set<string>();
  // A bill a statement line recorded is that line's: it is never offered to another line, and correcting it is done
  // from the bill's row. A line its record says still reads as already recorded.
  const fromStatement = new Set(bills.filter((bill) => bill.current?.source === "statement").map((bill) => bill.id));
  const open: number[] = [];

  lines.forEach((line, index) => {
    if (line.minor > 0) {
      result[index] = { line: line.line, status: "money_in" };
      return;
    }
    const usedBy = used[index];
    if (usedBy) {
      result[index] = { line: line.line, status: "used", invoiceId: usedBy.invoiceId, payee: usedBy.payee };
      taken.add(usedBy.invoiceId);
      return;
    }
    open.push(index);
  });

  // A line the bill's newest record already says takes that bill.
  for (const index of [...open]) {
    const recorded = bills.find((bill) => !taken.has(bill.id) && recordSays(bill, lines[index]));
    if (!recorded) continue;
    result[index] = { line: lines[index].line, status: "recorded", invoiceId: recorded.id, payee: recorded.payee };
    taken.add(recorded.id);
    open.splice(open.indexOf(index), 1);
  }

  const candidates = new Map<number, Candidate[]>();
  for (const index of open) {
    const found = bills.flatMap((bill) => (taken.has(bill.id) || fromStatement.has(bill.id) ? [] : (candidateFor(lines[index], bill) ?? [])));
    if (found.length > 0) candidates.set(index, found);
  }

  // Rounds: a line and a bill pair when each is the other's single best; paired ones leave the next round.
  const paired = new Set<string>();
  const waiting = new Set(candidates.keys());
  for (;;) {
    const bestBills = new Map<number, Candidate[]>();
    const bestLines = new Map<string, Array<{ index: number; score: number }>>();
    for (const index of waiting) {
      const left = candidates.get(index)!.filter((candidate) => !paired.has(candidate.invoiceId));
      if (left.length === 0) continue;
      const top = Math.max(...left.map(score));
      bestBills.set(index, left.filter((candidate) => score(candidate) === top));
      for (const candidate of left) bestLines.set(candidate.invoiceId, [...(bestLines.get(candidate.invoiceId) ?? []), { index, score: score(candidate) }]);
    }
    const pairs: Array<[number, Candidate]> = [];
    for (const [index, best] of bestBills) {
      if (best.length !== 1) continue;
      const rivals = bestLines.get(best[0].invoiceId)!;
      const top = Math.max(...rivals.map((rival) => rival.score));
      const atTop = rivals.filter((rival) => rival.score === top);
      if (atTop.length === 1 && atTop[0].index === index) pairs.push([index, best[0]]);
    }
    if (pairs.length === 0) break;
    for (const [index, candidate] of pairs) {
      result[index] = { line: lines[index].line, status: "matched", candidate, ticked: candidate.exact };
      paired.add(candidate.invoiceId);
      waiting.delete(index);
    }
  }

  for (const index of waiting) {
    const left = candidates.get(index)!.filter((candidate) => !paired.has(candidate.invoiceId));
    if (left.length === 0) continue;
    result[index] = { line: lines[index].line, status: "choose", candidates: [...left].sort((a, b) => score(b) - score(a)) };
  }
  return result;
}
