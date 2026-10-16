import type { ExternalDeal, StageState } from "../connectors/crm";
import { ProviderError, type ExternalOrganisation } from "../connectors/provider";
import { zohoAmount, zohoDay, zohoTime } from "../zohobooks/map";

/**
 * Zoho CRM's JSON in the connector core's shapes (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C5,
 * C6, C7). Pure: the HTTP lives in `./http.ts`. Whatever Zoho sends that does not read is left out, or refused as a bad
 * answer when the whole answer does not read, never guessed.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const cut = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));
const idOf = (value: unknown): string | null => {
  const written = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
  return written && /^[0-9A-Za-z_-]{1,100}$/.test(written) ? written : null;
};

/** A lookup field (`Account_Name`, `Contact_Name`, `Pipeline`): `{ name, id }`, or null. */
function lookup(value: unknown): { id: string; name: string | null } | null {
  if (!isObject(value)) return null;
  const id = idOf(value.id);
  return id ? { id, name: cut(text(value.name), 200) } : null;
}

/** A list answer's records: `data`, or none for a 204 or a 304 (read as null). Anything else does not read. */
function dataOf(body: unknown, label: string): unknown[] {
  if (body === null) return [];
  if (!isObject(body) || !Array.isArray(body.data)) throw new ProviderError("bad_response", `Zoho CRM's ${label} answer did not read`);
  return body.data;
}

/** What a deal is read with beyond its own fields: its stage's outcome, the home currency, its contact's email. */
export interface DealContext {
  /** Each stage's outcome, by the name Zoho CRM writes on a deal (its actual and its display value). */
  stages: ReadonlyMap<string, StageState>;
  /** The organization's home currency, for a deal without a `Currency` of its own (one currency organizations). */
  homeCurrency: string | null;
  /** The contacts' emails, by contact id. */
  emails: ReadonlyMap<string, string>;
}

export const EMPTY_CONTEXT: DealContext = { stages: new Map(), homeCurrency: null, emails: new Map() };

/** The fields every deal is read with (`fields` is required by Zoho CRM's list call, at most 50). Not its owner: nothing uses it. */
export const DEAL_FIELDS = ["Deal_Name", "Amount", "Currency", "Closing_Date", "Stage", "Pipeline", "Account_Name", "Contact_Name", "Modified_Time"] as const;

/**
 * A stage's outcome (C6): its forecast type from the pipelines, else Zoho CRM's own stage names ("Closed Won",
 * "Closed Lost", "Closed-Lost to Competition"), else open.
 */
export function stageOf(name: string | null, stages: ReadonlyMap<string, StageState>): StageState {
  if (name === null) return "open";
  const known = stages.get(name);
  if (known) return known;
  if (/^closed[\s-]*won\b/i.test(name)) return "won";
  if (/^closed[\s-]*lost\b/i.test(name)) return "lost";
  return "open";
}

/** A deal in the core's shape (C7), or null when it has no id or no last change. */
export function mapDeal(raw: unknown, context: DealContext): ExternalDeal | null {
  if (!isObject(raw)) return null;
  const externalId = idOf(raw.id);
  const updatedAt = zohoTime(raw.Modified_Time);
  if (!externalId || !updatedAt) return null;
  const account = lookup(raw.Account_Name);
  const contact = lookup(raw.Contact_Name);
  const pipeline = isObject(raw.Pipeline) ? lookup(raw.Pipeline) : null;
  const pipelineName = pipeline?.name ?? cut(text(raw.Pipeline), 200);
  const stageLabel = cut(text(raw.Stage), 200);
  const ownCurrency = text(raw.Currency);
  const currency = ownCurrency && /^[A-Z]{3}$/.test(ownCurrency) ? ownCurrency : context.homeCurrency;
  return {
    externalId,
    version: updatedAt,
    updatedAt,
    name: cut(text(raw.Deal_Name), 200) ?? "Untitled deal",
    amount: raw.Amount === null || raw.Amount === undefined ? null : zohoAmount(raw.Amount),
    currency,
    closeOn: zohoDay(raw.Closing_Date),
    pipelineId: pipeline?.id ?? pipelineName,
    pipelineLabel: pipelineName,
    stageId: stageLabel,
    stageLabel,
    stage: stageOf(stageLabel, context.stages),
    company: account ? { externalId: account.id, name: account.name ?? "Zoho CRM account", email: contact ? (context.emails.get(contact.id) ?? null) : null } : null,
  };
}

/** The contact a deal names, for its email; null for none. */
export function dealContactId(raw: unknown): string | null {
  return isObject(raw) ? (lookup(raw.Contact_Name)?.id ?? null) : null;
}

/** A page of deals: its records, whether more follow, and the token of the next page when Zoho gives one. */
export function mapDealsList(body: unknown): { raws: unknown[]; more: boolean; nextToken: string | null } {
  const raws = dataOf(body, "deals");
  const info = isObject(body) && isObject(body.info) ? body.info : {};
  return { raws, more: info.more_records === true, nextToken: text(info.next_page_token) };
}

/** The contacts' emails, by id. */
export function mapContactEmails(body: unknown): Map<string, string> {
  const emails = new Map<string, string>();
  for (const raw of dataOf(body, "contacts")) {
    if (!isObject(raw)) continue;
    const id = idOf(raw.id);
    const email = text(raw.Email);
    if (id && email && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) emails.set(id, email.toLowerCase());
  }
  return emails;
}

/** The Deals module's layouts, by id: each has its own pipelines. */
export function mapLayoutIds(body: unknown): string[] {
  if (body === null) return [];
  if (!isObject(body) || !Array.isArray(body.layouts)) throw new ProviderError("bad_response", "Zoho CRM's layouts answer did not read");
  return body.layouts.map((layout) => (isObject(layout) ? idOf(layout.id) : null)).filter((id): id is string => id !== null);
}

const FORECAST: Record<string, StageState> = { "closed won": "won", "closed lost": "lost", open: "open" };

/** Each stage's outcome in a layout's pipelines, by its actual and its display value (C6). */
export function mapPipelineStages(body: unknown): Map<string, StageState> {
  const stages = new Map<string, StageState>();
  if (body === null || !isObject(body) || !Array.isArray(body.pipeline)) return stages;
  for (const pipeline of body.pipeline) {
    if (!isObject(pipeline) || !Array.isArray(pipeline.maps)) continue;
    for (const stage of pipeline.maps) {
      if (!isObject(stage)) continue;
      const outcome = FORECAST[(text(stage.forecast_type) ?? "").toLowerCase()];
      if (!outcome) continue;
      for (const name of [text(stage.actual_value), text(stage.display_value)]) if (name) stages.set(name, outcome);
    }
  }
  return stages;
}

/** The organization a token reaches (C5): its id, its name, and its home currency. */
export function mapOrg(body: unknown): { organisation: ExternalOrganisation; homeCurrency: string | null } {
  const org = isObject(body) && Array.isArray(body.org) ? body.org[0] : null;
  const externalOrgId = isObject(org) ? idOf(org.id) : null;
  if (!isObject(org) || !externalOrgId) throw new ProviderError("bad_response", "Zoho CRM's organization answer did not read");
  const iso = text(org.iso_code);
  return {
    organisation: { externalOrgId, name: cut(text(org.company_name), 200) ?? "Zoho CRM organization", connectionId: null },
    homeCurrency: iso && /^[A-Z]{3}$/.test(iso) ? iso : null,
  };
}

/** `If-Modified-Since` in the form Zoho CRM shows (`2026-10-16T08:32:11+00:00`), floored to the second. */
export function ifModifiedSince(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19)}+00:00`;
}
