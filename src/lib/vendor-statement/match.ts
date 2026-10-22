import type { VendorStatementLine } from "./read";

/**
 * A vendor's statement against the books (docs/superpowers/specs/2026-10-22-vendor-statement-design.md VS3, VS4): each
 * charge against the vendor's bills, by number first, then by amount and the closest day; each payment they list
 * against the payments made to them; and what is left on either side, in words a person acts on. Pure.
 */

/** A bill to the vendor, as the books hold it. */
export interface BookBill {
  id: string;
  /** Its own number, from its `create_invoice` entry; null when it has none. */
  number: string | null;
  memo: string | null;
  amount: number;
  currency: string;
  /** The bill as written in the business's own currency, in shadow mode. */
  original: { amount: number; currency: string } | null;
  /** The day it was added, YYYY-MM-DD. */
  addedOn: string;
  status: string;
}

/** A confirmed payment to the vendor, for one of its bills. */
export interface BookPayment {
  invoiceId: string;
  amount: number;
  currency: string;
  paidOn: string;
  txUrl: string | null;
}

export interface StatementCheck {
  period: { from: string; to: string } | null;
  currency: string;
  counts: { lines: number; charges: number; payments: number; matchedCharges: number; matchedPayments: number };
  missing: Array<{ line: number; on: string; number: string | null; description: string; amount: number }>;
  twice: Array<{ number: string; lines: number[]; billIds: string[] }>;
  differs: Array<{ line: number; number: string; billId: string; theirs: number; ours: number }>;
  paidNotListed: Array<{ billId: string; number: string | null; amount: number; paidOn: string; txUrl: string | null }>;
  unknownPayments: Array<{ line: number; on: string; description: string; amount: number }>;
  notListed: Array<{ billId: string; number: string | null; amount: number | null; addedOn: string; status: string }>;
  balance: { theirs: number | null; ours: number };
}

/** How far apart a charge's day and a bill's may be to match by amount alone (VS3). */
export const CHARGE_DAYS = 45;
/** How far apart a payment they list and ours may be (VS3). */
export const PAYMENT_DAYS = 10;
const CENT = 0.005;
const DAY_MS = 86_400_000;

