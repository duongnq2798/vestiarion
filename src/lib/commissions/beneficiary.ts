import { db } from "../dal";
import { commissionsNotReady } from "./model";

/**
 * The members a plan of the partner this payable pays ever named as that partner (docs/superpowers/specs/2026-10-14-
 * commissions-design.md C11); none for a payable that pays no commission. Read through `commission_partner_members`
 * (0118), the same function `claim_invoice_decision` asks: none of them approves the payable, gives one of its two
 * approvals, or counts as someone else who may approve it. Before 0118 runs there is no commission payable, and the
 * answer is none. An answer that cannot be read is none here too: this read says a refusal in plain words before
 * anything is claimed, and the claim and `payment_approvals` refuse the partner in the database whatever it answered.
 * Runs inside an organization scope.
 */
export async function commissionPartnersOf(invoiceId: string): Promise<string[]> {
  try {
    const answer = await db().rpc("commission_partner_members", { p_invoice_id: invoiceId });
    if (answer.error) {
      if (!commissionsNotReady(answer.error)) console.error("commission partners: not read", answer.error.message);
      return [];
    }
    return Array.isArray(answer.data) ? (answer.data as unknown[]).filter((id): id is string => typeof id === "string") : [];
  } catch (error) {
    console.error("commission partners: not read", error instanceof Error ? error.message : error);
    return [];
  }
}
