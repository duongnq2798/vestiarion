import type { CrmAccountFacts, CrmFieldRead, CrmReceiptWriter } from "../connectors/crm";
import { COLLECTION_STATUS_WORDS, RECEIPT_PROPERTIES, RECONCILIATION_WORDS, type ReceiptField, type ReceiptProperty } from "../connectors/crm-receipts";
import { ProviderError } from "../connectors/provider";
import { apiCall, apiJson, failureOf, jsonOf, refusalWords, type PipedriveHttp } from "./http";
import { fieldText, mapDealFields, mapList, type DealField } from "./map";
import { readMe } from "./oauth";
import { PIPEDRIVE_WRITE_SCOPES } from "./settings";

/**
 * Receipts written back to Pipedrive deals (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P11, P12),
 * the core's `CrmReceiptWriter`: the nine figures as custom deal fields Vestiarion makes once per company, read and
 * written through API v2. Pipedrive keys a custom field by a hash it picks, so the fields are found by their names, each
 * of Vestiarion's own type; one of the same name and another type is someone else's, never changed. The statuses are
 * written in words and read back into their codes. And Pipedrive names no test company (P12): every company is a real
 * one to the reality rule, so payments on Arc testnet or in shadow mode are never written to it.
 */

/** A field's name in Pipedrive: "Vestiarion: Collected". */
export const pipedriveFieldName = (property: Pick<ReceiptProperty, "label">) => `Vestiarion: ${property.label}`;

/** Pipedrive's field type for each of the core's (P11): numbers as doubles, the day as a date, the rest as text. */
export function pipedriveFieldType(property: Pick<ReceiptProperty, "type">): "double" | "date" | "varchar" {
  return property.type === "number" ? "double" : property.type === "date" ? "date" : "varchar";
}

/** The account Pipedrive names for the reality rule: a company, never a test one (P12). */
export const PIPEDRIVE_ACCOUNT_TYPE = "COMPANY";

export const PIPEDRIVE_REALITY_REFUSAL =
  "Not written: Pipedrive does not say which of its companies are developer sandboxes, so payments on Arc testnet and in shadow mode are never written to Pipedrive.";

const WORDS: Partial<Record<ReceiptField, Readonly<Record<string, string>>>> = {
  vestiarion_collection_status: COLLECTION_STATUS_WORDS,
  vestiarion_reconciliation: RECONCILIATION_WORDS,
};

/** A value as written to Pipedrive: "" clears the field; numbers as numbers; statuses in words. */
export function toPipedrive(field: ReceiptField, type: string, value: string): string | number | null {
  if (value === "") return null;
  if (type === "double") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return WORDS[field]?.[value] ?? value;
}

/** A value as Pipedrive holds it, in the core's terms: a status's words read back into its code. */
export function fromPipedrive(field: ReceiptField, value: unknown): string {
  const written = fieldText(value).trim();
  const words = WORDS[field];
  if (!words || written === "") return written;
  const code = Object.entries(words).find(([, word]) => word.toLowerCase() === written.toLowerCase())?.[0];
  return code ?? written;
}

/** Deal fields read at most this many pages of 500. */
const FIELD_PAGES = 6;

