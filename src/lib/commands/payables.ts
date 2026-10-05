import { addInvoiceDetails, approveAndPay, ApprovalError, rejectInvoice, returnInvoice } from "../agent/approvals";
import { runCycleSoon } from "../agent/cycle-soon";
import { fromReserveNote, fromReserveStaysNote } from "../agent/liquidity";
import { sendNoticesSoon } from "../payment-notices-soon";
import { accessOf, cycleEventOf, provenanceOf, type Actor } from "./actor";
import { checkChatDecision, type ShownCard } from "./chat-decisions";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";
import { APPROVAL_RECORDED } from "../two-approvals";

/**
 * A person's decisions on a payable the agent stopped (integrations design §9, Phase 0): the console's Approvals
 * buttons, and any surface allowed to run them. Each calls the approvals library as the console always has; what
 * follows a decision (the payee's notice, the agent's next look) is raised here, so every surface gets it (R5).
 *
 * A decision from any surface but the console answers a card the surface showed (`card`), and passes the chat's rules
 * first (src/lib/commands/chat-decisions.ts, Slack design S10); an approval then pays the address those rules checked.
 */

/** The chat's rules for a decision from any surface but the console; the console's decisions pass untouched. */
async function chatRules(actor: Actor, decision: "approve" | "reject" | "return", invoiceId: string, card: ShownCard | undefined) {
  if (actor.surface.kind === "console") return { ok: true as const, address: undefined };
  const check = await checkChatDecision(actor, decision, invoiceId, card);
  return check.ok ? { ok: true as const, address: check.address ?? undefined } : check;
}

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
  input: { invoiceId: string; shownAddress?: string; card?: ShownCard }
): Promise<CommandOutcome<{ status: "paid" | "matched" | "approved"; txRef: string | null }>> {
  const refusal = gate(actor, "payable.approve");
  if (refusal) return refusal;
  let result: Awaited<ReturnType<typeof approveAndPay>>;
  try {
    const chat = await chatRules(actor, "approve", input.invoiceId, input.card);
    if (!chat.ok) return chat.refusal;
    const shownAddress = actor.surface.kind === "console" ? input.shownAddress : chat.address;
    result = await approveAndPay({ actorId: actor.userId, invoiceId: input.invoiceId, shownAddress, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  // A failed transfer leaves the invoice held with the provider's reason: something changed, and it is still a failure.
  // Cash brought back from the reserve for it stays in the operating wallet, which is said too (review finding 8).
  if (result.status === "held") return refused("transfer_failed", `${heldMessage(result.note)}${fromReserveStaysNote(result.fromReserveUsdc)}`, { changed: true });
  // Above the workspace's figure, the first of two approvals is recorded and sends nothing (two approvals T4, T8).
  if (result.status === "approved") return done(APPROVAL_RECORDED, { status: "approved", txRef: null });
  // A confirmed payment's payee hears of it now, not at the next cycle (payment notices R5).
  if (result.status === "paid") sendNoticesSoon(accessOf(actor));
  // Cash brought back from the reserve to pay it is said too (approval cash R4).
  const message = result.status === "paid" ? "Paid." : "Payment submitted; waiting for confirmation.";
  return done(`${message}${fromReserveNote(result.fromReserveUsdc)}`, { status: result.status, txRef: result.txRef });
}

export async function rejectPayable(actor: Actor, input: { invoiceId: string; reason: string; card?: ShownCard }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.reject");
  if (refusal) return refusal;
  try {
    const chat = await chatRules(actor, "reject", input.invoiceId, input.card);
    if (!chat.ok) return chat.refusal;
    await rejectInvoice({ actorId: actor.userId, invoiceId: input.invoiceId, reason: input.reason, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  return done("Rejected.");
}

export async function returnPayable(actor: Actor, input: { invoiceId: string; card?: ShownCard }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.return");
  if (refusal) return refusal;
  try {
    const chat = await chatRules(actor, "return", input.invoiceId, input.card);
    if (!chat.ok) return chat.refusal;
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
