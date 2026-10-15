/**
 * Two people before the first payment to an address (docs/superpowers/specs/2026-10-05-new-payee-check-design.md).
 *
 * A first payment is one to a payee at an address it has never received a confirmed payment from the workspace at (N1),
 * whatever the workspace paid that address for anyone else. Who stands behind the address is read from the
 * counterparty's ledger entries, newest first (N2): the entry that set the current address names who gave it — a
 * member, the payee for an address sent through a payee link or GitHub, or Vestiarion itself for a mirror address in
 * shadow mode — and the confirmations after it name the members who confirmed it. The agent makes a first payment on its
 * own only when two different parties stand behind the address (N3). Pure: the AP and contractor stages and Approvals
 * all ask it.
 *
 * An address the payee sent is the payee's, and the ledger says so, but a member asked for it, and that member counts as
 * having given it (independent review, 2026-10-15): the member who created the payee link, or the member a GitHub
 * bounty acts as. Otherwise one admin could ask for an address, send their own wallet through it, confirm it, and have
 * the agent make its first payment alone. That member is read from the workspace's own signed entries.
 *
 * Some addresses no member answers for alone (`unanswered`): one sent with `/payto` on GitHub, since every bounty acts
 * as the member who connected GitHub whoever typed it, and a GitHub login is tied to no member; and one whose giver no
 * entry names. For those the rule is exactly two different members: one confirms the address on Counterparties, and a
 * different one approves its first payment. So no confirmation counts as a second party, and the agent holds it; the
 * members who confirmed it are left out of approving it (`membersLeftOut`); and one approver alone is refused until
 * another member's confirmation is recorded, since an approval's own confirmation never counts (`firstPaymentRefusal`).
 * The workspace's only approver may still pay it. Only an address that waited for a confirmation can be confirmed on
 * Counterparties: one no entry records at all, written outside the ledger, or one typed in as its counterparty was added
 * by an old entry naming no one, can never show a confirmation, so it is held for a person as before, and no one is
 * left out for it.
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
   * On the entry an address sent through a payee link wrote, when the link's signed `payee_link_created` entry is missing:
   * the member who created the link, read from the link's own row when the facts were loaded (./new-payee-facts), never
   * from the entry; null when the row names no one.
   */
  linkCreatedBy?: string | null;
};

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const member = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Who asked the payee for an address they sent: the member who created the link, or the member a GitHub bounty acts as. */
type AskedBy = { linkCreatedBy?: string; bountyBy?: string };

/**
 * The member who asked for the address `set` wrote, from the counterparty's signed entries: a payee link's
 * `payee_link_created`, or else the link's row; the `github_bounty_attached` of the pull request a `/payto` was posted
 * on, or the member who added a counterparty from GitHub. Nothing when no one can be named.
 */
function askedBy(set: Entry, entries: ReadonlyArray<Entry>): AskedBy {
  if (set.detail.via === "payee_link") {
    const linkId = member(set.detail.linkId);
    const created = linkId ? entries.find((entry) => entry.action === "payee_link_created" && entry.detail.linkId === linkId) : undefined;
    const by = created ? member(created.detail.by) : member(set.linkCreatedBy);
    return by ? { linkCreatedBy: by } : {};
  }
  if (set.detail.via === "github") {
    if (set.action === "create_counterparty") {
      const by = member(set.detail.by);
      return by ? { bountyBy: by } : {};
    }
    // A comment's address on GitHub is its pull request's, then `#issuecomment-…`.
    const comment = member(set.detail.commentUrl)?.toLowerCase() ?? null;
    const bounty = comment
      ? entries.find((entry) => {
          const pull = member(entry.detail.pullRequest)?.toLowerCase();
          return entry.action === "github_bounty_attached" && pull !== undefined && comment.startsWith(`${pull}#`);
        })
      : undefined;
    // A bounty typed by its own pull request's author names no one: they chose to be paid.
    const selfBounty = bounty !== undefined && sameLogin(bounty.detail.login, bounty.detail.author);
    const by = bounty && !selfBounty ? member(bounty.detail.by) : null;
    return by ? { bountyBy: by } : {};
  }
  return {};
}

const sameLogin = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();

type Provenance = { addressBy: string | null; confirmers: string[] } & AskedBy;

/**
 * Who gave `address` and who confirmed it since, from the counterparty's entries newest first (N2); for an address the
 * payee sent, also the member who asked for it, when one can be named.
 */