/** A number as compared: letters and digits only, upper case. INV-2207, inv 2207 and INV2207 are one. */
export function sameNumber(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** USD and USDC are one currency to compare in, EUR and EURC another (VS3). */
function family(currency: string): string {
  const code = currency.toUpperCase();
  if (code === "USDC") return "USD";
  if (code === "EURC") return "EUR";
  return code;
}

/** A bill's amount in the statement's currency, or null when it has none in it. */
export function amountIn(bill: Pick<BookBill, "amount" | "currency" | "original">, currency: string): number | null {
  if (family(bill.currency) === family(currency)) return bill.amount;
  if (bill.original && family(bill.original.currency) === family(currency)) return bill.original.amount;
  return null;
}

const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
const round2 = (value: number) => Math.round(value * 100) / 100;
/** Bills a vendor is still owed for: not paid, rejected or recorded as received. */
const OPEN = (status: string) => !["paid", "rejected", "received"].includes(status);

/** Whether a bill names the statement's number: its own number, or, failing one, its memo carries it. */
function namesNumber(bill: BookBill, number: string): boolean {
  if (number === "") return false;
  if (bill.number) return sameNumber(bill.number) === number;
  // An imported bill keeps its number at the head of its memo (invoice capture C6); only a number of 4 or more characters.
  return number.length >= 4 && sameNumber(bill.memo).includes(number);
}

export function matchStatement(input: { lines: readonly VendorStatementLine[]; bills: readonly BookBill[]; payments: readonly BookPayment[]; currency: string }): StatementCheck {
  const { lines, currency } = input;
  const bills = input.bills.filter((bill) => bill.status !== "rejected");
  const charges = lines.filter((line) => line.kind === "charge");
  const listedPayments = lines.filter((line) => line.kind === "payment");
  const ordered = [...lines].map((line) => line.on).sort();
  const period = ordered.length > 0 ? { from: ordered[0], to: ordered[ordered.length - 1] } : null;

  // Listed twice: on their statement, and here.
  const twice: StatementCheck["twice"] = [];
  const byNumber = new Map<string, number[]>();
  for (const line of charges) {
    const number = sameNumber(line.number);
    if (number) byNumber.set(number, [...(byNumber.get(number) ?? []), line.line]);
  }
  const billsByNumber = new Map<string, string[]>();
  for (const bill of bills) {
    const number = sameNumber(bill.number);
    if (number) billsByNumber.set(number, [...(billsByNumber.get(number) ?? []), bill.id]);
  }
  for (const number of new Set([...byNumber.keys(), ...billsByNumber.keys()])) {
    const onTheirs = byNumber.get(number) ?? [];
    const here = billsByNumber.get(number) ?? [];
    if (onTheirs.length > 1 || here.length > 1) twice.push({ number, lines: onTheirs, billIds: here });
  }

  // Charges: by number, then by amount and the closest day.
  const used = new Set<string>();
  const missing: StatementCheck["missing"] = [];
  const differs: StatementCheck["differs"] = [];
  let matchedCharges = 0;
  for (const line of charges) {
    const number = sameNumber(line.number);
    const named = number ? bills.find((bill) => !used.has(bill.id) && namesNumber(bill, number)) : undefined;
    if (named) {
      used.add(named.id);
      matchedCharges += 1;
      const ours = amountIn(named, currency);
      if (ours !== null && Math.abs(ours - line.amount) > CENT) differs.push({ line: line.line, number: line.number ?? number, billId: named.id, theirs: line.amount, ours });
      continue;
    }
    const byAmount = bills
      .filter((bill) => !used.has(bill.id) && (() => {
        const ours = amountIn(bill, currency);
        return ours !== null && Math.abs(ours - line.amount) <= CENT && days(bill.addedOn, line.on) <= CHARGE_DAYS;
      })())
      .sort((a, b) => days(a.addedOn, line.on) - days(b.addedOn, line.on))[0];
    if (byAmount) {
      used.add(byAmount.id);
      matchedCharges += 1;
      continue;
    }
    missing.push({ line: line.line, on: line.on, number: line.number, description: line.description, amount: line.amount });
  }

  // Payments they list, against ours.
  const paid = input.payments
    .map((payment, index) => ({ ...payment, index, inCurrency: family(payment.currency) === family(currency) ? payment.amount : null }))
    .filter((payment) => payment.inCurrency !== null);
  const usedPayments = new Set<number>();
  const unknownPayments: StatementCheck["unknownPayments"] = [];
  let matchedPayments = 0;
  for (const line of listedPayments) {
    const ours = paid
      .filter((payment) => !usedPayments.has(payment.index) && Math.abs((payment.inCurrency as number) - line.amount) <= CENT && days(payment.paidOn, line.on) <= PAYMENT_DAYS)
      .sort((a, b) => days(a.paidOn, line.on) - days(b.paidOn, line.on))[0];
    if (ours) {
      usedPayments.add(ours.index);
      matchedPayments += 1;
    } else {
      unknownPayments.push({ line: line.line, on: line.on, description: line.description, amount: line.amount });
    }
  }

  const within = (day: string) => period !== null && day >= period.from && day <= period.to;
  const numberOf = (id: string) => bills.find((bill) => bill.id === id)?.number ?? null;
  const paidNotListed = paid
    .filter((payment) => !usedPayments.has(payment.index) && within(payment.paidOn))
    .map((payment) => ({ billId: payment.invoiceId, number: numberOf(payment.invoiceId), amount: payment.inCurrency as number, paidOn: payment.paidOn, txUrl: payment.txUrl }));
  const notListed = bills
    .filter((bill) => !used.has(bill.id) && within(bill.addedOn))
    .map((bill) => ({ billId: bill.id, number: bill.number, amount: amountIn(bill, currency), addedOn: bill.addedOn, status: bill.status }));

  // Their balance: the last line's that prints one, by day and then by the file's order. Ours: what our open bills add up to.
  const lastWithBalance = [...lines].filter((line) => line.balance !== null).sort((a, b) => a.on.localeCompare(b.on) || a.line - b.line).at(-1);
  const ours = round2(bills.filter((bill) => OPEN(bill.status)).reduce((sum, bill) => sum + (amountIn(bill, currency) ?? 0), 0));

  return {
    period,
    currency,
    counts: { lines: lines.length, charges: charges.length, payments: listedPayments.length, matchedCharges, matchedPayments },
    missing,
    twice,
    differs,
    paidNotListed,
    unknownPayments,
    notListed,
    balance: { theirs: lastWithBalance?.balance ?? null, ours },
  };
}
