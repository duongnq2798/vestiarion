import { networkProfile } from "../network";
import { chainById, homeChain, networkOfChain } from "../payee-chains";
import type { ReceiptFacts } from "./facts";
import type { OnChainCheck } from "./onchain";

/**
 * A receipt's Amounts list (docs/superpowers/specs/2026-10-22-receipt-v2-design.md RV4): the invoice it pays and its
 * number, what a discount took off, the route's fee and who paid it, what left the sender, and what the payee received,
 * read from their chain. A receipt shared before receipts v2 states no fees' payer, so it shows what was paid and
 * received.
 */

export interface AmountRow {
  label: string;
  value: string;
}

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const show = (value: number, token: string) => `${round6(value)} ${token}`;

export function receiptAmounts(facts: ReceiptFacts, onChain: OnChainCheck): AmountRow[] {
  const chain = chainById(facts.chain);
  const network = networkOfChain(facts.chain);
  const home = homeChain(network).label;
  const rows: AmountRow[] = [];
  if (facts.invoiceNumber) rows.push({ label: "Invoice", value: facts.invoiceNumber });
  if (facts.invoiceAmount != null && facts.invoiceAmount > facts.amount) {
    rows.push({
      label: "Invoice amount",
      value: `${show(facts.invoiceAmount, facts.token)}, less ${show(facts.invoiceAmount - facts.amount, facts.token)} for paying early`,
    });
  }
  rows.push({ label: "Amount paid", value: show(facts.amount, facts.token) });

  if (facts.feesPaidBy === "sender") {
    const gateway = facts.route === "gateway";
    if (facts.feeUsdc != null) {
      rows.push(
        gateway
          ? // Gateway's estimate when it was paid: its signed intent allowed a little more.
            { label: "Gateway fee", value: `about ${show(facts.feeUsdc, "USDC")}` }
          : // The most the burn allowed: what Circle did not charge of it was minted to the payee with the amount.
            { label: "CCTP fee", value: `up to ${show(facts.feeUsdc, "USDC")}` }
      );
    }
    rows.push({
      label: "Fees",
      value: facts.feeUsdc != null ? "Paid by the sender, on top of the amount. None was taken from the payee's payment." : "None was taken from the payee's payment.",
    });
    // In one token only: a EURC payment's fee would be in USDC, so its total is not a sum. Where the sender's wallet pays
    // its own gas (Arc mainnet), that small fee left it too; on Arc testnet Circle's Gas Station pays it, and a Gateway
    // payout sends no transaction of the sender's on Arc.
    if (facts.token === "USDC") {
      const total = show(facts.amount + (facts.feeUsdc ?? 0), "USDC");
      const ownGas = networkProfile(network).walletAccountType === "EOA" && !gateway;
      rows.push({ label: "Left the sender", value: `${gateway && facts.feeUsdc != null ? "about " : ""}${total}${ownGas ? `, and ${home}'s network fee` : ""}` });
    }
  }

  if (onChain.state === "matches" && onChain.received != null) {
    rows.push({ label: "Payee received", value: `${show(onChain.received, facts.token)}, read on ${chain.label}` });
  } else if (onChain.state === "unreadable") {
    rows.push({ label: "Payee received", value: `${show(facts.amount, facts.token)}, as stated: ${chain.label} did not answer just now` });
  }
  return rows;
}
