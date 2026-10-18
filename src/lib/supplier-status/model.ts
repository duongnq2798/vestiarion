import { utcDay } from "../copy";
import { dayWords, money } from "../customer-portal/model";

/**
 * A supplier's payment status, pure (docs/superpowers/specs/2026-10-18-supplier-status-design.md V2): where each of the
 * supplier's bills stands, in the supplier's words, and what is still to be paid per currency. The words never say why a
 * bill is held: a supplier reads "Being reviewed" whether the cash is short, a guardrail stopped it, it was flagged or a
 * person is deciding it. For a payable, `matched` is a payment submitted and not yet confirmed (settlement lifecycle
 * I17), and `processing` the claim a person holds while deciding it in Approvals, before any payment exists.
 */

/** How long a new link lasts, in days: the choice the person is given (the database refuses more than 91). */
export const LINK_DAYS = [7, 30, 90] as const;
export type LinkDays = (typeof LINK_DAYS)[number];

/** Paid bills stay on the page this long after they were paid, at most this many. */
export const RECENT_PAID_DAYS = 90;
export const RECENT_PAID_MAX = 10;

/** The signed entries this feature writes (domain `ap`). */
export const SUPPLIER_STATUS_ACTIONS = {
  shared: "supplier_status_shared",
  unshared: "supplier_status_unshared",
} as const;

/** The payables a supplier's page reads as open; `rejected` is never shown, and `paid` is read apart. */
export const OPEN_PAYABLE_STATUSES = ["pending", "matched", "held", "flagged", "awaiting_info", "scheduled", "processing"] as const;

export type Standing = "received" | "reviewing" | "scheduled" | "on_its_way" | "paid";

export interface SupplierBillIn {
  id: string;
  amount: number;
  currency: string;
  dueDate: string;
  memo: string | null;
  poReference: string | null;
  status: string;
  scheduledFor: string | null;
  settledAt: string | null;
  /** The confirmed payment's transaction, when there is one. */
  txHash: string | null;
  /** A payment started and not yet confirmed or failed. */
  inFlight: boolean;
}

export interface SupplierBillView {
  id: string;
  reference: string;
  poReference: string | null;
  amount: string;
  currency: string;
  due: string;
  standing: Standing;
  /** Where it stands, in the supplier's words: "Received", "Being reviewed", "To be paid on Oct 24, 2026"… */
  words: string;
  /** The transaction on the network's explorer, for a paid bill whose payment has one. */
  txUrl: string | null;
}

export interface SupplierStatusView {
  orgName: string;
  supplierName: string;
  /** "Oct 18, 2026": the day the page was read. */
  asOf: string;
  /** "Oct 17, 2026": the last day the link works. */
  until: string;
  open: SupplierBillView[];
  paid: SupplierBillView[];
  /** What is still to be paid, per currency, never summed across currencies: "190.00 USDC". */
  stillToBePaid: string[];
  /** A sandbox: its payments are simulated, and the page says so. */
  simulated: boolean;
  /** Whether any bill shown links its payment's transaction. */
  linksTransactions: boolean;
}

/** Where a bill stands for its supplier; null for a bill the page never shows (rejected). */
export function standingOf(bill: Pick<SupplierBillIn, "status" | "inFlight">): Standing | null {
  if (bill.status === "rejected") return null;
  if (bill.status === "paid") return "paid";
  if (bill.status === "matched" || bill.inFlight) return "on_its_way";
  if (bill.status === "scheduled") return "scheduled";
  if (bill.status === "pending") return "received";
  // Held, flagged, waiting for details, a person deciding it, or anything new: reviewed by the business, never why.
  return "reviewing";
}

function wordsOf(standing: Standing, bill: SupplierBillIn): string {
  switch (standing) {
    case "received":
      return "Received";
    case "reviewing":
      return "Being reviewed";
    case "scheduled":
      return bill.scheduledFor ? `To be paid on ${utcDay(bill.scheduledFor)}` : "Set to be paid";
    case "on_its_way":
      return "Payment on its way";
    case "paid":
      return bill.settledAt ? `Paid on ${utcDay(bill.settledAt)}` : "Paid";
  }
}

