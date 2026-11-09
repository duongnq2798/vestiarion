import { OPEN_STATUSES } from "../bills-view";
import { utcDay } from "../copy";
import { addressUnconfirmed } from "../counterparty-address";
import type { Network, PayeeChainEntry } from "../network";
import { addressOnChainUrl, ChainNotOnNetworkError, chainOn } from "../payee-chains";
import type { Lookalike } from "../payee-lock-rules";
import type { CounterpartyRow, InvoiceRow, MilestoneRow } from "../queries";
import { visibleText } from "../visible-text";

/**
 * What a counterparty's page shows, from what it read (docs/superpowers/specs/2026-11-09-counterparty-page-design.md):
 * the address's state and whether it may be copied (CL5), each payee link's state (CL6), the milestone, bill and
 * invoice groups (CL7, CL8), Payments' rows and the totals per currency (CL9), and the tiles. Pure: the page reads, and
 * this decides what each part says.
 */

/** A part of the page, read best effort (CL13): its value, or that it could not be read. Never 0 or "none" for that. */
export type Part<T> = { read: true; value: T } | { read: false };

/** A tile whose part could not be read (CL13). */
export const NOT_READ = "Not read";
/** A section whose part could not be read (CL13). */
export const PART_NOT_READ = "Not read just now. Reload the page in a moment.";

/** A vendor or a contractor: someone the workspace pays. A client pays the workspace (CL1). */
export function isPayee(role: string): boolean {
  return role !== "client";
}

// --- The payment address (CL5) ---

export type AddressState = "none" | "set_when_added" | "confirmed" | "unconfirmed" | "frozen";

/** The Address tile's words for each state. */
export const ADDRESS_STATE_WORDS: Record<AddressState, string> = {
  none: "None",
  set_when_added: "Set when added",
  confirmed: "Confirmed",
  unconfirmed: "To confirm",
  frozen: "Frozen",
};

/** Why Copy address is off for an address there is. */
export type CopyOff = { reason: "lookalike"; name: string } | { reason: "earlier_lookalike" } | { reason: "frozen" } | { reason: "unconfirmed" };

export interface AddressFacts {
  state: AddressState;
  /** CL5: Copy address shows. */
  copyable: boolean;
  /** Why it does not; null when it shows, and when there is no address to copy. */
  copyOff: CopyOff | null;
}

/**
 * CL5: the address's state, and whether "Copy address" shows: only for an address set when the counterparty was added or
 * confirmed since, not frozen, and like no other counterparty's address and no earlier one of this payee's. A copied
 * address is pasted somewhere money is sent from, and a lookalike is made to pass a glance at its first and last digits.
 * When copy is off, its reason is the one no other step lifts first: a lookalike stays one, a frozen address cannot be
 * confirmed until it is unfrozen.
 */
export function addressFacts(
  counterparty: Pick<CounterpartyRow, "address" | "address_changed_at" | "address_confirmed_at">,
  facts: { lookalikes: readonly Lookalike[]; earlierLookalike: string | null; frozen: boolean }
): AddressFacts {
  const unconfirmed = addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at);
  const state: AddressState = facts.frozen
    ? "frozen"
    : !counterparty.address
      ? "none"
      : unconfirmed
        ? "unconfirmed"
        : counterparty.address_changed_at || counterparty.address_confirmed_at
          ? "confirmed"
          : "set_when_added";
  if (!counterparty.address) return { state, copyable: false, copyOff: null };
  const copyOff: CopyOff | null =
    facts.lookalikes.length > 0
      ? { reason: "lookalike", name: visibleText(facts.lookalikes[0].name, 80) }
      : facts.earlierLookalike
        ? { reason: "earlier_lookalike" }
        : state === "frozen"
          ? { reason: "frozen" }
          : state === "unconfirmed"
            ? { reason: "unconfirmed" }
            : null;
  return { state, copyable: copyOff === null, copyOff };
}

/**
 * The line that says why Copy address is off. A lookalike's name is someone else's text, set apart by the page (CL12), so
 * it comes back on its own with the words before and after it.
 */
