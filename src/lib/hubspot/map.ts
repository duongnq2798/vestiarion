import type { ExternalCompany, ExternalDeal, StageState } from "../connectors/crm";
import { ProviderError, type ProviderTokens } from "../connectors/provider";

/**
 * HubSpot's JSON in the connector core's shapes (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H5, H6).
 * Pure: the HTTP lives in `./http.ts`. A record that does not read is left out, and an answer that does not read is a
 * bad response, never guessed.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const cut = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));
/** An id HubSpot writes as a number or a string. */
const idOf = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" && /^[0-9A-Za-z_-]{1,100}$/.test(value.trim()) ? value.trim() : null;
const CURRENCY = /^[A-Z]{3}$/;

/** HubSpot's search stops at 10,000 results for one query. */
export const SEARCH_CAP = 10_000;

/** A token answer (`/oauth/2026-03/token`), and the account it is for. A refresh may answer without a refresh token: the one sent stays. */
export function mapTokens(body: unknown, nowMs: number, sentRefreshToken?: string): { tokens: ProviderTokens; hubId: string | null } {
  const json = isObject(body) ? body : {};
  const accessToken = text(json.access_token);
  const refreshToken = text(json.refresh_token) ?? sentRefreshToken ?? null;
  if (!accessToken) throw new ProviderError("bad_response", "HubSpot's token answer had no access_token");
  if (!refreshToken) throw new ProviderError("bad_response", "HubSpot's token answer had no refresh_token");
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 1800;
  const scopes = Array.isArray(json.scopes) ? json.scopes.filter((scope): scope is string => typeof scope === "string") : typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [];
  return { tokens: { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000, scopes }, hubId: idOf(json.hub_id) };
}

/** The introspection of a token (`/oauth/2026-03/token/introspect`): its account and that account's domain. */
export function mapIntrospection(body: unknown): { hubId: string | null; hubDomain: string | null } {
  const json = isObject(body) && body.active !== false ? body : {};
  return { hubId: idOf(json.hub_id), hubDomain: cut(text(json.hub_domain), 200) };
}

/** The account's details (`/account-info/2026-03/details`): its currency and time zone. */
export function mapAccountDetails(body: unknown): { hubId: string | null; currency: string | null; timeZone: string | null } {
  const json = isObject(body) ? body : {};
  const currency = typeof json.companyCurrency === "string" && CURRENCY.test(json.companyCurrency) ? json.companyCurrency : null;
  return { hubId: idOf(json.portalId), currency, timeZone: cut(text(json.timeZone), 64) };
}

export interface PipelineStage {
  label: string;
  /** Won, lost or open by the stage's metadata; null when it does not say. */
  state: StageState | null;
}

export interface PipelineFacts {
  label: string;
  stages: Map<string, PipelineStage>;
}

function stageState(metadata: unknown): StageState | null {
  if (!isObject(metadata)) return null;
  if (metadata.isClosed === "false" || metadata.isClosed === false) return "open";
  if (metadata.isClosed !== "true" && metadata.isClosed !== true) return null;
  return Number(metadata.probability) === 1 ? "won" : "lost";
}

/** The deal pipelines (`/crm/pipelines/2026-03/deals`): each one's label and its stages'. */
export function mapPipelines(body: unknown): Map<string, PipelineFacts> {
  if (!isObject(body) || !Array.isArray(body.results)) throw new ProviderError("bad_response", "HubSpot's pipelines answer did not read");
  const pipelines = new Map<string, PipelineFacts>();
  for (const raw of body.results) {
    if (!isObject(raw)) continue;
    const id = text(raw.id);
    if (!id) continue;
    const stages = new Map<string, PipelineStage>();
    for (const stage of Array.isArray(raw.stages) ? raw.stages : []) {
      if (!isObject(stage)) continue;
      const stageId = text(stage.id);
      if (stageId) stages.set(stageId, { label: cut(text(stage.label), 200) ?? stageId, state: stageState(stage.metadata) });
    }
    pipelines.set(id, { label: cut(text(raw.label), 200) ?? id, stages });
  }
  return pipelines;
}

/** A CRM record as HubSpot sends it: its id, its properties as text, and when it last changed. */
export interface RawRecord {
  id: string;
  properties: Record<string, unknown>;
  updatedAt: string | null;
}

