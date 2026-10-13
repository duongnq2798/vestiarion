import { currentOrgId } from "../context";
import { db } from "../dal";
import { assertLedgerCanSign } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { CostDraft, CostLink, DealCost } from "./costs";
import { COST_COLUMNS, costsNotReady, linkOfMilestone, linkOfPayable, MILESTONE_COLUMNS, PAYABLE_COLUMNS, toCost, type CostRow, type LinkedMilestoneRow, type LinkedPayableRow } from "./costs-read";
import { formatMinor, minorToDecimal } from "./money";
import { readDeal, type DealRecord } from "./read";

/**
 * A deal's costs, written (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K1-K3): adding one, removing
 * one, and linking one to the payable or milestone it became. Every export runs inside an organization scope; who may do
 * it is the command's check. Each is a signed entry, written best effort after `assertLedgerCanSign`.
 */

export const COST_ACTIONS = {
  added: "deal_cost_added",
  removed: "deal_cost_removed",
  linked: "deal_cost_linked",
} as const;

export type DealCostErrorCode =
  | "not_ready"
  | "not_found"
  | "cost_not_found"
  | "counterparty_not_found"
  | "key_reused"
  | "removed"
  | "linked"
  | "link_not_found"
  | "link_taken"
  | "link_currency";

const MESSAGES: Record<DealCostErrorCode, string> = {
  not_ready: "Costs are not set up on this deployment yet.",
  not_found: "That deal was not found.",
  cost_not_found: "That cost is not on this deal.",
  counterparty_not_found: "That vendor or contractor was not found. Choose another, or none.",
  key_reused: "This form was sent already, with other details. Reload the page and try again.",
  removed: "That cost was removed.",
  linked: "That cost is linked already.",
  link_not_found: "That bill or milestone was not found. Reload the page to see the list as it is now.",
  link_taken: "That bill or milestone backs another cost already: its money is counted there.",
  link_currency: "That bill is not in the deal's currency, so it cannot stand for this cost.",
};

export class DealCostError extends Error {
  constructor(readonly code: DealCostErrorCode) {
    super(MESSAGES[code]);
    this.name = "DealCostError";
  }
}

const money = (minor: number, record: Pick<DealRecord, "digits" | "facts">) => `${formatMinor(minor, record.digits)} ${record.facts.currency}`;

async function dealOf(dealId: string): Promise<DealRecord> {
  const read = await readDeal(dealId);
  if (!read.available) throw new DealCostError("not_ready");
  if (!read.deal) throw new DealCostError("not_found");
  return read.deal;
}

async function costRow(dealId: string, costId: string): Promise<CostRow | null> {
  const found = await db().from("deal_costs").select(COST_COLUMNS).eq("deal_id", dealId).eq("id", costId).limit(1);
  if (costsNotReady(found.error)) throw new DealCostError("not_ready");
  if (found.error) throw new Error(found.error.message);
  return ((found.data ?? []) as unknown as CostRow[])[0] ?? null;
}

function costDetail(cost: DealCost, record: DealRecord) {
  return {
    dealId: record.facts.id,
    title: record.title,
    costId: cost.id,
    label: cost.label,
    counterpartyId: cost.counterparty?.id ?? null,
    counterpartyName: cost.counterparty?.name ?? null,
    currency: record.facts.currency,
    digits: record.digits,
    amount: minorToDecimal(cost.amountMinor, record.digits),
    amountMinor: cost.amountMinor,
    expectedOn: cost.expectedOn,
    noDocument: cost.noDocument,
  };
}

const sameCost = (row: CostRow, draft: CostDraft) =>
  row.deal_id === draft.dealId &&
  row.label === draft.label &&
  (row.counterparty_id ?? null) === draft.counterpartyId &&
  Number(row.amount_minor) === draft.amountMinor &&
  row.expected_on === draft.expectedOn &&
  row.no_document === draft.noDocument;

/** Adds a planned cost to a deal, once per key (K1, K3). */
export async function addDealCost(input: { actorId: string; draft: CostDraft }): Promise<{ cost: DealCost; created: boolean; title: string; amount: string }> {
  const { actorId, draft } = input;
  const record = await dealOf(draft.dealId);
  let counterparty: { id: string; name: string } | null = null;
  if (draft.counterpartyId) {
    const found = await db().from("counterparties").select("id, name").eq("id", draft.counterpartyId).maybeSingle<{ id: string; name: string }>();
    if (found.error) throw new Error(found.error.message);
    if (!found.data) throw new DealCostError("counterparty_not_found");
    counterparty = found.data;
  }
  // An unreadable signing key refuses the cost before anything is written, rather than leave it unsigned.
  assertLedgerCanSign();
  const inserted = await db()
    .from("deal_costs")
    .upsert(
      {
        deal_id: draft.dealId,
        label: draft.label,
        counterparty_id: counterparty?.id ?? null,
        amount_minor: draft.amountMinor,
        expected_on: draft.expectedOn,
        no_document: draft.noDocument,
        idempotency_key: draft.idempotencyKey,
        created_by: actorId,
      },
      { onConflict: "org_id,idempotency_key", ignoreDuplicates: true }
    )
    .select(COST_COLUMNS);
  if (costsNotReady(inserted.error)) throw new DealCostError("not_ready");
  if (inserted.error) throw new Error(inserted.error.message);
  const created = ((inserted.data ?? []) as unknown as CostRow[])[0];
  if (created) {
    const cost = toCost(created, null);
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "human",
      domain: "ar",
      action: COST_ACTIONS.added,
      summary: `Planned a cost of ${money(cost.amountMinor, record)} for the deal ${record.title}: ${cost.label}`,
      detail: { by: actorId, ...costDetail(cost, record) },
    });
    return { cost, created: true, title: record.title, amount: money(cost.amountMinor, record) };
  }
  // The same form again: the cost it made, when it is this one (D12's rule for deals).
  const again = await db().from("deal_costs").select(COST_COLUMNS).eq("idempotency_key", draft.idempotencyKey).limit(1);
  if (again.error) throw new Error(again.error.message);
  const existing = ((again.data ?? []) as unknown as CostRow[])[0];
  if (!existing || !sameCost(existing, { ...draft, counterpartyId: counterparty?.id ?? null })) throw new DealCostError("key_reused");
  return { cost: toCost(existing, null), created: false, title: record.title, amount: money(Number(existing.amount_minor), record) };
}

