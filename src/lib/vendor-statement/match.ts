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

/** A payment to the vendor, for one of its bills: a confirmed one made here, or one the business recorded it made. */
export interface BookPayment {
  invoiceId: string;
  amount: number;
  currency: string;
  paidOn: string;
  /** Where it can be seen, for a payment on Arc mainnet; null for any other. */
  txUrl: string | null;
}

export interface StatementCheck {
  period: { from: string; to: string } | null;
  currency: string;
  counts: { lines: number; charges: number; payments: number; matchedCharges: number; matchedPayments: number };
  missing: Array<{ line: number; on: string; number: string | null; description: string; amount: number }>;
  /** Their charges for a bill rejected here: disputed, a duplicate or not theirs. */
  rejected: Array<{ line: number; number: string; billId: string; amount: number }>;
  twice: Array<{ number: string; lines: number[]; billIds: string[] }>;
  differs: Array<{ line: number; number: string; billId: string; theirs: number; ours: number }>;
  /** Charges matched by number to a bill in another currency, so their amounts were not compared. */
  notCompared: Array<{ line: number; number: string; billId: string }>;
  paidNotListed: Array<{ billId: string; number: string | null; amount: number; paidOn: string; txUrl: string | null }>;
  unknownPayments: Array<{ line: number; on: string; description: string; amount: number }>;
  notListed: Array<{ billId: string; number: string | null; amount: number | null; addedOn: string; status: string }>;
  /** Their last printed balance; what our open bills added by the statement's last day add up to, in its currency; and
   * how many open bills in another currency that leaves out. */
  balance: { theirs: number | null; ours: number; otherCurrency: number };
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

/**
 * The number an imported bill keeps at the head of its memo (invoice capture C6): the memo's first word, when it has 4
 * or more letters and digits and at least one digit, so neither "Design" nor a lone "12" is taken for one.
 */
export function memoNumber(memo: string | null): string {
  const head = sameNumber((memo ?? "").trim().split(/[\s·,;:|]+/)[0]);
  return head.length >= 4 && /\d/.test(head) ? head : "";
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

export function matchStatement(input: { lines: readonly VendorStatementLine[]; bills: readonly BookBill[]; payments: readonly BookPayment[]; currency: string }): StatementCheck {
  const { lines, currency } = input;
  // A rejected bill answers a charge only by its number, and never stands as a bill the vendor should list.
  const bills = input.bills.filter((bill) => bill.status !== "rejected");
  const rejectedBills = input.bills.filter((bill) => bill.status === "rejected");
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

  // Charges, over the whole statement at each step, so no line takes by amount a bill a later line names by number: first
  // a bill's own number, then a number at the head of its memo, then a rejected bill's number, and only then the amount.
  const used = new Set<string>();
  const answered = new Map<number, BookBill>();
  const rejected: StatementCheck["rejected"] = [];
  const byNumberPass = (pool: readonly BookBill[], numberOf: (bill: BookBill) => string, onMatch: (line: VendorStatementLine, bill: BookBill) => void) => {
    for (const line of charges) {
      const number = sameNumber(line.number);
      if (!number || answered.has(line.line)) continue;
      const bill = pool.find((candidate) => !used.has(candidate.id) && numberOf(candidate) === number);
      if (!bill) continue;
      used.add(bill.id);
      answered.set(line.line, bill);
      onMatch(line, bill);
    }
  };
  const differs: StatementCheck["differs"] = [];
  const notCompared: StatementCheck["notCompared"] = [];
  let matchedCharges = 0;
  const compare = (line: VendorStatementLine, bill: BookBill) => {
    matchedCharges += 1;
    const ours = amountIn(bill, currency);
    const number = line.number ?? "";
    if (ours === null) notCompared.push({ line: line.line, number, billId: bill.id });
    else if (Math.abs(ours - line.amount) > CENT) differs.push({ line: line.line, number, billId: bill.id, theirs: line.amount, ours });
  };
  byNumberPass(bills, (bill) => sameNumber(bill.number), compare);
  byNumberPass(bills, (bill) => (bill.number ? "" : memoNumber(bill.memo)), compare);
  byNumberPass(rejectedBills, (bill) => sameNumber(bill.number) || memoNumber(bill.memo), (line, bill) =>
    rejected.push({ line: line.line, number: line.number ?? "", billId: bill.id, amount: line.amount })
  );

  // By amount: a line with no number, or a bill with none, the same amount within 45 days, the closest pairs first.
  const hasNumber = (bill: BookBill) => sameNumber(bill.number) !== "" || memoNumber(bill.memo) !== "";
  const pairs: Array<{ line: VendorStatementLine; bill: BookBill; apart: number }> = [];
  for (const line of charges) {
    if (answered.has(line.line)) continue;
    for (const bill of bills) {
      if (used.has(bill.id) || (sameNumber(line.number) !== "" && hasNumber(bill))) continue;
      const ours = amountIn(bill, currency);
      const apart = days(bill.addedOn, line.on);
      if (ours !== null && Math.abs(ours - line.amount) <= CENT && apart <= CHARGE_DAYS) pairs.push({ line, bill, apart });
    }
  }
  pairs.sort((a, b) => a.apart - b.apart || a.line.line - b.line.line);
  for (const { line, bill } of pairs) {
    if (answered.has(line.line) || used.has(bill.id)) continue;
    used.add(bill.id);
    answered.set(line.line, bill);
    matchedCharges += 1;
  }
  const missing: StatementCheck["missing"] = charges
    .filter((line) => !answered.has(line.line))
    .map((line) => ({ line: line.line, on: line.on, number: line.number, description: line.description, amount: line.amount }));

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
  const numberOf = (id: string) => input.bills.find((bill) => bill.id === id)?.number ?? null;
  const paidNotListed = paid
    .filter((payment) => !usedPayments.has(payment.index) && within(payment.paidOn))
    .map((payment) => ({ billId: payment.invoiceId, number: numberOf(payment.invoiceId), amount: payment.inCurrency as number, paidOn: payment.paidOn, txUrl: payment.txUrl }));
  const notListed = bills
    .filter((bill) => !used.has(bill.id) && within(bill.addedOn))
    .map((bill) => ({ billId: bill.id, number: bill.number, amount: amountIn(bill, currency), addedOn: bill.addedOn, status: bill.status }));

  // Their balance: the latest day's, and on that day the line written last, which a statement listed newest first writes
  // first. Ours: our open bills added by the statement's last day, in its currency.
  const newestFirst = lines.length > 1 && lines[0].on > lines[lines.length - 1].on;
  const lastWithBalance = [...lines]
    .filter((line) => line.balance !== null)
    .sort((a, b) => a.on.localeCompare(b.on) || (newestFirst ? b.line - a.line : a.line - b.line))
    .at(-1);
  const open = bills.filter((bill) => OPEN(bill.status) && (period === null || bill.addedOn <= period.to));
  const inCurrency = open.map((bill) => amountIn(bill, currency));
  const ours = round2(inCurrency.reduce<number>((sum, amount) => sum + (amount ?? 0), 0));

  return {
    period,
    currency,
    counts: { lines: lines.length, charges: charges.length, payments: listedPayments.length, matchedCharges, matchedPayments },
    missing,
    rejected,
    twice,
    differs,
    notCompared,
    paidNotListed,
    unknownPayments,
    notListed,
    balance: { theirs: lastWithBalance?.balance ?? null, ours, otherCurrency: inCurrency.filter((amount) => amount === null).length },
  };
}
