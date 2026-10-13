import { CLOCK_MARGIN_MS } from "../connectors/cursors";
import type { CrmPage, CrmPageRequest, ExternalCompany, ExternalDeal } from "../connectors/crm";
import {
  failureOf, HUBSPOT_ACCOUNT, HUBSPOT_DEAL_PIPELINES, hubspotAssociations, hubspotFetch, hubspotObjects, jsonOf, type HubSpotHttp,
} from "./http";
import {
  mapAccountDetails, mapAssociations, mapBatchDeals, mapCompanies, mapContactEmails, mapDeal, mapPipelines, mapSearchPage, PRIMARY_COMPANY_OF_DEAL,
  PRIMARY_CONTACT_OF_COMPANY, type DealContext, type PipelineFacts, type RawRecord,
} from "./map";

/**
 * Reading a HubSpot account (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H6): deals by search, a page
 * at a time in the order of their last change, each with its company and that company's main contact's email; the
 * deals linked to Vestiarion deals, by id; and, once per reader, the pipelines and the account's currency and time
 * zone. A reader lives for one run: the sweeper and each action make their own.
 */

export const PAGE_SIZE = 100;
/** HubSpot's batch reads take at most 100 ids. */
const BATCH = 100;

export const DEAL_PROPERTIES = [
  "dealname", "amount", "deal_currency_code", "closedate", "pipeline", "dealstage", "hs_is_closed", "hs_is_closed_won", "hs_lastmodifieddate",
  // The deal's owner in HubSpot, by id: the collections stage asks before the first overdue reminder when there is one
  // (docs/superpowers/specs/2026-10-13-collections-context-design.md C5). Read with crm.objects.deals.read, as the rest.
  "hubspot_owner_id",
] as const;

type Account = { accessToken: string; externalOrgId: string };

const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/**
 * The search for a page (H6): a backfill asks for what is open, or won since the window's first day; an incremental run
 * for every deal changed since five minutes before `since` (search lags a change by a few moments, and a deal read twice
 * is ignored by its version). In the order of the last change; `after` is the offset of the page.
 */
export function searchBody(request: Pick<CrmPageRequest, "phase" | "since" | "page" | "windowFrom">): Record<string, unknown> {
  const filterGroups =
    request.phase === "backfill" || !request.since
      ? [
          { filters: [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }] },
          {
            filters: [
              { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
              { propertyName: "closedate", operator: "GTE", value: String(dayStartMs(request.windowFrom)) },
            ],
          },
        ]
      : [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(Date.parse(request.since) - CLOCK_MARGIN_MS) }] }];
  return {
    filterGroups,
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
    properties: [...DEAL_PROPERTIES],
    limit: PAGE_SIZE,
    ...(request.page > 1 ? { after: String((request.page - 1) * PAGE_SIZE) } : {}),
  };
}

const headers = (account: Account) => ({ authorization: `Bearer ${account.accessToken}`, accept: "application/json", "content-type": "application/json" });

