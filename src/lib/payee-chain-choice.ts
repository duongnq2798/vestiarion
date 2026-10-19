import { enforcedSpendingLimit } from "./circle/spending-limit-setup";
import { currentOrgConfig } from "./context";
import { db } from "./dal";
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

/** At most this many payees are read at once, to keep each read's address short. */
const ID_CHUNK = 100;

/**
 * The payees among these that something owed to them would hold to the chain on file (P2): a milestone not yet paid or
 * closed, which is paid on the workspace's own chain only, or an open bill in another currency than USDC, since only
 * USDC crosses chains. Choosing another chain would strand it. Read in the workspace's scope; 0133's `chainOpen` asks
 * the same, and whether any payment was made, when the payee opens its link.
 */
export async function payeesHeldToTheirChain(ids: readonly string[]): Promise<Set<string>> {
  const held = new Set<string>();
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const [milestones, bills] = await Promise.all([
      db().from("milestones").select("contractor_id").in("contractor_id", chunk).not("status", "in", "(paid,closed)"),
      db()
        .from("invoices")
        .select("counterparty_id")
        .in("counterparty_id", chunk)
        .eq("direction", "payable")
        .neq("currency", "USDC")
        .not("status", "in", "(paid,rejected,received)"),
    ]);
    if (milestones.error) throw new Error(milestones.error.message);
    if (bills.error) throw new Error(bills.error.message);
    for (const row of (milestones.data ?? []) as Array<{ contractor_id: string }>) held.add(row.contractor_id);
    for (const row of (bills.data ?? []) as Array<{ counterparty_id: string }>) held.add(row.counterparty_id);
  }
  return held;
}

/**
 * Whether a payee may be offered the choice at all, as the console reads it: a vendor (a contractor's milestones are
 * paid on the workspace's own chain) with no address yet, and nothing owed to it held to its chain (`held`, from
 * `payeesHeldToTheirChain`). The link's page also needs no payment to it (0133's `chainOpen`).
 */
export function chainChoiceFits(counterparty: { id: string; role: string; address: string | null }, held: ReadonlySet<string>): boolean {
  return counterparty.role === "vendor" && !counterparty.address && !held.has(counterparty.id);
}
