import type { ExternalAccount, ExternalBill, ExternalContact, Page, PageRequest } from "../connectors/provider";
import { failureOf, jsonOf, xeroFetch, XERO_ACCOUNTING, type XeroHttp } from "./http";
import { mapAccounts, mapBillsPage, mapContactsPage } from "./map";

/**
 * Reading a Xero organisation's records (docs/superpowers/specs/2026-10-12-xero-connector-design.md X6): bills
 * (`ACCPAY` invoices) and contacts a page at a time in update order, a backfill of what is open now or the changes
 * since a time, and the chart of accounts. Each call names its organisation in `xero-tenant-id`.
 */

export const PAGE_SIZE = 100;

/** `If-Modified-Since` as Xero reads it: UTC to the second, without a zone. Floored, so a re-read is the risk, not a gap. */
export function modifiedSince(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

function headers(request: { accessToken: string; externalOrgId: string }, since: string | null): Record<string, string> {
  return {
    authorization: `Bearer ${request.accessToken}`,
    "xero-tenant-id": request.externalOrgId,
    accept: "application/json",
    ...(since ? { "if-modified-since": modifiedSince(since) } : {}),
  };
}

async function read(url: URL, request: { accessToken: string; externalOrgId: string }, since: string | null, label: string, deps: XeroHttp): Promise<unknown> {
  const response = await xeroFetch(url.toString(), { headers: headers(request, since) }, label, deps);
  if (!response.ok) throw failureOf(response, label, (deps.now ?? Date.now)());
  return jsonOf(response, label);
}

export function invoicesUrl(request: Pick<PageRequest, "page" | "phase">): URL {
  const url = new URL(`${XERO_ACCOUNTING}/Invoices`);
  url.searchParams.set("where", 'Type=="ACCPAY"');
  // A backfill reads what is open now; following changes reads every status, so a bill paid or voided later is seen.
  if (request.phase === "backfill") url.searchParams.set("Statuses", "AUTHORISED");
  url.searchParams.set("order", "UpdatedDateUTC ASC");
  url.searchParams.set("page", String(request.page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  return url;
}

export async function billsPage(request: PageRequest, deps: XeroHttp = {}): Promise<Page<ExternalBill>> {
  const body = await read(invoicesUrl(request), request, request.phase === "incremental" ? request.since : null, "invoices", deps);
  return mapBillsPage(body, request.page, PAGE_SIZE);
}

export function contactsUrl(request: Pick<PageRequest, "page">): URL {
  const url = new URL(`${XERO_ACCOUNTING}/Contacts`);
  url.searchParams.set("order", "UpdatedDateUTC ASC");
  url.searchParams.set("page", String(request.page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("includeArchived", "true");
  return url;
}

export async function contactsPage(request: PageRequest, deps: XeroHttp = {}): Promise<Page<ExternalContact>> {
  const body = await read(contactsUrl(request), request, request.phase === "incremental" ? request.since : null, "contacts", deps);
  return mapContactsPage(body, request.page, PAGE_SIZE);
}

export async function accounts(request: { accessToken: string; externalOrgId: string }, deps: XeroHttp = {}): Promise<ExternalAccount[]> {
  const url = new URL(`${XERO_ACCOUNTING}/Accounts`);
  url.searchParams.set("order", "Code ASC");
  return mapAccounts(await read(url, request, null, "accounts", deps));
}
