import type { ExternalAccount, ExternalBill, ExternalContact, ExternalOrganisation, Page, ProviderTokens, SourceStatus } from "../connectors/provider";
import { ProviderError } from "../connectors/provider";

/**
 * Xero's JSON in the connector core's shapes (docs/superpowers/specs/2026-10-12-xero-connector-design.md X6). Pure: the
 * HTTP lives in `./http.ts`. Whatever Xero sends that does not read is left out, or refused as a bad answer when the
 * whole answer does not read, never guessed.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const cut = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));

const MS_DATE = /^\/Date\((-?\d{1,15})(?:[+-]\d{4})?\)\/$/;
const ISO_DAY = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+)?$/;

function realDay(day: string): string | null {
  const at = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(at.valueOf()) && at.toISOString().startsWith(day) ? day : null;
}

/** A day, from Xero's `DueDateString`-style text first, else from its `/Date(ms+0000)/` form. */
export function xeroDay(dayString: unknown, msDate: unknown): string | null {
  const written = text(dayString);
  const fromText = written ? ISO_DAY.exec(written) : null;
  if (fromText) return realDay(fromText[1]);
  const ms = typeof msDate === "string" ? MS_DATE.exec(msDate.trim()) : null;
  return ms ? new Date(Number(ms[1])).toISOString().slice(0, 10) : null;
}

/** An instant (`UpdatedDateUTC`), as an ISO string: from `/Date(ms+0000)/`, or an ISO time Xero gives without its zone. */
export function xeroTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = MS_DATE.exec(value.trim());
  if (ms) return new Date(Number(ms[1])).toISOString();
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value.trim()) ? `${value.trim()}Z` : value.trim();
  const at = Date.parse(iso);
  return Number.isNaN(at) || !/^\d{4}-/.test(iso) ? null : new Date(at).toISOString();
}

/** A JSON number as an exact decimal string: Xero's amounts carry at most 4 places, so 6 rounds away float noise only. */
export function xeroAmount(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e15) return null;
  return String(Number(value.toFixed(6)));
}

const STATUS: Record<string, SourceStatus | "authorised"> = {
  AUTHORISED: "authorised",
  PAID: "paid",
  VOIDED: "voided",
  DELETED: "deleted",
  DRAFT: "draft",
  SUBMITTED: "draft",
};

/** One bill (`Type == "ACCPAY"`), or null when it is not one or does not read. */
export function mapBill(raw: unknown): ExternalBill | null {
  if (!isObject(raw) || raw.Type !== "ACCPAY") return null;
  const externalId = text(raw.InvoiceID);
  const updatedAt = xeroTime(raw.UpdatedDateUTC);
  const currency = typeof raw.CurrencyCode === "string" && /^[A-Z]{3}$/.test(raw.CurrencyCode) ? raw.CurrencyCode : null;
  const total = xeroAmount(raw.Total);
  const amountDue = xeroAmount(raw.AmountDue);
  const xeroStatus = typeof raw.Status === "string" ? STATUS[raw.Status] : undefined;
  if (!externalId || externalId.length > 100 || !updatedAt || !currency || total === null || amountDue === null || !xeroStatus) return null;
  // Approved, with something left to pay, is open; approved and fully paid (Xero says AUTHORISED until it says PAID) is paid.
  const status: SourceStatus = xeroStatus === "authorised" ? (Number(amountDue) > 0 ? "open" : "paid") : xeroStatus;
  const contact = isObject(raw.Contact) ? raw.Contact : {};
  return {
    externalId,
    version: updatedAt,
    updatedAt,
    contactExternalId: cut(text(contact.ContactID), 100),
    contactName: cut(text(contact.Name), 200) ?? "Unnamed supplier",
    number: cut(text(raw.InvoiceNumber), 255),
    reference: cut(text(raw.Reference), 255),
    currency,
    total,
    amountDue,
    issuedOn: xeroDay(raw.DateString, raw.Date),
    dueOn: xeroDay(raw.DueDateString, raw.DueDate),
    status,
  };
}

/** Whether the page read is the last: by Xero's `pagination` when it sends one, else by a page shorter than asked for. */
function isLast(body: Json, rawCount: number, page: number, pageSize: number): boolean {
  const pagination = isObject(body.pagination) ? body.pagination : null;
  if (pagination && typeof pagination.pageCount === "number") return page >= pagination.pageCount;
  return rawCount < pageSize;
}

/** How many records the read matches now, by Xero's `pagination.itemCount`; null when it sends none. */
function totalOf(body: Json): number | null {
  const pagination = isObject(body.pagination) ? body.pagination : null;
  return pagination && typeof pagination.itemCount === "number" && Number.isInteger(pagination.itemCount) && pagination.itemCount >= 0
    ? pagination.itemCount
    : null;
}