function recordOf(raw: unknown): RawRecord | null {
  if (!isObject(raw)) return null;
  const id = idOf(raw.id);
  if (!id) return null;
  return { id, properties: isObject(raw.properties) ? raw.properties : {}, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
}

function resultsOf(body: unknown, label: string): unknown[] {
  if (!isObject(body) || !Array.isArray(body.results)) throw new ProviderError("bad_response", `HubSpot's ${label} answer did not read`);
  return body.results;
}

/**
 * A page of a search (`/crm/objects/2026-03/deals/search`): the deals, HubSpot's count of what the query matches now,
 * and whether a page follows. The page whose next one would start at the 10,000th result is the last HubSpot gives.
 */
export function mapSearchPage(body: unknown, page: number, pageSize: number): { deals: RawRecord[]; last: boolean; capped: boolean; total: number | null } {
  const results = resultsOf(body, "search");
  const json = body as Json;
  const deals = results.map(recordOf).filter((deal): deal is RawRecord => deal !== null);
  const next = isObject(json.paging) && isObject(json.paging.next) ? json.paging.next.after : undefined;
  const after = typeof next === "string" && /^\d+$/.test(next) ? Number(next) : typeof next === "number" ? next : null;
  const total = typeof json.total === "number" && Number.isInteger(json.total) && json.total >= 0 ? json.total : null;
  if (after === null) return { deals, last: true, capped: false, total };
  // The offset of the page after this one: HubSpot reads no further than its cap.
  const capped = after >= SEARCH_CAP || page * pageSize >= SEARCH_CAP;
  return { deals, last: capped, capped, total };
}

/**
 * Deals read by id (`/crm/objects/2026-03/deals/batch/read`): those HubSpot has, and those it no longer has. An id is
 * missing only when HubSpot says it was not found, or when no other error leaves its absence unexplained.
 */
export function mapBatchDeals(body: unknown, asked: readonly string[]): { deals: RawRecord[]; missing: string[] } {
  const deals = resultsOf(body, "deals").map(recordOf).filter((deal): deal is RawRecord => deal !== null);
  const errors = Array.isArray((body as Json).errors) ? ((body as Json).errors as unknown[]).filter(isObject) : [];
  const found = new Set(deals.map((deal) => deal.id));
  const notFound = new Set(
    errors
      .filter((error) => error.category === "OBJECT_NOT_FOUND")
      .flatMap((error) => (isObject(error.context) && Array.isArray(error.context.ids) ? error.context.ids : []))
      .map((id) => String(id))
  );
  const unsure = errors.some((error) => error.category !== "OBJECT_NOT_FOUND");
  const missing = asked.filter((id) => !found.has(id) && (notFound.has(id) || !unsure));
  return { deals, missing };
}

/** A deal's primary company: HubSpot's association type 5, labelled Primary. */
export const PRIMARY_COMPANY_OF_DEAL: readonly number[] = [5];
/** A contact whose primary company this is: association type 2. */
export const PRIMARY_CONTACT_OF_COMPANY: readonly number[] = [2];

/**
 * Associations read in a batch (`/crm/associations/2026-03/{from}/{to}/batch/read`): for each record, the one
 * associated record that counts, the primary one where there is one (by its type or its label), else the lowest id.
 */
export function mapAssociations(body: unknown, primaryTypeIds: readonly number[]): Map<string, string> {
  const chosen = new Map<string, string>();
  for (const raw of resultsOf(body, "associations")) {
    if (!isObject(raw) || !isObject(raw.from) || !Array.isArray(raw.to)) continue;
    const from = idOf(raw.from.id);
    if (!from) continue;
    const targets = raw.to.flatMap((to): Array<{ id: string; primary: boolean }> => {
      if (!isObject(to)) return [];
      const id = idOf(to.toObjectId);
      if (!id) return [];
      const types = Array.isArray(to.associationTypes) ? to.associationTypes.filter(isObject) : [];
      const primary = types.some((type) => type.label === "Primary" || (type.category === "HUBSPOT_DEFINED" && primaryTypeIds.includes(Number(type.typeId))));
      return [{ id, primary }];
    });
    const lowest = (ids: Array<{ id: string }>) => [...ids].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0]?.id;
    const pick = lowest(targets.filter((target) => target.primary && /^\d+$/.test(target.id))) ?? lowest(targets.filter((target) => /^\d+$/.test(target.id)));
    if (pick) chosen.set(from, pick);
  }
  return chosen;
}

