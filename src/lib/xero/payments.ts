import type { ExternalPayment, OrganisationFacts, PaymentToBook } from "../connectors/provider";
import { ProviderError } from "../connectors/provider";
import { xeroAmount, xeroDay } from "./map";

/**
 * Xero's payments and organisation in the connector core's shapes (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W1, W7, W11). Pure: the HTTP lives in `./payments-api.ts`. A payment against a bill is `PaymentType: ACCPAYPAYMENT`;
 * `Status` is `AUTHORISED` or, once someone deleted it in Xero, `DELETED`.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const currencyOf = (value: unknown): string | null => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null);

/**
 * `GET /Organisation`: its name, its base currency, and whether Xero says it is a demo company. Only Xero's own word
 * makes it one (`IsDemoCompany: true`, or `Class: "DEMO"` when it gives no `IsDemoCompany`): a trial is a real
 * business trying Xero with its real books, and `IsDemoCompany: false` is never overruled by its class.
 */
export function mapOrganisation(body: unknown, externalOrgId: string): OrganisationFacts {
  const list = isObject(body) && Array.isArray(body.Organisations) ? body.Organisations : null;
  const raw = list?.[0];
  if (!isObject(raw)) throw new ProviderError("bad_response", "Xero's organisation answer did not read");
  return {
    externalOrgId,
    name: text(raw.Name)?.slice(0, 200) ?? "Xero organisation",
    demo: raw.IsDemoCompany === true || (raw.IsDemoCompany === undefined && raw.Class === "DEMO"),
    baseCurrency: currencyOf(raw.BaseCurrency),
  };
}

/** One payment, or null when it does not read. */
export function mapPayment(raw: unknown): ExternalPayment | null {
  if (!isObject(raw)) return null;
  const externalId = text(raw.PaymentID);
  const amount = xeroAmount(raw.Amount);
  if (!externalId || externalId.length > 100 || amount === null) return null;
  const invoice = isObject(raw.Invoice) ? raw.Invoice : {};
  const account = isObject(raw.Account) ? raw.Account : {};
  return {
    externalId,
    billExternalId: text(invoice.InvoiceID),
    accountExternalId: text(account.AccountID),
    amount,
    currency: currencyOf(invoice.CurrencyCode),
    date: xeroDay(raw.DateString, raw.Date),
    reference: text(raw.Reference),
    status: raw.Status === "DELETED" ? "deleted" : "active",
  };
}

/** The payments of an answer (`{ Payments: [...] }`); an answer without the list does not read. */
export function mapPayments(body: unknown): ExternalPayment[] {
  if (!isObject(body) || !Array.isArray(body.Payments)) throw new ProviderError("bad_response", "Xero's payments answer did not read");
  return body.Payments.map(mapPayment).filter((payment): payment is ExternalPayment => payment !== null);
}

/**
 * The payment on this bill with this reference: the one still standing first, else a deleted one, so a payment someone
 * deleted in Xero is seen, and never booked again on its own (W7, step 3).
 */
export function paymentOnBill(payments: readonly ExternalPayment[], billId: string, reference: string): ExternalPayment | null {
  const mine = payments.filter((payment) => payment.billExternalId === billId && (payment.reference ?? "").toLowerCase() === reference.toLowerCase());
  return mine.find((payment) => payment.status === "active") ?? mine[0] ?? null;
}

/** `PUT /Payments`'s body: the bill, the account by its id, the day, the amount in the bill's currency, the reference. */
export function paymentBody(payment: PaymentToBook): { Payments: Array<Record<string, unknown>> } {
  return {
    Payments: [
      {
        Invoice: { InvoiceID: payment.billExternalId },
        Account: { AccountID: payment.accountExternalId },
        Date: payment.date,
        Amount: Number(payment.amount),
        Reference: payment.reference,
      },
    ],
  };
}

/** A 400's own words: the validation errors Xero gave, once each, cut to fit a message; null when it gave none. */
export function validationMessage(body: unknown): string | null {
  if (!isObject(body)) return null;
  const elements = Array.isArray(body.Elements) ? body.Elements : [];
  const messages = elements.flatMap((element) =>
    isObject(element) && Array.isArray(element.ValidationErrors) ? element.ValidationErrors.flatMap((error) => (isObject(error) && text(error.Message) ? [text(error.Message) as string] : [])) : []
  );
  const unique = [...new Set(messages)];
  if (unique.length > 0) return unique.join(" ").slice(0, 240);
  return text(body.Message)?.slice(0, 240) ?? text(body.Detail)?.slice(0, 240) ?? null;
}

/** The `where` filter for payments with this reference: a transaction hash, which holds no quote to escape. */
export function referenceFilter(reference: string): string {
  if (!/^[0-9A-Za-z]{1,255}$/.test(reference)) throw new ProviderError("bad_response", "A booking's reference is not a transaction hash");
  return `Reference=="${reference}"`;
}