function listOf(body: unknown, key: string): { body: Json; items: unknown[] } {
  if (!isObject(body) || !Array.isArray(body[key])) throw new ProviderError("bad_response", `Xero's ${key} answer did not read`);
  return { body, items: body[key] as unknown[] };
}

export function mapBillsPage(body: unknown, page: number, pageSize: number): Page<ExternalBill> {
  const list = listOf(body, "Invoices");
  const items = list.items.map(mapBill).filter((bill): bill is ExternalBill => bill !== null);
  return { items, page, last: isLast(list.body, list.items.length, page, pageSize), total: totalOf(list.body) };
}

function mapContact(raw: unknown): ExternalContact | null {
  if (!isObject(raw)) return null;
  const externalId = text(raw.ContactID);
  const updatedAt = xeroTime(raw.UpdatedDateUTC);
  const name = cut(text(raw.Name), 200);
  if (!externalId || externalId.length > 100 || !updatedAt || !name || raw.IsSupplier !== true) return null;
  return { externalId, version: updatedAt, updatedAt, name, isSupplier: true, archived: raw.ContactStatus !== "ACTIVE" };
}

/** Suppliers only: a customer is never a payee. The page ends by Xero's own count, before the filter. */
export function mapContactsPage(body: unknown, page: number, pageSize: number): Page<ExternalContact> {
  const list = listOf(body, "Contacts");
  const items = list.items.map(mapContact).filter((contact): contact is ExternalContact => contact !== null);
  return { items, page, last: isLast(list.body, list.items.length, page, pageSize), total: totalOf(list.body) };
}

/** The accounts a payment can be booked to (I14): active bank accounts, and active accounts Xero lets take payments, never revenue or expense. */
export function mapAccounts(body: unknown): ExternalAccount[] {
  return listOf(body, "Accounts").items.flatMap((raw): ExternalAccount[] => {
    if (!isObject(raw) || raw.Status !== "ACTIVE") return [];
    if (raw.Class === "REVENUE" || raw.Class === "EXPENSE") return [];
    const bank = raw.Type === "BANK";
    if (!bank && raw.EnablePaymentsToAccount !== true) return [];
    const externalId = text(raw.AccountID);
    const name = cut(text(raw.Name), 150);
    if (!externalId || !name) return [];
    return [{
      externalId,
      code: cut(text(raw.Code), 10),
      name,
      type: typeof raw.Type === "string" ? raw.Type : "OTHER",
      currency: typeof raw.CurrencyCode === "string" && /^[A-Z]{3}$/.test(raw.CurrencyCode) ? raw.CurrencyCode : null,
      bank,
    }];
  });
}

/** Xero's token answer (`/connect/token`). Throws on one without both tokens, naming the field, never a value. */
export function mapTokens(body: unknown, nowMs: number): ProviderTokens {
  const json = isObject(body) ? body : {};
  const accessToken = text(json.access_token);
  const refreshToken = text(json.refresh_token);
  if (!accessToken) throw new ProviderError("bad_response", "Xero's token answer had no access_token");
  if (!refreshToken) throw new ProviderError("bad_response", "Xero's token answer had no refresh_token");
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 1800;
  const scopes = typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [];
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000, scopes };
}

/**
 * The authorization a Xero access token came from (its `authentication_event_id` claim), to offer the organisations
 * just connected. Read without checking the signature: the token came from Xero over TLS a moment ago, and this only
 * narrows a list the person then picks from.
 */
export function authEventOf(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isObject(claims) ? text(claims.authentication_event_id) : null;
  } catch {
    return null;
  }
}

/** Xero's `/connections`: the organisations (never a practice), those of `authEventId` when any is. */
export function mapConnections(body: unknown, authEventId: string | null): ExternalOrganisation[] {
  if (!Array.isArray(body)) throw new ProviderError("bad_response", "Xero's connections answer did not read");
  const organisations = body.flatMap((raw): Array<ExternalOrganisation & { event: string | null }> => {
    if (!isObject(raw) || raw.tenantType !== "ORGANISATION") return [];
    const externalOrgId = text(raw.tenantId);
    if (!externalOrgId || externalOrgId.length > 100) return [];
    return [{ externalOrgId, name: cut(text(raw.tenantName), 200) ?? "Xero organisation", connectionId: text(raw.id), event: text(raw.authEventId) }];
  });
  const thisTime = authEventId ? organisations.filter((organisation) => organisation.event === authEventId) : [];
  return (thisTime.length > 0 ? thisTime : organisations).map(({ externalOrgId, name, connectionId }) => ({ externalOrgId, name, connectionId }));
}
