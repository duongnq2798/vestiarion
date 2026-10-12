import type { ExternalAccount, ExternalBill, ExternalContact, ExternalOrganisation, Page, ProviderTokens, SourceStatus } from "../connectors/provider";
import { ProviderError } from "../connectors/provider";

/**
 * QuickBooks Online's JSON in the connector core's shapes (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md
 * Q6, Q8, Q9). Pure: the HTTP lives in `./http.ts`. Whatever QuickBooks sends that does not read is left out, or refused
 * as a bad answer when the whole answer does not read (a `Fault`), never guessed.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const cut = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));
const currencyOf = (value: unknown): string | null => {
  const code = isObject(value) ? value.value : null;
  return typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : null;
};

/** An update time (`MetaData.LastUpdatedTime`, `2026-10-11T23:15:22-07:00`) in UTC to the millisecond; null without a zone. */
export function qbTime(value: unknown): string | null {
  const written = text(value);
  if (!written || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(written)) return null;
  const at = Date.parse(written);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A day (`TxnDate`, `DueDate`), only when it is on the calendar. */
export function qbDay(value: unknown): string | null {
  const written = text(value);
  if (!written || !/^\d{4}-\d{2}-\d{2}$/.test(written)) return null;
  const at = new Date(`${written}T00:00:00.000Z`);
  return !Number.isNaN(at.valueOf()) && at.toISOString().startsWith(written) ? written : null;
}

/** A JSON number as an exact decimal string: QuickBooks' amounts carry at most 2 places (5 for a rate), so 6 rounds away float noise only. */
export function qbAmount(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e15) return null;
  return String(Number(value.toFixed(6)));
}

/**
 * A record's version (Q8): its update time, then its `SyncToken` padded to 8 digits, so two changes in the same second
 * still order as text. `deleted` sorts after any number: a deletion is the last word.
 */
export function qbVersion(updatedAt: string, syncToken: unknown): string {
  if (syncToken === "deleted") return `${updatedAt}#deleted`;
  const token = typeof syncToken === "string" && /^\d{1,8}$/.test(syncToken) ? syncToken : "0";
  return `${updatedAt}#${token.padStart(8, "0")}`;
}

/** A time in a query's `WHERE`, in UTC to the second (`2026-10-12T09:55:00Z`). Floored, so a re-read is the risk, not a gap. */
export function qbFilterTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19)}Z`;
}

/** QuickBooks answers a refused request with a `Fault`: never read as data. */
function refuseFault(body: unknown, label: string): Json {
  if (!isObject(body)) throw new ProviderError("bad_response", `QuickBooks' ${label} answer did not read`);
  if (isObject(body.Fault)) {
    const type = text(body.Fault.type);
    throw new ProviderError("bad_response", `QuickBooks' ${label} answer was a fault${type ? ` (${type.slice(0, 40)})` : ""}`);
  }
  return body;
}

/** The records of one entity in a query's answer, and how many QuickBooks sent (none when it sends no key). */
function queryList(body: unknown, entity: string): unknown[] {
  const json = refuseFault(body, entity);
  if (!isObject(json.QueryResponse)) throw new ProviderError("bad_response", `QuickBooks' ${entity} answer did not read`);
  const list = json.QueryResponse[entity];
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ProviderError("bad_response", `QuickBooks' ${entity} answer did not read`);
  return list;
}

