import type { ExternalDeal, StageState } from "../connectors/crm";
import { ProviderError, type ProviderTokens } from "../connectors/provider";
import { apiHostOf, openCredential, sealCredential } from "./credential";

/**
 * Pipedrive's JSON in the connector core's shapes (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P5,
 * P6). Pure: the HTTP lives in `./http.ts`. A record that does not read is left out, and an answer that does not read is
 * a bad response, never guessed.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const cut = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));
/** Pipedrive's ids are positive integers; an older answer may wrap one as `{ value }`. */
export const idOf = (value: unknown): string | null => {
  if (isObject(value)) return idOf(value.value ?? value.id);
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,19}$/.test(value.trim())) return value.trim();
  return null;
};
const CURRENCY = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The scopes of a token answer: Pipedrive's `scope`, separated by commas or spaces. */
export function scopesOf(scope: unknown): string[] {
  return typeof scope === "string" ? [...new Set(scope.split(/[\s,]+/).filter(Boolean))] : [];
}

/**
 * A token answer (`/oauth/token`), its tokens sealed with the host of its `api_domain` (P5). A refresh may answer
 * without a refresh token, or without `api_domain`: the ones sent stay. An `api_domain` that is not a Pipedrive company's
 * own is refused, whatever came with it.
 */
export function mapTokens(body: unknown, nowMs: number, sent?: { refreshCredential: string }): ProviderTokens {
  const json = isObject(body) ? body : {};
  const previous = sent ? openCredential(sent.refreshCredential) : null;
  const accessToken = text(json.access_token);
  if (!accessToken) throw new ProviderError("bad_response", "Pipedrive's token answer had no access_token");
  const named = json.api_domain === undefined || json.api_domain === null ? null : apiHostOf(json.api_domain);
  if (json.api_domain !== undefined && json.api_domain !== null && named === null) throw new ProviderError("bad_response", "Pipedrive's token answer named an API domain that is not Pipedrive's");
  const host = named ?? previous?.host ?? null;
  if (!host) throw new ProviderError("bad_response", "Pipedrive's token answer had no api_domain");
  const refreshToken = text(json.refresh_token) ?? previous?.token ?? null;
  if (!refreshToken) throw new ProviderError("bad_response", "Pipedrive's token answer had no refresh_token");
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? Math.min(json.expires_in, 24 * 3600) : 3600;
  return {
    accessToken: sealCredential(host, accessToken),
    refreshToken: sealCredential(host, refreshToken),
    expiresAt: nowMs + expiresIn * 1000,
    scopes: scopesOf(json.scope),
  };
}

/** The user a token acts as, and their company (`/api/v1/users/me`). */
export interface PipedriveMe {
  companyId: string;
  companyName: string | null;
  companyDomain: string | null;
  userId: string | null;
  userName: string | null;
  /** An admin of any of the company's apps: one who may add custom fields and see every deal by default. */
  admin: boolean;
}

export function mapMe(body: unknown): PipedriveMe {
  const json = isObject(body) && isObject(body.data) ? body.data : null;
  const companyId = json ? idOf(json.company_id) : null;
  if (!json || !companyId) throw new ProviderError("bad_response", "Pipedrive's users/me named no company");
  const access = Array.isArray(json.access) ? json.access : [];
  const admin = json.is_admin === true || access.some((entry) => isObject(entry) && entry.admin === true && (entry.app === "global" || entry.app === "sales" || entry.app === "account_settings"));
  return {
    companyId,
    companyName: cut(text(json.company_name), 200),
    companyDomain: cut(text(json.company_domain), 100),
    userId: idOf(json.id),
    userName: cut(text(json.name), 200),
    admin,
  };
}