export function copyOffWords(off: CopyOff): { before: string; name: string | null; after: string } {
  switch (off.reason) {
    case "lookalike":
      return { before: "Copy is off: this address looks like ", name: off.name, after: "'s. Check every character on the explorer." };
    case "earlier_lookalike":
      return { before: "Copy is off: this address looks like one this payee had before. Check every character on the explorer.", name: null, after: "" };
    case "frozen":
      return { before: "Frozen: copy comes back once an owner or admin unfreezes it.", name: null, after: "" };
    case "unconfirmed":
      return { before: "Copy comes back once someone confirms this address.", name: null, after: "" };
  }
}

/** CL5: said instead of an explorer link for a chain the workspace's network does not pay on. */
export const NO_EXPLORER = "Not a chain this workspace pays on, so there is no explorer link.";

/**
 * CL5: the address on its chain's explorer (`addressOnChainUrl`), or, for a chain the workspace does not pay on, why there
 * is no link. Neither for no address, nor for one that is not 0x and 40 hex digits.
 */
export function addressExplorer(network: Network, counterparty: Pick<CounterpartyRow, "address" | "chain">): { href: string } | { href: null; note: string | null } {
  if (!counterparty.address) return { href: null, note: null };
  const chain = paidChain(network, counterparty.chain);
  if (!chain) return { href: null, note: NO_EXPLORER };
  const href = addressOnChainUrl(chain, counterparty.address);
  return href ? { href } : { href: null, note: null };
}

/** The payee's chain on the workspace's network; null for one it does not pay on (`ChainNotOnNetworkError`). */
function paidChain(network: Network, chain: string | null): PayeeChainEntry | null {
  try {
    return chainOn(network, chain);
  } catch (error) {
    if (error instanceof ChainNotOnNetworkError) return null;
    throw error;
  }
}

// --- The payee link (CL6) ---

/** The links Payee link lists, newest first; every one is in History and the Audit log. */
export const PAYEE_LINKS_SHOWN = 5;

/**
 * How long a used link takes its payee's invoice, and its status page stays open: 30 days, as 0133's functions count them
 * (`INVOICE_DAYS_MS` in src/lib/platform/payee-links.ts, which this pure file does not import).
 */
export const USED_LINK_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** A payee link as `payeeLinksOf` reads it: never its token's hash. The invoice columns are 0133's, absent before it. */
export interface PayeeLinkRecord {
  id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  asks_invoice?: boolean | null;
  invoice_at?: string | null;
  invoice_closed_at?: string | null;
}

export type PayeeLinkInvoice = { kind: "sent"; at: string } | { kind: "waiting"; until: string } | { kind: "closed" };

export type PayeeLinkState =
  | { kind: "out"; expiresAt: string }
  | { kind: "replaced"; at: string }
  | { kind: "revoked"; at: string }
  | { kind: "expired"; at: string }
  | { kind: "used"; at: string; invoice: PayeeLinkInvoice | null };

export interface PayeeLinkLine {
  id: string;
  state: PayeeLinkState;
  /** "Out · expires Nov 16, 2026", "Replaced by a newer link · Nov 9, 2026", "Used · Nov 10, 2026". */
  label: string;
  /** A used link's invoice: "Invoice sent · …", "Waiting for their invoice · until …", "Invoice closed"; null for none. */
  invoice: string | null;
  /** "Made by {email}", or "Made by a former member". */
  madeBy: string;
}

/**
 * An instant to the microsecond Postgres keeps, so two times are equal only when they are the same instant, however they
 * are written ("Z" or "+00:00"). NaN for a time that is none.
 */
function microsOf(at: string): number {
  const fraction = /T[\d:]+\.(\d+)/.exec(at)?.[1] ?? "";
  return Date.parse(at) * 1000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}

function linkState(link: PayeeLinkRecord, newer: readonly PayeeLinkRecord[], now: number): PayeeLinkState {
  if (link.used_at) {
    let invoice: PayeeLinkInvoice | null = null;
    if (link.asks_invoice) {
      const until = Date.parse(link.used_at) + USED_LINK_DAYS_MS;
      invoice = link.invoice_at
        ? { kind: "sent", at: link.invoice_at }
        : link.invoice_closed_at || until <= now
          ? { kind: "closed" }
          : { kind: "waiting", until: new Date(until).toISOString() };
    }
    return { kind: "used", at: link.used_at, invoice };
  }
  // A link revoked once it had expired, as making a link revokes every earlier unused one, had expired first.
  if (link.revoked_at && microsOf(link.revoked_at) < microsOf(link.expires_at)) {
    // create_payee_link and create_payee_link_with_options revoke the earlier unused links in the transaction that inserts
    // the new one, so its `created_at` is their `revoked_at`.
    const revokedAt = microsOf(link.revoked_at);
    return newer.some((other) => microsOf(other.created_at) === revokedAt) ? { kind: "replaced", at: link.revoked_at } : { kind: "revoked", at: link.revoked_at };
  }
  if (Date.parse(link.expires_at) <= now) return { kind: "expired", at: link.expires_at };
  return { kind: "out", expiresAt: link.expires_at };
}