/** A query's `count(*)`: `QueryResponse.totalCount`, or null when the answer has none. */
export function mapCount(body: unknown): number | null {
  const json = refuseFault(body, "count");
  const count = isObject(json.QueryResponse) ? json.QueryResponse.totalCount : undefined;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

/** "Voided" is the memo QuickBooks writes when a bill is voided in its screens; it is not the business's own. */
const VOIDED_MEMO = /^voided\b/i;

/**
 * One bill, or null when it does not read. `homeCurrency` is the company's, for a bill QuickBooks sent without its own
 * (null: such a bill is left out rather than guessed).
 */
export function mapBill(raw: unknown, homeCurrency: string | null): ExternalBill | null {
  if (!isObject(raw)) return null;
  const externalId = text(raw.Id);
  const meta = isObject(raw.MetaData) ? raw.MetaData : {};
  const updatedAt = qbTime(meta.LastUpdatedTime);
  const currency = currencyOf(raw.CurrencyRef) ?? homeCurrency;
  const total = qbAmount(raw.TotalAmt);
  const balance = qbAmount(raw.Balance);
  if (!externalId || externalId.length > 100 || !updatedAt || !currency || total === null || balance === null) return null;
  const memo = cut(text(raw.PrivateNote), 255);
  // QuickBooks has no draft bill: one with something left to pay is open; one with nothing is paid, or voided when its
  // total went to zero with QuickBooks' own "Voided" memo.
  const status: SourceStatus = Number(balance) > 0 ? "open" : Number(total) === 0 && memo !== null && VOIDED_MEMO.test(memo) ? "voided" : "paid";
  const vendor = isObject(raw.VendorRef) ? raw.VendorRef : {};
  return {
    externalId,
    version: qbVersion(updatedAt, raw.SyncToken),
    updatedAt,
    contactExternalId: cut(text(vendor.value), 100),
    contactName: cut(text(vendor.name), 200) ?? "Unnamed vendor",
    number: cut(text(raw.DocNumber), 255),
    reference: memo !== null && VOIDED_MEMO.test(memo) ? null : memo,
    currency,
    total,
    amountDue: balance,
    issuedOn: qbDay(raw.TxnDate),
    dueOn: qbDay(raw.DueDate),
    status,
  };
}

/** Whether a page holds a bill without its own currency: then the company's home currency is read first. */
export function billsLackCurrency(body: unknown): boolean {
  try {
    return queryList(body, "Bill").some((raw) => isObject(raw) && currencyOf(raw.CurrencyRef) === null);
  } catch {
    return false;
  }
}

/**
 * Whether a page is the last: shorter than asked for, or reaching the count QuickBooks gave for the same filter. Both
 * by what QuickBooks sent, before anything is left out.
 */
function isLast(rawCount: number, page: number, pageSize: number, total: number | null): boolean {
  if (rawCount < pageSize) return true;
  return total !== null && (page - 1) * pageSize + rawCount >= total;
}

export function mapBillsPage(body: unknown, page: number, pageSize: number, total: number | null, homeCurrency: string | null): Page<ExternalBill> {
  const raws = queryList(body, "Bill");
  const items = raws.map((raw) => mapBill(raw, homeCurrency)).filter((bill): bill is ExternalBill => bill !== null);
  return { items, page, last: isLast(raws.length, page, pageSize, total), total };
}

/**
 * The bills change data capture says were deleted (Q8): QuickBooks keeps only their id and time, so each is named by
 * them alone (`factsKnown: false`) and its row keeps the facts it has. The bills it says changed are left to the
 * query, which pages.
 */
export function mapDeletedBills(body: unknown): ExternalBill[] {
  const json = refuseFault(body, "change data capture");
  if (!Array.isArray(json.CDCResponse)) throw new ProviderError("bad_response", "QuickBooks' change data capture answer did not read");
  const raws = json.CDCResponse.flatMap((response) => {
    const queries = isObject(response) && Array.isArray(response.QueryResponse) ? response.QueryResponse : [];
    return queries.flatMap((query) => (isObject(query) && Array.isArray(query.Bill) ? (query.Bill as unknown[]) : []));
  });
  return raws.flatMap((raw): ExternalBill[] => {
    if (!isObject(raw) || raw.status !== "Deleted") return [];
    const externalId = text(raw.Id);
    const updatedAt = qbTime(isObject(raw.MetaData) ? raw.MetaData.LastUpdatedTime : null);
    if (!externalId || externalId.length > 100 || !updatedAt) return [];
    return [{
      externalId,
      version: qbVersion(updatedAt, "deleted"),
      updatedAt,
      contactExternalId: null,
      contactName: "Unnamed vendor",
      number: null,
      reference: null,
      // ISO 4217's code for "no currency": the row keeps its own.
      currency: "XXX",
      total: "0",
      amountDue: "0",
      issuedOn: null,
      dueOn: null,
      status: "deleted",
      factsKnown: false,
    }];
  });
}

function mapVendor(raw: unknown): ExternalContact | null {
  if (!isObject(raw)) return null;
  const externalId = text(raw.Id);
  const updatedAt = qbTime(isObject(raw.MetaData) ? raw.MetaData.LastUpdatedTime : null);
  const name = cut(text(raw.DisplayName) ?? text(raw.CompanyName), 200);
  if (!externalId || externalId.length > 100 || !updatedAt || !name) return null;
  return { externalId, version: qbVersion(updatedAt, raw.SyncToken), updatedAt, name, isSupplier: true, archived: raw.Active === false };
}

/** Vendors, every one a supplier; an inactive one (QuickBooks' deleted vendor) archived. */
export function mapVendorsPage(body: unknown, page: number, pageSize: number): Page<ExternalContact> {
  const raws = queryList(body, "Vendor");
  const items = raws.map(mapVendor).filter((vendor): vendor is ExternalContact => vendor !== null);
  return { items, page, last: isLast(raws.length, page, pageSize, null), total: null };
}

/** The accounts a payment can be booked to (I14): active bank accounts only, by name. */
export function mapBankAccounts(body: unknown): ExternalAccount[] {
  return queryList(body, "Account")
    .flatMap((raw): ExternalAccount[] => {
      if (!isObject(raw) || raw.Active !== true || raw.AccountType !== "Bank") return [];
      const externalId = text(raw.Id);
      const name = cut(text(raw.Name), 150);
      if (!externalId || !name) return [];
      return [{ externalId, code: cut(text(raw.AcctNum), 10), name, type: "Bank", currency: currencyOf(raw.CurrencyRef), bank: true }];
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** The company the callback named, by its `CompanyInfo` read with the new token (Q4). */
export function mapCompany(body: unknown, realmId: string): ExternalOrganisation {
  const json = refuseFault(body, "company");
  if (!isObject(json.CompanyInfo)) throw new ProviderError("bad_response", "QuickBooks' company answer did not read");
  const name = cut(text(json.CompanyInfo.CompanyName) ?? text(json.CompanyInfo.LegalName), 200) ?? "QuickBooks company";
  return { externalOrgId: realmId, name, connectionId: null };
}

/** The company's home currency (`Preferences.CurrencyPrefs.HomeCurrency`), or null. */
export function mapHomeCurrency(body: unknown): string | null {
  const json = refuseFault(body, "preferences");
  const prefs = isObject(json.Preferences) && isObject(json.Preferences.CurrencyPrefs) ? json.Preferences.CurrencyPrefs : null;
  return prefs ? currencyOf(prefs.HomeCurrency) : null;
}

/**
 * Intuit's token answer. It names no scope, so the scopes asked for are kept. Throws on one without both tokens,
 * naming the field, never a value.
 */
export function mapTokens(body: unknown, nowMs: number, scopes: readonly string[]): ProviderTokens {
  const json = isObject(body) ? body : {};
  const accessToken = text(json.access_token);
  const refreshToken = text(json.refresh_token);
  if (!accessToken) throw new ProviderError("bad_response", "Intuit's token answer had no access_token");
  if (!refreshToken) throw new ProviderError("bad_response", "Intuit's token answer had no refresh_token");
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000, scopes: [...scopes] };
}
