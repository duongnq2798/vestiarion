import type { BookingProvider, BookOutcome, ExternalBill, ExternalPayment, OrganisationFacts, OrgRequest, PaymentToBook } from "../connectors/provider";
import { ProviderError } from "../connectors/provider";
import { failureOf, jsonOf, xeroFetch, XERO_ACCOUNTING, type XeroHttp } from "./http";
import { mapBill, xeroAmount, xeroDay } from "./map";
import { mapOrganisation, mapPayments, paymentBody, paymentOnBill, referenceFilter, validationMessage } from "./payments";
import { XERO_WRITE_SCOPES } from "./settings";

/**
 * Booking payments in a Xero organisation (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W7, W11):
 * the organisation's kind, one bill as it is now, a payment found by its reference, a payment booked with an
 * idempotency key, and a payment read back. Each call names its organisation in `xero-tenant-id`; a refusal becomes a
 * `ProviderError` naming the call and its status, never a token or a body, except a booking's validation errors, which
 * are Xero's own words about the payment.
 */

/** Xero's ids are GUIDs: anything else is never put in a path. */
const XERO_ID = /^[0-9A-Fa-f-]{1,100}$/;

function headers(request: OrgRequest, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${request.accessToken}`, "xero-tenant-id": request.externalOrgId, accept: "application/json", ...extra };
}

async function get(url: URL, request: OrgRequest, label: string, deps: XeroHttp): Promise<Response> {
  return xeroFetch(url.toString(), { headers: headers(request) }, label, deps);
}

function idPath(kind: string, id: string): URL {
  if (!XERO_ID.test(id)) throw new ProviderError("bad_response", `Xero ${kind}: an id that is not Xero's`);
  return new URL(`${XERO_ACCOUNTING}/${kind}/${id}`);
}

export async function organisation(request: OrgRequest, deps: XeroHttp = {}): Promise<OrganisationFacts> {
  const response = await get(new URL(`${XERO_ACCOUNTING}/Organisation`), request, "organisation", deps);
  if (!response.ok) throw failureOf(response, "organisation", (deps.now ?? Date.now)());
  return mapOrganisation(await jsonOf(response, "organisation"), request.externalOrgId);
}

/** `GET /Invoices/{id}`: the bill now, null once Xero has none; with the payments Xero lists on it, which carry their references. */
async function readBill(request: OrgRequest & { billId: string }, deps: XeroHttp): Promise<{ bill: ExternalBill | null; payments: ExternalPayment[] }> {
  const response = await get(idPath("Invoices", request.billId), request, "invoice", deps);
  if (response.status === 404) return { bill: null, payments: [] };
  if (!response.ok) throw failureOf(response, "invoice", (deps.now ?? Date.now)());
  const body = (await jsonOf(response, "invoice")) as { Invoices?: unknown };
  const raw = Array.isArray(body?.Invoices) ? body.Invoices[0] : undefined;
  const bill = mapBill(raw);
  const listed = raw && typeof raw === "object" && Array.isArray((raw as { Payments?: unknown }).Payments) ? ((raw as { Payments: unknown[] }).Payments as Array<Record<string, unknown>>) : [];
  const currency = bill?.currency ?? null;
  const payments = listed.flatMap((payment): ExternalPayment[] => {
    const id = typeof payment.PaymentID === "string" ? payment.PaymentID : null;
    const amount = xeroAmount(payment.Amount);
    if (!id || amount === null) return [];
    return [{
      externalId: id,
      billExternalId: request.billId,
      accountExternalId: null,
      amount,
      currency,
      date: xeroDay(payment.DateString, payment.Date),
      reference: typeof payment.Reference === "string" ? payment.Reference : null,
      status: "active",
    }];
  });
  return { bill, payments };
}

export async function bill(request: OrgRequest & { billId: string }, deps: XeroHttp = {}): Promise<ExternalBill | null> {
  return (await readBill(request, deps)).bill;
}

/**
 * The payment on this bill with this reference: by `where=Reference=="…"`, which lists deleted payments too; when Xero
 * will not take that filter (a 400), from the payments its bill lists, which are the ones still standing: then, when
 * a deleted one matters and none stands, it cannot say there is none, and throws.
 */
export async function findPayment(request: OrgRequest & { billId: string; reference: string; deletedMatters?: boolean }, deps: XeroHttp = {}): Promise<ExternalPayment | null> {
  const url = new URL(`${XERO_ACCOUNTING}/Payments`);
  url.searchParams.set("where", referenceFilter(request.reference));
  const response = await get(url, request, "payments", deps);
  if (response.status === 400) {
    const standing = paymentOnBill((await readBill(request, deps)).payments, request.billId, request.reference);
    if (!standing && request.deletedMatters) throw new ProviderError("unavailable", "Xero payments: the reference filter was refused, so a deleted payment cannot be ruled out");
    return standing;
  }
  if (!response.ok) throw failureOf(response, "payments", (deps.now ?? Date.now)());
  return paymentOnBill(mapPayments(await jsonOf(response, "payments")), request.billId, request.reference);
}

/** `PUT /Payments`, with an `Idempotency-Key`: the payment Xero made, or its refusal in its own words. */
export async function bookPayment(request: OrgRequest & { payment: PaymentToBook; idempotencyKey: string }, deps: XeroHttp = {}): Promise<BookOutcome> {
  const response = await xeroFetch(
    `${XERO_ACCOUNTING}/Payments`,
    {
      method: "PUT",
      headers: headers(request, { "content-type": "application/json", "idempotency-key": request.idempotencyKey.slice(0, 128) }),
      body: JSON.stringify(paymentBody(request.payment)),
    },
    "payment",
    deps
  );
  if (response.status === 400) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: false, message: validationMessage(body) ?? "Xero refused the payment." };
  }
  if (!response.ok) throw failureOf(response, "payment", (deps.now ?? Date.now)());
  const [made] = mapPayments(await jsonOf(response, "payment"));
  if (!made) throw new ProviderError("bad_response", "Xero payment: an answer without the payment");
  return { ok: true, payment: made };
}

/** `GET /Payments/{id}`: the payment as Xero holds it now, null once it has none. */
export async function payment(request: OrgRequest & { paymentId: string }, deps: XeroHttp = {}): Promise<ExternalPayment | null> {
  const response = await get(idPath("Payments", request.paymentId), request, "payment read", deps);
  if (response.status === 404) return null;
  if (!response.ok) throw failureOf(response, "payment read", (deps.now ?? Date.now)());
  return mapPayments(await jsonOf(response, "payment read"))[0] ?? null;
}

/** Xero as the core's booking seam sees it. */
export function xeroBooking(deps: XeroHttp = {}): BookingProvider {
  return {
    writeScopes: XERO_WRITE_SCOPES,
    organisation: (request) => organisation(request, deps),
    bill: (request) => bill(request, deps),
    findPayment: (request) => findPayment(request, deps),
    bookPayment: (request) => bookPayment(request, deps),
    payment: (request) => payment(request, deps),
  };
}