function linkLabel(state: PayeeLinkState): string {
  switch (state.kind) {
    case "out":
      return `Out · expires ${utcDay(state.expiresAt)}`;
    case "replaced":
      return `Replaced by a newer link · ${utcDay(state.at)}`;
    case "revoked":
      return `Revoked · ${utcDay(state.at)}`;
    case "expired":
      return `Expired unused · ${utcDay(state.at)}`;
    case "used":
      return `Used · ${utcDay(state.at)}`;
  }
}

function invoiceLabel(invoice: PayeeLinkInvoice | null): string | null {
  if (!invoice) return null;
  if (invoice.kind === "sent") return `Invoice sent · ${utcDay(invoice.at)}`;
  if (invoice.kind === "waiting") return `Waiting for their invoice · until ${utcDay(invoice.until)}`;
  return "Invoice closed";
}

/**
 * CL6: each link's state, newest first. Out: unused, unexpired, unrevoked. Replaced by a newer link: revoked at the instant
 * a newer link was made. Revoked: at any other time. Expired unused. Used, with its invoice when it asked for one: sent,
 * waiting until 30 days after it was used, or closed (by a member, or by those 30 days passing). Each names who made it.
 */
export function payeeLinkStates(
  links: readonly PayeeLinkRecord[],
  context: { now: number; members: ReadonlyArray<{ userId: string; email: string }> }
): PayeeLinkLine[] {
  const newestFirst = [...links].sort((a, b) => microsOf(b.created_at) - microsOf(a.created_at));
  const emails = new Map(context.members.map((member) => [member.userId, member.email]));
  return newestFirst.map((link, index) => {
    const state = linkState(link, newestFirst.slice(0, index), context.now);
    const email = link.created_by ? emails.get(link.created_by) : undefined;
    return {
      id: link.id,
      state,
      label: linkLabel(state),
      invoice: invoiceLabel(state.kind === "used" ? state.invoice : null),
      madeBy: email ? `Made by ${email}` : "Made by a former member",
    };
  });
}

/** The Payee link tile (CL6): the link out, else a used one still waiting for its invoice, else none. */
export function payeeLinkTileWords(links: { active: { expiresAt: string } | null; waiting: { until: string } | null }): string {
  if (links.active) return `Out · expires ${utcDay(links.active.expiresAt)}`;
  if (links.waiting) return `Waiting for their invoice · until ${utcDay(links.waiting.until)}`;
  return "None out";
}

// --- Milestones, bills and invoices (CL7, CL8) ---

/** Rows a group shows, and how many it has. */
export interface Group<T> {
  rows: T[];
  count: number;
}

/** The open bills or invoices shown, by due date (CL8). */
export const OPEN_SHOWN = 200;
/** The latest rejected bills, or received invoices, shown (CL8). */
export const CLOSED_SHOWN = 10;

