import type { ProviderId } from "./provider";

/**
 * How a payment made on Arc will be booked in the accounting tool, shown before an owner or admin picks the account
 * (docs/superpowers/specs/2026-10-12-xero-connector-design.md X14, I14). USDC is booked as USD and EURC as EUR; the
 * network fee is shown apart and not booked to this account. Each payment is booked only after a person approves it
 * (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W5, W6). Pure and browser-safe.
 */

/**
 * Which tools book the payments a person approves (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W11):
 * a provider with `booking` on its `AccountingProvider`. Browser-safe, for the preview; a provider that adds booking sets
 * it here too. A CRM books nothing (HubSpot connector H1).
 */
export const BOOKS_PAYMENTS: Record<ProviderId, boolean> = { xero: true, quickbooks: false, hubspot: false, asana: false };

export interface BookingAccount {
  name: string;
  code: string | null;
  currency: string | null;
}

/**
 * A bill to show the preview with: its supplier, number, and amount in its own currency. The Settings card reads one
 * still open in the tool with an amount due, in US dollars, one added to Vestiarion first (`accountingPanelView`).
 */
export interface BookingSample {
  supplier: string;
  number: string | null;
  amount: string;
  currency: string;
}

const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function accountName(account: BookingAccount): string {
  return account.code ? `${account.name} (${account.code})` : account.name;
}

/**
 * The accounts the picker lists (X14): the bank accounts, in the tool's order, and only them by default. The other
 * accounts the tool lets take payments (Xero's clearing, equity or drawings accounts) come after them only when asked
 * for: a supplier payment booked from an owner's equity or drawings account is almost always wrong. `others` counts
 * the ones kept back, or shown, so the toggle is there only when there are some.
 */
export function accountsToOffer<T extends { bank: boolean }>(accounts: readonly T[], showOthers: boolean): { offered: T[]; others: number } {
  const banks = accounts.filter((candidate) => candidate.bank);
  const others = accounts.filter((candidate) => !candidate.bank);
  return { offered: showOthers ? [...banks, ...others] : banks, others: others.length };
}

/** A bill the preview can show as it is: in US dollars, paid as that many USDC, with something left to pay. */
function shownAsItIs(sample: BookingSample | null): sample is BookingSample {
  return sample !== null && sample.currency === "USD" && Number.isFinite(Number(sample.amount)) && Number(sample.amount) > 0;
}

export function bookingPreview(account: BookingAccount, sample: BookingSample | null, label: string, books = true): { lines: string[]; warning: string | null } {
  // A bill in US dollars with an amount due is paid as that many USDC. Without one, the line says it is an example, with
  // a round figure and no supplier: never a bill already paid (0.00), and never a rate for another currency.
  const bill = shownAsItIs(sample) ? sample : null;
  const amount = bill ? MONEY.format(Number(bill.amount)) : "100.00";
  const payment = bill
    ? `A payment of ${amount} USDC to ${bill.supplier}${bill.number ? ` for bill ${bill.number}` : ""}`
    : "For example, a payment of 100.00 USDC for a bill";
  const lines = [
    `${payment} will be booked in ${label} as a payment of ${amount} USD from ${accountName(account)}, with the Arc transaction as its reference.`,
    books
      ? `The network fee is shown apart and not booked to this account. Each payment is booked in ${label} only after an owner or admin approves it on Bills & receivables.`
      : `The network fee is shown apart and not booked to this account. Nothing is written to ${label} yet: Vestiarion keeps this choice for when it books its payments there.`,
  ];
  const warning =
    account.currency && account.currency !== "USD"
      ? `This account holds ${account.currency}. A payment in USDC is booked as USD, and one in EURC as EUR, so an account in USD fits it best.`
      : null;
  return { lines, warning };
}
