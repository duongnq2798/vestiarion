import type { InvoiceDraft } from "./normalize";

/**
 * Which counterparty an invoice read from a document is from (invoice from a
 * document D5), and whether it asks to be paid somewhere the workspace does
 * not know (D6). The address on an invoice is evidence, never an instruction:
 * nothing here changes a counterparty, and the agent pays the address on file.
 */

export interface MatchableCounterparty {
  id: string;
  name: string;
  role: string;
  address: string | null;
}

export interface CounterpartyMatch {
  counterpartyId: string | null;
  matchedBy: "address" | "name" | null;
  warnings: string[];
}

/** Words that say what kind of company it is, not which one. */
const LEGAL_SUFFIXES = new Set([
  "ltd", "limited", "inc", "incorporated", "llc", "llp", "co", "company", "corp", "corporation",
  "gmbh", "ag", "sa", "sas", "sarl", "srl", "bv", "nv", "plc", "pte", "pty", "oy", "ab", "the",
]);

/** A name as lowercase words, punctuation and legal suffixes removed: "Northwind Hosting, Ltd." is "northwind hosting". */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !LEGAL_SUFFIXES.has(word))
    .join(" ");
}

/** One key holds the other as whole words. */
function contains(a: string, b: string): boolean {
  return ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

function byName(vendorName: string, counterparties: MatchableCounterparty[]): MatchableCounterparty[] {
  const key = nameKey(vendorName);
  if (key.length < 3) return [];
  const exact = counterparties.filter((counterparty) => nameKey(counterparty.name) === key);
  if (exact.length > 0) return exact;
  return counterparties.filter((counterparty) => {
    const other = nameKey(counterparty.name);
    return other.length >= 3 && contains(key, other);
  });
}

const sameAddress = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export function matchCounterparty(draft: InvoiceDraft, counterparties: MatchableCounterparty[]): CounterpartyMatch {
  const named = draft.vendorName ? byName(draft.vendorName, counterparties) : [];
  const byAddress = draft.payToAddress ? counterparties.find((counterparty) => sameAddress(counterparty.address, draft.payToAddress)) : undefined;

  if (byAddress) {
    const warnings =
      named.length === 1 && named[0].id !== byAddress.id
        ? [`This invoice names ${draft.vendorName} but asks to be paid to ${draft.payToAddress}, the address on file for ${byAddress.name}. Check which counterparty sent it.`]
        : [];
    return { counterpartyId: byAddress.id, matchedBy: "address", warnings };
  }

  if (named.length === 1) {
    const [counterparty] = named;
    const warnings =
      draft.payToAddress && counterparty.address && !sameAddress(counterparty.address, draft.payToAddress)
        ? [
            `This invoice asks to be paid to ${draft.payToAddress}. The address on file for ${counterparty.name} is ${counterparty.address}. The agent pays the address on file; confirm a change with the vendor before making it.`,
          ]
        : [];
    return { counterpartyId: counterparty.id, matchedBy: "name", warnings };
  }

  if (!draft.vendorName) return { counterpartyId: null, matchedBy: null, warnings: [] };
  return {
    counterpartyId: null,
    matchedBy: null,
    warnings: [
      named.length > 1
        ? `More than one counterparty matches ${draft.vendorName}. Choose one.`
        : `No counterparty matches ${draft.vendorName}. Add it on Counterparties first, or choose one.`,
    ],
  };
}
