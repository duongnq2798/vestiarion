import { currentOrgConfig } from "../context";
import { enforcedSpendingLimit } from "../circle/spending-limit-setup";
import type { SpendingLimitPayment, Stablecoin } from "../circle/types";
import { spendingLimitRef, spendingLimitVerdict } from "../spending-limit/onchain";
import { workspaceNetwork } from "../workspace-network";

/**
 * A person's payment from a workspace that pays from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-
 * treasury-design.md W11). Vestiarion can move that wallet's USDC only through the workspace's contract, from the
 * agent's wallet: so a person's approval goes through it too, within the same figures, which bound everything
 * Vestiarion can move there. For this host alone it replaces the rule that a person's payment never goes through the
 * contract (onchain spending limit R6).
 */

/** Why the contract cannot carry a person's payment, in words a person can act on; nothing was sent. */
export class ContractRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractRefusal";
  }
}

export interface PersonPayment {
  sourceType: "invoice" | "milestone";
  sourceId: string;
  /** The payee's address; null when it has none. */
  to: string | null;
  /** What leaves the wallet: the discounted amount where a discount is taken. */
  amount: number;
  currency: Stablecoin;
  /** A payout to another chain, which the contract cannot carry. */
  crossChain: boolean;
  /**
   * Whether to ask the contract first; false for a payment that may have been sent already, which only goes through it
   * again under the same key and ref: the contract itself refuses a second payment of the same ref.
   */
  check?: boolean;
}

/**
 * The contract a person's payment goes through, once the contract's own answer allows it; null for a workspace that
 * pays from a Circle wallet. A refusal is a `ContractRefusal`, before anything is claimed or sent.
 */
export async function personPaymentThroughContract(
  input: PersonPayment,
  deps: { verdict?: typeof spendingLimitVerdict } = {}
): Promise<SpendingLimitPayment | null> {
  if (currentOrgConfig().chain.walletHost !== "external") return null;
  const network = workspaceNetwork();
  if (input.currency !== "USDC" || input.crossChain) throw new ContractRefusal(`Only USDC on ${network.label} can be paid from your wallet's contract.`);
  const limit = await enforcedSpendingLimit();
  if (!limit) throw new ContractRefusal("This workspace's wallet has not approved its spending limit contract, so nothing can be paid from it.");
  if (!input.to) throw new ContractRefusal("The payee has no address to pay yet.");
  const ref = spendingLimitRef(input.sourceType, input.sourceId);
  if (input.check !== false) {
    const verdict = await (deps.verdict ?? spendingLimitVerdict)({ contract: limit.contract, agent: limit.agentAddress, to: input.to, amount: input.amount, ref });
    if (verdict.state === "refused") {
      if ("limit" in verdict) {
        const which = verdict.error === "OverDailyLimit" ? "daily" : "7-day";
        throw new ContractRefusal(`Paying ${input.amount} USDC would pass the contract's ${which} limit of ${verdict.limit} USDC: ${verdict.spent} USDC paid so far.`);
      }
      throw new ContractRefusal(`The contract on ${network.label} refused this payment (${verdict.error}).`);
    }
    if (verdict.state === "unreadable") throw new ContractRefusal(`The contract on ${network.label} could not be read; nothing was paid. Try again in a moment.`);
  }
  return { contract: limit.contract, agentWalletId: limit.agentWalletId, ref };
}
