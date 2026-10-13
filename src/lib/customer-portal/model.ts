import { parseAmount, fromMicros, toMicros } from "../allocations/model";
import { utcDay } from "../copy";

/**
 * The customer portal's rules (docs/superpowers/specs/2026-10-13-customer-portal-design.md P3, P4, P7, P8), pure: what a
 * customer's form may say, when a promise or a dispute pauses the agent's reminders, what the statement shows, the words
 * the customer reads about each of its requests, and finance's next step on each. The database checks the same bounds
 * again (0109); these give the customer and finance plain words first.
 *
 * A claim of payment is the customer's word that it paid, never a payment: nothing here settles an invoice, and no words
 * here say an invoice is paid because the customer said so.
 */

export type RequestKind = "paid" | "promise" | "dispute" | "pay_link";
export const REQUEST_KINDS: readonly RequestKind[] = ["paid", "promise", "dispute", "pay_link"];
export type RequestOutcome = "resolved" | "not_received" | "superseded";
/** What a person may close a request as: superseded is the customer's own newer request, never a person's. */
export type CloseOutcome = Exclude<RequestOutcome, "superseded">;
export type Coin = "USDC" | "EURC";

/** How long a new link lasts, in days: the choice the person is given, and the default. */
export const LINK_DAYS = [7, 30, 90] as const;
export type LinkDays = (typeof LINK_DAYS)[number];
export const DEFAULT_LINK_DAYS: LinkDays = 30;
export const MESSAGE_MAX = 2000;
export const REFERENCE_MAX = 120;
/** A promise is for today up to this many days ahead. */
export const PROMISE_MAX_DAYS = 90;
/** A day paid may be up to a year back. */
export const PAID_MAX_AGE_DAYS = 366;
/** What one link may send in a day, requests and messages together (0109's cap). */
export const DAILY_LIMIT = 30;
/** Paid invoices stay on the statement this long after they were settled, at most this many. */
export const RECENT_PAID_DAYS = 90;
export const RECENT_PAID_MAX = 10;

/** The signed entries this feature writes (domain `ar`). */
export const CUSTOMER_PORTAL_ACTIONS = {
  shared: "customer_statement_shared",
  unshared: "customer_statement_unshared",
  said: {
    paid: "customer_said_paid",
    promise: "customer_promised_payment",
    dispute: "customer_disputed_invoice",
    pay_link: "customer_asked_pay_link",
  } satisfies Record<RequestKind, string>,
  customerWrote: "customer_wrote",
  replied: "customer_request_replied",
  closed: "customer_request_closed",
} as const;

/** What finance sees each kind as: a claim of payment is never called paid. */
export const KIND_LABELS: Record<RequestKind, string> = {
  paid: "Customer says paid",
  promise: "Promise to pay",
  dispute: "Dispute",
  pay_link: "Asks for a pay link",
};

export interface RequestMessage {
  id: string;
  author: "customer" | "business";
  body: string;
  createdAt: string;
  /** The member who replied; null for the customer's words, or once that member deleted their account. */
  by: string | null;
}

export interface CustomerRequest {
  id: string;
  kind: RequestKind;
  invoiceId: string;
  counterpartyId: string;
  linkId: string;
  paidOn: string | null;
  reference: string | null;
  amount: number | null;
  promisedOn: string | null;
  status: "open" | "closed";
  outcome: RequestOutcome | null;
  createdAt: string;
  closedAt: string | null;
  messages: RequestMessage[];
}

const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** "1,250.00 USDC". */
export const money = (amount: number, currency: string) => `${AMOUNT.format(amount)} ${currency}`;

/** A calendar day as UTC days since the epoch; null for anything that is not a real YYYY-MM-DD day. */
function dayNumber(day: string): number | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(at).toISOString().slice(0, 10) === day ? Math.round(at / DAY_MS) : null;
}

