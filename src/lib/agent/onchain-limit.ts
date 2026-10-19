import { enforcedSpendingLimit, type EnforcedSpendingLimit } from "../circle/spending-limit-setup";
import type { SpendingLimitPayment, Stablecoin } from "../circle/types";
import { paidAcrossChains } from "../payee-chains";
import { spendingLimitCrossChainVerdict, spendingLimitRef, spendingLimitVerdict } from "../spending-limit/onchain";
import type { OnChainLimitCheck } from "./guardrails";

/**
 * The spending limit enforced on Arc as one cycle sees it (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * R3, R4, R7): whether the workspace enforces it, read once on first use, then for each payment the agent would make
 * itself, whether the contract can carry it and, when it can, the contract's own verdict and what to send it through.
 * The AP and contractor stages share one, as they share the spending limit itself. A version 2 contract carries a payout
 * to another chain too (docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-chain-design.md V12).
 */

/** What the decision records, and what its payment is sent through when the contract carries it. */
export interface OnChainLimitDecisionCheck extends OnChainLimitCheck {
  contract: string;
  /** The agent's wallet address: the only one the contract lets pay. */
  agent: string;
  ref: string;
  /** Null when the contract cannot carry the payment (R4). */
  payment: SpendingLimitPayment | null;
}

export interface OnChainLimitGate {
  check(input: {
    sourceType: "invoice" | "milestone";
    sourceId: string;
    /** The payee's address; null when it has none yet, so there is nothing to ask the contract. */
    to: string | null;
    /** What the transfer would send, in USDC. */
    amount: number;
    currency?: Stablecoin;
    destinationChain?: string | null;
    /**
     * A payout to another chain's fee as read for this decision, in units, and the payee chain's CCTP domain: what a
     * version 2 contract is asked with. Null or absent when none was read: there is then no verdict to ask for.
     */
    bridgeFee?: { maxFeeUnits: bigint; domain: number } | null;
  }): Promise<OnChainLimitDecisionCheck | null>;
}

export function onChainLimitGate(
  deps: {
    read?: () => Promise<EnforcedSpendingLimit | null>;
    verdict?: typeof spendingLimitVerdict;
    crossChainVerdict?: typeof spendingLimitCrossChainVerdict;
  } = {}
): OnChainLimitGate {
  const read = deps.read ?? enforcedSpendingLimit;
  const ask = deps.verdict ?? spendingLimitVerdict;
  const askAcross = deps.crossChainVerdict ?? spendingLimitCrossChainVerdict;
  let loaded: Promise<EnforcedSpendingLimit | null> | null = null;
  return {
    async check(input) {
      const limit = await (loaded ??= read());
      if (!limit) return null;
      const ref = spendingLimitRef(input.sourceType, input.sourceId);
      const named = { contract: limit.contract, agent: limit.agentAddress, ref };
      if ((input.currency ?? "USDC") === "EURC") return { ...named, covered: false, uncoveredBecause: "eurc", verdict: null, payment: null };
      const payment = { contract: limit.contract, agentWalletId: limit.agentWalletId, ref, ...(limit.version === 2 ? { version: 2 as const } : {}) };
      if (paidAcrossChains(input.destinationChain)) {
        // Version 1 pays on its own chain only (R4); version 2 burns for the payee's chain through `payAcrossChains`.
        if (limit.version !== 2) return { ...named, covered: false, uncoveredBecause: "another_chain", verdict: null, payment: null };
        const fee = input.bridgeFee ?? null;
        const verdict =
          input.to && fee
            ? await askAcross({ contract: limit.contract, agent: limit.agentAddress, recipient: input.to, amount: input.amount, maxFeeUnits: fee.maxFeeUnits, domain: fee.domain, ref: ref as `0x${string}` })
            : null;
        return { ...named, covered: true, verdict, payment };
      }
      const verdict = input.to ? await ask({ contract: limit.contract, agent: limit.agentAddress, to: input.to, amount: input.amount, ref: ref as `0x${string}` }) : null;
      return { ...named, covered: true, verdict, payment };
    },
  };
}

/** What a decision's ledger entry records of the check: addresses, the ref and the verdict, never a Circle wallet id. */
export function onChainLimitRecord(check: OnChainLimitDecisionCheck): Record<string, unknown> {
  return {
    contract: check.contract,
    agent: check.agent,
    ref: check.ref,
    covered: check.covered,
    ...(check.uncoveredBecause ? { uncoveredBecause: check.uncoveredBecause } : {}),
    verdict: check.verdict,
  };
}
