import { connectionFor, NotSetUpError } from "../connectors/connections";
import { chooseOverwrite, setReceiptWrites } from "../connectors/crm-receipts-actions";
import { writeGate } from "../connectors/crm-receipts-run";
import { plannable } from "../connectors/crm";
import { crmRow, crmRowForDeal, emailToFill, keepChanges, linkPlanned, sourceOf } from "../connectors/crm-actions";
import { amountText, changesKey, rowChanges } from "../connectors/crm-store";
import { PROVIDER_KINDS, PROVIDER_LABELS, type ProviderId } from "../connectors/provider";
import { crmProvider } from "../crm-providers";
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

/**
 * Turns writing receipts to a CRM on or off (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3): an owner's or
 * admin's. On needs the connection connected with every write scope granted; one without them is told to allow writing
 * to the CRM first, which goes through the connect page and turns it on there.
 */
export async function setCrmReceiptWrites(actor: Actor, input: { provider: ProviderId; on: boolean }): Promise<CommandOutcome> {
  const refusal = gate(actor, "crm.receipt_writes");
  if (refusal) return refusal;
  const label = PROVIDER_LABELS[input.provider];
  const provider = PROVIDER_KINDS[input.provider] === "crm" ? crmProvider(input.provider) : null;
  if (!provider?.receipts) return refused("not_ready", `Writing to ${label} is not set up on this deployment.`);
  try {
    const connection = await connectionFor(input.provider);
    if (!connection || connection.status === "revoked") return refused("not_connected", `${label} is not connected to this workspace.`);
    if (input.on) {
      const allowed = writeGate({ ...connection, writesOn: true }, provider.receipts.writeScopes);
      if (!allowed.ok && allowed.reason === "reconnect") return refused("reconnect", `${label} needs you to reconnect first.`);
      if (!allowed.ok) return refused("scope", `${label} has not allowed Vestiarion to write yet. Use Allow writing to ${label}, then try again.`);
    }
    const changed = await setReceiptWrites({ connection, on: input.on, by: actor.userId });
    if (!input.on) return done(changed ? `Vestiarion no longer writes to ${label}. What it wrote stays there.` : `Writing to ${label} is off already.`);
    return done(
      changed
        ? `Receipts are written to ${label} from the next sync, within 15 minutes, or now with Sync now.`
        : `Writing to ${label} is on already.`
    );
  } catch (error) {
    if (error instanceof NotSetUpError) return refused("not_ready", `Writing to ${label} is not set up on this deployment yet.`);
    console.error("turning CRM receipts on or off failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

/**
 * Writes Vestiarion's figures over what someone changed in the CRM (R5): only over the fields the page showed, as the
 * CRM held them then (`seen`); a conflict that changed since is refused, never written over unseen.
 */
export async function overwriteCrmReceipt(actor: Actor, input: { dealId: string; seen: string; label: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "crm.receipt_overwrite");
  if (refusal) return refusal;
  try {
    const outcome = await chooseOverwrite({ dealId: input.dealId, seen: input.seen, by: actor.userId, label: input.label });
    if (outcome.ok) return done(`Vestiarion writes its figures to ${input.label} at the next sync, as long as ${input.label} still holds what you saw.`);
    if (outcome.reason === "none") return refused("not_found", "Nothing waits on you for this deal now. Reload the page.");
    return refused("changed", `${input.label} changed since this page was opened. Reload the page to see what it holds now.`, { changed: true });
  } catch (error) {
    if (error instanceof NotSetUpError) return refused("not_ready", "Writing to a CRM is not set up on this deployment yet.");
    console.error("overwriting a CRM receipt failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