/** Companies read in a batch: each one's name, its domain when it has none. */
export function mapCompanies(body: unknown): Map<string, { name: string | null }> {
  const companies = new Map<string, { name: string | null }>();
  for (const record of resultsOf(body, "companies").map(recordOf)) {
    if (!record) continue;
    companies.set(record.id, { name: cut(text(record.properties.name) ?? text(record.properties.domain), 200) });
  }
  return companies;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Contacts read in a batch: each one's email, when it is one. */
export function mapContactEmails(body: unknown): Map<string, string> {
  const emails = new Map<string, string>();
  for (const record of resultsOf(body, "contacts").map(recordOf)) {
    const email = record ? text(record.properties.email)?.toLowerCase() : null;
    if (record && email && email.length <= 320 && EMAIL.test(email)) emails.set(record.id, email);
  }
  return emails;
}

/** An amount as HubSpot writes it (`"4800.50"`), as an exact decimal (`"4800.5"`); null when it is none or not one. */
export function hubspotAmount(value: unknown): string | null {
  const written = typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
  const match = written ? /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(written) : null;
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** An instant HubSpot gives as an ISO time or as epoch milliseconds, as an ISO string. */
export function hubspotTime(value: unknown): string | null {
  const written = text(value);
  if (!written) return null;
  const ms = /^\d{10,15}$/.test(written) ? Number(written) : /^\d{4}-\d{2}-\d{2}T/.test(written) ? Date.parse(written) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The day of an instant in the account's time zone (UTC when it has none, or one that does not read); a day as is. */
export function closeDay(value: unknown, timeZone: string | null): string | null {
  const written = text(value);
  if (written && /^\d{4}-\d{2}-\d{2}$/.test(written)) return written;
  const instant = hubspotTime(value);
  if (!instant) return null;
  if (timeZone) {
    try {
      // en-CA writes YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
    } catch {
      // A zone this runtime does not know: UTC.
    }
  }
  return instant.slice(0, 10);
}

/** What a deal is read with: the pipelines, the account's currency and time zone, and each deal's company. */
export interface DealContext {
  pipelines: Map<string, PipelineFacts>;
  accountCurrency: string | null;
  timeZone: string | null;
  companyOf: (dealId: string) => ExternalCompany | null;
}

const flag = (value: unknown): boolean | null => (value === "true" || value === true ? true : value === "false" || value === false ? false : null);

/** One deal, or null when it does not read. */
export function mapDeal(raw: RawRecord, context: DealContext): ExternalDeal | null {
  const props = raw.properties;
  const version = hubspotTime(props.hs_lastmodifieddate) ?? hubspotTime(raw.updatedAt);
  if (!raw.id || !version) return null;
  const pipelineId = cut(text(props.pipeline), 100);
  const stageId = cut(text(props.dealstage), 100);
  const pipeline = pipelineId ? context.pipelines.get(pipelineId) : undefined;
  const stage = stageId ? pipeline?.stages.get(stageId) : undefined;
  // The deal's own flags, which HubSpot works out from its stage; the stage's metadata when they are not there.
  const won = flag(props.hs_is_closed_won);
  const closed = flag(props.hs_is_closed);
  const state: StageState = won === true ? "won" : closed === true ? "lost" : closed === false ? "open" : (stage?.state ?? "open");
  const own = typeof props.deal_currency_code === "string" && CURRENCY.test(props.deal_currency_code) ? props.deal_currency_code : null;
  return {
    externalId: raw.id,
    version,
    updatedAt: version,
    name: cut(text(props.dealname), 200) ?? "Untitled deal",
    amount: hubspotAmount(props.amount),
    currency: own ?? context.accountCurrency,
    closeOn: closeDay(props.closedate, context.timeZone),
    pipelineId,
    pipelineLabel: pipeline?.label ?? null,
    stageId,
    stageLabel: stage?.label ?? null,
    stage: state,
    company: context.companyOf(raw.id),
  };
}