export function pipedriveReceipts(deps: PipedriveHttp = {}): CrmReceiptWriter {
  const now = deps.now ?? Date.now;
  /** The company's deal fields, by name, read once per writer (one run). */
  let fields: Promise<DealField[]> | null = null;
  /** Each of Vestiarion's fields' key, once found or made. */
  const codes = new Map<ReceiptField, { code: string; type: string }>();
  let properties: readonly ReceiptProperty[] = [];

  async function readFieldsList(credential: string): Promise<DealField[]> {
    const items: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < FIELD_PAGES; page += 1) {
      const list = mapList(await apiJson(credential, "/api/v2/dealFields", { query: { limit: "500", ...(cursor ? { cursor } : {}) } }, "deal fields", deps), "deal fields");
      items.push(...list.items);
      cursor = list.next;
      if (!cursor) break;
    }
    return mapDealFields(items);
  }

  function dealFields(credential: string): Promise<DealField[]> {
    fields ??= readFieldsList(credential).catch((error: unknown) => {
      fields = null;
      throw error;
    });
    return fields;
  }

  /** Vestiarion's fields as found now: each name of Vestiarion's own type; another type is someone else's. */
  async function resolve(credential: string, wanted: readonly ReceiptProperty[]): Promise<{ missing: ReceiptProperty[]; foreign: string[] }> {
    const found = await dealFields(credential);
    const missing: ReceiptProperty[] = [];
    const foreign: string[] = [];
    for (const property of wanted) {
      if (codes.has(property.name)) continue;
      const name = pipedriveFieldName(property);
      const type = pipedriveFieldType(property);
      const same = found.filter((field) => field.name === name);
      const ours = same.find((field) => field.type === type);
      if (ours) codes.set(property.name, { code: ours.code, type });
      else if (same.length > 0) foreign.push(name);
      else missing.push(property);
    }
    return { missing, foreign };
  }

  return {
    writeScopes: PIPEDRIVE_WRITE_SCOPES,
    testAccounts: false,
    realityRefusal: PIPEDRIVE_REALITY_REFUSAL,

    /** The company, read right before a run's writes: still the connection's, and never a test one (P12). */
    async account({ accessToken, externalOrgId }): Promise<CrmAccountFacts> {
      const me = await readMe(accessToken, deps);
      if (me.companyId !== externalOrgId) throw new ProviderError("forbidden", "Pipedrive users/me: a token of another company");
      return { accountType: PIPEDRIVE_ACCOUNT_TYPE, test: false };
    },

    async ensureFields({ accessToken, properties: wanted }) {
      properties = wanted;
      const { missing, foreign } = await resolve(accessToken, wanted);
      if (foreign.length > 0) {
        return {
          ok: false,
          message: `Pipedrive has a deal field named ${foreign.map((name) => `"${name}"`).join(", ")} of another type: Vestiarion never changes it, and writes nothing. Rename that field in Pipedrive, and Vestiarion adds its own.`.slice(0, 300),
        };
      }
      for (const property of missing) {
        const type = pipedriveFieldType(property);
        const response = await apiCall(
          accessToken,
          "/api/v2/dealFields",
          { method: "POST", body: { field_name: pipedriveFieldName(property), field_type: type, description: property.description.slice(0, 255) } },
          "deal field",
          deps
        );
        if (response.status === 429 || response.status >= 500 || response.status === 401) throw failureOf(response, "deal field", now());
        if (!response.ok) {
          // A plan's limit on custom fields, or a user who may not add them (P13): Pipedrive's own words, with what to do.
          const words = await refusalWords(response);
          return {
            ok: false,
            message: `Pipedrive did not let Vestiarion add its deal fields${words ? `: ${words}` : ` (${response.status})`}. Your Pipedrive plan's custom field limit may be reached, or the user who connected may not add fields: a Pipedrive admin reconnects, or makes room.`.slice(0, 300),
          };
        }
        const made = mapDealFields([(((await jsonOf(response, "deal field")) ?? {}) as { data?: unknown }).data]);
        if (made[0]) codes.set(property.name, { code: made[0].code, type });
        else {
          // Made, but its key not read: read the fields again to find it.
          fields = null;
          await resolve(accessToken, [property]);
        }
      }
      return codes.size >= wanted.length ? { ok: true } : { ok: false, message: "Pipedrive made Vestiarion's deal fields, but did not show them back yet. Vestiarion tries again on its own." };
    },

    async readFields({ accessToken, dealId, names }): Promise<CrmFieldRead> {
      // A read-back without a send first in this run (a write left sent) finds the fields, never makes them.
      const known = properties.length > 0 ? properties : RECEIPT_PROPERTIES;
      await resolve(accessToken, known.filter((property) => names.includes(property.name)));
      const wanted = names.flatMap((name) => {
        const found = codes.get(name as ReceiptField);
        return found ? [{ name: name as ReceiptField, code: found.code }] : [];
      });
      const response = await apiCall(
        accessToken,
        `/api/v2/deals/${encodeURIComponent(dealId)}`,
        { query: wanted.length > 0 ? { custom_fields: wanted.map((field) => field.code).join(",") } : {} },
        "deal",
        deps
      );
      if (response.status === 404 || response.status === 410) return { found: false };
      if (!response.ok) throw failureOf(response, "deal", now());
      const body = (await jsonOf(response, "deal")) as { data?: unknown };
      const data = typeof body?.data === "object" && body.data !== null ? (body.data as Record<string, unknown>) : null;
      if (!data) throw new ProviderError("bad_response", "Pipedrive deal: no data");
      if (data.is_deleted === true || data.status === "deleted") return { found: false };
      const custom = typeof data.custom_fields === "object" && data.custom_fields !== null ? (data.custom_fields as Record<string, unknown>) : {};
      // A field missing from the company (someone deleted it) holds nothing.
      const values: Record<string, string | null> = Object.fromEntries(names.map((name) => [name, null]));
      for (const field of wanted) values[field.name] = fromPipedrive(field.name, custom[field.code]);
      return { found: true, values };
    },

    async writeFields({ accessToken, dealId, values }) {
      const custom: Record<string, string | number | null> = {};
      for (const [name, value] of Object.entries(values)) {
        const field = codes.get(name as ReceiptField);
        if (!field) return { ok: false, message: "Vestiarion's deal fields are not in Pipedrive yet. Vestiarion tries again on its own." };
        custom[field.code] = toPipedrive(name as ReceiptField, field.type, value);
      }
      const response = await apiCall(accessToken, `/api/v2/deals/${encodeURIComponent(dealId)}`, { method: "PATCH", body: { custom_fields: custom } }, "deal update", deps);
      if (response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403) throw failureOf(response, "deal update", now());
      if (!response.ok) {
        const words = await refusalWords(response);
        return { ok: false, message: `Pipedrive refused the write${words ? `: ${words}` : ` (${response.status})`}.`.slice(0, 300) };
      }
      return { ok: true };
    },
  };
}
