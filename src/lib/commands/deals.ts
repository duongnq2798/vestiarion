import { NotSetUpError } from "../connectors/connections";
import { crmRowForDeal, reviewChanges, sourceOf } from "../connectors/crm-actions";
import { changesKey, rowChanges } from "../connectors/crm-store";
import { PROVIDER_LABELS } from "../connectors/provider";
import type { CostDraft } from "../deals/costs";
import { addDealCost as writeAddCost, DealCostError, linkDealCost as writeLinkCost, removeDealCost as writeRemoveCost, type LinkTarget } from "../deals/costs-write";
import type { ChangeDraft, DealDraft } from "../deals/input";
import { changeDeal as writeChange, confirmDeal, DealError, releaseDealLine as writeRelease, switchDealAutoRelease } from "../deals/write";
import type { Actor } from "./actor";
import { changedAgain } from "./crm";
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

/** The CRM row a deal was planned from, when the change was made from its changes; none before migration 0105. */
async function crmOrigin(dealId: string) {
  try {
    return await crmRowForDeal(dealId);
  } catch (error) {
    if (error instanceof NotSetUpError) return null;
    throw error;
  }
}

/**
 * Changes, cancels or reopens a deal: its next version, which never rewrites a released line (D7-D9). Made from the
 * changes a CRM brought (`fromCrm`, HubSpot connector H12), its entry says so, and those changes count as reviewed: only
 * the changes the form was filled in from (`seen`, their `changesKey`). A set the CRM made since refuses the change
 * before anything is written, so it is never marked as seen behind the person.
 */
export async function changeDeal(actor: Actor, input: { change: ChangeDraft; fromCrm?: { seen: string } }): Promise<CommandOutcome<{ version: number }>> {
  const refusal = gate(actor, "deal.change");
  if (refusal) return refusal;
  try {
    const origin = input.fromCrm ? await crmOrigin(input.change.dealId) : null;
    if (origin && input.fromCrm) {
      const changes = rowChanges(origin.row, "active");
      if (changes.length > 0 && changesKey(changes) !== input.fromCrm.seen) return changedAgain(PROVIDER_LABELS[origin.connection.provider]);
    }
    const result = await writeChange({ actorId: actor.userId, change: input.change, ...(origin ? { source: sourceOf(origin) } : {}) });
    if (origin && result.created) await reviewChanges(origin, actor.userId);
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

/**
 * A cost's refusal in its own words (deal cash readiness K3); a form sent again with other details, or a cost changed
 * since the page was drawn, refreshes the page. Anything else is logged and said as a failure no one can act on.
 */
function costRefusalOf(error: unknown, what: string, actor: Actor): Refused {
  if (error instanceof DealCostError) {
    return refused(error.code, error.message, ["key_reused", "removed", "linked", "link_taken", "link_not_found"].includes(error.code) ? { changed: true } : {});
  }
  console.error(what, actor.orgId, error instanceof Error ? error.message : "unknown error");
  return refused("failed", TRY_AGAIN);
}

/** Adds a planned cost to a deal. The same form again adds no second one. */
export async function addDealCost(actor: Actor, input: { draft: CostDraft }): Promise<CommandOutcome<{ costId: string }>> {
  const refusal = gate(actor, "deal.add_cost");
  if (refusal) return refusal;
  try {
    const result = await writeAddCost({ actorId: actor.userId, draft: input.draft });
    return done(
      result.created ? `${result.cost.label}, ${result.amount}, is planned for ${result.title}.` : `This cost was added already: ${result.cost.label}.`,
      { costId: result.cost.id }
    );
  } catch (error) {
    return costRefusalOf(error, "adding a deal cost failed", actor);
  }
}

/** Removes a planned cost: it is kept, and counted nowhere. */
export async function removeDealCost(actor: Actor, input: { dealId: string; costId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "deal.remove_cost");
  if (refusal) return refusal;
  try {
    const result = await writeRemoveCost({ actorId: actor.userId, dealId: input.dealId, costId: input.costId });
    return done(result.removed ? `${result.label} is removed from ${result.title}.` : `${result.label} was removed already.`);
  } catch (error) {
    return costRefusalOf(error, "removing a deal cost failed", actor);
  }
}

/** Links a planned cost to the bill or milestone it became, which then counts in its place. */
export async function linkDealCost(actor: Actor, input: { dealId: string; costId: string; target: LinkTarget }): Promise<CommandOutcome> {
  const refusal = gate(actor, "deal.link_cost");
  if (refusal) return refusal;
  try {
    const result = await writeLinkCost({ actorId: actor.userId, dealId: input.dealId, costId: input.costId, target: input.target });
    return done(`${result.label} is linked to ${result.to}: it counts in the plan's place.`);
  } catch (error) {
    return costRefusalOf(error, "linking a deal cost failed", actor);
  }
}
