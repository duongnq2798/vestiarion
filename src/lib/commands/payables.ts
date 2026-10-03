import { addInvoiceDetails, approveAndPay, ApprovalError, rejectInvoice, returnInvoice } from "../agent/approvals";
import { runCycleSoon } from "../agent/cycle-soon";
import { sendNoticesSoon } from "../payment-notices-soon";
import { accessOf, cycleEventOf, provenanceOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * A person's decisions on a payable the agent stopped (integrations design §9, Phase 0): the console's Approvals
 * buttons, and any surface allowed to run them. Each calls the approvals library as the console always has; what
 * follows a decision (the payee's notice, the agent's next look) is raised here, so every surface gets it (R5).
 */

/** An `ApprovalError` carries a message safe to show; anything else goes to the server log. */
function approvalRefusal(error: unknown): Refused {
  if (error instanceof ApprovalError) return refused(error.code, error.message);
  console.error("approval action failed", error);
  return refused("failed", TRY_AGAIN);
}

/**
 * `payInvoice`'s note on a failed transfer reads ` [transfer failed: <reason>]`, or ` [execution failed: <reason>]`
 * for one that never reached the provider. The reason, for the person who pressed Approve and pay; a note in neither
 * shape is shown trimmed, whole, rather than dropped.
 */
export function heldMessage(note: string): string {
  const match = /\[(?:transfer|execution) failed:\s*(.+?)\]\s*$/.exec(note);
  const reason = match ? match[1] : note.trim();
  return `The transfer failed: ${reason}. The invoice is held.`;
}

export async function approvePayable(
  actor: Actor,
  input: { invoiceId: string; shownAddress?: string }
): Promise<CommandOutcome<{ status: "paid" | "matched"; txRef: string | null }>> {
  const refusal = gate(actor, "payable.approve");
  if (refusal) return refusal;
  let result: Awaited<ReturnType<typeof approveAndPay>>;
  try {
    result = await approveAndPay({ actorId: actor.userId, invoiceId: input.invoiceId, shownAddress: input.shownAddress, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  // A failed transfer leaves the invoice held with the provider's reason: something changed, and it is still a failure.
  if (result.status === "held") return refused("transfer_failed", heldMessage(result.note), { changed: true });
  // A confirmed payment's payee hears of it now, not at the next cycle (payment notices R5).
  if (result.status === "paid") sendNoticesSoon(accessOf(actor));
  return done(result.status === "paid" ? "Paid." : "Payment submitted; waiting for confirmation.", { status: result.status, txRef: result.txRef });
}

export async function rejectPayable(actor: Actor, input: { invoiceId: string; reason: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.reject");
  if (refusal) return refusal;
  try {
    await rejectInvoice({ actorId: actor.userId, invoiceId: input.invoiceId, reason: input.reason, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  return done("Rejected.");
}

export async function returnPayable(actor: Actor, input: { invoiceId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.return");
  if (refusal) return refusal;
  try {
    await returnInvoice({ actorId: actor.userId, invoiceId: input.invoiceId, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  runCycleSoon(cycleEventOf(actor, "payable_returned"));
  return done("Returned to the agent. It usually decides it again within a minute.");
}

/**
 * Adds the purchase order or goods receipt a held payable was missing (complete held invoice). Entering facts is a
 * records write, for owners and admins: an approver decides payments, and does not enter them (R1). The cycle the
 * event starts reopens the payable on the changed facts and decides it again (R4).
 */
export async function addPayableDetails(
  actor: Actor,
  input: { invoiceId: string; poReference: string | null; goodsReceived: boolean }
): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.add_details");
  if (refusal) return refusal;
  try {
    await addInvoiceDetails({
      actorId: actor.userId,
      invoiceId: input.invoiceId,
      poReference: input.poReference,
      goodsReceived: input.goodsReceived,
      ...provenanceOf(actor),
    });
  } catch (error) {
    return approvalRefusal(error);
  }
  runCycleSoon(cycleEventOf(actor, "details_added"));
  return done("Details added. The agent usually decides it again within a minute.");
}
