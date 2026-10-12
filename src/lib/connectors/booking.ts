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
export const BOOKS_PAYMENTS: Record<ProviderId, boolean> = { xero: true, quickbooks: false, hubspot: false };

export interface BookingAccount {
  name: string;
  code: string | null;
  currency: string | null;
}

/** A bill to show the preview with: its supplier, number, and amount in its own currency. */
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

export function bookingPreview(account: BookingAccount, sample: BookingSample | null, label: string, books = true): { lines: string[]; warning: string | null } {
  // A bill in US dollars is paid as that many USDC; any other example is a round figure, so no rate is implied.
  const amount = sample && sample.currency === "USD" ? MONEY.format(Number(sample.amount)) : "1,250.00";
  const toWhom = sample ? `${sample.supplier}${sample.number ? ` for bill ${sample.number}` : ""}` : "a supplier for one of its bills";
  const lines = [
    `A payment of ${amount} USDC to ${toWhom} will be booked in ${label} as a payment of ${amount} USD from ${accountName(account)}, with the Arc transaction as its reference.`,
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