/** Removes a cost: it stays, with who removed it, and is counted nowhere (K3). */
export async function removeDealCost(input: { actorId: string; dealId: string; costId: string }): Promise<{ removed: boolean; title: string; label: string }> {
  const { actorId, dealId, costId } = input;
  const record = await dealOf(dealId);
  const row = await costRow(dealId, costId);
  if (!row) throw new DealCostError("cost_not_found");
  if (row.removed_at) return { removed: false, title: record.title, label: row.label };
  assertLedgerCanSign();
  const updated = await db()
    .from("deal_costs")
    .update({ removed_at: new Date().toISOString(), removed_by: actorId })
    .eq("id", costId)
    .eq("deal_id", dealId)
    .is("removed_at", null)
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
  // Someone removed it a moment before.
  if ((updated.data ?? []).length === 0) return { removed: false, title: record.title, label: row.label };
  const cost = toCost(row, null);
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: COST_ACTIONS.removed,
    summary: `Removed the planned cost ${cost.label} (${money(cost.amountMinor, record)}) from the deal ${record.title}`,
    detail: { by: actorId, ...costDetail(cost, record), linked: row.invoice_id ? { kind: "payable", id: row.invoice_id } : row.milestone_id ? { kind: "milestone", id: row.milestone_id } : null },
  });
  return { removed: true, title: record.title, label: cost.label };
}

/** What a link names: one of the workspace's payables, or one of its milestones. */
export type LinkTarget = { kind: "payable" | "milestone"; id: string };

/**
 * Links a cost to the payable or milestone it became (K2): from then on that row's amount, day and status count, never
 * the planned amount. Set once; a row backs one live cost; a payable must be in the deal's currency.
 */
export async function linkDealCost(input: { actorId: string; dealId: string; costId: string; target: LinkTarget }): Promise<{ title: string; label: string; to: string }> {
  const { actorId, dealId, costId, target } = input;
  const record = await dealOf(dealId);
  const row = await costRow(dealId, costId);
  if (!row) throw new DealCostError("cost_not_found");
  if (row.removed_at) throw new DealCostError("removed");
  if (row.invoice_id || row.milestone_id) {
    if (row.invoice_id === target.id || row.milestone_id === target.id) return { title: record.title, label: row.label, to: "it already" };
    throw new DealCostError("linked");
  }
  const currency = { currency: record.facts.currency, digits: record.digits };
  let link: CostLink;
  if (target.kind === "payable") {
    const found = await db().from("invoices").select(`${PAYABLE_COLUMNS}, direction`).eq("id", target.id).limit(1);
    if (found.error) throw new Error(found.error.message);
    const payable = ((found.data ?? []) as unknown as Array<LinkedPayableRow & { direction: string }>)[0];
    if (!payable || payable.direction !== "payable") throw new DealCostError("link_not_found");
    link = linkOfPayable(payable, currency);
  } else {
    const found = await db().from("milestones").select(MILESTONE_COLUMNS).eq("id", target.id).limit(1);
    if (found.error) throw new Error(found.error.message);
    const milestone = ((found.data ?? []) as unknown as LinkedMilestoneRow[])[0];
    if (!milestone) throw new DealCostError("link_not_found");
    link = linkOfMilestone(milestone, currency);
  }
  if (link.amountMinor === null) throw new DealCostError("link_currency");
  assertLedgerCanSign();
  const updated = await db()
    .from("deal_costs")
    .update({
      [target.kind === "payable" ? "invoice_id" : "milestone_id"]: target.id,
      linked_at: new Date().toISOString(),
      linked_by: actorId,
    })
    .eq("id", costId)
    .eq("deal_id", dealId)
    .is("removed_at", null)
    .is("invoice_id", null)
    .is("milestone_id", null)
    .select("id");
  if (updated.error) {
    if (/deal_costs_(invoice|milestone)_key/.test(`${updated.error.message} ${(updated.error as { details?: string }).details ?? ""}`)) throw new DealCostError("link_taken");
    throw new Error(updated.error.message);
  }
  if ((updated.data ?? []).length === 0) throw new DealCostError("linked");
  const cost = toCost(row, link);
  const to = link.kind === "payable" ? `the bill from ${link.counterpartyName}, ${money(link.amountMinor as number, record)}` : `the milestone ${link.title} for ${link.contractorName}, ${money(link.amountMinor as number, record)}`;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: COST_ACTIONS.linked,
    summary: `Linked the planned cost ${cost.label} of the deal ${record.title} to ${to}`,
    detail: {
      by: actorId,
      ...costDetail(cost, record),
      linked: { kind: link.kind, id: link.id, amount: minorToDecimal(link.amountMinor as number, record.digits), amountMinor: link.amountMinor, status: link.status },
    },
  });
  return { title: record.title, label: cost.label, to };
}
