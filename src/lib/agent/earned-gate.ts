import type { OrgDb } from "../dal";
import { EARNED_WAITING_MAX, earnedLostEntry } from "../earned-vendors";
import { syncEarnedVendors } from "../earned-vendors-store";
import { appendLedgerEntry } from "../ledger";
import { readOutflowBudget } from "./outflow-budget";

/**
 * Earned vendors paid on their own, the autonomy ladder's third step
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL21-AL27): which vendors the AP stage of a shadow-mode
 * workspace pays on the agent's own decision instead of holding the payment for a verdict. Built once as the stage starts
 * (`earnedGateFor`), and asked only where the stage would hold a payment that passed every guardrail and every check
 * after them for a verdict, so it never lets through anything a rule or a check stopped.
 *
 * A vendor is granted only when it is earned now under the owner's rule and recorded earned, the owner's switch is on,
 * the agent has a spending limit, the workspace is not on Arc mainnet, and fewer than 3 of its payments made this way
 * wait for a verdict (AL22, AL26). Anything that cannot be read grants none: every payment then waits for a verdict, as
 * before, and the gate never throws into the stage (AL24). A live workspace never builds one: the agent already pays
 * what passes its checks there.
 */

/** What allowed a payment made on its own, recorded on its `ap_pay` entry as `earned` (AL27). */
export interface EarnedGrant {
  /** The `vendor_earned` entry that recorded the vendor earned. */
  recordSeq: number;
  /** The rule it was earned under: agreed verdicts in a row. */
  streak: number;
  /** Agreed verdicts in a row it had when the stage started. */
  agreed: number;
}

export interface EarnedGate {
  /**
   * The grant for this vendor's payment that passed every check, or null: it waits for a verdict (AL22, AL24, AL26).
   */
  paysAlone(counterpartyId: string): EarnedGrant | null;
  /** A payment made on its own this stage now waits for a verdict too, toward the 3 (AL26). */
  paid(counterpartyId: string): void;
  /**
   * A decision this stage broke the vendor's status (AL25): no grant for the rest of the stage, and `vendor_earned_lost`
   * signed at once, best effort, naming the decision; the next sync signs it when this could not. Never throws.
   */
  lose(counterpartyId: string, because: { kind: "flagged" | "code_stop"; decisionSeq: number; rule: string | null }): Promise<void>;
}

/** No vendor is paid on its own: every payment in shadow mode waits for a verdict. */
export const NO_EARNED: EarnedGate = {
  paysAlone: () => null,
  paid: () => {},
  lose: async () => {},
};

/** What a payment the agent made on its own says, after its reasoning (AL22). */
export const EARNED_PAID_NOTE = " [an earned vendor under the owner's rule: paid without waiting for a verdict; give yours after]";

/** One vendor the gate grants: earned now and recorded earned, with how many of its own payments wait for a verdict. */
export interface EarnedVendorGrant {
  vendorId: string;
  name: string;
  grant: EarnedGrant;
  waiting: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

/** The gate over these vendors, for one stage: each paid on its own until 3 wait, or until a decision breaks it. */
export function earnedGate(granted: readonly EarnedVendorGrant[]): EarnedGate {
  const vendors = new Map(granted.map((vendor) => [vendor.vendorId, { ...vendor }]));
  return {
    paysAlone: (counterpartyId) => {
      const vendor = vendors.get(counterpartyId);
      return vendor && vendor.waiting < EARNED_WAITING_MAX ? vendor.grant : null;
    },
    paid: (counterpartyId) => {
      const vendor = vendors.get(counterpartyId);
      if (vendor) vendor.waiting += 1;
    },
    lose: async (counterpartyId, because) => {
      const vendor = vendors.get(counterpartyId);
      if (!vendor) return;
      vendors.delete(counterpartyId);
      try {
        await appendLedgerEntry(
          earnedLostEntry({
            vendorId: vendor.vendorId,
            name: vendor.name,
            streak: vendor.grant.streak,
            because: because.kind,
            since: { kind: because.kind, at: new Date().toISOString(), decisionSeq: because.decisionSeq, rule: because.rule },
            trigger: "cycle",
          })
        );
      } catch (error) {
        console.error("earned vendors: a loss in the AP stage not signed; the next sync signs it", messageOf(error));
      }
    },
  };
}

/**
 * The stage's gate (AL22, AL24): signs the statuses as the stage starts, as step 2's sync does (AL16), then grants each
 * vendor earned now and recorded earned, while the owner's switch is on, the agent has a spending limit and the
 * workspace is off Arc mainnet. Any failure grants none, logged.
 */
export async function earnedGateFor(db: OrgDb, input: { network: string; shadow: { startedAt: string } | null }): Promise<EarnedGate> {
  try {
    const sync = await syncEarnedVendors(db, { trigger: "cycle", shadow: input.shadow });
    if (!sync.payments || sync.streak === null) return NO_EARNED;
    // Shadow mode runs on Arc testnet only: on Arc mainnet there is nothing to pay on its own.
    if (input.network === "arc-mainnet") return NO_EARNED;
    // The agent's own payments always count against its spending limit: with none set, none is made this way (AL21).
    const budget = await readOutflowBudget(db);
    if (!budget || (budget.dailyUsdc === null && budget.weeklyUsdc === null)) return NO_EARNED;
    const streak = sync.streak;
    const granted: EarnedVendorGrant[] = [];
    for (const status of sync.statuses) {
      const recorded = sync.recorded.get(status.vendorId);
      if (status.state !== "earned" || recorded?.state !== "earned") continue;
      granted.push({ vendorId: status.vendorId, name: status.name, grant: { recordSeq: recorded.seq, streak, agreed: status.agreed }, waiting: status.waiting });
    }
    return granted.length > 0 ? earnedGate(granted) : NO_EARNED;
  } catch (error) {
    console.error("earned vendors: not read as the AP stage started; every payment waits for a verdict", messageOf(error));
    return NO_EARNED;
  }
}
