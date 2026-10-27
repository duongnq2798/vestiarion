import { normalisePo, normaliseText, RECURRING_MAX_DAYS, RECURRING_MIN_DAYS, scoreDuplicate, type InvoiceLike } from "../agent/duplicates";
import { lastDayWithoutFee } from "../agent/late-fee";
import { currencyDigits, decimalKey } from "../bill-import/amounts";
import { memoWithInvoiceNumber } from "../bill-import/memo";
import type { Table } from "../bill-import/table";
import { utcDay } from "../copy";
import { sameNumber } from "../vendor-statement/match";
import { questionsOf, readBills, type CheckAnswers, type ListBill } from "./read";

/**
 * What the free bill list check finds in a list (docs/superpowers/specs/2026-10-28-check-bills-design.md CB5–CB7): likely
 * duplicates by vendor, scored by the agent's own `scoreDuplicate` with its invoice numbers compared too; runs of the same
 * amount about a month apart, which its recurring rule keeps out of the duplicates; and the early-payment discounts and
 * late fees of the next 7 days, with what each is worth, and whether the bill may repeat another. Pure: it runs in the
 * browser on what the person gave it.
 */

/**
 * Each bill is compared with at most this many bills before it that share its amount, and as many that share its
 * purchase order or its number, the ones due closest (CB5), and a run looks at as many a month before each bill (CB6):
 * 5,000 bills of one vendor and one amount are checked in a second or two.
 */
export const COMPARED_PER_BUCKET = 50;

/** The days ahead a deadline is listed for, today included (CB7). */
export const DEADLINE_DAYS = 7;

/**
 * The same invoice number for the same amount: the most `scoreDuplicate` gives a bill whose money has not left, which no
 * bill of a list is known to have. No finding is stronger.
 */
const SAME_NUMBER_CONFIDENCE = 0.85;

/** The same invoice number for a different amount, as `scoreDuplicate` weighs a purchase order billed again. */
const SAME_NUMBER_REBILLED_CONFIDENCE = 0.55;

const DAY_MS = 86_400_000;

/** A sum in one currency. */
export interface Total {
  currency: string;
  amount: number;
}

/** A bill that may repeat one due before it (CB5). */
export interface DuplicateFinding {
  /** The later bill: the one paying both would pay twice. */
  bill: ListBill;
  other: ListBill;
  confidence: number;
  /** `scoreDuplicate`'s explanation, as written; null when only the invoice numbers match. */
  explanation: string | null;
  /** The invoice numbers, when they are the same: "Row 4 has the same invoice number, BP-1042, written bp 1042 here." */
  numberWords: string | null;
  /** The later bill's amount. */
  atStake: { amount: string; currency: string };
}

export interface VendorDuplicates {
  /** The vendor's name as its first row in the list writes it. */
  vendor: string;
  findings: DuplicateFinding[];
  atStake: Total[];
}

/** Bills of one vendor for one amount, each due about a month after the one before (CB6). */
export interface MonthApartRun {
  vendor: string;
  amount: string;
  currency: string;
  bills: ListBill[];
  /** The days between each bill and the next. */
  gaps: number[];
}

/** A discount that ends, or a late fee that starts, in the next 7 days (CB7). */
export interface Deadline {
  bill: ListBill;
  kind: "discount" | "late_fee";
  /** The last day to pay and keep the discount, or to pay before the fee: `YYYY-MM-DD`. */
  lastDay: string;
  /** Days from today to `lastDay`: 0 is today. */
  daysLeft: number;
  /** The discount, or a month of a percent fee, or a fixed fee. */
  worth: Total;
  words: string;
  /** The row this bill may repeat, when it is a likely duplicate: it is checked before it is paid (CB7). */
  repeats: number | null;
}

export interface BillCheck {
  bills: ListBill[];
  /** Bills past `MAX_CHECK_BILLS`, not read. */
  leftOut: number;
  /** Bills read well enough to check. */
  checked: number;
  /** Vendors among them, by `vendorKey`. */
  vendors: number;
  duplicates: VendorDuplicates[];
  atStake: Total[];
  monthApart: MonthApartRun[];
  deadlines: Deadline[];
  /** The list has a column for early-payment discounts, and one for late fees. */
  terms: { discount: boolean; lateFee: boolean };
}

const round6 = (value: number) => Number(value.toFixed(6));

/** An amount as the page writes it: 1,250.00 USD; 120,000 JPY. */
export function moneyWords(amount: number | string, currency: string): string {
  const digits = currencyDigits(currency);
  const number = new Intl.NumberFormat("en-US", { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits }).format(Number(amount));
  return `${number} ${currency}`;
}