/** A list answer of API v2: its items, and the cursor of the page after it (null at the end). */
export function mapList(body: unknown, label: string): { items: unknown[]; next: string | null } {
  const json = isObject(body) ? body : {};
  if (json.success === false) throw new ProviderError("bad_response", `Pipedrive ${label}: success false`);
  const items = json.data === null || json.data === undefined ? [] : json.data;
  if (!Array.isArray(items)) throw new ProviderError("bad_response", `Pipedrive ${label}: no data list`);
  const additional = isObject(json.additional_data) ? json.additional_data : {};
  const next = typeof additional.next_cursor === "string" && additional.next_cursor.length > 0 && additional.next_cursor.length <= 2000 ? additional.next_cursor : null;
  return { items, next };
}

/** An exact decimal from Pipedrive's `value`, a JSON number; null for none, a negative, or more than six places. */
export function amountOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const written = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,18})(?:\.(\d{1,6}))?$/.exec(written);
  if (!match) return null;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const whole = match[1].replace(/^0+(?=\d)/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** An instant as Pipedrive writes it, as one ISO format, so versions compare as text; null when it does not read. */
export function instantOf(value: unknown): string | null {
  const written = text(value);
  if (!written) return null;
  // API v2 writes RFC 3339; an older answer `YYYY-MM-DD HH:MM:SS` in UTC.
  const at = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(written) ? `${written.replace(" ", "T")}Z` : written);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

const dayOf = (value: unknown): string | null => {
  const written = text(value);
  if (!written) return null;
  if (DAY.test(written)) return written;
  const at = instantOf(written);
  return at ? at.slice(0, 10) : null;
};

/** What a page's deals are told by: stage and pipeline names, organizations' names, persons' emails. */
export interface DealContext {
  stages: ReadonlyMap<string, { name: string; pipelineId: string | null }>;
  pipelines: ReadonlyMap<string, string>;
  organizations: ReadonlyMap<string, string>;
  emails: ReadonlyMap<string, string>;
}

export const EMPTY_CONTEXT: DealContext = { stages: new Map(), pipelines: new Map(), organizations: new Map(), emails: new Map() };

const STATES: Record<string, StageState> = { open: "open", won: "won", lost: "lost" };

/** Whether Pipedrive says a deal was deleted. */
export const isDeletedDeal = (raw: unknown) => isObject(raw) && (raw.status === "deleted" || raw.is_deleted === true);

/** The organization and person a deal names, by id, for the reads that tell them. */
export function dealRefs(raw: unknown): { organizationId: string | null; personId: string | null } {
  if (!isObject(raw)) return { organizationId: null, personId: null };
  return { organizationId: idOf(raw.org_id), personId: idOf(raw.person_id) };
}

/**
 * A deal (API v2) as the core keeps it (P6): its status is its stage's state; the stage's name is its label, a lost
 * deal's reason when it has one; the close day is the won day for a won deal, the lost day for a lost one, the expected
 * close date for an open one; the customer is its organization, with its person's email. A deleted deal says only that.
 * Null when the deal does not read.
 */
export function mapDeal(raw: unknown, context: DealContext): ExternalDeal | null {
  if (!isObject(raw)) return null;
  const externalId = idOf(raw.id);
  const version = instantOf(raw.update_time);
  if (!externalId || !version) return null;
  const name = cut(text(raw.title), 200) ?? `Deal ${externalId}`;
  if (isDeletedDeal(raw)) {
    return {
      externalId, version, updatedAt: version, name, amount: null, currency: null, closeOn: null,
      pipelineId: null, pipelineLabel: null, stageId: null, stageLabel: null, stage: "open", company: null, deleted: true,
    };
  }
  const stage = STATES[typeof raw.status === "string" ? raw.status : ""];
  if (!stage) return null;
  const stageId = idOf(raw.stage_id);
  const pipelineId = idOf(raw.pipeline_id) ?? (stageId ? (context.stages.get(stageId)?.pipelineId ?? null) : null);
  const stageName = stageId ? (context.stages.get(stageId)?.name ?? null) : null;
  const lostReason = stage === "lost" ? cut(text(raw.lost_reason), 200) : null;
  const closeOn =
    stage === "won"
      ? (dayOf(raw.local_won_date) ?? dayOf(raw.won_time) ?? dayOf(raw.local_close_date) ?? dayOf(raw.close_time))
      : stage === "lost"
        ? (dayOf(raw.local_lost_date) ?? dayOf(raw.lost_time) ?? dayOf(raw.local_close_date) ?? dayOf(raw.close_time))
        : dayOf(raw.expected_close_date);
  const currency = typeof raw.currency === "string" && CURRENCY.test(raw.currency) ? raw.currency : null;
  const { organizationId, personId } = dealRefs(raw);
  const embeddedName = isObject(raw.org_id) ? cut(text(raw.org_id.name), 200) : null;
  const organizationName = organizationId ? (context.organizations.get(organizationId) ?? embeddedName ?? `Organization ${organizationId}`) : null;
  return {
    externalId,
    version,
    updatedAt: version,
    name,
    amount: amountOf(raw.value),
    currency,
    closeOn,
    pipelineId,
    pipelineLabel: pipelineId ? (cut(context.pipelines.get(pipelineId) ?? null, 200) ?? null) : null,
    stageId,
    stageLabel: lostReason ?? cut(stageName, 200),
    stage,
    company: organizationId && organizationName ? { externalId: organizationId, name: organizationName, email: personId ? (context.emails.get(personId) ?? null) : null } : null,
    ownerId: idOf(raw.owner_id),
  };
}

/** Organizations by id (`/api/v2/organizations`): each one's name. */
export function mapOrganizations(items: readonly unknown[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const id = idOf(item.id);
    const name = cut(text(item.name), 200);
    if (id && name) found.set(id, name);
  }
  return found;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

/** Persons by id (`/api/v2/persons`): each one's primary email, else its first, in lowercase. */
export function mapPersonEmails(items: readonly unknown[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const id = idOf(item.id);
    const emails = Array.isArray(item.emails) ? item.emails.filter(isObject) : Array.isArray(item.email) ? item.email.filter(isObject) : [];
    const primary = emails.find((entry) => entry.primary === true) ?? emails[0];
    const email = primary ? text(primary.value)?.toLowerCase() : null;
    if (id && email && email.length <= 320 && EMAIL.test(email)) found.set(id, email);
  }
  return found;
}

/** Stages (`/api/v2/stages`): each one's name and pipeline. */
export function mapStages(items: readonly unknown[]): Map<string, { name: string; pipelineId: string | null }> {
  const found = new Map<string, { name: string; pipelineId: string | null }>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const id = idOf(item.id);
    const name = cut(text(item.name), 200);
    if (id && name) found.set(id, { name, pipelineId: idOf(item.pipeline_id) });
  }
  return found;
}

/** Pipelines (`/api/v2/pipelines`): each one's name. */
export function mapPipelines(items: readonly unknown[]): Map<string, string> {
  return mapOrganizations(items);
}

/** A deal field (`/api/v2/dealFields`), as the receipts read it: its name, its key and its type. */
export interface DealField {
  name: string;
  code: string;
  type: string;
  custom: boolean;
}

export function mapDealFields(items: readonly unknown[]): DealField[] {
  return items.flatMap((item): DealField[] => {
    if (!isObject(item)) return [];
    const name = text(item.field_name) ?? text(item.name);
    const code = text(item.field_code) ?? text(item.key);
    const type = text(item.field_type);
    if (!name || !code || !type || !/^[A-Za-z0-9_]{1,64}$/.test(code)) return [];
    return [{ name, code, type, custom: item.is_custom_field === true || /^[0-9a-f]{40}$/.test(code) }];
  });
}

/** A field's value as Pipedrive hands it back, as text: a number in its shortest form, a day, text; "" for none. */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value;
  if (isObject(value) && "value" in value) return fieldText(value.value);
  return "";
}
