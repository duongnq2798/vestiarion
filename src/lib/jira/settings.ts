/**
 * The platform's one Atlassian OAuth 2.0 (3LO) app, "Vestiarion", which the people of any Jira Cloud site may authorize
 * (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1). Off unless both variables are set: then the Jira
 * card, the Contractors controls and every Jira route are not there. There is no third variable: Jira signs its webhook
 * deliveries with the app's client secret (JR15). The variables are set for Production only, since the app has one
 * callback URL, so a preview or a local deployment stays off.
 */

export interface JiraSettings {
  clientId: string;
  /** Exchanges and refreshes the tokens, and is the key Jira signs each webhook delivery's token with (JR15). */
  clientSecret: string;
}

/** Atlassian's client ids are 32 characters of letters and digits; allow some room. */
const CLIENT_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Each reason already logged, so a deployment that sets only one variable says so once a process, not on every request. */
const warned = new Set<string>();

/** Jira is off, and why, logged once. Never a value: only which variable was not used. */
function off(reason: string): null {
  if (!warned.has(reason)) {
    warned.add(reason);
    console.warn(`Jira is off: ${reason}`);
  }
  return null;
}

export function jiraSettingsFromEnv(env: Record<string, string | undefined> = process.env): JiraSettings | null {
  const clientId = env.JIRA_CLIENT_ID?.trim();
  const clientSecret = env.JIRA_CLIENT_SECRET?.trim();
  // Neither set is a deployment without Jira, which says nothing.
  if (!clientId && !clientSecret) return null;
  if (!clientId) return off("JIRA_CLIENT_ID is not set");
  if (!clientSecret) return off("JIRA_CLIENT_SECRET is not set");
  if (!CLIENT_ID.test(clientId)) return off("JIRA_CLIENT_ID is not an Atlassian client id");
  return { clientId, clientSecret };
}

/**
 * The scopes asked (JR3), Jira's classic ones: `read:jira-work` for the issues, their attachments, web links and
 * comments; `read:jira-user` for `/myself` and the user search that refuses an acceptance by the payee (JR12);
 * `manage:jira-webhook` for the one webhook on the site (JR14); and `offline_access`, which adds a refresh token.
 * Nothing in Jira is created, commented on or changed but that webhook.
 */
export const JIRA_SCOPES = ["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"] as const;

/**
 * The scopes each version of Jira's statement was agreed with, oldest first (JR3). A connection keeps the version it
 * agreed to, so a change of `JIRA_SCOPES` is a new version of the statement, recorded here beside the scopes it asks:
 * tests/jira-api.test.ts holds `JIRA_SCOPES` to the scopes of the current version, and these versions to Jira's history
 * in consent.ts. It gates nothing: the connect route asks for `JIRA_SCOPES`, whatever version a connection agreed to.
 */
export const SCOPES_BY_CONSENT: Readonly<Record<string, readonly string[]>> = {
  "jira-2026-11-09": ["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"],
};