/** The YYYY-MM-DD day of a timestamp or a day, in UTC. */
export const dayOf = (value: string) => (DAY.test(value) ? value : new Date(value).toISOString().slice(0, 10));
/** Today in UTC, as YYYY-MM-DD. */
export const todayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
/** The day `days` after `day`. */
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** "Oct 18, 2026". */
export const dayWords = (day: string) => utcDay(`${dayOf(day)}T12:00:00Z`);

export interface SubmissionForm {
  invoiceId?: string;
  kind?: string;
  paidOn?: string;
  reference?: string;
  amount?: string;
  promisedOn?: string;
  message?: string;
}

export interface Submission {
  invoiceId: string;
  kind: RequestKind;
  paidOn: string | null;
  reference: string | null;
  amount: number | null;
  promisedOn: string | null;
  message: string | null;
}

export type SubmissionRead =
  | { ok: true; submission: Submission }
  | { ok: false; field: "form" | "paidOn" | "reference" | "amount" | "promisedOn" | "message"; message: string };

export const SUBMISSION_MESSAGES = {
  invoice: "That invoice is not on this statement.",
  kind: "Choose what you want to tell them.",
  paidOnMissing: "Enter the day you paid.",
  paidOnFuture: "The day you paid can't be after today.",
  paidOnOld: "Enter a day in the last year.",
  amount: "Enter the amount you paid, such as 1,250.00.",
  reference: `Keep the reference under ${REFERENCE_MAX} characters.`,
  promisedOnMissing: "Choose the day you will pay.",
  promisedOnPast: "Choose today or a later day.",
  promisedOnFar: `Choose a day within ${PROMISE_MAX_DAYS} days.`,
  disputeMissing: "Say what is wrong with this invoice.",
  messageLong: "Keep your message under 2,000 characters.",
} as const;

const refuse = (field: Extract<SubmissionRead, { ok: false }>["field"], message: string): SubmissionRead => ({ ok: false, field, message });

/** What the customer's form says, read and checked; today is the UTC day. */
export function readSubmission(form: SubmissionForm, today: string): SubmissionRead {
  const invoiceId = (form.invoiceId ?? "").trim();
  if (!UUID.test(invoiceId)) return refuse("form", SUBMISSION_MESSAGES.invoice);
  const kind = form.kind as RequestKind;
  if (!REQUEST_KINDS.includes(kind)) return refuse("form", SUBMISSION_MESSAGES.kind);
  const message = (form.message ?? "").trim() || null;
  if (message && message.length > MESSAGE_MAX) return refuse("message", SUBMISSION_MESSAGES.messageLong);
  const todayNumber = dayNumber(today) as number;
  const base: Submission = { invoiceId: invoiceId.toLowerCase(), kind, paidOn: null, reference: null, amount: null, promisedOn: null, message };

  if (kind === "paid") {
    const paidOn = (form.paidOn ?? "").trim();
    const paid = dayNumber(paidOn);
    if (paid === null) return refuse("paidOn", SUBMISSION_MESSAGES.paidOnMissing);
    // A day ahead of UTC is still today somewhere.
    if (paid > todayNumber + 1) return refuse("paidOn", SUBMISSION_MESSAGES.paidOnFuture);
    if (paid < todayNumber - PAID_MAX_AGE_DAYS) return refuse("paidOn", SUBMISSION_MESSAGES.paidOnOld);
    const reference = (form.reference ?? "").trim() || null;
    if (reference && reference.length > REFERENCE_MAX) return refuse("reference", SUBMISSION_MESSAGES.reference);
    const typed = (form.amount ?? "").trim();
    let amount: number | null = null;
    if (typed) {
      const micros = parseAmount(typed);
      if (micros === null || micros >= 1_000_000_000_000 * 1_000_000) return refuse("amount", SUBMISSION_MESSAGES.amount);
      amount = fromMicros(micros);
    }
    return { ok: true, submission: { ...base, paidOn, reference, amount } };
  }
  if (kind === "promise") {
    const promisedOn = (form.promisedOn ?? "").trim();
    const promised = dayNumber(promisedOn);
    if (promised === null) return refuse("promisedOn", SUBMISSION_MESSAGES.promisedOnMissing);
    if (promised < todayNumber) return refuse("promisedOn", SUBMISSION_MESSAGES.promisedOnPast);
    if (promised > todayNumber + PROMISE_MAX_DAYS) return refuse("promisedOn", SUBMISSION_MESSAGES.promisedOnFar);
    return { ok: true, submission: { ...base, promisedOn } };
  }
  if (kind === "dispute" && !message) return refuse("message", SUBMISSION_MESSAGES.disputeMissing);
  return { ok: true, submission: base };
}

