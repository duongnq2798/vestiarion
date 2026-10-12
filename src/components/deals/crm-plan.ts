import type { CrmRowView } from "@/lib/connectors/crm-review";

/**
 * What `?hubspot=<row>` shows on Receivables: the deal it was planned as, when a deal of the list is planned already
 * (after its own Plan collections, or an old link), and otherwise the filled-in form, read again from the row. Never
 * "cannot be planned: planned already" for a deal that simply is.
 */
export function crmPlanState(rowId: string | null, won: readonly CrmRowView[]): { kind: "planned"; rowId: string; title: string; dealId: string; cancelled: boolean } | { kind: "form"; rowId: string } | null {
  if (rowId === null) return null;
  const row = won.find((candidate) => candidate.id === rowId);
  if (row?.linkedDeal) return { kind: "planned", rowId, title: row.linkedDeal.title, dealId: row.linkedDeal.id, cancelled: row.linkedDeal.status === "cancelled" };
  return { kind: "form", rowId };
}
