/**
 * Jira over HTTP (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2, JR3, JR8, JR17): Atlassian's OAuth
 * endpoints and Jira Cloud's REST API, named here once. Every API request goes to `api.atlassian.com` and nowhere else,
 * naming the site by its cloudId (`/ex/jira/<cloudId>/rest/api/3/...`); a person goes to `auth.atlassian.com` only to
 * authorize, and the tokens come from there too. A link a person or Jira gave is never opened.
 */

/** Atlassian's authorization server: the consent screen and the token endpoint. */
export const JIRA_AUTH_HOST = "auth.atlassian.com";
/** Atlassian's API gateway: the sites a grant reaches, and each site's REST API. */
export const JIRA_API_HOST = "api.atlassian.com";
export const JIRA_AUTHORIZE = `https://${JIRA_AUTH_HOST}/authorize`;
/** Takes a JSON body, for the code's exchange and for each refresh (JR2, JR3). */
export const JIRA_TOKEN = `https://${JIRA_AUTH_HOST}/oauth/token`;
/** The sites a token reaches, `[{id, name, url, scopes, avatarUrl}]`, where `id` is the cloudId (JR2). */
export const JIRA_RESOURCES = `https://${JIRA_API_HOST}/oauth/token/accessible-resources`;
/**
 * Atlassian's sign-in, where the consent screen may send a person who is signed out before they agree. Only the content
 * security policy's form targets name it (B11); no request is ever made to it.
 */
export const JIRA_LOGIN = "https://id.atlassian.com";
