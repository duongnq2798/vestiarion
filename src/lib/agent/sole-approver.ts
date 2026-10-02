import { db } from "../dal";

/**
 * Whether this person is the only member of the workspace in scope who may approve payments
 * (docs/superpowers/specs/2026-10-03-sole-approver-design.md): then they may approve what they entered
 * themselves, since there is nobody else to. Read through `sole_approver` (migration 0061), the same function
 * `claim_invoice_decision` asks.
 *
 * Fails closed (R3): an answer that cannot be read, or anything but `true`, is `false`, so the separation
 * between whoever enters a payment and whoever approves it stays.
 */
export async function isSoleApprover(userId: string): Promise<boolean> {
  try {
    const result = await db().rpc("sole_approver", { p_user_id: userId });
    if (result.error) {
      console.error("sole approver: not read", result.error.message);
      return false;
    }
    return result.data === true;
  } catch (error) {
    console.error("sole approver: not read", error instanceof Error ? error.message : error);
    return false;
  }
}
