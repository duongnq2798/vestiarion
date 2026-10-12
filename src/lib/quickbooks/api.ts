import type { ExternalAccount, ExternalBill, ExternalContact, ExternalOrganisation, Page, PageRequest } from "../connectors/provider";
import { failureOf, jsonOf, quickBooksFetch, type QuickBooksHttp } from "./http";
import { billsLackCurrency, mapBankAccounts, mapBillsPage, mapCompany, mapCount, mapDeletedBills, mapHomeCurrency, mapVendorsPage, qbFilterTime } from "./map";
import { MINOR_VERSION, quickBooksApiBase, type QuickBooksSettings } from "./settings";

/**
 * Reading a QuickBooks Online company (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q6, Q7, Q8):
 * vendors and bills a page at a time in update order, with a count of the same filter beside each page of bills; a
 * backfill of the open bills due in the window, or every bill changed since a time; the bills deleted since then from
 * change data capture; the bank accounts; and the company itself. Every call names the company in its path and
 * `minorversion=75`.
 */

export const PAGE_SIZE = 100;
/** Change data capture looks back 30 days at most; an hour short of that, for the two clocks. */
export const CDC_LOOKBACK_MS = 30 * 86_400_000 - 3_600_000;

interface CompanyRequest {
  accessToken: string;
  externalOrgId: string;
}

/** The company's own URL for `path`, with `minorversion` and the parameters, each encoded (a space as %20). */
export function companyUrl(settings: QuickBooksSettings, realmId: string, path: string, params: Record<string, string> = {}): string {
  const query = Object.entries({ ...params, minorversion: MINOR_VERSION })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${quickBooksApiBase(settings.environment)}/v3/company/${encodeURIComponent(realmId)}/${path}?${query}`;
}

async function read(url: string, request: CompanyRequest, label: string, deps: QuickBooksHttp): Promise<unknown> {
  const response = await quickBooksFetch(url, { headers: { authorization: `Bearer ${request.accessToken}`, accept: "application/json" } }, label, deps);
  if (!response.ok) throw failureOf(response, label, (deps.now ?? Date.now)());
  return jsonOf(response, label);
}

function query(settings: QuickBooksSettings, request: CompanyRequest, statement: string, label: string, deps: QuickBooksHttp): Promise<unknown> {
  return read(companyUrl(settings, request.externalOrgId, "query", { query: statement }), request, label, deps);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Which bills a read asks for: a backfill, the open ones due from the window's first day (Q7); an incremental run,
 * every bill changed since `since`, whatever its balance, so a bill paid later is seen.
 */
export function billsWhere(request: Pick<PageRequest, "phase" | "since" | "windowFrom">): string {
  if (request.phase === "incremental" && request.since) return `MetaData.LastUpdatedTime >= '${qbFilterTime(request.since)}'`;
  const window = request.windowFrom && DAY.test(request.windowFrom) ? ` AND DueDate >= '${request.windowFrom}'` : "";
  return `Balance > '0'${window}`;
}

export function billsStatement(request: Pick<PageRequest, "phase" | "since" | "windowFrom" | "page">): string {
  const start = (request.page - 1) * PAGE_SIZE + 1;
  return `SELECT * FROM Bill WHERE ${billsWhere(request)} ORDERBY MetaData.LastUpdatedTime STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
}

export function vendorsStatement(request: Pick<PageRequest, "phase" | "since" | "page">): string {
  const since = request.phase === "incremental" && request.since ? ` AND MetaData.LastUpdatedTime >= '${qbFilterTime(request.since)}'` : "";
  const start = (request.page - 1) * PAGE_SIZE + 1;
  // Inactive vendors too: QuickBooks deletes a vendor by making it inactive.
  return `SELECT * FROM Vendor WHERE Active IN (true, false)${since} ORDERBY MetaData.LastUpdatedTime STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
}

/** The company the callback named, read with the new token (Q4). */
export async function companyInfo(settings: QuickBooksSettings, request: CompanyRequest, deps: QuickBooksHttp = {}): Promise<ExternalOrganisation> {
  const realm = request.externalOrgId;
  return mapCompany(await read(companyUrl(settings, realm, `companyinfo/${encodeURIComponent(realm)}`), request, "company", deps), realm);
}

/** The company's home currency, read once per provider object, only when a bill came without its own. */
async function homeCurrency(settings: QuickBooksSettings, request: CompanyRequest, deps: QuickBooksHttp, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(request.externalOrgId)) return cache.get(request.externalOrgId) ?? null;
  const currency = mapHomeCurrency(await read(companyUrl(settings, request.externalOrgId, "preferences"), request, "preferences", deps));
  cache.set(request.externalOrgId, currency);
  return currency;
}

/** The bills change data capture says were deleted since `since`, at most 30 days back (Q8). */
export async function deletedBills(settings: QuickBooksSettings, request: CompanyRequest & { since: string }, deps: QuickBooksHttp = {}): Promise<ExternalBill[]> {
  const earliest = (deps.now ?? Date.now)() - CDC_LOOKBACK_MS;
  const since = Math.max(Date.parse(request.since), earliest);
  const url = companyUrl(settings, request.externalOrgId, "cdc", { entities: "Bill", changedSince: qbFilterTime(new Date(since).toISOString()) });
  return mapDeletedBills(await read(url, request, "change data capture", deps));
}

export async function billsPage(
  settings: QuickBooksSettings,
  request: PageRequest,
  deps: QuickBooksHttp = {},
  cache: Map<string, string | null> = new Map()
): Promise<Page<ExternalBill>> {
  const body = await query(settings, request, billsStatement(request), "bills", deps);
  // QuickBooks' count of the same filter: fewer than on the page before means a bill left the read (X8).
  const total = mapCount(await query(settings, request, `SELECT COUNT(*) FROM Bill WHERE ${billsWhere(request)}`, "bill count", deps));
  const home = billsLackCurrency(body) ? await homeCurrency(settings, request, deps, cache) : null;
  const page = mapBillsPage(body, request.page, PAGE_SIZE, total, home);
  if (request.phase !== "incremental" || request.page !== 1 || !request.since) return page;
  // A deleted bill is never in a query's answer: change data capture names it, once per run, on its first page.
  return { ...page, items: [...page.items, ...(await deletedBills(settings, { ...request, since: request.since }, deps))] };
}

export async function vendorsPage(settings: QuickBooksSettings, request: PageRequest, deps: QuickBooksHttp = {}): Promise<Page<ExternalContact>> {
  return mapVendorsPage(await query(settings, request, vendorsStatement(request), "vendors", deps), request.page, PAGE_SIZE);
}

/** The bank accounts a payment can be booked to, read when a person opens the picker (I14). */
export async function bankAccounts(settings: QuickBooksSettings, request: CompanyRequest, deps: QuickBooksHttp = {}): Promise<ExternalAccount[]> {
  return mapBankAccounts(await query(settings, request, "SELECT * FROM Account WHERE AccountType = 'Bank' AND Active = true MAXRESULTS 1000", "accounts", deps));
}