export function addressProvenance(address: string, entries: ReadonlyArray<Entry>): Provenance {
  const { addressBy, confirmers, linkCreatedBy, bountyBy } = provenanceOf(address, entries);
  return { addressBy, confirmers, ...(linkCreatedBy ? { linkCreatedBy } : {}), ...(bountyBy ? { bountyBy } : {}) };
}

/**
 * `addressProvenance`, and whether the address waited for a person's confirmation when it was set (`changed`): only
 * then does Counterparties offer to confirm it.
 */
function provenanceOf(address: string, entries: ReadonlyArray<Entry>): Provenance & { changed: boolean } {
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
    if (!same(set, address)) return { addressBy: null, confirmers: [], changed: false };
    // A change waits for a person's confirmation, and so does an address that came with a counterparty added through the
    // API or GitHub (counterparty creation R3); one typed in as the counterparty was added never asks for it.
    const changed = entry.action === "counterparty_address_changed" || entry.detail.via === "api" || entry.detail.via === "github";
    // The payee's own, sent through a payee link or GitHub; otherwise the member who typed it, or no one known.
    if (entry.detail.via === "mirror") return { addressBy: MIRROR, confirmers, changed };
    const fromPayee = entry.detail.via === "github" || entry.detail.via === "payee_link";
    return fromPayee ? { addressBy: PAYEE, confirmers, ...askedBy(entry, entries), changed } : { addressBy: member(entry.detail.by), confirmers, changed };
  }
  return { addressBy: null, confirmers: [], changed: false };
}

/** What the check answers for a payment to an address (N1–N3, N6). */
export interface NewPayeeCheck {
  firstPayment: boolean;
  /** Who gave the address: a member's id, `PAYEE`, `MIRROR`, or null when not known. */
  addressBy: string | null;
  /** For an address the payee sent through a payee link: the member who created the link, when one can be named. */
  linkCreatedBy?: string;
  /** For an address the payee sent on GitHub: the member the pull request's bounty acts as, when one can be named. */
  bountyBy?: string;
  confirmedBy: string | null;
  /**
   * For a first payment to an address no member answers for alone: every member who confirmed it, left out of approving
   * it. Absent otherwise, and when no one has confirmed it.
   */
  confirmersLeftOut?: string[];
  /**
   * A first payment to an address no member answers for alone: sent on GitHub, or with no giver named, set by a change a
   * person can confirm. Two different members stand behind it: one who confirmed it, and another who approves it.
   */
  unanswered?: true;
  twoParties: boolean;
}

/**
 * The member who answers for an address (N4): for an address the payee sent, the member who asked for it, or null when
 * no one can be named; otherwise whoever gave it, as `addressBy` names them.
 */
export function addressGiver(check: Pick<NewPayeeCheck, "addressBy" | "linkCreatedBy" | "bountyBy"> | null | undefined): string | null {
  if (!check) return null;
  return check.addressBy === PAYEE ? (check.linkCreatedBy ?? check.bountyBy ?? null) : check.addressBy;
}

/**
 * The members a first payment's approval must not rest on alone (N4): whoever answers for the address, and, for an
 * address no member answers for alone, whoever confirmed it. Approve and pay, Pay now and the two approvals all leave
 * them out, unless one of them is the workspace's only approver.
 */
export function membersLeftOut(
  check: Pick<NewPayeeCheck, "addressBy" | "linkCreatedBy" | "bountyBy" | "confirmersLeftOut" | "unanswered"> | null | undefined
): string[] {
  if (!check) return [];
  // No member answers for it: exactly whoever confirmed it, the member a bounty acts as included only if they did.
  if (check.unanswered) return [...new Set(check.confirmersLeftOut ?? [])];
  const giver = addressGiver(check);
  return giver ? [giver] : [];
}

/** The refusal of a confirmer of an address no member answers for, and of anyone while no other member confirmed it. */
const CONFIRMED_IT = "You confirmed this address, so someone else must approve its first payment.";
const CONFIRM_FIRST = "Someone else must confirm this address on Counterparties before its first payment.";

/**
 * Why this person may not approve this first payment on their own approval alone (N4), or null when they may: they gave
 * the address or asked for it; or, for an address no member answers for, they confirmed it, or no other member has
 * confirmed it yet. Read before the approval, whose own confirmation of the address never counts. The workspace's only
 * approver may still approve it.
 */
