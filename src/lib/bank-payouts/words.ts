import { clabeBank } from "../blindpay/clabe";

/**
 * How a bank payout reads on the approval card (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B12): the
 * vendor's account by its bank and last four digits, and what BlindPay's indicative quote says the vendor receives.
 * Pure and browser-safe.
 */

export interface BankPayoutShown {
  bankCode: string;
  last4: string;
  beneficiaryName: string;
  accountStatus: "verifying" | "approved" | "rejected" | "deprecated";
  quote: { receiverAmount: number; currency: "MXN"; rate: number | null; feesSender: number } | null;
  quoteProblem: "not_set_up" | "eurc" | "below_minimum" | "unread" | "sent" | null;
}

const pesos = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

/** "Paid to a bank account in Mexico: BBVA ····1234, Ana López, through BlindPay." */
export function bankAccountLine(bank: Pick<BankPayoutShown, "bankCode" | "last4" | "beneficiaryName" | "accountStatus">): string {
  const checking = bank.accountStatus === "approved" ? "" : bank.accountStatus === "verifying" ? " BlindPay is still checking the account." : " BlindPay did not approve the account.";
  return `Paid to a bank account in Mexico: ${clabeBank(bank.bankCode)} ····${bank.last4}, ${bank.beneficiaryName}, through BlindPay.${checking}`;
}

/** What the vendor would receive now, by BlindPay's indicative quote, or why the card has none. */
export function bankQuoteLine(bank: Pick<BankPayoutShown, "beneficiaryName" | "quote" | "quoteProblem">): string {
  if (bank.quote) {
    const rate = bank.quote.rate !== null ? `${pesos(bank.quote.rate)} MXN per USDC, ` : "";
    return `${bank.beneficiaryName} receives about ${pesos(bank.quote.receiverAmount)} MXN (${rate}BlindPay's fees ${pesos(bank.quote.feesSender)} USDC). Approve and pay asks BlindPay for a fresh quote.`;
  }
  switch (bank.quoteProblem) {
    case "sent":
      return "Its payout was already sent: Approve and pay reads it from BlindPay.";
    case "eurc":
      return "Only USDC is paid to a bank account, and this invoice is in EURC.";
    case "below_minimum":
      return "BlindPay pays at least 10.00 USDC to a bank account.";
    case "not_set_up":
      return "Bank payouts are not set up on this workspace: an owner sets them up under Settings.";
    default:
      return "BlindPay did not quote it just now. Approve and pay asks BlindPay again, and pays nothing without a quote.";
  }
}
