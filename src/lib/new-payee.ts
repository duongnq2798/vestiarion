/**
 * Two people before the first payment to an address (docs/superpowers/specs/2026-10-05-new-payee-check-design.md).
 *
 * A first payment is one to an address that has never received a confirmed payment from the workspace (N1). Who stands
 * behind the address is read from the counterparty's ledger entries, newest first (N2): the entry that set the current
 * address names who gave it — a member, or the payee for an address sent through a payee link or GitHub — and the
 * confirmations after it name the members who confirmed it. The agent makes a first payment on its own only when two
 * different parties stand behind the address (N3). Pure: the AP and contractor stages and Approvals all ask it.
 */

/** The giver of an address the payee sent, through a payee link or GitHub, rather than a member. */
export const PAYEE = "payee";

const SET_ADDRESS = new Set(["create_counterparty", "counterparty_address_changed"]);

type Entry = { action: string; detail: Record<string, unknown> };

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const member = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Who gave `address` and who confirmed it since, from the counterparty's entries newest first (N2). */
export function addressProvenance(address: string, entries: ReadonlyArray<Entry>): { addressBy: string | null; confirmers: string[] } {
  const confirmers: string[] = [];
  for (const entry of entries) {
    if (entry.action === "counterparty_address_confirmed") {
      const by = member(entry.detail.by);
      if (by && same(entry.detail.address, address) && !confirmers.includes(by)) confirmers.push(by);
      continue;
    }
    if (!SET_ADDRESS.has(entry.action)) continue;
    // The newest entry that set an address: if it is not this one, something outside the ledger wrote it.
    const set = entry.action === "create_counterparty" ? entry.detail.address : entry.detail.to;
    if (!same(set, address)) return { addressBy: null, confirmers: [] };
    // The payee's own, sent through a payee link or GitHub; otherwise the member who typed it, or no one known.
    const fromPayee = entry.detail.via === "github" || entry.detail.via === "payee_link";
    return { addressBy: fromPayee ? PAYEE : member(entry.detail.by), confirmers };
  }
  return { addressBy: null, confirmers: [] };
}

/** The check for a payment to `address` (N1, N3); null for a counterparty with no address, which other rules answer. */
export function newPayeeCheck(input: {
  address: string | null;
  /** Every address the workspace has made a confirmed payment to, lowercase. */
  paidTo: ReadonlySet<string>;
  /** The counterparty's ledger entries that set or confirmed its address, newest first. */
  entries: ReadonlyArray<Entry>;
}): { firstPayment: boolean; addressBy: string | null; confirmedBy: string | null; twoParties: boolean } | null {
  if (!input.address) return null;
  const { addressBy, confirmers } = addressProvenance(input.address, input.entries);
  const other = confirmers.find((by) => by !== addressBy) ?? null;
  if (input.paidTo.has(input.address.toLowerCase())) {
    return { firstPayment: false, addressBy, confirmedBy: other ?? confirmers[0] ?? null, twoParties: true };
  }
  // A member's confirmation of the payee's own address, or a second member's of one a member gave: two parties.
  const twoParties = addressBy !== null && other !== null;
  return { firstPayment: true, addressBy, confirmedBy: other ?? confirmers[0] ?? null, twoParties };
}
