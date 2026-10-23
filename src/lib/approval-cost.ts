import { lateFeeLine, type LateFee } from "./agent/late-fee";
import { amountToPay } from "./agent/payment-timing";
import { ARC_FEE_USD } from "./circle/types";
import { utcDay } from "./copy";
import { networkProfile } from "./network";
import { chainById, networkOfChain, paidAcrossChains } from "./payee-chains";

/**
 * What Approve and pay would cost, on the approval card before anyone approves (docs/superpowers/specs/2026-10-22-
 * approval-total-cost-design.md TC1-TC3): the invoice, an early-payment discount that still applies, the route's fee
 * for a payee on another chain, what leaves the balance that pays it, and what the payee receives, then a late fee the
 * bill carries (docs/superpowers/specs/2026-10-23-late-fees-design.md LF4), which is never part of what leaves. Arc's network fee
 * is a note, where the workspace's wallets pay their own gas (Arc mainnet's EOAs): it is small and is never read before
 * the transfer. On Arc testnet Circle's Gas Station pays it.
 */

export interface CostLine {
  label: string;
  value: string;
  /** The line a person decides on: what leaves. */
  total?: boolean;
}

export interface ApprovalCost {
  lines: CostLine[];
  note: string | null;
}

const show = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const micro = (value: number) => Math.round(value * 1_000_000);

export function approvalCost(
  payable: {
    amount: number;
    counterpartyName: string;
    currency?: "USDC" | "EURC";
    discount: { pct: number; deadline: string } | null;
    payeeChain?: string;
    bridgeFeeUsdc?: number | null;
    payoutRoute?: "cctp" | "gateway";
    lateFee?: LateFee | null;
  },
  now: Date = new Date()
): ApprovalCost {
  const currency = payable.currency ?? "USDC";
  const { amountPaid, discountTaken } = amountToPay(payable.amount, payable.discount, now);
  const elsewhere = paidAcrossChains(payable.payeeChain);
  const gateway = elsewhere && payable.payoutRoute === "gateway";
  const fee = elsewhere ? (payable.bridgeFeeUsdc ?? null) : 0;

  const lines: CostLine[] = [{ label: "Invoice", value: `${show(payable.amount)} ${currency}` }];
  if (discountTaken > 0 && payable.discount) {
    lines.push({ label: `Early-payment discount, ${payable.discount.pct}% through ${utcDay(payable.discount.deadline)}`, value: `-${show(discountTaken)} ${currency}` });
  }
  if (elsewhere) lines.push({ label: gateway ? "Gateway fee, about" : "CCTP fee, about", value: fee === null ? "not read just now" : `${show(fee)} USDC` });
  // A cross-chain payout is in USDC only, so the amount and its fee add up; one whose fee was not read says so.
  const from = gateway ? "Leaves the Gateway balance" : "Leaves the operating wallet";
  lines.push({
    label: from,
    value: fee === null ? `${show(amountPaid)} ${currency} and the fee` : `${show((micro(amountPaid) + micro(fee)) / 1_000_000)} ${currency}`,
    total: true,
  });
  // CCTP mints the amount, and what Circle did not charge of the most the fee could be (CCTP payouts R3).
  const onChain = elsewhere ? ` on ${chainById(payable.payeeChain as string).label}` : "";
  lines.push({ label: `${payable.counterpartyName} receives`, value: `${elsewhere && !gateway ? "at least " : ""}${show(amountPaid)} ${currency}${onChain}` });
  // What paying late would cost: the vendor charges it, and a late payment is still paid at its amount.
  if (payable.lateFee) lines.push(lateFeeLine(payable.lateFee, payable.amount, currency));

  // A Gateway payout sends no transaction of the wallet's on Arc; a smart account's gas is paid by Circle's Gas Station.
  const ownGas = payable.payeeChain !== undefined && networkProfile(networkOfChain(payable.payeeChain)).walletAccountType === "EOA";
  return {
    lines,
    note: gateway || !ownGas ? null : `Arc's network fee, about ${show(ARC_FEE_USD)} USDC a transaction, also leaves the operating wallet.`,
  };
}

/**
 * A payout to a vendor's bank account (docs/superpowers/specs/2026-10-22-bank-route-comparison-design.md BR1-BR3): the
 * invoice, BlindPay's fees, which its quote takes from what the vendor receives, and what leaves the operating wallet,
 * with what the vendor would receive in USDC to a wallet instead: the full amount, no fee taken. Null without BlindPay's
 * quote, or while an early-payment discount applies, since the listing's quote is for the invoice's full amount.
 */
export function bankPayoutCost(
  payable: {
    amount: number;
    counterpartyName: string;
    discount: { pct: number; deadline: string } | null;
    bank?: { quote: { feesSender: number } | null } | null;
    lateFee?: LateFee | null;
  },
  now: Date = new Date()
): ApprovalCost | null {
  const quote = payable.bank?.quote ?? null;
  if (!quote) return null;
  if (amountToPay(payable.amount, payable.discount, now).discountTaken > 0) return null;
  return {
    lines: [
      { label: "Invoice", value: `${show(payable.amount)} USDC` },
      { label: "BlindPay's fees, taken from it", value: `-${show(quote.feesSender)} USDC` },
      { label: "Leaves the operating wallet", value: `${show(payable.amount)} USDC`, total: true },
      ...(payable.lateFee ? [lateFeeLine(payable.lateFee, payable.amount)] : []),
    ],
    note: `Paid in USDC to a wallet instead, ${payable.counterpartyName} would receive the full ${show(payable.amount)} USDC, with no fee taken: ask them for a wallet address with a payee link.`,
  };
}