const group = <T>(rows: T[], shown: number): Group<T> => ({ rows: rows.slice(0, shown), count: rows.length });
/** A time, a day ("2026-11-09", read as its start in UTC) or none, as a number to sort by: none sorts last. */
const timeOf = (at: string | null | undefined) => {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? -Infinity : time;
};
/** Newest first, a row with no time last, ties in the order read. */
const newestFirst = <T>(rows: readonly T[], at: (row: T) => string | null | undefined): T[] =>
  rows
    .map((row, index) => ({ row, index, time: timeOf(at(row)) }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map((entry) => entry.row);

/** A bill or an invoice not yet paid, received or rejected: Bills' open statuses, and one being paid now (CL8). */
export function invoiceOpen(invoice: Pick<InvoiceRow, "status">): boolean {
  return OPEN_STATUSES.has(invoice.status) || invoice.status === "processing";
}

/** A client's invoice it paid. */
const received = (invoice: Pick<InvoiceRow, "status">) => invoice.status === "received" || invoice.status === "paid";

export interface InvoiceGroups {
  /** Open, by due date: the first 200. */
  open: Group<InvoiceRow>;
  /** A payee's rejected bills ("Rejected"), or a client's paid invoices ("Received"): the latest 10. */
  closed: Group<InvoiceRow>;
  /** A payee's paid bills, or a client's paid invoices, every one: Payments' rows (CL9). */
  paid: InvoiceRow[];
}

/**
 * CL8: a payee's bills (its payables), or a client's invoices (its receivables), in their groups. A rejected bill is the
 * latest by when it was added, a received invoice by when its money arrived; either by its due date before those were kept.
 */
export function invoiceGroups(invoices: readonly InvoiceRow[], role: string): InvoiceGroups {
  const payee = isPayee(role);
  const own = invoices.filter((invoice) => invoice.direction === (payee ? "payable" : "receivable"));
  const open = own.filter(invoiceOpen).sort((a, b) => a.due_date.slice(0, 10).localeCompare(b.due_date.slice(0, 10)));
  if (payee) {
    const rejected = newestFirst(
      own.filter((invoice) => invoice.status === "rejected"),
      (invoice) => invoice.created_at ?? invoice.due_date
    );
    return { open: group(open, OPEN_SHOWN), closed: group(rejected, CLOSED_SHOWN), paid: own.filter((invoice) => invoice.status === "paid") };
  }
  const paid = newestFirst(own.filter(received), (invoice) => invoice.settled_at ?? invoice.due_date);
  return { open: group(open, OPEN_SHOWN), closed: group(paid, CLOSED_SHOWN), paid };
}

export interface MilestoneGroups {
  /** "Open": pending, verified or held, in the order read. */
  open: MilestoneRow[];
  /** "Closed without paying": the latest closed first. */
  closed: MilestoneRow[];
  /** Paid, which Payments lists (CL9). */
  paid: MilestoneRow[];
}

/** CL7: a payee's milestones in their groups. */
export function milestoneGroups(milestones: readonly MilestoneRow[]): MilestoneGroups {
  return {
    open: milestones.filter((milestone) => ["pending", "verified", "held"].includes(milestone.status)),
    closed: newestFirst(
      milestones.filter((milestone) => milestone.status === "closed"),
      (milestone) => milestone.closed_at
    ),
    paid: milestones.filter((milestone) => milestone.status === "paid"),
  };
}

// --- Payments and totals (CL9) ---

/** Payments shown by default, and with `?history=all#payments`. */
export const PAYMENTS_SHOWN = 10;
export const PAYMENTS_ALL = 500;

/** A row of Payments, at the time its row's date says: a milestone when it was paid, a bill or invoice its due date. */
export type PaymentRow = { kind: "milestone"; at: string; milestone: MilestoneRow } | { kind: "invoice"; at: string; invoice: InvoiceRow };

/**
 * CL9: paid milestones and paid bills (a client's paid invoices), merged, newest first by the date each row shows
 * (`milestoneDate`, `rowDate`): the latest 10, or 500 with every payment asked for. `count` is every one.
 */
export function paymentRows(
  input: { milestones: ReadonlyArray<{ milestone: MilestoneRow; paidAt: string }>; invoices: readonly InvoiceRow[] },
  all: boolean
): { shown: PaymentRow[]; count: number } {
  const rows: PaymentRow[] = [
    ...input.milestones.map(({ milestone, paidAt }) => ({ kind: "milestone" as const, at: paidAt, milestone })),
    // A paid bill's row leads with its due date (`rowDate`).
    ...input.invoices.map((invoice) => ({ kind: "invoice" as const, at: invoice.due_date.slice(0, 10), invoice })),
  ];
  const ordered = newestFirst(rows, (row) => row.at);
  return { shown: ordered.slice(0, all ? PAYMENTS_ALL : PAYMENTS_SHOWN), count: ordered.length };
}

export type Currency = "USDC" | "EURC";

/** One currency's total. */
export interface CurrencyTotal {
  currency: Currency;
  amount: number;
}

const MICROS = 1_000_000;

/**
 * CL9: totals per currency, USDC first, for the currencies the rows are in: "120 USDC · 40 EURC". USDC and EURC are
 * never added together. Summed in millionths, as the amounts are kept, so no float error builds up. None for no row.
 */
export function totalsByCurrency(rows: ReadonlyArray<{ amount: number; currency?: string | null }>): CurrencyTotal[] {
  const sums = new Map<Currency, number>();
  for (const row of rows) {
    const currency: Currency = row.currency === "EURC" ? "EURC" : "USDC";
    sums.set(currency, (sums.get(currency) ?? 0) + Math.round(row.amount * MICROS));
  }
  return (["USDC", "EURC"] as const).filter((currency) => sums.has(currency)).map((currency) => ({ currency, amount: (sums.get(currency) ?? 0) / MICROS }));
}

/** What a paid bill or invoice counts: what actually left or arrived (`paid_amount`, less any discount), else its amount. */
const paidAmount = (invoice: InvoiceRow) => ({ amount: invoice.paid_amount ?? invoice.amount, currency: invoice.currency });
/** Milestones are paid in USDC. */
const milestoneAmount = (milestone: MilestoneRow) => ({ amount: milestone.amount, currency: "USDC" });

/**
 * CL9, CL13: what is owed to a payee (its open bills and open milestones) or by a client (its open invoices), and what
 * was paid, per currency, from every row read, not only those shown.
 */
export function counterpartyTotals(role: string, invoices: readonly InvoiceRow[], milestones: readonly MilestoneRow[]): { owed: CurrencyTotal[]; paid: CurrencyTotal[] } {
  const bills = invoiceGroups(invoices, role);
  const own = invoices.filter((invoice) => invoice.direction === (isPayee(role) ? "payable" : "receivable"));
  const work = isPayee(role) ? milestoneGroups(milestones) : { open: [], closed: [], paid: [] };
  return {
    owed: totalsByCurrency([...own.filter(invoiceOpen), ...work.open.map(milestoneAmount)]),
    paid: totalsByCurrency([...bills.paid.map(paidAmount), ...work.paid.map(milestoneAmount)]),
  };
}

// --- The tiles ---

export type TileValue = { kind: "money"; totals: CurrencyTotal[] } | { kind: "words"; words: string };

export interface Tile {
  label: string;
  value: TileValue;
  /** Something waits on a person: an address to confirm, a frozen one, or a payee with none. */
  held: boolean;
}

/**
 * The header's tiles: what is owed and what was paid ("Not read" when the bills, or a payee's milestones, could not be
 * read), the address's state, and, for a writer on a payee's page, its payee link (null otherwise).
 */
export function tiles(input: {
  role: string;
  invoices: Part<readonly InvoiceRow[]>;
  /** A payee's milestones; a client's are not read. */
  milestones: Part<readonly MilestoneRow[]>;
  address: Part<AddressState>;
  payeeLink: Part<{ active: { expiresAt: string } | null; waiting: { until: string } | null }> | null;
}): Tile[] {
  const payee = isPayee(input.role);
  const notRead: TileValue = { kind: "words", words: NOT_READ };
  const milestones: Part<readonly MilestoneRow[]> = payee ? input.milestones : { read: true, value: [] };
  const totals = input.invoices.read && milestones.read ? counterpartyTotals(input.role, input.invoices.value, milestones.value) : null;
  const address = input.address;
  const shown: Tile[] = [
    { label: payee ? "Owed to them" : "Owed by them", value: totals ? { kind: "money", totals: totals.owed } : notRead, held: false },
    { label: payee ? "Paid to them" : "Paid by them", value: totals ? { kind: "money", totals: totals.paid } : notRead, held: false },
    {
      label: "Address",
      value: address.read ? { kind: "words", words: ADDRESS_STATE_WORDS[address.value] } : notRead,
      held: address.read && (address.value === "unconfirmed" || address.value === "frozen" || (payee && address.value === "none")),
    },
  ];
  if (payee && input.payeeLink) {
    shown.push({ label: "Payee link", value: input.payeeLink.read ? { kind: "words", words: payeeLinkTileWords(input.payeeLink.value) } : notRead, held: false });
  }
  return shown;
}
