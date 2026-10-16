/**
 * Zoho's data centers (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z3, Z4). A Zoho account lives
 * in one, with its own accounts server (OAuth) and API domain; the callback names it by `location`. Only this table is
 * ever used to reach Zoho: the callback's `accounts-server` is never read, so an edited callback sends the client
 * secret nowhere. Each token the provider hands the core carries its data center in front of it (`eu|1000.…`), so a
 * refresh, a revocation and every API call go to the data center the token came from.
 */

export const ZOHO_REGIONS = {
  us: { accounts: "https://accounts.zoho.com", api: "https://www.zohoapis.com" },
  eu: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu" },
  in: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in" },
  au: { accounts: "https://accounts.zoho.com.au", api: "https://www.zohoapis.com.au" },
  jp: { accounts: "https://accounts.zoho.jp", api: "https://www.zohoapis.jp" },
  uk: { accounts: "https://accounts.zoho.uk", api: "https://www.zohoapis.uk" },
  ca: { accounts: "https://accounts.zohocloud.ca", api: "https://www.zohoapis.ca" },
  sa: { accounts: "https://accounts.zoho.sa", api: "https://www.zohoapis.sa" },
  ae: { accounts: "https://accounts.zoho.ae", api: "https://www.zohoapis.ae" },
} as const;

export type ZohoRegion = keyof typeof ZOHO_REGIONS;

/** The data center a callback's `location` names, or null for one not in the table. No `location`: the US (Z3). */
export function regionOf(location: string | null | undefined): ZohoRegion | null {
  if (location === null || location === undefined || location === "") return "us";
  const key = location.trim().toLowerCase();
  return Object.hasOwn(ZOHO_REGIONS, key) ? (key as ZohoRegion) : null;
}

const SEPARATOR = "|";

/** A token as the core keeps it: its data center, then Zoho's own token. */
export function withRegion(region: ZohoRegion, token: string): string {
  return `${region}${SEPARATOR}${token}`;
}

/** A kept token read back: its data center and Zoho's own token. Throws on one that carries none from the table. */
export function regionalToken(kept: string): { region: ZohoRegion; token: string } {
  const at = kept.indexOf(SEPARATOR);
  const region = at > 0 ? regionOf(kept.slice(0, at)) : null;
  const token = at > 0 ? kept.slice(at + 1) : "";
  if (!region || at === 0 || !token) throw new Error("a Zoho token without its data center");
  return { region, token };
}
