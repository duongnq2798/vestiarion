import type { ChangeDraft, DealDraft } from "../deals/input";
import { changeDeal as writeChange, confirmDeal, DealError, releaseDealLine as writeRelease, switchDealAutoRelease } from "../deals/write";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * A deal's commands (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D13): confirming one, changing,
 * cancelling or reopening it, releasing a line as a receivable, and the switch that lets the agent release each line on
 * its day. Each needs `records.write`, as adding a receivable does; the console runs them.
 */

/**
 * A refusal in the deal's own words; anything else is logged and said as a failure no one can act on. A deal changed
 * since the page was drawn, or a form sent again with other details, refreshes the page: the deal as it is, and a new key.
 */
function refusalOf(error: unknown, what: string, actor: Actor): Refused {
  if (error instanceof DealError) return refused(error.code, error.message, error.code === "changed" || error.code === "key_reused" ? { changed: true } : {});
  console.error(what, actor.orgId, error instanceof Error ? error.message : "unknown error");
  return refused("failed", TRY_AGAIN);
}

/** Confirms a deal: its schedule as version 1, every line planned. The same confirm again answers the same deal (D12). */
export async function addDeal(actor: Actor, input: { draft: DealDraft }): Promise<CommandOutcome<{ dealId: string; created: boolean }>> {
  const refusal = gate(actor, "deal.create");
  if (refusal) return refusal;
  try {
    const result = await confirmDeal({ actorId: actor.userId, draft: input.draft });
    return done(
      result.created
        ? `Deal confirmed with ${result.customerName}: ${result.title}. Release each line when it is time to invoice it.`
        : `This deal was confirmed already: ${result.title}.`,
      { dealId: result.dealId, created: result.created }
    );
  } catch (error) {
    return refusalOf(error, "confirming a deal failed", actor);
  }
}

/** Changes, cancels or reopens a deal: its next version, which never rewrites a released line (D7-D9). */
export async function changeDeal(actor: Actor, input: { change: ChangeDraft }): Promise<CommandOutcome<{ version: number }>> {
  const refusal = gate(actor, "deal.change");
  if (refusal) return refusal;
  try {
    const result = await writeChange({ actorId: actor.userId, change: input.change });
    if (!result.created) return done(`That change was saved already, as version ${result.version}.`, { version: result.version });
    const message =
      result.kind === "cancelled"
        ? `${result.title} is cancelled. The lines not invoiced yet are stopped; the receivables made stay as they are.`
        : result.kind === "reopened"
          ? `${result.title} is reopened as version ${result.version}.`
          : `Version ${result.version} of ${result.title} is saved. The receivables made stay as they are.`;
    return done(message, { version: result.version });
  } catch (error) {
    return refusalOf(error, "changing a deal failed", actor);
  }
}

/** Releases one line as a receivable, through the add-receivable path (D10). */
export async function releaseDealLine(actor: Actor, input: { dealId: string; lineId: string }): Promise<CommandOutcome<{ invoiceId: string }>> {
  const refusal = gate(actor, "deal.release");
  if (refusal) return refusal;
  try {
    const result = await writeRelease({ actorId: actor.userId, dealId: input.dealId, lineId: input.lineId, via: "person" });
    return done(
      result.made
        ? `${result.line} of ${result.title} is now a receivable from ${result.customerName}: ${result.amount}.`
        : `${result.line} of ${result.title} was a receivable already.`,
      { invoiceId: result.invoiceId }
    );
  } catch (error) {
    return refusalOf(error, "releasing a deal line failed", actor);
  }
}

/** Turns on or off the agent's release of each line on its invoice day (D10). */
export async function setDealAutoRelease(actor: Actor, input: { dealId: string; on: boolean }): Promise<CommandOutcome> {
  const refusal = gate(actor, "deal.auto_release");
  if (refusal) return refusal;
  try {
    const result = await switchDealAutoRelease({ actorId: actor.userId, dealId: input.dealId, on: input.on });
    return done(
      input.on
        ? `The agent now releases each line of ${result.title} on its invoice day.`
        : `The lines of ${result.title} are now released by a person only.`
    );
  } catch (error) {
    return refusalOf(error, "switching a deal's release failed", actor);
  }
}
