import type { ExternalBill, ExternalContact, ExternalOrganisation, Page, ProviderTokens, SourceStatus } from "../connectors/provider";
import { ProviderError } from "../connectors/provider";
import { withRegion, type ZohoRegion } from "./regions";

/**
 * Zoho Books' JSON in the connector core's shapes (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z4,
 * Z5, Z6, Z8). Pure: the HTTP lives in `./http.ts`. Whatever Zoho sends that does not read is left out, or refused as a
 * bad answer when the whole answer does not read (a non-zero `code`), never guessed.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const cut = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));
const idOf = (value: unknown): string | null => {
  const written = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
  return written && /^[0-9A-Za-z_-]{1,100}$/.test(written) ? written : null;
};

/**
 * A time Zoho writes (`2026-10-15T14:02:11+0530`, its offset with or without a colon) in UTC to the millisecond; null
 * without a zone.
 */
export function zohoTime(value: unknown): string | null {
  const written = text(value);
  const match = written?.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/i);
  if (!match) return null;
  const zone = match[2].toUpperCase() === "Z" ? "Z" : match[2].includes(":") ? match[2] : `${match[2].slice(0, 3)}:${match[2].slice(3)}`;
  const at = Date.parse(`${match[1]}${zone}`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A time for `last_modified_time`, in UTC to the second with Zoho's own zone form (`2026-10-15T08:32:11+0000`). Floored. */
export function zohoFilterTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19)}+0000`;
}

/** A day (`date`, `due_date`), only when it is on the calendar. */
export function zohoDay(value: unknown): string | null {
  const written = text(value);
  if (!written || !/^\d{4}-\d{2}-\d{2}$/.test(written)) return null;
  const at = new Date(`${written}T00:00:00.000Z`);
  return !Number.isNaN(at.valueOf()) && at.toISOString().startsWith(written) ? written : null;
}

/** An amount as an exact decimal string: Zoho's carry at most a few places, so 6 rounds away float noise only. */
export function zohoAmount(value: unknown): string | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(number) || Math.abs(number) >= 1e15) return null;
  return String(Number(number.toFixed(6)));
}

/** Zoho answers a refused request with a non-zero `code` and a `message`: never read as data. */
function refuseError(body: unknown, label: string): Json {
  if (!isObject(body)) throw new ProviderError("bad_response", `Zoho Books' ${label} answer did not read`);
  if (body.code !== undefined && body.code !== 0) {
    const code = typeof body.code === "number" ? ` (${body.code})` : "";
    throw new ProviderError("bad_response", `Zoho Books' ${label} answer was an error${code}`);
  }
  return body;
}

function listOf(body: unknown, key: string, label: string): { raws: unknown[]; more: boolean } {
  const json = refuseError(body, label);
  const list = json[key];
  if (list === undefined) return { raws: [], more: false };
  if (!Array.isArray(list)) throw new ProviderError("bad_response", `Zoho Books' ${label} answer did not read`);
  const context = isObject(json.page_context) ? json.page_context : {};
  return { raws: list, more: context.has_more_page === true };
}

/** Zoho's bill statuses in the core's words (Z6); null for one it does not know, which is left out. */
const STATUS: Record<string, SourceStatus> = {
  open: "open",
  overdue: "open",
  partially_paid: "open",
  approved: "open",
  paid: "paid",
  void: "voided",
  draft: "draft",
  pending_approval: "draft",
};

/** One bill, or null when it does not read. */
export function mapBill(raw: unknown): ExternalBill | null {
  if (!isObject(raw)) return null;
  const externalId = idOf(raw.bill_id);
  const updatedAt = zohoTime(raw.last_modified_time);
  const currency = text(raw.currency_code)?.toUpperCase() ?? null;
  const total = zohoAmount(raw.total);
  const balance = zohoAmount(raw.balance);
  const written = text(raw.status)?.toLowerCase() ?? "";
  const status = Object.hasOwn(STATUS, written) ? STATUS[written] : null;
  if (!externalId || !updatedAt || !currency || !/^[A-Z]{3}$/.test(currency) || total === null || balance === null || !status) return null;
  return {
    externalId,
    // The update time to the millisecond orders as text; Zoho keeps no other version.
    version: updatedAt,
    updatedAt,
    contactExternalId: idOf(raw.vendor_id),
    contactName: cut(text(raw.vendor_name), 200) ?? "Unnamed vendor",
    number: cut(text(raw.bill_number), 255),
    reference: cut(text(raw.reference_number), 255),
    currency,
    total,
    amountDue: balance,
    issuedOn: zohoDay(raw.date),
    dueOn: zohoDay(raw.due_date),
    status,
  };
}

export function mapBillsPage(body: unknown, page: number): Page<ExternalBill> {
  const { raws, more } = listOf(body, "bills", "bills");
  const items = raws.map(mapBill).filter((bill): bill is ExternalBill => bill !== null);
  return { items, page, last: !more, total: null };
}

function mapVendor(raw: unknown): ExternalContact | null {
  if (!isObject(raw)) return null;
  const externalId = idOf(raw.contact_id);
  const updatedAt = zohoTime(raw.last_modified_time);
  const name = cut(text(raw.contact_name) ?? text(raw.company_name), 200);
  if (!externalId || !updatedAt || !name) return null;
  if (text(raw.contact_type) !== null && text(raw.contact_type) !== "vendor") return null;
  return { externalId, version: updatedAt, updatedAt, name, isSupplier: true, archived: text(raw.status)?.toLowerCase() === "inactive" };
}

/** Vendors, every one a supplier; an inactive one archived (Z8). */
export function mapVendorsPage(body: unknown, page: number): Page<ExternalContact> {
  const { raws, more } = listOf(body, "contacts", "vendors");
  const items = raws.map(mapVendor).filter((vendor): vendor is ExternalContact => vendor !== null);
  return { items, page, last: !more, total: null };
}

/** The organizations the token reaches (Z5), by id and name. */
export function mapOrganizations(body: unknown): ExternalOrganisation[] {
  const { raws } = listOf(body, "organizations", "organizations");
  return raws.flatMap((raw): ExternalOrganisation[] => {
    if (!isObject(raw)) return [];
    const externalOrgId = idOf(raw.organization_id);
    if (!externalOrgId) return [];
    return [{ externalOrgId, name: cut(text(raw.name), 200) ?? "Zoho Books organization", connectionId: null }];
  });
}

/** The error a token answer carries (Zoho may send it with HTTP 200), or null. */
export function tokenError(body: unknown): string | null {
  return isObject(body) && typeof body.error === "string" ? body.error.slice(0, 60) : null;
}

/**
 * Zoho's token answer, each token carrying its data center (Z4). A refresh answers an access token only: the refresh
 * token it was given is kept. Throws on one without an access token, naming the field, never a value.
 */
export function mapTokens(body: unknown, region: ZohoRegion, nowMs: number, scopes: readonly string[], keptRefreshToken?: string): ProviderTokens {
  const json = isObject(body) ? body : {};
  const accessToken = text(json.access_token);
  const refreshToken = text(json.refresh_token);
  if (!accessToken) throw new ProviderError("bad_response", "Zoho's token answer had no access_token");
  if (!refreshToken && !keptRefreshToken) throw new ProviderError("bad_response", "Zoho's token answer had no refresh_token");
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken: withRegion(region, accessToken),
    refreshToken: refreshToken ? withRegion(region, refreshToken) : (keptRefreshToken as string),
    expiresAt: nowMs + expiresIn * 1000,
    scopes: [...scopes],
  };
}
