/**
 * A Pipedrive token and the company domain it was issued for, kept as one credential
 * (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P5). Pipedrive's token answer names `api_domain`, the
 * company's own base URL, where every call made with that token goes. The core stores tokens as opaque strings, sealed
 * under the master key (`token-store.ts`); sealing the domain with its token means a refresh's new domain replaces the
 * old one in the same compare-and-set, and a token is only ever sent to the host Pipedrive named with it. Pure.
 */

const PREFIX = "pd1";

/**
 * A company's API host under pipedrive.com, as `api_domain` names it (`<company>.pipedrive.com`). Up to three labels are
 * taken, so a regional name Pipedrive may give is not refused; every one of them is Pipedrive's own zone.
 */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}pipedrive\.com$/;

/**
 * The host of an `api_domain`, or null for anything but `https://<name>.pipedrive.com` (with no port, user, path beyond
 * `/`, query or fragment). Pipedrive is the only host a Pipedrive token goes to.
 */
export function apiHostOf(apiDomain: unknown): string | null {
  if (typeof apiDomain !== "string" || apiDomain.length > 255) return null;
  let url: URL;
  try {
    url = new URL(apiDomain.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") return null;
  const host = url.hostname.toLowerCase();
  return HOST.test(host) ? host : null;
}

export interface Credential {
  host: string;
  token: string;
}

/** `pd1|<host>|<token>`: the token as Pipedrive gave it, after its host. */
export function sealCredential(host: string, token: string): string {
  if (!HOST.test(host)) throw new Error("not a Pipedrive API host");
  if (token === "" || /[\r\n]/.test(token)) throw new Error("not a Pipedrive token");
  return `${PREFIX}|${host}|${token}`;
}

/** A sealed credential opened; null for anything else, so a malformed one is never sent anywhere. */
export function openCredential(value: string): Credential | null {
  if (!value.startsWith(`${PREFIX}|`)) return null;
  const rest = value.slice(PREFIX.length + 1);
  const bar = rest.indexOf("|");
  if (bar <= 0) return null;
  const host = rest.slice(0, bar);
  const token = rest.slice(bar + 1);
  if (!HOST.test(host) || token === "" || /[\r\n]/.test(token)) return null;
  return { host, token };
}

/** The company's base URL for API calls. */
export const apiBase = (credential: Credential) => `https://${credential.host}`;
