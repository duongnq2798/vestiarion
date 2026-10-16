import type { CrmPage, CrmPageRequest, ExternalDeal, StageState } from "../connectors/crm";
import { CLOCK_MARGIN_MS } from "../connectors/cursors";
import { ProviderError } from "../connectors/provider";
import { crmGet, type ZohoCrmHttp } from "./http";
import { DEAL_FIELDS, dealContactId, EMPTY_CONTEXT, ifModifiedSince, mapContactEmails, mapDeal, mapDealsList, mapLayoutIds, mapOrg, mapPipelineStages, type DealContext } from "./map";

/**
 * Reading Zoho CRM's deals for the connector core (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C6,
 * C7, C8): API v8's Deals, 200 a page in the order of their last change, each page with its contacts' emails; and the
 * deals named by id. Zoho CRM pages with `page_token` past its first 2,000 records and the core with page numbers: a
 * reader remembers the token of each page it read, and one asked for a page it has no token for (a run resumed after the
 * page budget ran out) walks there from the first page. Make one reader per run: it reads the stages and the
 * organization's home currency once.
 */

export const PAGE_SIZE = 200;
/** Zoho CRM reads at most this many records by page number; past it, only by `page_token`. */
const PAGE_NUMBER_LIMIT = 10;

export function zohoCrmReader(deps: ZohoCrmHttp = {}) {
  /** The token of each page read so far, by the query and its page number; page 1 has none. */
  const tokens = new Map<string, string | null>();
  let lookups: Promise<Pick<DealContext, "stages" | "homeCurrency">> | null = null;

  /**
   * Each stage's outcome from every Deals layout's pipelines (C6). A layout or pipeline Zoho will not show (a scope, an
   * edition without pipelines) leaves the stage names to say it; a refused token or an outage ends the run.
   */
  async function stages(credential: string): Promise<Map<string, StageState>> {
    try {
      const layouts = mapLayoutIds(await crmGet(credential, "/settings/layouts", { query: { module: "Deals" } }, "layouts", deps));
      const found = new Map<string, StageState>();
      for (const layoutId of layouts.slice(0, 10)) {
        for (const [name, outcome] of mapPipelineStages(await crmGet(credential, "/settings/pipeline", { query: { layout_id: layoutId } }, "pipelines", deps))) {
          found.set(name, outcome);
        }
      }
      return found;
    } catch (error) {
      if (error instanceof ProviderError && (error.failure === "forbidden" || error.failure === "bad_response")) return new Map();
      throw error;
    }
  }

  /** The stages and the home currency, once per reader. */
  function context(credential: string) {
    lookups ??= Promise.all([stages(credential), crmGet(credential, "/org", {}, "organization", deps).then((body) => mapOrg(body).homeCurrency)])
      .then(([found, homeCurrency]) => ({ stages: found, homeCurrency }))
      .catch((error: unknown) => {
        lookups = null;
        throw error;
      });
    return lookups;
  }

  /** The emails of the contacts a set of deals names: one call, at most 100 ids. */
  async function contextFor(credential: string, raws: readonly unknown[]): Promise<DealContext> {
    if (raws.length === 0) return EMPTY_CONTEXT;
    const contactIds = [...new Set(raws.map(dealContactId).filter((id): id is string => id !== null))].slice(0, 100);
    const [shared, emails] = await Promise.all([
      context(credential),
      contactIds.length === 0
        ? Promise.resolve(new Map<string, string>())
        : crmGet(credential, "/Contacts", { query: { ids: contactIds.join(","), fields: "Email" } }, "contacts", deps).then(mapContactEmails),
    ]);
    return { ...shared, emails };
  }

  function query(request: Pick<CrmPageRequest, "phase" | "since">): { query: Record<string, string>; ifModifiedSince?: string } {
    const base = { fields: DEAL_FIELDS.join(","), per_page: String(PAGE_SIZE), sort_by: "Modified_Time", sort_order: "asc" };
    if (request.phase === "backfill" || request.since === null) return { query: base };
    // Every deal changed since a few minutes before the last run's latest: a deal read twice is ignored by its version.
    return { query: base, ifModifiedSince: ifModifiedSince(new Date(Date.parse(request.since) - CLOCK_MARGIN_MS).toISOString()) };
  }

  async function readPage(credential: string, asked: ReturnType<typeof query>, page: number, token: string | null) {
    // Past the first page Zoho's token is used where it gave one; else the page number, which reads the first 2,000.
    const where: Record<string, string> = token ? { page_token: token } : page > 1 ? { page: String(page) } : {};
    return mapDealsList(await crmGet(credential, "/Deals", { query: { ...asked.query, ...where }, ifModifiedSince: asked.ifModifiedSince }, "deals", deps));
  }

  return {
    /** A page of deals (C8): the page asked for, walking there from the last page whose token is known. */
    async deals(request: CrmPageRequest): Promise<CrmPage> {
      const asked = query(request);
      const key = (page: number) => `${JSON.stringify(asked)}#${page}`;
      tokens.set(key(1), null);
      let page = request.page;
      // A page by number reads within Zoho's first 2,000 records; beyond them, walk the tokens from the last one known.
      while (page > 1 && !tokens.has(key(page)) && page > PAGE_NUMBER_LIMIT) page -= 1;
      let list = await readPage(request.accessToken, asked, page, tokens.get(key(page)) ?? null);
      while (page < request.page) {
        if (!list.more) return { items: [], page: request.page, last: true, total: null };
        if (list.nextToken) tokens.set(key(page + 1), list.nextToken);
        page += 1;
        if (!list.nextToken && page > PAGE_NUMBER_LIMIT) throw new ProviderError("bad_response", "Zoho CRM gave no token for a page past its first 2,000 deals");
        list = await readPage(request.accessToken, asked, page, tokens.get(key(page)) ?? null);
      }
      if (list.more && list.nextToken) tokens.set(key(request.page + 1), list.nextToken);
      const context = await contextFor(request.accessToken, list.raws);
      const items = list.raws.map((raw) => mapDeal(raw, context)).filter((deal): deal is ExternalDeal => deal !== null);
      return { items, page: request.page, last: !list.more, total: null };
    },

    /** The deals named, at most 100: those Zoho CRM has; `missing`, those it no longer has (deleted there). */
    async dealsById(input: { accessToken: string; externalOrgId: string; ids: readonly string[] }): Promise<{ deals: ExternalDeal[]; missing: string[] }> {
      const ids = [...new Set(input.ids)].slice(0, 100);
      if (ids.length === 0) return { deals: [], missing: [] };
      const list = mapDealsList(await crmGet(input.accessToken, "/Deals", { query: { ids: ids.join(","), fields: DEAL_FIELDS.join(",") } }, "deals by id", deps));
      const context = await contextFor(input.accessToken, list.raws);
      const deals = list.raws.map((raw) => mapDeal(raw, context)).filter((deal): deal is ExternalDeal => deal !== null && ids.includes(deal.externalId));
      const present = new Set(deals.map((deal) => deal.externalId));
      return { deals, missing: ids.filter((id) => !present.has(id)) };
    },

    /** The organization a token reaches (C5): one per grant. */
    async organisation(accessToken: string) {
      return mapOrg(await crmGet(accessToken, "/org", {}, "organization", deps)).organisation;
    },
  };
}
