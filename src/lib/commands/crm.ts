import { NotSetUpError } from "../connectors/connections";
import { plannable } from "../connectors/crm";
import { crmRow, crmRowForDeal, emailToFill, keepChanges, linkPlanned, sourceOf } from "../connectors/crm-actions";
import { amountText, changesKey, rowChanges } from "../connectors/crm-store";
import { PROVIDER_LABELS } from "../connectors/provider";
import type { DealDraft } from "../deals/input";
import { readDeal } from "../deals/read";
import { confirmDeal, DealError } from "../deals/write";
import { changeCounterpartyNoticeEmail, NoticeEmailTaken } from "../payment-notices";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * What a person does with a CRM's deals (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H3, H11, H12,
 * H13): a won deal planned as a Vestiarion deal through the New deal form and `create_deal`, a deal's changes in the CRM
 * kept without a new version, and a customer's billing email filled from the CRM. Each needs `records.write`, as adding
 * a deal does; the console runs them. The CRM's row is read again here, never believed from the form.
 */

const NOT_SET_UP = "Deals from a CRM are not set up on this deployment yet.";

/** Turns a won CRM deal into a Vestiarion deal: the person's form, the CRM's deal id as its reference (H11). */
export async function planCrmDeal(actor: Actor, input: { rowId: string; draft: DealDraft }): Promise<CommandOutcome<{ dealId: string; created: boolean }>> {
  const refusal = gate(actor, "crm.plan_deal");
  if (refusal) return refusal;
  try {
    const read = await crmRow(input.rowId);
    if (!read || read.connection.status === "revoked") return refused("not_found", "That deal is no longer in the list. Reload the page.");
    const { row, connection } = read;
    const label = PROVIDER_LABELS[connection.provider];
    // Whether it may be planned now, its link aside: a repeated confirm finds the deal it made.
    const check = plannable(
      { stage: row.stage_state, sourceStatus: row.source_status, dealId: null, amount: amountText(row.amount), companyExternalId: row.company_external_id },
      label
    );
    if (!check.ok) return refused("not_plannable", `${row.name} cannot be planned: ${check.reason.toLowerCase()}.`);
    const result = await confirmDeal({ actorId: actor.userId, draft: { ...input.draft, externalRef: row.external_id }, source: sourceOf(read) });
    if (row.deal_id && row.deal_id !== result.dealId) return refused("planned", `This ${label} deal is planned already.`);
    await linkPlanned(read, result.dealId, result.customerId);
    return done(
      result.created
        ? `Deal confirmed with ${result.customerName}: ${result.title}, from ${label}. Release each line when it is time to invoice it.`
        : `This deal was confirmed already: ${result.title}.`,
      { dealId: result.dealId, created: result.created }
    );
  } catch (error) {
    if (error instanceof NotSetUpError) return refused("not_ready", NOT_SET_UP);
    if (error instanceof DealError) {
      // The CRM's deal id is unique among the workspace's deals: a second plan of it is refused there.
      if (error.code === "external_ref_taken") return refused("planned", "This deal is planned already. Reload the page.");
      return refused(error.code, error.message, error.code === "changed" || error.code === "key_reused" ? { changed: true } : {});
    }
    console.error("planning a CRM deal failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

/** The words for changes made in the CRM after the page that acts on them was shown (H12). */
export const changedAgain = (label: string) =>
  refused("changed", `${label} changed this deal again since this page was opened. Reload the page to see what changed now.`, { changed: true });

/**
 * Keeps a deal as it is although it changed in the CRM: its changes count as reviewed, with a signed entry (H12). Only
 * the changes the page showed (`seen`, their `changesKey`): a set the CRM made since is refused, never marked as seen.
 */
export async function keepCrmChange(actor: Actor, input: { dealId: string; seen: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "crm.keep_change");
  if (refusal) return refusal;
  try {
    const [read, deal] = await Promise.all([crmRowForDeal(input.dealId), readDeal(input.dealId)]);
    if (!deal.available || !deal.deal || !read) return refused("not_found", "That deal was not found.");
    const label = PROVIDER_LABELS[read.connection.provider];
    const changes = rowChanges(read.row, deal.deal.facts.status);
    if (changes.length > 0 && changesKey(changes) !== input.seen) return changedAgain(label);
    const kept = await keepChanges(read, { id: deal.deal.facts.id, title: deal.deal.title, status: deal.deal.facts.status }, actor.userId);
    return done(kept === null ? `Nothing changed in ${label} since.` : `${deal.deal.title} stays as it is. ${label}'s changes are marked as seen.`);
  } catch (error) {
    if (error instanceof NotSetUpError) return refused("not_ready", NOT_SET_UP);
    console.error("keeping a CRM deal's changes failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

/**
 * Fills a customer's empty billing email with its company's main contact's email from the CRM (H13): only the email the
 * person was shown and confirmed (`email`), and only while the customer still has none, in the same write.
 */
export async function fillCrmEmail(actor: Actor, input: { counterpartyId: string; email: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "crm.fill_email");
  if (refusal) return refusal;
  try {
    const found = await emailToFill(input.counterpartyId);
    if (!found) return refused("not_found", "That customer has a billing email already, or the CRM has none for it.");
    if (found.email !== input.email.trim().toLowerCase()) {
      return refused("changed", `${PROVIDER_LABELS[found.source.provider]} has another email for ${found.name} now. Reload the page to see it.`, { changed: true });
    }
    await changeCounterpartyNoticeEmail({ actorId: actor.userId, counterpartyId: input.counterpartyId, email: found.email, source: found.source, onlyIfEmpty: true });
    return done(`Reminders to ${found.name} go to ${found.email} once you turn them on for an invoice.`);
  } catch (error) {
    if (error instanceof NotSetUpError) return refused("not_ready", NOT_SET_UP);
    if (error instanceof NoticeEmailTaken) return refused("taken", "That customer has a billing email already. Reload the page to see it.", { changed: true });
    console.error("filling a billing email from a CRM failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
