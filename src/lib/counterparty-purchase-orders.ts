import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * Whether a counterparty needs a purchase order on file before the agent pays or schedules its invoices
 * (docs/superpowers/specs/2026-10-05-three-way-match-design.md M2). Every counterparty needs one unless an owner or
 * admin marks it "Paid without purchase orders" on Counterparties: the written policy and the model are told the
 * setting, and the AP guardrail refuses an incomplete match. Goods received is needed either way. Every export that
 * touches the database runs inside an organization scope.
 *
 * The write is a compare-and-set on the value it read, like the limit and the address edits. Unlike the limit, nothing
 * in the cycle writes this column, so it is not refused while a cycle runs: the AP stage reads it as it loads the
 * payables, and the next cycle decides with the change.
 */

export type CounterpartyPurchaseOrdersErrorCode = "unchanged" | "conflict" | "not_found";

export class CounterpartyPurchaseOrdersError extends Error {
  constructor(
    readonly code: CounterpartyPurchaseOrdersErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CounterpartyPurchaseOrdersError";
  }
}

export async function changeCounterpartyPurchaseOrders(input: {
  actorId: string;
  counterpartyId: string;
  required: boolean;
}): Promise<{ name: string; from: boolean; to: boolean }> {
  const result = await db().from("counterparties").select("id, name, purchase_order_required").eq("id", input.counterpartyId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { id: string; name: string; purchase_order_required: boolean | null } | null;
  if (!row) throw new CounterpartyPurchaseOrdersError("not_found", "Counterparty not found.");

  const from = row.purchase_order_required !== false;
  const to = input.required;
  if (from === to) {
    throw new CounterpartyPurchaseOrdersError(
      "unchanged",
      to ? `${row.name} already needs a purchase order.` : `${row.name} is already paid without purchase orders.`
    );
  }

  const rows = unwrap(
    await db().from("counterparties").update({ purchase_order_required: to }).eq("id", row.id).eq("purchase_order_required", from).select("id")
  ) as Array<{ id: string }>;
  if (rows.length === 0) throw new CounterpartyPurchaseOrdersError("conflict", "This counterparty changed a moment ago. Check it and try again.");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "compliance",
    action: "counterparty_purchase_orders_changed",
    summary: to ? `Marked ${row.name} as needing purchase orders` : `Marked ${row.name} as paid without purchase orders`,
    detail: { by: input.actorId, counterpartyId: row.id, from, to },
  });

  return { name: row.name, from, to };
}
