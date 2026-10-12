/**
 * Money received applied to receivables, pure (docs/superpowers/specs/2026-10-12-allocations-design.md L4, L6–L8).
 *
 * What each receivable still owes and what each incoming payment has left, from the rows of `receivable_allocations`
 * (0103), and what one press may write: refused here, in plain words, in the same cases migration 0103's trigger
 * refuses, so a person reads why before anything is written, and the database still holds the line when two people
 * act at once. Amounts are whole millionths (the 6 places `numeric(20,6)` keeps), so sums never drift; currencies are
 * never added together.
 */

export type Coin = "USDC" | "EURC";
export type AllocationKind = "payment" | "fee" | "reversal";
export type AllocationBasis = "sender" | "amount" | "person";

/** Millionths in one unit. */
export const MICROS = 1_000_000;
/** The most characters a fee's or a reversal's reason holds. */
export const REASON_MAX = 280;

export const toMicros = (amount: number | string): number => Math.round(Number(amount) * MICROS);
export const fromMicros = (micros: number): number => micros / MICROS;

const PLAIN = /^\d+(?:\.\d{1,6})?$/;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?$/;

/** An amount as a person types it ("1250", "1,250.00", up to 6 places), in millionths; null when it is not one above zero. */
export function parseAmount(typed: string): number | null {
  const text = typed.trim();
  if (!PLAIN.test(text) && !GROUPED.test(text)) return null;
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  const micros = Number(whole) * MICROS + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

const WORDS = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** "1,250.00 USDC", "1.234567 USDC". */
export function amountWords(micros: number, currency: string): string {
  return `${WORDS.format(fromMicros(micros))} ${currency}`;
}

/** A row of `receivable_allocations`, its amount in millionths. */
export interface AllocationRow {
  id: string;
  kind: AllocationKind;
  invoiceId: string;
  transferId: string | null;
  amount: number;
  currency: Coin;
  reverses: string | null;
  reason: string | null;
  basis: AllocationBasis | null;
  paymentSeq: number | null;
  createdBy: string | null;
  createdAt: string;
}

/** An incoming payment on Arc (`incoming_transfers`), its amount in millionths. */
export interface PaymentIn {
  id: string;
  circleTxId: string;
  txHash: string | null;
  from: string | null;
  amount: number;
  currency: Coin;
  receivedAt: string;
  /** The receivable a whole match settled with all of it (0050's `invoice_id`), or null. */
  wholeMatch: string | null;
  /** A reference the payment carries, such as an invoice number; an Arc transfer carries none. */
  reference?: string | null;
}

/** A receivable, its amount in millionths. */
export interface ReceivableIn {
  id: string;
  counterpartyId: string;
  customer: string;
  amount: number;
  currency: Coin;
  status: string;
  dueDate: string;
  createdAt: string;
  memo: string | null;
  poReference: string | null;
}

/** The statuses a receivable takes money in. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "matched"]);

/** The rows still in force: a payment or a fee no reversal names. */
export function liveRows(rows: readonly AllocationRow[]): AllocationRow[] {
  const reversed = new Set(rows.flatMap((row) => (row.kind === "reversal" && row.reverses ? [row.reverses] : [])));
  return rows.filter((row) => row.kind !== "reversal" && !reversed.has(row.id));
}

const sum = (rows: readonly AllocationRow[]) => rows.reduce((total, row) => total + row.amount, 0);

export interface AppliedLine {
  allocationId: string;
  kind: "payment" | "fee";
  amount: number;
  transferId: string | null;
  reason: string | null;
  basis: AllocationBasis | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ReceivableBalance {
  invoiceId: string;
  currency: Coin;
  amount: number;
  /** What the customer's payments brought to it. */
  paid: number;
  /** What a person marked as fees: applied, never paid by the customer. */
  fees: number;
  applied: number;
  outstanding: number;
  state: "open" | "part_paid" | "paid" | "closed";
  /** The payments and fees in force, oldest first. */
  lines: AppliedLine[];
  /** Settled by a whole match (0050): one transfer, all of it. */
  wholeMatch: boolean;
}

/** What a receivable holds now (L4). */
export function receivableBalance(receivable: ReceivableIn, rows: readonly AllocationRow[], wholeMatch: boolean): ReceivableBalance {
  const live = liveRows(rows.filter((row) => row.invoiceId === receivable.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const paidRows = live.filter((row) => row.kind === "payment");
  const feeRows = live.filter((row) => row.kind === "fee");
  const lines = live.map((row): AppliedLine => ({
    allocationId: row.id,
    kind: row.kind === "fee" ? "fee" : "payment",
    amount: row.amount,
    transferId: row.transferId,
    reason: row.reason,
    basis: row.basis,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));
  const base = { invoiceId: receivable.id, currency: receivable.currency, amount: receivable.amount, lines, wholeMatch };
  const fees = sum(feeRows);
  if (receivable.status === "received" || receivable.status === "paid") {
    // Received another way (a whole match, by hand, sample history): all of it, as the status says.
    const paid = live.length === 0 ? receivable.amount : sum(paidRows);
    return { ...base, paid, fees, applied: paid + fees, outstanding: 0, state: "paid" };
  }
  const paid = sum(paidRows);
  const applied = paid + fees;
  if (!OPEN_STATUSES.has(receivable.status)) return { ...base, paid, fees, applied, outstanding: 0, state: "closed" };
  const outstanding = Math.max(0, receivable.amount - applied);
  return { ...base, paid, fees, applied, outstanding, state: outstanding === 0 ? "paid" : applied > 0 ? "part_paid" : "open" };
}

export interface PaymentBalance {
  paymentId: string;
  currency: Coin;
  amount: number;
  applied: number;
  unapplied: number;
  /** How many rows name this payment: the next one a person writes is this plus one. */
  version: number;
  /** The customer its applications in force name, or null. */
  customerId: string | null;
  /** The payment rows in force, oldest first. */
  lines: AllocationRow[];
}

/** What a payment has applied and has left now (L4, L6). */
export function paymentBalance(payment: PaymentIn, rows: readonly AllocationRow[], receivables: ReadonlyMap<string, ReceivableIn>): PaymentBalance {
  const own = rows.filter((row) => row.transferId === payment.id);
  const version = own.reduce((highest, row) => Math.max(highest, row.paymentSeq ?? 0), 0);
  const lines = liveRows(own)
    .filter((row) => row.kind === "payment")
    .sort((a, b) => (a.paymentSeq ?? 0) - (b.paymentSeq ?? 0));
  const base = { paymentId: payment.id, currency: payment.currency, amount: payment.amount, version, lines };
  if (payment.wholeMatch) return { ...base, applied: payment.amount, unapplied: 0, customerId: receivables.get(payment.wholeMatch)?.counterpartyId ?? null };
  const applied = sum(lines);
  const customerId = lines.map((line) => receivables.get(line.invoiceId)?.counterpartyId).find((id): id is string => Boolean(id)) ?? null;
  return { ...base, applied, unapplied: Math.max(0, payment.amount - applied), customerId };
}

export type AllocationErrorCode =
  | "not_ready"
  | "nothing"
  | "no_payment"
  | "payment_matched"
  | "stale"
  | "amount"
  | "duplicate"
  | "not_a_receivable"
  | "closed"
  | "receivable_matched"
  | "currency"
  | "other_customer"
  | "exceeds_payment"
  | "exceeds_receivable"
  | "reason_required"
  | "reason_too_long"
  | "fee_without_payment"
  | "fee_left"
  | "not_found"
  | "not_reversible"
  | "already_reversed";

export const ALLOCATION_MESSAGES: Record<AllocationErrorCode, string> = {
  not_ready: "Applying payments is not set up on this deployment yet.",
  nothing: "Choose at least one invoice to apply the payment to.",
  no_payment: "That payment is not in this workspace.",
  payment_matched: "That payment was already matched to an invoice in full.",
  stale: "Someone applied this payment a moment ago. Reload the page to see what is left of it.",
  amount: "Type each amount above zero, such as 250.00.",
  duplicate: "Each invoice can appear once.",
  not_a_receivable: "That is not an invoice to collect in this workspace.",
  closed: "That invoice is not open any more.",
  receivable_matched: "A payment was already matched to that invoice in full.",
  currency: "The payment and the invoice are in different currencies. Apply it to an invoice in the same currency.",
  other_customer: "One payment is applied to one customer's invoices.",
  exceeds_payment: "That is more than is left of the payment.",
  exceeds_receivable: "That is more than is still owed on the invoice.",
  reason_required: "Say in a few words why it is a fee, or why you reverse it.",
  reason_too_long: `Keep the reason to ${REASON_MAX} characters.`,
  fee_without_payment: "A fee is recorded beside a payment applied to the same invoice.",
  fee_left: "Reverse the fee recorded beside this payment first.",
  not_found: "That is not in this workspace.",
  not_reversible: "Only a payment or a fee applied can be reversed.",
  already_reversed: "That was reversed already. Reload the page to see it.",
};

export type Refusal = { ok: false; code: AllocationErrorCode; message: string };
const refuse = (code: AllocationErrorCode): Refusal => ({ ok: false, code, message: ALLOCATION_MESSAGES[code] });

export class AllocationError extends Error {
  constructor(readonly code: AllocationErrorCode) {
    super(ALLOCATION_MESSAGES[code]);
    this.name = "AllocationError";
  }
}

/** The trigger's refusals (0103), by the word that starts each message. */
const DB_CODES: Record<string, AllocationErrorCode> = {
  allocation_no_payment: "no_payment",
  allocation_not_a_receivable: "not_a_receivable",
  allocation_not_reversible: "not_reversible",
  allocation_reversal_mismatch: "not_reversible",
  allocation_fee_left: "fee_left",
  allocation_receivable_closed: "closed",
  allocation_currency: "currency",
  allocation_receivable_matched: "receivable_matched",
  allocation_exceeds_receivable: "exceeds_receivable",
  allocation_fee_without_payment: "fee_without_payment",
  allocation_payment_matched: "payment_matched",
  allocation_other_customer: "other_customer",
  allocation_exceeds_payment: "exceeds_payment",
  allocation_stale: "stale",
};

/** A refusal from PostgREST or Postgres as one of ours; null for any other failure. */
export function allocationErrorFromDb(error: { code?: string; message?: string } | null): AllocationError | null {
  if (!error) return null;
  const message = error.message ?? "";
  if (error.code === "PGRST205" || error.code === "42P01" || (/receivable_allocations/.test(message) && /schema cache|does not exist/.test(message))) {
    return new AllocationError("not_ready");
  }
  if (error.code === "23505") {
    if (message.includes("receivable_allocations_one_reversal")) return new AllocationError("already_reversed");
    if (message.includes("receivable_allocations_payment_seq")) return new AllocationError("stale");
    return null;
  }
  const word = /^(\w+):/.exec(message)?.[1];
  const code = word ? DB_CODES[word] : undefined;
  return code ? new AllocationError(code) : null;
}

/** A row one press writes. */
export interface PlannedRow {
  kind: AllocationKind;
  invoiceId: string;
  transferId: string | null;
  amount: number;
  currency: Coin;
  reason: string | null;
  basis?: AllocationBasis | null;
  reverses?: string;
  paymentSeq: number | null;
}

export interface ApplicationInput {
  /** The payment applied; null to record only a fee beside a payment applied before. */
  payment: PaymentIn | null;
  /** The payment's version as the person read it; null for the agent, which names none. */
  version: number | null;
  lines: ReadonlyArray<{ invoiceId: string; amount: number }>;
  fees: ReadonlyArray<{ invoiceId: string; amount: number; reason: string }>;
}

export interface Book {
  receivables: readonly ReceivableIn[];
  rows: readonly AllocationRow[];
  /** Receivables a whole match settled (0050's `invoice_id`). */
  wholeMatched: ReadonlySet<string>;
}

export type ApplicationPlan = { ok: true; rows: PlannedRow[]; unappliedAfter: number; outstandingAfter: Map<string, number> } | Refusal;

function reasonOf(typed: string): string | Refusal {
  const reason = typed.trim();
  if (reason === "") return refuse("reason_required");
  if (reason.length > REASON_MAX) return refuse("reason_too_long");
  return reason;
}

/**
 * The rows one application writes (L4–L7), or why not: payment rows first, by receivable, numbered after the version the
 * person read, then each fee after the payment beside it. Payments and receivables are locked in that order by the
 * trigger, so two presses over the same receivables never wait on each other the wrong way round.
 */
export function planApplication(input: ApplicationInput, book: Book, basis: AllocationBasis): ApplicationPlan {
  const { payment } = input;
  if (input.lines.length === 0 && input.fees.length === 0) return refuse("nothing");
  if (!payment && input.lines.length > 0) return refuse("no_payment");
  const byId = new Map(book.receivables.map((receivable) => [receivable.id, receivable]));

  let paymentState: PaymentBalance | null = null;
  if (payment) {
    if (payment.wholeMatch) return refuse("payment_matched");
    paymentState = paymentBalance(payment, book.rows, byId);
    if (input.version !== null && input.version !== paymentState.version) return refuse("stale");
  }

  const seenLines = new Set<string>();
  const seenFees = new Set<string>();
  for (const line of [...input.lines, ...input.fees]) {
    if (!Number.isSafeInteger(line.amount) || line.amount <= 0) return refuse("amount");
  }
  for (const line of input.lines) {
    if (seenLines.has(line.invoiceId)) return refuse("duplicate");
    seenLines.add(line.invoiceId);
  }
  for (const fee of input.fees) {
    if (seenFees.has(fee.invoiceId)) return refuse("duplicate");
    seenFees.add(fee.invoiceId);
  }

  const touched = [...new Set([...input.lines.map((line) => line.invoiceId), ...input.fees.map((fee) => fee.invoiceId)])];
  const balances = new Map<string, ReceivableBalance>();
  for (const id of touched) {
    const receivable = byId.get(id);
    if (!receivable) return refuse("not_a_receivable");
    if (!OPEN_STATUSES.has(receivable.status)) return refuse("closed");
    if (book.wholeMatched.has(id)) return refuse("receivable_matched");
    if (payment && seenLines.has(id) && receivable.currency !== payment.currency) return refuse("currency");
    balances.set(id, receivableBalance(receivable, book.rows, false));
  }

  // One payment, one customer (L6): the one its applications already name, and the same for every line.
  if (payment && paymentState) {
    const customers = new Set(input.lines.map((line) => (byId.get(line.invoiceId) as ReceivableIn).counterpartyId));
    if (paymentState.customerId) customers.add(paymentState.customerId);
    if (customers.size > 1) return refuse("other_customer");
    const total = input.lines.reduce((running, line) => running + line.amount, 0);
    if (total > paymentState.unapplied) return refuse("exceeds_payment");
  }

  const outstandingAfter = new Map<string, number>();
  for (const id of [...touched].sort()) {
    const balance = balances.get(id) as ReceivableBalance;
    const paidNow = input.lines.find((line) => line.invoiceId === id)?.amount ?? 0;
    const fee = input.fees.find((candidate) => candidate.invoiceId === id);
    if (paidNow + (fee?.amount ?? 0) > balance.outstanding) return refuse("exceeds_receivable");
    if (fee) {
      const reason = reasonOf(fee.reason);
      if (typeof reason !== "string") return reason;
      if (balance.paid + paidNow <= 0) return refuse("fee_without_payment");
    }
    outstandingAfter.set(id, balance.outstanding - paidNow - (fee?.amount ?? 0));
  }

  const ordered = [...input.lines].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  const rows: PlannedRow[] = ordered.map((line, index) => ({
    kind: "payment",
    invoiceId: line.invoiceId,
    transferId: (payment as PaymentIn).id,
    amount: line.amount,
    currency: (payment as PaymentIn).currency,
    reason: null,
    basis,
    paymentSeq: input.version === null ? null : input.version + index + 1,
  }));
  for (const fee of [...input.fees].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))) {
    rows.push({
      kind: "fee",
      invoiceId: fee.invoiceId,
      transferId: null,
      amount: fee.amount,
      currency: (byId.get(fee.invoiceId) as ReceivableIn).currency,
      reason: fee.reason.trim(),
      basis: null,
      paymentSeq: null,
    });
  }
  const unappliedAfter = paymentState ? paymentState.unapplied - ordered.reduce((running, line) => running + line.amount, 0) : 0;
  return { ok: true, rows, unappliedAfter, outstandingAfter };
}

export type ReversalPlan = { ok: true; rows: PlannedRow[] } | Refusal;

/**
 * The reversal of one row (L8), or why not. Reversing a receivable's last payment in force takes the fees beside it
 * too, fees first, since a fee stands only beside a payment.
 */
export function planReversal(input: { allocationId: string; reason: string }, rows: readonly AllocationRow[]): ReversalPlan {
  const target = rows.find((row) => row.id === input.allocationId);
  if (!target) return refuse("not_found");
  if (target.kind === "reversal") return refuse("not_reversible");
  if (rows.some((row) => row.kind === "reversal" && row.reverses === target.id)) return refuse("already_reversed");
  const reason = reasonOf(input.reason);
  if (typeof reason !== "string") return reason;

  const reversal = (row: AllocationRow): PlannedRow => ({
    kind: "reversal",
    invoiceId: row.invoiceId,
    transferId: row.transferId,
    amount: row.amount,
    currency: row.currency,
    reason,
    reverses: row.id,
    paymentSeq: null,
  });
  const live = liveRows(rows.filter((row) => row.invoiceId === target.invoiceId));
  const otherPayments = live.filter((row) => row.kind === "payment" && row.id !== target.id);
  const fees = target.kind === "payment" && otherPayments.length === 0 ? live.filter((row) => row.kind === "fee") : [];
  return { ok: true, rows: [...fees.map(reversal), reversal(target)] };
}
