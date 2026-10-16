import { zohoBooksSettingsFromEnv, type ZohoBooksSettings } from "../zohobooks/settings";

/**
 * The platform's Zoho client, for Zoho CRM (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C2). One Zoho
 * "Server-based Applications" client serves Zoho Books and Zoho CRM alike, so Zoho CRM is on with the Zoho Books client
 * (`ZOHO_BOOKS_CLIENT_ID`, `ZOHO_BOOKS_CLIENT_SECRET`), or with its own when `ZOHO_CRM_CLIENT_ID` and
 * `ZOHO_CRM_CLIENT_SECRET` are both set. Off otherwise: then the Zoho CRM card, its pages and every route are not there.
 */

export type ZohoCrmSettings = ZohoBooksSettings;

export function zohoCrmSettingsFromEnv(env: Record<string, string | undefined> = process.env): ZohoCrmSettings | null {
  if (env.ZOHO_CRM_CLIENT_ID?.trim() && env.ZOHO_CRM_CLIENT_SECRET?.trim()) {
    return zohoBooksSettingsFromEnv({ ZOHO_BOOKS_CLIENT_ID: env.ZOHO_CRM_CLIENT_ID, ZOHO_BOOKS_CLIENT_SECRET: env.ZOHO_CRM_CLIENT_SECRET });
  }
  return zohoBooksSettingsFromEnv(env);
}

/** Where Zoho sends a person back: the deployment's own callback, registered on the client beside Zoho Books'. */
export function zohoCrmRedirectUri(origin: string): string {
  return `${origin}/api/integrations/zohocrm/callback`;
}

/**
 * Read only (C3): deals, the accounts and contacts they name, the organization, and the Deals layouts and their
 * pipelines, which say which stages are won and lost.
 */
export const ZOHO_CRM_SCOPES = [
  "ZohoCRM.modules.deals.READ",
  "ZohoCRM.modules.accounts.READ",
  "ZohoCRM.modules.contacts.READ",
  "ZohoCRM.org.READ",
  "ZohoCRM.settings.layouts.READ",
  "ZohoCRM.settings.pipeline.READ",
] as const;
