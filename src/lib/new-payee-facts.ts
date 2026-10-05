import { unwrap, type OrgDb } from "./dal";

/**
 * What the new payee check reads (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N1, N2), once per stage
 * or approval: every address the workspace has made a confirmed payment to, and each counterparty's ledger entries
 * that set or confirmed its address, newest first. `newPayeeCheck` (./new-payee) decides from them.
 */
export interface NewPayeeFacts {
  /** Every address this workspace has made a confirmed payment to, lowercase. */
  paidTo: Set<string>;
  /** Each counterparty's entries that set or confirmed its address, newest first. */
  entries: Map<string, Array<{ action: string; detail: Record<string, unknown> }>>;
}

const ADDRESS_ACTIONS = ["create_counterparty", "counterparty_address_changed", "counterparty_address_confirmed"];

export async function loadNewPayeeFacts(db: OrgDb, counterpartyIds: readonly string[]): Promise<NewPayeeFacts> {
  const paid = unwrap(await db.from("payment_intents").select("destination").eq("status", "confirmed")) as Array<{ destination: string | null }>;
  const paidTo = new Set(paid.flatMap((row) => (row.destination ? [row.destination.toLowerCase()] : [])));

  const entries = new Map<string, Array<{ action: string; detail: Record<string, unknown> }>>();
  if (counterpartyIds.length === 0) return { paidTo, entries };
  const rows = unwrap(
    await db
      .from("ledger_entries")
      .select("action, detail")
      .eq("domain", "compliance")
      .in("action", ADDRESS_ACTIONS)
      .in("detail->>counterpartyId", [...counterpartyIds])
      .order("seq", { ascending: false })
  ) as Array<{ action: string; detail: Record<string, unknown> }>;
  for (const row of rows) {
    const id = row.detail.counterpartyId;
    if (typeof id !== "string") continue;
    const list = entries.get(id);
    if (list) list.push(row);
    else entries.set(id, [row]);
  }
  return { paidTo, entries };
}
