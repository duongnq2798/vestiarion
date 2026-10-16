import type { ExternalBill, ExternalContact, ExternalOrganisation, Page, PageRequest } from "../connectors/provider";
import { failureOf, jsonOf, zohoFetch, type ZohoBooksHttp } from "./http";
import { mapBillsPage, mapOrganizations, mapVendorsPage, zohoFilterTime } from "./map";
import { regionalToken, ZOHO_REGIONS } from "./regions";

/**
 * Reading a Zoho Books organization (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z5, Z6, Z8): the
 * organizations a token reaches; bills a page at a time, every bill in a backfill or those changed since a time; and
 * every vendor. Each call goes to the API domain of the data center the access token carries, names the organization
 * as `organization_id`, and sends the token as `Zoho-oauthtoken`.
 */

export const PAGE_SIZE = 200;

/** The URL of `path` at the token's data center, with the parameters. */
export function booksUrl(accessToken: string, path: string, params: Record<string, string> = {}): { url: string; token: string } {
  const { region, token } = regionalToken(accessToken);
  const url = new URL(`${ZOHO_REGIONS[region].api}/books/v3/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: url.toString(), token };
}

async function read(accessToken: string, path: string, params: Record<string, string>, label: string, deps: ZohoBooksHttp): Promise<unknown> {
  const { url, token } = booksUrl(accessToken, path, params);
  const response = await zohoFetch(url, { headers: { authorization: `Zoho-oauthtoken ${token}`, accept: "application/json" } }, label, deps);
  if (!response.ok) throw failureOf(response, label, (deps.now ?? Date.now)());
  return jsonOf(response, label);
}

/** The organizations a fresh token reaches (Z5). */
export async function organizations(accessToken: string, deps: ZohoBooksHttp = {}): Promise<ExternalOrganisation[]> {
  return mapOrganizations(await read(accessToken, "organizations", {}, "organizations", deps));
}

/**
 * Which bills a read asks for (Z6): a backfill, every bill, the core keeping the open ones in its window; an incremental
 * run, those changed since `since`, whatever their status, so a bill paid or voided later is seen. Oldest first, so a
 * run resumed at a page reads on from where it stopped.
 */
export function billsParams(request: Pick<PageRequest, "externalOrgId" | "phase" | "since" | "page">): Record<string, string> {
  const params: Record<string, string> = {
    organization_id: request.externalOrgId,
    filter_by: "Status.All",
    sort_column: "created_time",
    sort_order: "A",
    page: String(request.page),
    per_page: String(PAGE_SIZE),
  };
  if (request.phase === "incremental" && request.since) params.last_modified_time = zohoFilterTime(request.since);
  return params;
}

export async function billsPage(request: PageRequest, deps: ZohoBooksHttp = {}): Promise<Page<ExternalBill>> {
  return mapBillsPage(await read(request.accessToken, "bills", billsParams(request), "bills", deps), request.page);
}

/** Every vendor, inactive ones too (Z8): Zoho has no filter by change time for contacts. */
export async function vendorsPage(request: PageRequest, deps: ZohoBooksHttp = {}): Promise<Page<ExternalContact>> {
  const params = {
    organization_id: request.externalOrgId,
    contact_type: "vendor",
    filter_by: "Status.All",
    sort_column: "created_time",
    page: String(request.page),
    per_page: String(PAGE_SIZE),
  };
  return mapVendorsPage(await read(request.accessToken, "contacts", params, "vendors", deps), request.page);
}
