import { db } from "../dal";
import { commissionsNotReady } from "./model";

/**
 * Whether this person may not approve this payable because it pays the commission of a partner a plan named them as
 * (docs/superpowers/specs/2026-10-14-commissions-design.md C11), sole approver or not. Read through
 * `commission_beneficiary_approval` (0118), the same function `claim_invoice_decision` asks. Before 0118 runs there is
 * no commission payable, and the answer is no. An answer that cannot be read is no here too: this check says the
 * refusal in plain words before anything is claimed, and the claim and `payment_approvals` refuse the partner in the
 * database whatever it answered. Runs inside an organization scope.
 */
export async function paysOwnCommission(invoiceId: string, userId: string): Promise<boolean> {
  try {
    const answer = await db().rpc("commission_beneficiary_approval", { p_invoice_id: invoiceId, p_user_id: userId });
    if (answer.error) {
      if (!commissionsNotReady(answer.error)) console.error("commission partner: not read", answer.error.message);
      return false;
    }
    return answer.data === true;
  } catch (error) {
    console.error("commission partner: not read", error instanceof Error ? error.message : error);
    return false;
  }
}
