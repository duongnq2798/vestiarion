/**
 * The platform's one QuickBooks Online app (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q2). Off
 * unless its client id and secret are both set: then the QuickBooks card, its pages and every QuickBooks route are not
 * there, as Xero's. `QUICKBOOKS_ENVIRONMENT` picks the API's base URL (sandbox companies or real ones); the OAuth
 * endpoints are the same for both. The webhook needs its verifier token too.
 */

export type QuickBooksEnvironment = "sandbox" | "production";

export interface QuickBooksSettings {
  clientId: string;
  clientSecret: string;
  environment: QuickBooksEnvironment;
}

/** Intuit's client ids are about 50 letters and digits; allow some room. */
const CLIENT_ID = /^[A-Za-z0-9]{20,80}$/;

export function quickBooksSettingsFromEnv(env: Record<string, string | undefined> = process.env): QuickBooksSettings | null {
  const clientId = env.QUICKBOOKS_CLIENT_ID?.trim();
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("QuickBooks is off: QUICKBOOKS_CLIENT_ID is not an Intuit client id");
    return null;
  }
  const environment = (env.QUICKBOOKS_ENVIRONMENT?.trim() || "sandbox").toLowerCase();
  if (environment !== "sandbox" && environment !== "production") {
    console.warn("QuickBooks is off: QUICKBOOKS_ENVIRONMENT is neither sandbox nor production");
    return null;
  }
  return { clientId, clientSecret, environment };
}

/** The verifier token Intuit signs each webhook notification with (Q11); null when unset. */
export function quickBooksWebhookTokenFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN?.trim();
  return token ? token : null;
}

/** Where Intuit sends a person back: the deployment's own callback, as registered for the app. */
export function quickBooksRedirectUri(origin: string): string {
  return `${origin}/api/integrations/quickbooks/callback`;
}

/**
 * The one scope the Accounting API has: it can read and write, and Vestiarion only reads (Q13). No OpenID scopes:
 * nothing about the Intuit user is needed.
 */
export const QUICKBOOKS_SCOPES = ["com.intuit.quickbooks.accounting"] as const;

/** The Accounting API's base URL for sandbox companies, or for real ones. */
export function quickBooksApiBase(environment: QuickBooksEnvironment): string {
  return environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

/** Minor versions 1 to 74 were retired on 1 August 2025; 75 is the base. */
export const MINOR_VERSION = "75";
