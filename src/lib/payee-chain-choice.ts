import { enforcedSpendingLimit } from "./circle/spending-limit-setup";
import { currentOrgConfig } from "./context";
import type { PayeeChainEntry } from "./network";
import { chainsOn } from "./payee-chains";
import { workspaceNetwork } from "./workspace-network";

/**
 * Whether a payee link may let its payee choose where it is paid (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md
 * P1, P2), and among which chains: the workspace network's payee chains, only when there are more than one, and only
 * when the workspace can pay each of them. A workspace that pays from its owner's own wallet pays another chain only
 * through version 2 of its spending limit contract (mainnet Base payouts B3, spending limit v2 V13), so with version 1,
 * or with no contract carrying the agent's payments, it offers none: Approve and pay would refuse the payout. Read in
 * the workspace's scope.
 */
export async function choosablePayeeChains(): Promise<readonly PayeeChainEntry[]> {
  const chains = chainsOn(workspaceNetwork().id);
  if (chains.length < 2) return [];
  if (currentOrgConfig().chain.walletHost === "external" && (await enforcedSpendingLimit())?.version !== 2) return [];
  return chains;
}

/**
 * Whether a payee may be offered the choice at all, as the console reads it: a vendor (a contractor's milestones are
 * paid on the workspace's own chain) with no address yet. The link's page also needs no payment to it (0133's
 * `chainOpen`), which the console does not read for every row.
 */
export function chainChoiceFits(counterparty: { role: string; address: string | null }): boolean {
  return counterparty.role === "vendor" && !counterparty.address;
}
