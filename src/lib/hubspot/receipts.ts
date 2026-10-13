import type { CrmAccountFacts, CrmFieldRead, CrmReceiptWriter } from "../connectors/crm";
import type { ReceiptProperty } from "../connectors/crm-receipts";
import { failureOf, HUBSPOT_ACCOUNT, HUBSPOT_DEAL_PROPERTIES, hubspotFetch, hubspotObjects, jsonOf, type HubSpotHttp } from "./http";
import { HUBSPOT_TEST_ACCOUNTS, mapAccountDetails, mapDealFields, mapPropertyDefinitions, mapRefusal } from "./map";
import { HUBSPOT_WRITE_SCOPES } from "./settings";

/**
 * Writing receipts back to HubSpot deals (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R2-R6): the account's
 * type, read for the reality rule; the Vestiarion property group and its properties, made once where missing
 * (`crm.schemas.deals.write`); a deal's Vestiarion fields as they are now; and writing them (`crm.objects.deals.write`).
 * HubSpot's own deal fields are never written. Each call has a timeout; a 429, a 401, a 403 or a 5xx is a
 * `ProviderError`, as every read's; a request HubSpot refuses (a 400) comes back in HubSpot's words.
 */

type Account = { accessToken: string; externalOrgId: string };

const headers = (account: Account) => ({ authorization: `Bearer ${account.accessToken}`, accept: "application/json", "content-type": "application/json" });

/** HubSpot's property types and field types, as the core names them. */
function definition(property: ReceiptProperty, group: string): Record<string, unknown> {
  return {
    name: property.name,
    label: property.label,
    groupName: group,
    type: property.type,
    fieldType: property.fieldType,
    description: property.description,
    formField: false,
    ...(property.type === "number" ? { numberDisplayHint: "formatted" } : {}),
    ...(property.options ? { options: property.options.map((option, index) => ({ value: option.value, label: option.label, displayOrder: index, hidden: false })) } : {}),
  };
}

export function hubspotReceipts(deps: HubSpotHttp = {}): CrmReceiptWriter {
  const now = deps.now ?? Date.now;

  async function send(url: string, account: Account, label: string, method: string, body?: unknown): Promise<Response> {
    return hubspotFetch(url, { method, headers: headers(account), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, label, deps);
  }

  /** A refusal to throw (429, 401, 403, 5xx), or null for a status the caller reads itself. */
  async function thrown(response: Response, label: string): Promise<never | null> {
    if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) throw await failureOf(response, label, now());
    return null;
  }

  async function refusal(response: Response): Promise<string> {
    try {
      return mapRefusal(await response.json());
    } catch {
      return `HubSpot refused the request (${response.status}).`;
    }
  }

  return {
    writeScopes: HUBSPOT_WRITE_SCOPES,

    async account(account): Promise<CrmAccountFacts> {
      const response = await send(HUBSPOT_ACCOUNT, account, "account details", "GET");
      if (!response.ok) throw await failureOf(response, "account details", now());
      const { accountType } = mapAccountDetails(await jsonOf(response, "account details"));
      return { accountType, test: accountType !== null && HUBSPOT_TEST_ACCOUNTS.has(accountType) };
    },

    async ensureFields({ group, properties, ...account }) {
      const read = await send(`${HUBSPOT_DEAL_PROPERTIES}/batch/read`, account, "deal properties", "POST", {
        archived: false,
        inputs: properties.map((property) => ({ name: property.name })),
      });
      if (!read.ok) {
        await thrown(read, "deal properties");
        return { ok: false, message: await refusal(read) };
      }
      const existing = mapPropertyDefinitions(await jsonOf(read, "deal properties"));
      // A property of the name with another type is someone else's: never changed, and nothing is written over it.
      const clash = properties.find((property) => existing.has(property.name) && existing.get(property.name)?.type !== property.type);
      if (clash) return { ok: false, message: `A HubSpot deal property named ${clash.name} exists already with another type. Rename or delete it in HubSpot.` };
      const missing = properties.filter((property) => !existing.has(property.name));
      if (missing.length === 0) return { ok: true };
      const made = await send(`${HUBSPOT_DEAL_PROPERTIES}/groups`, account, "property group", "POST", { name: group.name, label: group.label, displayOrder: -1 });
      // 409: the group is there already.
      if (!made.ok && made.status !== 409) {
        await thrown(made, "property group");
        return { ok: false, message: await refusal(made) };
      }
      for (const property of missing) {
        const created = await send(HUBSPOT_DEAL_PROPERTIES, account, "deal property", "POST", definition(property, group.name));
        if (created.ok || created.status === 409) continue;
        await thrown(created, "deal property");
        return { ok: false, message: await refusal(created) };
      }
      return { ok: true };
    },

    async readFields({ dealId, names, ...account }): Promise<CrmFieldRead> {
      const url = `${hubspotObjects("deals")}/${encodeURIComponent(dealId)}?properties=${names.map(encodeURIComponent).join(",")}&archived=false`;
      const response = await send(url, account, "deal", "GET");
      if (response.status === 404) return { found: false };
      if (!response.ok) throw await failureOf(response, "deal", now());
      return { found: true, values: mapDealFields(await jsonOf(response, "deal"), names) };
    },

    async writeFields({ dealId, values, ...account }) {
      const response = await send(`${hubspotObjects("deals")}/${encodeURIComponent(dealId)}`, account, "deal update", "PATCH", { properties: values });
      if (response.ok) return { ok: true };
      if (response.status === 404) return { ok: false, message: "HubSpot no longer has this deal." };
      await thrown(response, "deal update");
      return { ok: false, message: await refusal(response) };
    },
  };
}
