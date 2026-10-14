import type { CrmPage, CrmPageRequest, ExternalDeal } from "../connectors/crm";
import { CLOCK_MARGIN_MS } from "../connectors/cursors";
import { apiJson, type PipedriveHttp } from "./http";
import { dealRefs, EMPTY_CONTEXT, isDeletedDeal, mapDeal, mapList, mapOrganizations, mapPersonEmails, mapPipelines, mapStages, type DealContext } from "./map";

/**
 * Reading Pipedrive's deals for the connector core (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P6):
 * API v2's deals, 100 a page in the order of their last change, each page with its organizations and persons; and the
 * deals named by id, archived ones included. Pipedrive pages with opaque cursors and the core with page numbers: a
 * reader remembers the cursor of each page it read, and one asked for a page it has no cursor for (a run resumed after
 * the page budget ran out) walks there from the first page. Make one reader per run: it reads stages and pipelines once.
 */

export const PAGE_SIZE = 100;
/** Stages and pipelines read at most this many pages of 500. */
const LOOKUP_PAGES = 4;

/** RFC 3339 without milliseconds, rounded down: Pipedrive's `updated_since` takes it. */
const rfc3339 = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function pipedriveReader(deps: PipedriveHttp = {}) {
  /** The cursor of each page read so far, by the query and its page number; page 1 has none. */
  const cursors = new Map<string, string | null>();
  let lookups: Promise<Pick<DealContext, "stages" | "pipelines">> | null = null;

  async function listAll(credential: string, path: string, label: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < LOOKUP_PAGES; page += 1) {
      const list = mapList(await apiJson(credential, path, { query: { limit: "500", ...(cursor ? { cursor } : {}) } }, label, deps), label);
      items.push(...list.items);
      cursor = list.next;
      if (!cursor) break;
    }
    return items;
  }

  /** Stages and pipelines, once per reader: a label that cannot be read leaves the deal without it, never the run. */
  function stagesAndPipelines(credential: string) {
    lookups ??= Promise.all([listAll(credential, "/api/v2/stages", "stages"), listAll(credential, "/api/v2/pipelines", "pipelines")])
      .then(([stages, pipelines]) => ({ stages: mapStages(stages), pipelines: mapPipelines(pipelines) }))
      .catch((error: unknown) => {
        lookups = null;
        throw error;
      });
    return lookups;
  }

  /** The organizations' names and the persons' emails a set of deals names: one call each, at most 100 ids. */
  async function contextFor(credential: string, raws: readonly unknown[]): Promise<DealContext> {
    const organizationIds = new Set<string>();
    const personIds = new Set<string>();
    for (const raw of raws) {
      if (isDeletedDeal(raw)) continue;
      const refs = dealRefs(raw);
      if (refs.organizationId) organizationIds.add(refs.organizationId);
      if (refs.personId) personIds.add(refs.personId);
    }
    const byIds = async (path: string, ids: Set<string>, label: string) =>
      ids.size === 0 ? [] : mapList(await apiJson(credential, path, { query: { ids: [...ids].slice(0, 100).join(","), limit: "100" } }, label, deps), label).items;
    const [labels, organizations, persons] = await Promise.all([
      raws.length > 0 ? stagesAndPipelines(credential) : Promise.resolve(EMPTY_CONTEXT),
      byIds("/api/v2/organizations", organizationIds, "organizations"),
      byIds("/api/v2/persons", personIds, "persons"),
    ]);
    return { ...labels, organizations: mapOrganizations(organizations), emails: mapPersonEmails(persons) };
  }

  function query(request: Pick<CrmPageRequest, "phase" | "since">): Record<string, string> {
    const base = { limit: String(PAGE_SIZE), sort_by: "update_time", sort_direction: "asc" };
    if (request.phase === "backfill" || request.since === null) return { ...base, status: "open,won" };
    // Every change since a few minutes before the last run's latest, lost and deleted deals too: a deal read twice is
    // ignored by its version.
    return { ...base, status: "open,won,lost,deleted", updated_since: rfc3339(Date.parse(request.since) - CLOCK_MARGIN_MS) };
  }

  async function readPage(credential: string, asked: Record<string, string>, cursor: string | null) {
    return mapList(await apiJson(credential, "/api/v2/deals", { query: { ...asked, ...(cursor ? { cursor } : {}) } }, "deals", deps), "deals");
  }

  return {
    /** A page of deals (P6): the page asked for, walking there from the last page whose cursor is known. */
    async deals(request: CrmPageRequest): Promise<CrmPage> {
      const asked = query(request);
      const key = (page: number) => `${JSON.stringify(asked)}#${page}`;
      cursors.set(key(1), null);
      let page = request.page;
      while (page > 1 && !cursors.has(key(page))) page -= 1;
      let cursor = cursors.get(key(page)) ?? null;
      let list = await readPage(request.accessToken, asked, cursor);
      while (page < request.page) {
        if (!list.next) return { items: [], page: request.page, last: true, total: null };
        cursors.set(key(page + 1), list.next);
        page += 1;
        cursor = list.next;
        list = await readPage(request.accessToken, asked, cursor);
      }
      if (list.next) cursors.set(key(request.page + 1), list.next);
      const context = await contextFor(request.accessToken, list.items);
      const items = list.items.map((raw) => mapDeal(raw, context)).filter((deal): deal is ExternalDeal => deal !== null);
      return { items, page: request.page, last: list.next === null, total: null };
    },

    /**
     * The deals named (P6), at most 100: those Pipedrive has, archived ones included; `missing`, those it has not, or
     * says were deleted.
     */
    async dealsById(input: { accessToken: string; externalOrgId: string; ids: readonly string[] }): Promise<{ deals: ExternalDeal[]; missing: string[] }> {
      const ids = [...new Set(input.ids)].slice(0, 100);
      if (ids.length === 0) return { deals: [], missing: [] };
      const byIds = async (path: string, wanted: readonly string[], label: string) =>
        mapList(await apiJson(input.accessToken, path, { query: { ids: wanted.join(","), status: "open,won,lost,deleted", limit: "100" } }, label, deps), label).items;
      const found = await byIds("/api/v2/deals", ids, "deals by id");
      const seen = new Set(found.map((raw) => mapDeal(raw, EMPTY_CONTEXT)?.externalId).filter((id): id is string => Boolean(id)));
      const rest = ids.filter((id) => !seen.has(id));
      const archived = rest.length > 0 ? await byIds("/api/v2/deals/archived", rest, "archived deals by id") : [];
      const raws = [...found, ...archived];
      const live = raws.filter((raw) => !isDeletedDeal(raw));
      const context = await contextFor(input.accessToken, live);
      const deals = live.map((raw) => mapDeal(raw, context)).filter((deal): deal is ExternalDeal => deal !== null && ids.includes(deal.externalId));
      const present = new Set(deals.map((deal) => deal.externalId));
      return { deals, missing: ids.filter((id) => !present.has(id)) };
    },
  };
}
