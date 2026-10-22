/**
 * Names in an address field (docs/superpowers/specs/2026-10-22-ens-address-names-design.md EN1-EN3): what reads as an ENS
 * name or a Basename, and whether a name looks like the payee it is given for. Pure: no network, safe in the browser.
 */

/** An ENS name or a Basename (`name.base.eth`): labels of letters, digits and hyphens, ending in `.eth`. */
const NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/i;

export function isAddressName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 255 && NAME.test(trimmed);
}

/** What a field says when someone types a name where an address goes (EN2). */
export const NAME_NOT_ADDRESS = "That is a name, not an address. Choose Use this address under the field to take the address it points to.";

/**
 * Words too common in business names to tell one from another: a name that shares only these with the payee, such as
 * cheap-usdc-supply.eth for Northwind Supply, does not look like it.
 */
const COMMON = new Set([
  "inc", "llc", "ltd", "co", "corp", "company", "the", "and", "studio", "studios", "group", "limited", "gmbh", "sas",
  "pay", "payment", "payments", "billing", "invoice", "invoices", "finance", "wallet", "usdc", "usd", "crypto",
  "supply", "supplies", "service", "services", "solutions", "logistics", "global", "international", "holdings",
  "partners", "tech", "labs", "digital", "systems", "trading", "consulting", "agency", "media", "design", "shop", "store",
]);

/** A payee's name as words: letters and digits, accents taken off. */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a name looks like the payee (EN3), judged by its registered label, the one before `.base.eth` or `.eth`: the
 * payee's name run together (acmestudio.eth for Acme Studio), or a part of the label, between hyphens, that is one of the
 * payee's own words or begins with one of four letters or more (pay-northwind.eth, northwindpay.eth). A word inside
 * another (notacme.eth, tsunami.eth for Sun) does not count. A different name is worth a question, not a refusal: a
 * person may own a name unlike their business's.
 */
export function nameMatchesPayee(name: string, payeeName: string): boolean {
  const label = name.trim().toLowerCase().replace(/(\.base)?\.eth$/, "").split(".").pop() ?? "";
  const parts = label.split("-").filter(Boolean);
  const squashed = parts.join("");
  const every = words(payeeName);
  const own = every.filter((word) => word.length >= 3 && !COMMON.has(word));
  if (own.length === 0 || squashed.length === 0) return true;
  if (squashed === every.join("") || squashed === own.join("")) return true;
  return parts.some((part) => own.some((word) => part === word || (word.length >= 4 && part.startsWith(word))));
}

/** An address shortened to its first 6 and last 4 characters, as the hint shows it. */
export function shortened(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