export interface ReminderPause {
  reason: "promise" | "dispute" | "paid" | "promise_passed";
  /** The promised day, through which the reminders wait; null for anything that holds them until a person acts. */
  until: string | null;
}

/**
 * Whether an invoice's reminders wait, from its customer's requests (P7, and collections context C2, C3): an open
 * dispute holds them until a person resolves it; a claim of payment until a person finds the payment or marks it not
 * received; an open promise through its day; and a promise whose day passed until finance reviews it and closes it.
 */
export function reminderPause(requests: readonly Pick<CustomerRequest, "kind" | "status" | "promisedOn">[], today: string): ReminderPause | null {
  const open = requests.filter((request) => request.status === "open");
  if (open.some((request) => request.kind === "dispute")) return { reason: "dispute", until: null };
  if (open.some((request) => request.kind === "paid")) return { reason: "paid", until: null };
  const promised = open
    .filter((request) => request.kind === "promise" && request.promisedOn !== null)
    .map((request) => request.promisedOn as string)
    .sort();
  if (promised.length === 0) return null;
  const last = promised[promised.length - 1];
  return last >= today ? { reason: "promise", until: last } : { reason: "promise_passed", until: null };
}

export interface StatementInvoiceIn {
  id: string;
  amount: number;
  currency: string;
  dueDate: string;
  memo: string | null;
  poReference: string | null;
  status: string;
  settledAt: string | null;
}

export interface StatementInput {
  orgName: string;
  customerName: string;
  expiresAt: string;
  now: number;
  /** The customer's receivables, and no one else's. */
  invoices: StatementInvoiceIn[];
  /** What is still owed and was received on each part-paid invoice, from the payments applied to it. */
  owed: ReadonlyMap<string, { outstanding: number; received: number }>;
  /** Each open invoice's pay link, when it has one that can be shown. */
  payLinks: ReadonlyMap<string, string>;
  requests: CustomerRequest[];
}

export interface StatementLine {
  id: string;
  label: string;
  reference: string | null;
  amount: number;
  currency: Coin;
  owed: number;
  received: number;
  dueDate: string;
  /** Whole days past the due day; 0 when it is not overdue. */
  overdueDays: number;
  state: "open" | "overdue" | "paid";
  /** The day it was settled, for a paid invoice. */
  paidOn: string | null;
  payUrl: string | null;
  /** Its requests, open ones first, then newest first. */
  requests: CustomerRequest[];
  pause: ReminderPause | null;
}

export interface StatementTotal {
  currency: Coin;
  owed: number;
  overdue: number;
  open: number;
}

export interface StatementView {
  orgName: string;
  customerName: string;
  expiresAt: string;
  today: string;
  /** What is owed in each currency, never summed across currencies. */
  totals: StatementTotal[];
  open: StatementLine[];
  paid: StatementLine[];
}

const OPEN = new Set(["pending", "matched"]);
const PAID = new Set(["received", "paid"]);