/** Sums by currency, in the order each currency first appears. */
export function totalsWords(totals: readonly Total[]): string {
  const words = totals.map((total) => moneyWords(total.amount, total.currency));
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** A day as the page writes it: "Oct 31, 2026". */
export const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);

function addTo(totals: Total[], currency: string, amount: number) {
  const total = totals.find((each) => each.currency === currency);
  if (total) total.amount = round6(total.amount + amount);
  else totals.push({ currency, amount: round6(amount) });
}

/** Due first, then by row: the order a bill is compared with the ones before it. */
const byDue = (a: ListBill, b: ListBill) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : a.line - b.line);

function addAt<T>(map: Map<string, T[]>, key: string, item: T) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) addAt(groups, key(item), item);
  return [...groups.values()];
}

/** A checked bill as the agent's duplicate check reads an invoice: its memo as the import would write it (B9), no status. */
function invoiceLike(bill: ListBill): InvoiceLike {
  return {
    id: `row-${bill.line}`,
    counterpartyId: bill.vendorKey,
    amount: Number(bill.amount),
    currency: bill.currency!,
    memo: memoWithInvoiceNumber(bill.invoiceNumber, bill.memo),
    poReference: bill.poReference,
    dueDate: bill.dueDate!,
    status: "",
  };
}

const amountKey = (bill: ListBill) => `${bill.currency} ${decimalKey(bill.amount!)}`;

/**
 * A bill's invoice number as compared (CB5): its letters and digits as `sameNumber` reads them, and only when they hold
 * a digit other than 0, so a placeholder a sheet fills an empty cell with ("N/A", "none", "TBD", "0") is no number.
 */
function numberOf(bill: ListBill): string {
  const number = sameNumber(bill.invoiceNumber);
  return /[1-9]/.test(number) ? number : "";
}

function numberWordsOf(bill: ListBill, other: ListBill, sameAmount: boolean): string {
  const named = other.invoiceNumber === bill.invoiceNumber ? other.invoiceNumber : `${other.invoiceNumber}, written ${bill.invoiceNumber} here`;
  return sameAmount
    ? `Row ${other.line} has the same invoice number, ${named}.`
    : `Row ${other.line} has the same invoice number, ${named}, for a different amount: ${moneyWords(other.amount!, other.currency!)}.`;
}

/** A checked bill with what it is compared by, worked out once. */
interface Compared {
  bill: ListBill;
  like: InvoiceLike;
  amount: string;
  po: string | null;
  number: string;
  /** Its description as `scoreDuplicate` compares it: the memo the import would write, case and spaces aside. */
  memo: string | null;
  /** Its due date as a count of days, to find the bills a month before it. */
  day: number;
}

function compared(bill: ListBill): Compared {
  const like = invoiceLike(bill);
  return {
    bill,
    like,
    amount: amountKey(bill),
    po: normalisePo(bill.poReference),
    number: numberOf(bill),
    memo: normaliseText(like.memo),
    day: Math.round(Date.parse(`${bill.dueDate}T00:00:00.000Z`) / DAY_MS),
  };
}

/** The buckets beside its amount a bill is found in: its purchase order and its invoice number, as each is compared. */
const keysOf = (bill: Compared) => [...(bill.po ? [`po ${bill.po}`] : []), ...(bill.number ? [`number ${bill.number}`] : [])];

/**
 * Two bills of one vendor and one amount that the agent's recurring rule spares (CB6): the later due 24 to 32 days after
 * the earlier, with no purchase order or invoice number in common, either of which makes them a likely duplicate.
 */
function monthApartPair(later: Compared, earlier: Compared): boolean {
  const gap = later.day - earlier.day;
  if (gap < RECURRING_MIN_DAYS || gap > RECURRING_MAX_DAYS) return false;
  return !(later.po !== null && later.po === earlier.po) && !(later.number !== "" && later.number === earlier.number);
}