/** A transaction on Arc the explorer can open: a simulated payment's reference (`sim_...`) is never linked. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Open bills first by what happens next: on its way, then by the day set, then the rest by due day. */
const ORDER: Record<Standing, number> = { on_its_way: 0, scheduled: 1, reviewing: 2, received: 3, paid: 4 };

export function buildSupplierStatus(input: {
  orgName: string;
  supplierName: string;
  expiresAt: string;
  now: number;
  /** A sandbox workspace, whose payments are simulated. */
  simulated?: boolean;
  bills: SupplierBillIn[];
  /** The network's explorer address for a transaction, without its hash. */
  explorerTx: string;
}): SupplierStatusView {
  const views: SupplierBillView[] = [];
  const sortDay = new Map<string, string>();
  for (const bill of input.bills) {
    const standing = standingOf(bill);
    if (!standing) continue;
    views.push({
      id: bill.id,
      reference: bill.memo?.trim() || `Bill due ${dayWords(bill.dueDate)}`,
      poReference: bill.poReference?.trim() || null,
      amount: money(bill.amount, bill.currency),
      currency: bill.currency,
      due: dayWords(bill.dueDate),
      standing,
      words: wordsOf(standing, bill),
      txUrl: standing === "paid" && bill.txHash && TX_HASH.test(bill.txHash) ? `${input.explorerTx}${bill.txHash}` : null,
    });
    sortDay.set(bill.id, standing === "paid" ? (bill.settledAt ?? "") : standing === "scheduled" ? (bill.scheduledFor ?? bill.dueDate) : bill.dueDate);
  }
  const open = views
    .filter((view) => view.standing !== "paid")
    .sort((a, b) => ORDER[a.standing] - ORDER[b.standing] || (sortDay.get(a.id) ?? "").localeCompare(sortDay.get(b.id) ?? ""));
  const paid = views.filter((view) => view.standing === "paid").sort((a, b) => (sortDay.get(b.id) ?? "").localeCompare(sortDay.get(a.id) ?? ""));

  const totals = new Map<string, number>();
  for (const bill of input.bills) {
    const standing = standingOf(bill);
    if (!standing || standing === "paid") continue;
    totals.set(bill.currency, (totals.get(bill.currency) ?? 0) + bill.amount);
  }
  return {
    orgName: input.orgName,
    supplierName: input.supplierName,
    asOf: utcDay(new Date(input.now).toISOString()),
    until: utcDay(input.expiresAt),
    open,
    paid,
    stillToBePaid: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => money(amount, currency)),
    simulated: input.simulated ?? false,
    linksTransactions: paid.some((view) => view.txUrl !== null),
  };
}

export interface SupplierLinkView {
  id: string;
  supplierName: string;
  /** "Works until Nov 12, 2026" or "Expired Oct 1, 2026". */
  until: string;
  expired: boolean;
  /** "Made by ana@example.com on Oct 13, 2026". */
  made: string;
}

/** The links members see on the Bills tab: live ones first, newest first, each with its supplier and who made it. */
export function supplierLinkRows(
  links: ReadonlyArray<{ id: string; counterpartyId: string; createdBy: string | null; createdAt: string; expiresAt: string; expired: boolean }>,
  names: ReadonlyMap<string, string>,
  members: ReadonlyMap<string, string> | null
): SupplierLinkView[] {
  return [...links]
    .sort((a, b) => Number(a.expired) - Number(b.expired) || b.createdAt.localeCompare(a.createdAt))
    .map((link) => ({
      id: link.id,
      supplierName: names.get(link.counterpartyId) ?? "A supplier",
      until: link.expired ? `Expired ${utcDay(link.expiresAt)}` : `Works until ${utcDay(link.expiresAt)}`,
      expired: link.expired,
      made: `Made by ${link.createdBy ? (members?.get(link.createdBy) ?? "a member") : "a former member"} on ${utcDay(link.createdAt)}`,
    }));
}
