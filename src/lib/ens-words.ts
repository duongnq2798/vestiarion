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

/** The words of a payee's name that can identify it: letters and digits, three or more, without the usual company words. */
const COMMON = new Set(["inc", "llc", "ltd", "co", "corp", "company", "the", "and", "studio", "studios", "group", "limited", "gmbh", "sas"]);
function words(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !COMMON.has(word));
}

/**
 * Whether a name looks like the payee (EN3): its registered label, the one before `.base.eth` or `.eth`, contains one of the payee's
 * words, or they read the same with spaces and hyphens taken out. A different name is worth a question, not a refusal: a
 * person may own a name unlike their business's.
 */
export function nameMatchesPayee(name: string, payeeName: string): boolean {
  const label = name.trim().toLowerCase().replace(/(\.base)?\.eth$/, "").split(".").pop() ?? "";
  const squashed = label.replace(/-/g, "");
  const payee = words(payeeName);
  if (payee.length === 0 || squashed.length === 0) return true;
  if (payee.join("") === squashed) return true;
  return payee.some((word) => squashed.includes(word));
}

/** An address shortened to its first 6 and last 4 characters, as the hint shows it. */
export function shortened(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