export function hubspotReader(deps: HubSpotHttp = {}) {
  const now = deps.now ?? Date.now;
  const contexts = new Map<string, Promise<Omit<DealContext, "companyOf">>>();

  async function call(url: string, account: Account, label: string, body?: unknown): Promise<unknown> {
    const response = await hubspotFetch(url, { method: body === undefined ? "GET" : "POST", headers: headers(account), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, label, deps);
    if (!response.ok) throw await failureOf(response, label, now());
    return jsonOf(response, label);
  }

  /** The pipelines and the account's details, read once per reader and account. */
  function context(account: Account): Promise<Omit<DealContext, "companyOf">> {
    let found = contexts.get(account.externalOrgId);
    if (!found) {
      found = (async () => {
        const pipelines: Map<string, PipelineFacts> = mapPipelines(await call(HUBSPOT_DEAL_PIPELINES, account, "pipelines"));
        const details = mapAccountDetails(await call(HUBSPOT_ACCOUNT, account, "account details"));
        return { pipelines, accountCurrency: details.currency, timeZone: details.timeZone };
      })();
      // A failed read is not kept: the next call reads again.
      found.catch(() => contexts.delete(account.externalOrgId));
      contexts.set(account.externalOrgId, found);
    }
    return found;
  }

  async function associated(account: Account, from: string, to: string, ids: readonly string[], primary: readonly number[]): Promise<Map<string, string>> {
    const chosen = new Map<string, string>();
    for (let at = 0; at < ids.length; at += BATCH) {
      const batch = ids.slice(at, at + BATCH);
      const body = await call(hubspotAssociations(from, to), account, `${from} to ${to}`, { inputs: batch.map((id) => ({ id })) });
      for (const [key, value] of mapAssociations(body, primary)) chosen.set(key, value);
    }
    return chosen;
  }

  async function batchRead(account: Account, object: "companies" | "contacts" | "deals", ids: readonly string[], properties: readonly string[]): Promise<unknown[]> {
    const bodies: unknown[] = [];
    for (let at = 0; at < ids.length; at += BATCH) {
      const batch = ids.slice(at, at + BATCH);
      bodies.push(await call(`${hubspotObjects(object)}/batch/read?archived=false`, account, object, { inputs: batch.map((id) => ({ id })), properties: [...properties], propertiesWithHistory: [] }));
    }
    return bodies;
  }

  /** Each deal's company, with its main contact's email: up to four calls for a page. */
  async function companiesOf(account: Account, dealIds: readonly string[]): Promise<Map<string, ExternalCompany>> {
    const companyOfDeal = await associated(account, "deals", "companies", dealIds, PRIMARY_COMPANY_OF_DEAL);
    const companyIds = [...new Set(companyOfDeal.values())];
    if (companyIds.length === 0) return new Map();
    const names = new Map<string, { name: string | null }>();
    for (const body of await batchRead(account, "companies", companyIds, ["name", "domain"])) for (const [id, company] of mapCompanies(body)) names.set(id, company);
    const contactOfCompany = await associated(account, "companies", "contacts", companyIds, PRIMARY_CONTACT_OF_COMPANY);
    const contactIds = [...new Set(contactOfCompany.values())];
    const emails = new Map<string, string>();
    if (contactIds.length > 0) for (const body of await batchRead(account, "contacts", contactIds, ["email"])) for (const [id, email] of mapContactEmails(body)) emails.set(id, email);
    const companies = new Map<string, ExternalCompany>();
    for (const [dealId, companyId] of companyOfDeal) {
      const named = names.get(companyId);
      // A company HubSpot did not return (deleted a moment ago) is no company.
      if (!named) continue;
      const contactId = contactOfCompany.get(companyId);
      companies.set(dealId, { externalId: companyId, name: named.name ?? "Unnamed company", email: contactId ? (emails.get(contactId) ?? null) : null });
    }
    return companies;
  }

  async function mapped(account: Account, raws: RawRecord[]): Promise<ExternalDeal[]> {
    if (raws.length === 0) return [];
    const [base, companies] = await Promise.all([context(account), companiesOf(account, raws.map((raw) => raw.id))]);
    const dealContext: DealContext = { ...base, companyOf: (dealId) => companies.get(dealId) ?? null };
    return raws.map((raw) => mapDeal(raw, dealContext)).filter((deal): deal is ExternalDeal => deal !== null);
  }

  return {
    async deals(request: CrmPageRequest): Promise<CrmPage> {
      const account = { accessToken: request.accessToken, externalOrgId: request.externalOrgId };
      const body = await call(`${hubspotObjects("deals")}/search`, account, "deal search", searchBody(request));
      const page = mapSearchPage(body, request.page, PAGE_SIZE);
      return { items: await mapped(account, page.deals), page: request.page, last: page.last, total: page.total, capped: page.capped };
    },

    async dealsById(input: { accessToken: string; externalOrgId: string; ids: readonly string[] }): Promise<{ deals: ExternalDeal[]; missing: string[] }> {
      const account = { accessToken: input.accessToken, externalOrgId: input.externalOrgId };
      const raws: RawRecord[] = [];
      const missing: string[] = [];
      for (let at = 0; at < input.ids.length; at += BATCH) {
        const asked = input.ids.slice(at, at + BATCH);
        const [body] = await batchRead(account, "deals", asked, DEAL_PROPERTIES);
        const read = mapBatchDeals(body, asked);
        raws.push(...read.deals);
        missing.push(...read.missing);
      }
      return { deals: await mapped(account, raws), missing };
    },
  };
}