const byOpenThenNewest = (a: CustomerRequest, b: CustomerRequest) =>
  (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/** The statement a customer's link shows: its open invoices by due day, what it owes in each currency, and recent payments. */
export function buildStatement(input: StatementInput): StatementView {
  const today = todayOf(input.now);
  const todayNumber = dayNumber(today) as number;
  const requestsBy = new Map<string, CustomerRequest[]>();
  for (const request of input.requests) requestsBy.set(request.invoiceId, [...(requestsBy.get(request.invoiceId) ?? []), request]);

  const lineOf = (invoice: StatementInvoiceIn): StatementLine => {
    const currency: Coin = invoice.currency === "EURC" ? "EURC" : "USDC";
    const dueDate = dayOf(invoice.dueDate);
    const open = OPEN.has(invoice.status);
    const balance = input.owed.get(invoice.id);
    const late = open ? Math.max(0, todayNumber - (dayNumber(dueDate) as number)) : 0;
    const requests = [...(requestsBy.get(invoice.id) ?? [])].sort(byOpenThenNewest);
    return {
      id: invoice.id,
      label: invoice.memo?.trim() || `Invoice due ${dayWords(dueDate)}`,
      reference: invoice.poReference?.trim() || null,
      amount: invoice.amount,
      currency,
      owed: open ? (balance ? balance.outstanding : invoice.amount) : 0,
      received: balance?.received ?? 0,
      dueDate,
      overdueDays: late,
      state: open ? (late > 0 ? "overdue" : "open") : "paid",
      paidOn: !open && invoice.settledAt ? dayOf(invoice.settledAt) : null,
      payUrl: open ? (input.payLinks.get(invoice.id) ?? null) : null,
      requests,
      pause: open ? reminderPause(requests, today) : null,
    };
  };

  const open = input.invoices
    .filter((invoice) => OPEN.has(invoice.status))
    .map(lineOf)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  const cutoff = input.now - RECENT_PAID_DAYS * DAY_MS;
  const paid = input.invoices
    .filter((invoice) => PAID.has(invoice.status) && invoice.settledAt !== null && Date.parse(invoice.settledAt) >= cutoff)
    .sort((a, b) => (b.settledAt as string).localeCompare(a.settledAt as string) || a.id.localeCompare(b.id))
    .slice(0, RECENT_PAID_MAX)
    .map(lineOf);

  // Summed in millionths, per currency, in the order each currency first comes due.
  const totals = new Map<Coin, { owed: number; overdue: number; open: number }>();
  for (const line of open) {
    const total = totals.get(line.currency) ?? { owed: 0, overdue: 0, open: 0 };
    total.owed += toMicros(line.owed);
    if (line.state === "overdue") total.overdue += toMicros(line.owed);
    total.open += 1;
    totals.set(line.currency, total);
  }
  return {
    orgName: input.orgName,
    customerName: input.customerName,
    expiresAt: input.expiresAt,
    today,
    totals: [...totals.entries()].map(([currency, total]) => ({ currency, owed: fromMicros(total.owed), overdue: fromMicros(total.overdue), open: total.open })),
    open,
    paid,
  };
}

export interface CustomerWords {
  title: string;
  detail: string | null;
  status: string;
}

/** What the customer reads about one of its requests, in its own words: it said, the business is doing. */
export function customerRequestWords(request: CustomerRequest, context: { orgName: string; currency: string; today: string; payUrl: string | null }): CustomerWords {
  const org = context.orgName;
  const closedOn = request.closedAt ? dayWords(request.closedAt) : null;
  const superseded = request.outcome === "superseded" ? "Replaced by what you said after it." : null;
  switch (request.kind) {
    case "paid": {
      const parts = [request.amount !== null ? money(request.amount, context.currency) : null, request.reference ? `reference ${request.reference}` : null].filter(Boolean);
      return {
        title: `You said you paid on ${dayWords(request.paidOn as string)}`,
        detail: parts.length > 0 ? parts.join(" · ") : null,
        status:
          superseded ??
          (request.status === "open"
            ? `${org} is checking for your payment. The invoice stays open until they find it.`
            : request.outcome === "not_received"
              ? `${org} has not received this payment. Check its details, then tell them again.`
              : `${org} found your payment.`),
      };
    }
    case "promise": {
      const day = request.promisedOn as string;
      return {
        title: `You promised to pay by ${dayWords(day)}`,
        detail: null,
        status:
          superseded ??
          (request.status === "closed"
            ? `Closed by ${org}${closedOn ? ` on ${closedOn}` : ""}.`
            : day >= context.today
              ? "Reminders about this invoice wait until then."
              : "That day has passed."),
      };
    }
    case "dispute":
      return {
        title: "You disputed this invoice",
        detail: null,
        status: request.status === "open" ? `Reminders about this invoice wait until ${org} resolves it.` : `${org} resolved it${closedOn ? ` on ${closedOn}` : ""}.`,
      };
    case "pay_link":
      return {
        title: "You asked for a pay link",
        detail: null,
        status: context.payUrl ? "The pay link is ready: Pay on Arc." : request.status === "open" ? `${org} will add one here.` : `${org} answered your request.`,
      };
  }
}

export interface FinanceStep {
  /** The next action, a few words. */
  label: string;
  detail: string;
  /** The ways a person may close it now. */
  closes: CloseOutcome[];
  /** Whether a reply is the step. */
  reply: boolean;
  /** Whether the step is on the invoice itself (its pay link). */
  openInvoice: boolean;
}

/** Finance's next step on an open request (P8), from the request and its invoice as they are now. */
export function financeNextStep(
  request: CustomerRequest,
  context: { invoiceOpen: boolean; payLink: boolean; sandbox: boolean; today: string; owed: number; currency: Coin }
): FinanceStep {
  const step = (label: string, detail: string, closes: CloseOutcome[], extra: Partial<Pick<FinanceStep, "reply" | "openInvoice">> = {}): FinanceStep => ({
    label,
    detail,
    closes,
    reply: extra.reply ?? false,
    openInvoice: extra.openInvoice ?? false,
  });
  if (!context.invoiceOpen) {
    return request.kind === "paid"
      ? step("Close it: the invoice is paid", "The invoice is settled now. Close this as found.", ["resolved"])
      : step("Close it: the invoice is no longer open", "Nothing is owed on this invoice now. Close this.", ["resolved"]);
  }
  switch (request.kind) {
    case "paid": {
      const amount = money(request.amount ?? context.owed, context.currency);
      const reference = request.reference ? `, reference ${request.reference}` : "";
      return step(
        "Find the payment",
        `Look for ${amount} paid on ${dayWords(request.paidOn as string)}${reference}. Once it arrived, apply it under Apply payments, then close this as found. The agent's reminders wait until you close it.`,
        ["resolved", "not_received"],
        { reply: true }
      );
    }
    case "promise": {
      const day = request.promisedOn as string;
      return day >= context.today
        ? step(`Wait until ${dayWords(day)}`, `The agent's reminders about this invoice wait through ${dayWords(day)}. Nothing to do before then.`, ["resolved"], { reply: true })
        : step(
            "Review it: the promised day passed",
            "The invoice is still open, and the agent sends no reminder until you close this. Reply or follow up, then close it to let reminders go again.",
            ["resolved"],
            { reply: true }
          );
    }
    case "dispute":
      return step("Reply, then resolve", "The agent's reminders about this invoice wait until you resolve the dispute.", ["resolved"], { reply: true });
    case "pay_link":
      if (context.sandbox) return step("Answer the customer", "A sandbox has no wallet to be paid into: pay links are made in a live workspace. Reply with how to pay, then close this.", ["resolved"], { reply: true });
      return context.payLink
        ? step("Close it: the pay link is on their statement", "Their statement shows the invoice's pay link now.", ["resolved"])
        : step("Make a pay link", "Open the invoice and make its pay link: it shows on their statement at once.", ["resolved"], { reply: true, openInvoice: true });
  }
}

/** The words of a person's close, on a button and in the entry. */
export const CLOSE_LABELS: Record<RequestKind, Partial<Record<CloseOutcome, string>>> = {
  paid: { resolved: "Payment found", not_received: "Not received" },
  promise: { resolved: "Close" },
  dispute: { resolved: "Resolve" },
  pay_link: { resolved: "Done" },
};
