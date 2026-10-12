import { applyPayment, reverseAllocation, type ApplyInput } from "../allocations/apply";
import { AllocationError, amountWords } from "../allocations/model";
import { plural } from "../copy";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Applying money received to receivables, and reversing it (docs/superpowers/specs/2026-10-12-allocations-design.md
 * L10): records, entered as an invoice is, so `records.write` (owners and admins), from the console only. A refusal
 * from the model or the database reads in its own words; anything else is logged and said as a failure.
 */

export async function applyReceivedPayment(
  actor: Actor,
  input: Omit<ApplyInput, "actorId">
): Promise<CommandOutcome<{ applied: number; settled: number; unappliedAfter: number }>> {
  const refusal = gate(actor, "receivable.apply_payment");
  if (refusal) return refusal;
  try {
    const result = await applyPayment({ ...input, actorId: actor.userId });
    const payments = result.rows.filter((row) => row.kind === "payment");
    const fees = result.rows.filter((row) => row.kind === "fee");
    const settled = new Set(result.rows.filter((row) => row.outstandingAfter === 0).map((row) => row.invoiceId)).size;
    const parts = [
      payments.length > 0 ? `Applied to ${payments.length} ${plural(payments.length, "invoice", "invoices")}` : "",
      fees.length > 0 ? `${payments.length > 0 ? "recorded" : "Recorded"} ${fees.length} ${plural(fees.length, "fee", "fees")}` : "",
    ].filter(Boolean);
    const paid = settled > 0 ? ` ${settled} ${plural(settled, "is", "are")} now paid.` : "";
    const credit =
      result.unappliedAfter > 0 && result.currency
        ? ` ${amountWords(result.unappliedAfter, result.currency)} of the payment is left${result.customer ? ` as credit for ${result.customer}` : ""}.`
        : "";
    return done(`${parts.join(", and ")}.${paid}${credit}`, { applied: payments.length, settled, unappliedAfter: result.unappliedAfter });
  } catch (error) {
    if (error instanceof AllocationError) return refused(error.code, error.message, error.code === "stale" ? { changed: true } : {});
    console.error("applying a payment failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function reverseAppliedPayment(
  actor: Actor,
  input: { allocationId: string; reason: string }
): Promise<CommandOutcome<{ reversed: number; outstandingAfter: number }>> {
  const refusal = gate(actor, "receivable.reverse_allocation");
  if (refusal) return refusal;
  try {
    const result = await reverseAllocation({ ...input, actorId: actor.userId });
    const fees = result.rows.length - 1;
    const withFees = fees > 0 ? `, with the ${plural(fees, "fee", "fees")} recorded beside it` : "";
    return done(`Reversed${withFees}. ${amountWords(result.outstandingAfter, result.currency)} is owed on ${result.label}.`, {
      reversed: result.rows.length,
      outstandingAfter: result.outstandingAfter,
    });
  } catch (error) {
    if (error instanceof AllocationError) return refused(error.code, error.message, error.code === "already_reversed" ? { changed: true } : {});
    console.error("reversing a payment applied failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