export function firstPaymentRefusal(check: NewPayeeCheck | null | undefined, actorId: string): string | null {
  if (!check) return null;
  if (check.unanswered) {
    const confirmers = check.confirmersLeftOut ?? [];
    if (confirmers.includes(actorId)) return CONFIRMED_IT;
    return confirmers.length === 0 ? CONFIRM_FIRST : null;
  }
  return addressGiver(check) === actorId ? newPayeeSelfMessage(check) : null;
}

/** How the payee sent an address a member asked for: through a payee link, or on GitHub; null for any other address. */
export function askedVia(check: Pick<NewPayeeCheck, "linkCreatedBy" | "bountyBy"> | null | undefined): "payee_link" | "github" | null {
  return check?.linkCreatedBy ? "payee_link" : check?.bountyBy ? "github" : null;
}

/**
 * Why a member left out of a first payment's approval may not give it alone (N4): they gave the address, asked the
 * payee for it, or, `actorId` being given, confirmed an address no member answers for alone.
 */
export function newPayeeSelfMessage(
  check: Pick<NewPayeeCheck, "addressBy" | "linkCreatedBy" | "bountyBy" | "confirmersLeftOut"> | null | undefined,
  actorId?: string
): string {
  // Only an address no member answers for alone lists its confirmers, and only they are left out of it.
  if (actorId !== undefined && check?.confirmersLeftOut?.includes(actorId)) return CONFIRMED_IT;
  // An address a GitHub bounty asked for is one no member answers for alone, so only a payee link's creator is told this.
  return askedVia(check) === "payee_link"
    ? "You asked for this address with a payee link, so someone else must approve its first payment."
    : "You gave this payee's address, so someone else must approve its first payment.";
}

/** The check for a payment to `address` (N1, N3); null for a counterparty with no address, which other rules answer. */
export function newPayeeCheck(input: {
  address: string | null;
  /** Every address this payee has received a confirmed payment at from the workspace, lowercase. */
  paidTo: ReadonlySet<string>;
  /** The counterparty's ledger entries that set, confirmed or asked for its address, newest first. */
  entries: ReadonlyArray<Entry>;
}): NewPayeeCheck | null {
  if (!input.address) return null;
  const { addressBy, confirmers, linkCreatedBy, bountyBy, changed } = provenanceOf(input.address, input.entries);
  const asked = { ...(linkCreatedBy ? { linkCreatedBy } : {}), ...(bountyBy ? { bountyBy } : {}) };
  // The confirmer must be someone other than whoever stands behind the address: for one the payee sent, who asked for it.
  const giver = addressGiver({ addressBy, ...asked });
  const other = confirmers.find((by) => by !== giver) ?? null;
  if (input.paidTo.has(input.address.toLowerCase())) {
    return { firstPayment: false, addressBy, ...asked, confirmedBy: other ?? confirmers[0] ?? null, twoParties: true };
  }
  // No member answers for it alone: sent on GitHub, or no giver named, set by a change someone can confirm. No
  // confirmation is a second party then; whoever confirmed it is left out of approving it.
  const unanswered = changed && addressBy !== MIRROR && (giver === null || bountyBy !== undefined);
  const leftOut = unanswered ? { ...(confirmers.length > 0 ? { confirmersLeftOut: confirmers } : {}), unanswered: true as const } : {};
  // A member's confirmation of the payee's own address, when another member asked for it through a payee link, or a
  // second member's of one a member gave: two parties.
  const twoParties = addressBy === MIRROR || (!unanswered && giver !== null && other !== null);
  return { firstPayment: true, addressBy, ...asked, confirmedBy: other ?? confirmers[0] ?? null, ...leftOut, twoParties };
}

/**
 * What a decision on a first payment records as `observed.newPayee` (N6): who gave the address, beside it the member who
 * asked the payee for it when there was one, who confirmed it, and whether two parties stand behind it.
 */
export function newPayeeObserved(check: NewPayeeCheck): {
  addressBy: string | null;
  linkCreatedBy?: string;
  bountyBy?: string;
  confirmedBy: string | null;
  unanswered?: true;
  twoParties: boolean;
} {
  return {
    addressBy: check.addressBy,
    ...(check.linkCreatedBy ? { linkCreatedBy: check.linkCreatedBy } : {}),
    ...(check.bountyBy ? { bountyBy: check.bountyBy } : {}),
    confirmedBy: check.confirmedBy,
    ...(check.unanswered ? { unanswered: true as const } : {}),
    twoParties: check.twoParties,
  };
}
