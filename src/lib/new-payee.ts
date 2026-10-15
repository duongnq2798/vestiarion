/**
 * Two people before the first payment to an address (docs/superpowers/specs/2026-10-05-new-payee-check-design.md).
 *
 * A first payment is one to an address that has never received a confirmed payment from the workspace (N1). Who stands
 * behind the address is read from the counterparty's ledger entries, newest first (N2): the entry that set the current
 * address names who gave it — a member, the payee for an address sent through a payee link or GitHub, or Vestiarion
 * itself for a mirror address in shadow mode — and the
 * confirmations after it name the members who confirmed it. The agent makes a first payment on its own only when two
 * different parties stand behind the address (N3). Pure: the AP and contractor stages and Approvals all ask it.
 *
 * An address sent through a payee link is the payee's, and the ledger says so, but a member chose to ask for it: the
 * member who created the link counts as having given it (independent review, 2026-10-15). Otherwise one admin could
 * create a link, send their own wallet through it, confirm it, and have the agent make its first payment alone.
 */

/** The giver of an address the payee sent, through a payee link or GitHub, rather than a member. */
export const PAYEE = "payee";

/**
 * The giver of a mirror address: a wallet Vestiarion made for a payee with none, in shadow mode on Arc testnet (shadow mode
 * S7). No person typed it, so no outsider could have given it: it stands as two parties behind its first payment.
 */
export const MIRROR = "mirror";

const SET_ADDRESS = new Set(["create_counterparty", "counterparty_address_changed"]);

type Entry = {
  action: string;
  detail: Record<string, unknown>;
  /**
   * On the entry an address sent through a payee link wrote: the member who created that link, read from the link itself
   * when the facts were loaded (./new-payee-facts), never from the entry; null when it is not known, the link gone or the
   * member's account deleted since.
   */
  linkCreatedBy?: string | null;
};

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const member = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * Who gave `address` and who confirmed it since, from the counterparty's entries newest first (N2); for an address sent
 * through a payee link, also the member who created the link, when known.
 */
export function addressProvenance(
  address: string,
  entries: ReadonlyArray<Entry>
): { addressBy: string | null; confirmers: string[]; linkCreatedBy?: string } {
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
    if (entry.detail.via === "mirror") return { addressBy: MIRROR, confirmers };
    const fromPayee = entry.detail.via === "github" || entry.detail.via === "payee_link";
    const linkCreatedBy = entry.detail.via === "payee_link" ? member(entry.linkCreatedBy) : null;
    return { addressBy: fromPayee ? PAYEE : member(entry.detail.by), confirmers, ...(linkCreatedBy ? { linkCreatedBy } : {}) };
  }
  return { addressBy: null, confirmers: [] };
}

/** What the check answers for a payment to an address (N1–N3, N6). */
export interface NewPayeeCheck {
  firstPayment: boolean;
  /** Who gave the address: a member's id, `PAYEE`, `MIRROR`, or null when not known. */
  addressBy: string | null;
  /** For an address the payee sent through a payee link: the member who created the link, when known. */
  linkCreatedBy?: string;
  confirmedBy: string | null;
  twoParties: boolean;
}

/** The check for a payment to `address` (N1, N3); null for a counterparty with no address, which other rules answer. */
export function newPayeeCheck(input: {
  address: string | null;
  /** Every address the workspace has made a confirmed payment to, lowercase. */
  paidTo: ReadonlySet<string>;
  /** The counterparty's ledger entries that set or confirmed its address, newest first. */
  entries: ReadonlyArray<Entry>;
}): NewPayeeCheck | null {
  if (!input.address) return null;
  const { addressBy, confirmers, linkCreatedBy } = addressProvenance(input.address, input.entries);
  const link = linkCreatedBy ? { linkCreatedBy } : {};
  // The confirmer must be someone other than whoever stands behind the address: for a payee link, its creator.
  const giver = linkCreatedBy ?? addressBy;
  const other = confirmers.find((by) => by !== giver) ?? null;
  if (input.paidTo.has(input.address.toLowerCase())) {
    return { firstPayment: false, addressBy, ...link, confirmedBy: other ?? confirmers[0] ?? null, twoParties: true };
  }
  // A member's confirmation of the payee's own address, when another member created its link or no one known did, or a
  // second member's of one a member gave: two parties.
  const twoParties = addressBy === MIRROR || (giver !== null && other !== null);
  return { firstPayment: true, addressBy, ...link, confirmedBy: other ?? confirmers[0] ?? null, twoParties };
}

/**
 * The member a first payment's approval must not rest on alone (N4): the member who created the payee link an address
 * was sent through, or else whoever gave it, as `addressBy` names them. Approve and pay, Pay now and the two approvals
 * all leave this one out, unless they decide alone.
 */
export function addressGiver(check: Pick<NewPayeeCheck, "addressBy" | "linkCreatedBy"> | null | undefined): string | null {
  return check ? (check.linkCreatedBy ?? check.addressBy) : null;
}

/**
 * What a decision on a first payment records as `observed.newPayee` (N6): who gave the address, beside it the member who
 * created the payee link it came through when there was one, who confirmed it, and whether two parties stand behind it.
 */
export function newPayeeObserved(check: NewPayeeCheck): { addressBy: string | null; linkCreatedBy?: string; confirmedBy: string | null; twoParties: boolean } {
  return {
    addressBy: check.addressBy,
    ...(check.linkCreatedBy ? { linkCreatedBy: check.linkCreatedBy } : {}),
    confirmedBy: check.confirmedBy,
    twoParties: check.twoParties,
  };
}
