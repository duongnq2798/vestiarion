import { createPortalLink, PortalLinkError, stopPortalLink } from "../customer-portal/links";
import type { CloseOutcome } from "../customer-portal/model";
import { closeCustomerRequest, CustomerRequestError, replyToCustomer } from "../customer-portal/requests";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * A customer's statement link and what customers say through it
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P9): making and stopping a link are records on the
 * receivables side, so `records.write` (owners and admins); replying and closing a request are the receivables
 * bookkeeping, `receivables.reconcile` (owners, admins and accountants; accountant console A1). From the console only.
 */

export async function shareCustomerStatement(
  actor: Actor,
  input: { counterpartyId: string; days: number }
): Promise<CommandOutcome<{ token: string; linkId: string; expiresAt: string }>> {
  const refusal = gate(actor, "customer_portal.share");
  if (refusal) return refusal;
  try {
    const made = await createPortalLink({ actorId: actor.userId, counterpartyId: input.counterpartyId, days: input.days });
    const replaced = made.replaced > 0 ? ` The link ${made.customerName} had before no longer works.` : "";
    return done(`Statement link ready for ${made.customerName}. Copy it now: it is shown only once.${replaced}`, {
      token: made.token,
      linkId: made.linkId,
      expiresAt: made.expiresAt,
    });
  } catch (error) {
    // A link whose entry failed was made and stopped, and one replaced stays stopped: the list changed.
    if (error instanceof PortalLinkError) return refused(error.code, error.message, error.code === "not_recorded" || error.code === "busy" ? { changed: true } : {});
    console.error("sharing a statement failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function stopCustomerStatement(actor: Actor, input: { linkId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "customer_portal.unshare");
  if (refusal) return refusal;
  try {
    await stopPortalLink({ actorId: actor.userId, linkId: input.linkId });
    return done("The link no longer opens the statement.");
  } catch (error) {
    if (error instanceof PortalLinkError) return refused(error.code, error.message, error.code === "already_stopped" ? { changed: true } : {});
    console.error("stopping a statement link failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function replyToCustomerRequest(actor: Actor, input: { requestId: string; body: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "customer_request.reply");
  if (refusal) return refusal;
  try {
    const { customerName } = await replyToCustomer({ actorId: actor.userId, requestId: input.requestId, body: input.body });
    return done(`Sent. ${customerName} sees your reply on its statement.`);
  } catch (error) {
    if (error instanceof CustomerRequestError) return refused(error.code, error.message, error.code === "closed" ? { changed: true } : {});
    console.error("replying to a customer failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function closeCustomerRequestCommand(actor: Actor, input: { requestId: string; outcome: CloseOutcome }): Promise<CommandOutcome> {
  const refusal = gate(actor, "customer_request.close");
  if (refusal) return refusal;
  try {
    const { customerName, kind } = await closeCustomerRequest({ actorId: actor.userId, requestId: input.requestId, outcome: input.outcome });
    const resumes = kind === "dispute" || kind === "promise" ? " The agent's reminders about the invoice go on as before." : "";
    return done(`Closed. ${customerName} sees it on its statement.${resumes}`);
  } catch (error) {
    if (error instanceof CustomerRequestError) return refused(error.code, error.message, error.code === "closed" ? { changed: true } : {});
    console.error("closing a customer request failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