/** The first place in `indexes`, in order of due date, whose bill is due on `day` or after. */
function firstDueFrom(indexes: readonly number[], sorted: readonly Compared[], day: number): number {
  let low = 0;
  let high = indexes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[indexes[middle]].day < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** One bill against one due before it: the agent's score, and the invoice numbers. */
function compare(later: Compared, earlier: Compared): DuplicateFinding | null {
  const { bill } = later;
  const other = earlier.bill;
  const match = scoreDuplicate(later.like, earlier.like);
  const sameInvoice = later.number !== "" && later.number === earlier.number;
  if (!match && !sameInvoice) return null;
  const sameAmount = later.amount === earlier.amount;
  const numberConfidence = sameInvoice ? (sameAmount ? SAME_NUMBER_CONFIDENCE : SAME_NUMBER_REBILLED_CONFIDENCE) : 0;
  return {
    bill,
    other,
    confidence: Math.max(match?.confidence ?? 0, numberConfidence),
    explanation: match?.explanation ?? null,
    numberWords: sameInvoice ? numberWordsOf(bill, other, sameAmount) : null,
    atStake: { amount: bill.amount!, currency: bill.currency! },
  };
}

/** The stronger finding; between two as strong, the one against the bill due closer before it. */
function stronger(a: DuplicateFinding, b: DuplicateFinding | null): DuplicateFinding {
  if (!b || a.confidence !== b.confidence) return !b || a.confidence > b.confidence ? a : b;
  return byDue(a.other, b.other) > 0 ? a : b;
}

/**
 * Likely duplicates (CB5): within each vendor, each bill against the bills due before it that share its amount, purchase
 * order or invoice number, the closest `COMPARED_PER_BUCKET` of each, kept with its strongest match. Strongest vendors first.
 * A bill that follows one of the same amount and description a month before it is the next month of that charge: it is
 * compared by amount only with the bills since, not with the months before, which the agent's rule would take for repeats.
 */
export function likelyDuplicates(bills: readonly ListBill[]): VendorDuplicates[] {
  const vendors: VendorDuplicates[] = [];
  for (const group of groupBy(bills.filter((bill) => bill.checked), (bill) => bill.vendorKey)) {
    const sorted = [...group].sort(byDue).map(compared);
    const buckets = new Map<string, number[]>();
    const findings: DuplicateFinding[] = [];
    sorted.forEach((bill, index) => {
      const sameAmount = buckets.get(`amount ${bill.amount}`) ?? [];
      const monthBefore = firstDueFrom(sameAmount, sorted, bill.day - RECURRING_MAX_DAYS);
      const since = firstDueFrom(sameAmount, sorted, bill.day - RECURRING_MIN_DAYS + 1);
      let monthly = false;
      for (let at = monthBefore; at < since && !monthly; at++) {
        const earlier = sorted[sameAmount[at]];
        monthly = bill.memo !== null && earlier.memo === bill.memo && monthApartPair(bill, earlier);
      }
      const byAmount = sameAmount.slice(Math.max(monthly ? monthBefore : 0, sameAmount.length - COMPARED_PER_BUCKET));
      const byKeys = keysOf(bill).flatMap((key) => (buckets.get(key) ?? []).slice(-COMPARED_PER_BUCKET));
      // The closest first: a later index is due later. Past the strongest finding there is, nothing farther can beat it.
      const before = [...new Set([...byAmount, ...byKeys])].sort((a, b) => b - a);
      let best: DuplicateFinding | null = null;
      for (const at of before) {
        const finding = compare(bill, sorted[at]);
        if (finding) best = stronger(finding, best);
        if (best && best.confidence >= SAME_NUMBER_CONFIDENCE) break;
      }
      if (best) findings.push(best);
      for (const key of [`amount ${bill.amount}`, ...keysOf(bill)]) addAt(buckets, key, index);
    });
    if (findings.length === 0) continue;
    findings.sort((a, b) => b.confidence - a.confidence || a.bill.line - b.bill.line);
    const atStake: Total[] = [];
    for (const finding of findings) addTo(atStake, finding.atStake.currency, Number(finding.atStake.amount));
    const first = group.reduce((earliest, bill) => (bill.line < earliest.line ? bill : earliest));
    vendors.push({ vendor: first.vendor, findings, atStake });
  }
  const top = (vendor: VendorDuplicates) => vendor.findings[0].confidence;
  const staked = (vendor: VendorDuplicates) => vendor.atStake.reduce((sum, total) => sum + total.amount, 0);
  return vendors.sort((a, b) => top(b) - top(a) || staked(b) - staked(a) || a.vendor.localeCompare(b.vendor));
}

/**
 * Runs of the same amount about a month apart (CB6): bills of one vendor, in one currency, for one amount, each due
 * `RECURRING_MIN_DAYS` to `RECURRING_MAX_DAYS` after the one before it in the run, with no purchase order or invoice
 * number in common (`monthApartPair`). Each bill follows the closest such bill before it that no other bill follows yet,
 * one already in a run first, so a bill of the same amount between two months, or a month sent twice, breaks no run.
 */
export function monthApart(bills: readonly ListBill[]): MonthApartRun[] {
  const runs: MonthApartRun[] = [];
  for (const group of groupBy(bills.filter((bill) => bill.checked), (bill) => `${bill.vendorKey}\n${amountKey(bill)}`)) {
    const sorted = [...group].sort(byDue).map(compared);
    const all = sorted.map((_, index) => index);
    const follows = new Map<number, number>();
    const followed = new Map<number, number>();
    sorted.forEach((bill, index) => {
      const open: number[] = [];
      const from = firstDueFrom(all, sorted, bill.day - RECURRING_MAX_DAYS);
      for (let at = firstDueFrom(all, sorted, bill.day - RECURRING_MIN_DAYS + 1) - 1; at >= from && open.length < COMPARED_PER_BUCKET; at--) {
        if (!followed.has(at) && monthApartPair(bill, sorted[at])) open.push(at);
      }
      const earlier = open.find((at) => follows.has(at)) ?? open[0];
      if (earlier === undefined) return;
      follows.set(index, earlier);
      followed.set(earlier, index);
    });
    sorted.forEach((first, index) => {
      if (follows.has(index) || !followed.has(index)) return;
      const run = [index];
      for (let at = followed.get(index); at !== undefined; at = followed.get(at)) run.push(at);
      runs.push({
        vendor: first.bill.vendor,
        amount: decimalKey(first.bill.amount!),
        currency: first.bill.currency!,
        bills: run.map((at) => sorted[at].bill),
        gaps: run.slice(1).map((at, step) => sorted[at].day - sorted[run[step]].day),
      });
    });
  }
  return runs.sort((a, b) => a.bills[0].line - b.bills[0].line);
}

/**
 * The deadlines of the next `DEADLINE_DAYS` days from `today` (CB7): a discount whose last day is today or within them,
 * and a late fee whose first day falls in them, so its last day without the fee does. Nearest first. A deadline of a bill
 * that may repeat another names that row, so the page does not urge paying it without a look.
 */
export function deadlinesOf(bills: readonly ListBill[], today: string, duplicates: readonly VendorDuplicates[]): Deadline[] {
  const repeated = new Map(duplicates.flatMap((vendor) => vendor.findings.map((finding) => [finding.bill.line, finding.other.line] as const)));
  const deadlines: Deadline[] = [];
  const soon = (day: string) => {
    const left = daysBetween(today, day);
    return left >= 0 && left < DEADLINE_DAYS ? left : null;
  };
  for (const bill of bills) {
    if (!bill.checked) continue;
    const amount = Number(bill.amount);
    const currency = bill.currency!;
    if (bill.discount) {
      const left = soon(bill.discount.deadline);
      if (left !== null) {
        const worth = round6((amount * bill.discount.pct) / 100);
        deadlines.push({
          bill,
          kind: "discount",
          lastDay: bill.discount.deadline,
          daysLeft: left,
          worth: { amount: worth, currency },
          words: `Pay by ${dayWords(bill.discount.deadline)} to keep the ${bill.discount.pct}% early-payment discount: ${moneyWords(worth, currency)}.`,
          repeats: repeated.get(bill.line) ?? null,
        });
      }
    }
    if (bill.lateFee && bill.lateFee.startsOn > today) {
      const lastDay = lastDayWithoutFee(bill.lateFee);
      const left = soon(lastDay);
      if (left !== null) {
        const fee = bill.lateFee;
        const worth = fee.kind === "fixed" ? fee.value : round6((amount * fee.value) / 100);
        deadlines.push({
          bill,
          kind: "late_fee",
          lastDay,
          daysLeft: left,
          worth: { amount: worth, currency },
          words:
            fee.kind === "fixed"
              ? `Pay by ${dayWords(lastDay)} to avoid a ${moneyWords(worth, currency)} late fee.`
              : `Pay by ${dayWords(lastDay)} to avoid a ${fee.value}% monthly late fee: ${moneyWords(worth, currency)} a month.`,
          repeats: repeated.get(bill.line) ?? null,
        });
      }
    }
  }
  return deadlines.sort((a, b) => (a.lastDay < b.lastDay ? -1 : a.lastDay > b.lastDay ? 1 : a.bill.line - b.bill.line));
}

/** Everything the check finds in a list, read with the person's answers, its deadlines from `today` (`YYYY-MM-DD`). */
export function checkBills(table: Table, answers: CheckAnswers, today: string): BillCheck {
  const bills = readBills(table, answers);
  const checked = bills.filter((bill) => bill.checked);
  const duplicates = likelyDuplicates(bills);
  const atStake: Total[] = [];
  for (const vendor of duplicates) for (const total of vendor.atStake) addTo(atStake, total.currency, total.amount);
  return {
    bills,
    leftOut: questionsOf(table, answers).leftOut,
    checked: checked.length,
    vendors: new Set(checked.map((bill) => bill.vendorKey)).size,
    duplicates,
    atStake,
    monthApart: monthApart(bills),
    deadlines: deadlinesOf(bills, today, duplicates),
    terms: {
      discount: answers.mapping.discountPct !== undefined,
      lateFee: answers.mapping.lateFeePercent !== undefined || answers.mapping.lateFeeAmount !== undefined,
    },
  };
}
