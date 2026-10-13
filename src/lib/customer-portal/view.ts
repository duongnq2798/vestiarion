import { utcDay } from "../copy";
import { CLOSE_LABELS, dayWords, financeNextStep, KIND_LABELS, money, reminderPause, type Coin, type CustomerRequest, type FinanceStep, type RequestKind } from "./model";

/**
 * The Receivables tab's view of customer statements (docs/superpowers/specs/2026-10-13-customer-portal-design.md P8, P9),
 * pure: each open request as finance reads it, and each link not stopped. The page and the pictures build both with
 * these, from what they read.
 */

export interface FromCustomerInvoice {
  id: string;
  counterpartyName: string;
  amount: number;
  currency: string | null;
  status: string;
  dueDate: string;
  memo: string | null;
}

export interface FromCustomerView {
  id: string;
  kind: RequestKind;
  kindLabel: string;
  customerName: string;
  invoiceLabel: string;
  invoiceHref: string;
  owed: string;
  said: string;
  on: string;
  pause: string | null;
  messages: Array<{ id: string; who: string; business: boolean; body: string; on: string }>;
  step: FinanceStep;
  closeLabels: (typeof CLOSE_LABELS)[RequestKind];
}

const OPEN = new Set(["pending", "matched"]);
const PAID = new Set(["received", "paid"]);

/** What the customer said, in one sentence for finance. */
export function saidWords(request: CustomerRequest, currency: string): string {
  switch (request.kind) {
    case "paid": {
      const amount = request.amount !== null ? ` ${money(request.amount, currency)}` : "";
      const reference = request.reference ? `, reference ${request.reference}` : "";
      return `Says it paid${amount} on ${dayWords(request.paidOn as string)}${reference}.`;
    }
    case "promise":
      return `Promises to pay by ${dayWords(request.promisedOn as string)}.`;
    case "dispute":
      return "Disputes this invoice.";
    case "pay_link":
      return "Asks for a pay link to pay on Arc.";
  }
}

/**
 * What a receivable's row says its customer said on its statement, from its open requests: its word, never a payment.
 * A dispute first, then a claim of payment, a promise, a pay link asked for.
 */
export function customerNote(requests: readonly CustomerRequest[]): string | null {
  const open = requests.filter((request) => request.status === "open");
  const paid = open.find((request) => request.kind === "paid");
  const promise = open.find((request) => request.kind === "promise");
  if (open.some((request) => request.kind === "dispute")) return "Disputed by the customer";
  if (paid) return `Customer says paid ${dayWords(paid.paidOn as string)}`;
  if (promise) return `Customer promised by ${dayWords(promise.promisedOn as string)}`;
  if (open.some((request) => request.kind === "pay_link")) return "Customer asks for a pay link";
  return null;
}

/** The open requests, oldest first (the one waiting longest on top), as finance acts on them. */
export function fromCustomerItems(input: {
  requests: readonly CustomerRequest[];
  invoices: ReadonlyMap<string, FromCustomerInvoice>;
  /** What is still owed on an open invoice. */
  owedOf: (invoiceId: string) => number;
  /** The open invoices with a pay link the customer's statement shows. */
  payLinked: ReadonlySet<string>;
  sandbox: boolean;
  today: string;
  /** Members' emails by user id, for who replied; null when they could not be read. */
  members: ReadonlyMap<string, string> | null;
  invoiceHref: (invoiceId: string) => string;
}): FromCustomerView[] {
  const openBy = new Map<string, CustomerRequest[]>();
  for (const request of input.requests) if (request.status === "open") openBy.set(request.invoiceId, [...(openBy.get(request.invoiceId) ?? []), request]);
  return input.requests
    .filter((request) => request.status === "open" && input.invoices.has(request.invoiceId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((request) => {
      const invoice = input.invoices.get(request.invoiceId) as FromCustomerInvoice;
      const currency: Coin = invoice.currency === "EURC" ? "EURC" : "USDC";
      const invoiceOpen = OPEN.has(invoice.status);
      const owed = invoiceOpen ? input.owedOf(invoice.id) : 0;
      const pause = invoiceOpen ? reminderPause(openBy.get(invoice.id) ?? [], input.today) : null;
      return {
        id: request.id,
        kind: request.kind,
        kindLabel: KIND_LABELS[request.kind],
        customerName: invoice.counterpartyName,
        invoiceLabel: invoice.memo?.trim() || `Invoice due ${utcDay(invoice.dueDate)}`,
        invoiceHref: input.invoiceHref(invoice.id),
        owed: invoiceOpen ? `${money(owed, currency)} still owed` : PAID.has(invoice.status) ? "Paid" : "No longer open",
        said: saidWords(request, currency),
        on: utcDay(request.createdAt),
        pause: pause ? (pause.reason === "dispute" ? "Reminders wait until you resolve it" : `Reminders wait through ${dayWords(pause.until as string)}`) : null,
        messages: request.messages.map((message) => ({
          id: message.id,
          who: message.author === "customer" ? invoice.counterpartyName : message.by ? (input.members?.get(message.by) ?? "A member") : "A former member",
          business: message.author === "business",
          body: message.body,
          on: utcDay(message.createdAt),
        })),
        step: financeNextStep(request, { invoiceOpen, payLink: input.payLinked.has(invoice.id), sandbox: input.sandbox, today: input.today, owed, currency }),
        closeLabels: CLOSE_LABELS[request.kind],
      };
    });
}

export interface StatementLinkView {
  id: string;
  customerName: string;
  until: string;
  expired: boolean;
  made: string;
}

/** Each link not stopped, live ones first, as the Receivables tab lists them. */
export function statementLinkRows(
  links: ReadonlyArray<{ id: string; counterpartyId: string; createdBy: string | null; createdAt: string; expiresAt: string; expired: boolean }>,
  names: ReadonlyMap<string, string>,
  members: ReadonlyMap<string, string> | null
): StatementLinkView[] {
  return [...links]
    .sort((a, b) => Number(a.expired) - Number(b.expired) || b.createdAt.localeCompare(a.createdAt))
    .map((link) => ({
      id: link.id,
      customerName: names.get(link.counterpartyId) ?? "A customer",
      until: link.expired ? `Expired ${utcDay(link.expiresAt)}` : `Works until ${utcDay(link.expiresAt)}`,
      expired: link.expired,
      made: `Made by ${link.createdBy ? (members?.get(link.createdBy) ?? "a member") : "a former member"} on ${utcDay(link.createdAt)}`,
    }));
}
