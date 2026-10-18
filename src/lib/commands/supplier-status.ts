import { createSupplierLink, stopSupplierLink, SupplierLinkError } from "../supplier-status/links";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * A supplier's payment status link (docs/superpowers/specs/2026-10-18-supplier-status-design.md V1, V6): making and
 * stopping a link are records on the payables side, so `records.write` (owners and admins). From the console only.
 */

export async function shareSupplierStatus(
  actor: Actor,
  input: { counterpartyId: string; days: number }
): Promise<CommandOutcome<{ token: string; linkId: string; expiresAt: string }>> {
  const refusal = gate(actor, "supplier_status.share");
  if (refusal) return refusal;
  try {
    const made = await createSupplierLink({ actorId: actor.userId, counterpartyId: input.counterpartyId, days: input.days });
    const replaced = made.replaced > 0 ? ` The link ${made.supplierName} had before no longer works.` : "";
    return done(`Payment status link ready for ${made.supplierName}. Copy it now: it is shown only once.${replaced}`, {
      token: made.token,
      linkId: made.linkId,
      expiresAt: made.expiresAt,
    });
  } catch (error) {
    // A link whose entry failed was made and stopped, and one replaced stays stopped: the list changed.
    if (error instanceof SupplierLinkError) return refused(error.code, error.message, error.code === "not_recorded" || error.code === "busy" ? { changed: true } : {});
    console.error("sharing a payment status link failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    // The supplier's old link may have been stopped before the failure: the list is shown again either way.
    return refused("failed", TRY_AGAIN, { changed: true });
  }
}

export async function stopSupplierStatus(actor: Actor, input: { linkId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "supplier_status.unshare");
  if (refusal) return refusal;
  try {
    await stopSupplierLink({ actorId: actor.userId, linkId: input.linkId });
    return done("The link no longer opens the supplier's payment status.");
  } catch (error) {
    if (error instanceof SupplierLinkError) return refused(error.code, error.message, error.code === "already_stopped" ? { changed: true } : {});
    console.error("stopping a payment status link failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
