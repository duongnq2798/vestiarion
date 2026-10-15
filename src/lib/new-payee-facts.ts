import { platformDb, unwrap, type OrgDb } from "./dal";
import { newPayeeCheck } from "./new-payee";

/**
 * What the new payee check reads (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N1, N2), once per stage
 * or approval: every address the workspace has made a confirmed payment to, and each counterparty's ledger entries
 * that set or confirmed its address, newest first. `newPayeeCheck` (./new-payee) decides from them.
 *
 * An entry an address sent through a payee link wrote names the link (`linkId`), not who made it. Who did is read from
 * the link's own `payee_links` row in this workspace (migration 0039, `created_by`) and set beside the entry as
 * `linkCreatedBy`, so the check counts that member as having given the address (independent review, 2026-10-15). The
 * ledger's detail is left as written.
 */
export interface NewPayeeFacts {
  /** Every address this workspace has made a confirmed payment to, lowercase. */
  paidTo: Set<string>;
  /** Each counterparty's entries that set or confirmed its address, newest first. */
  entries: Map<string, Array<{ action: string; detail: Record<string, unknown>; linkCreatedBy?: string | null }>>;
}

const ADDRESS_ACTIONS = ["create_counterparty", "counterparty_address_changed", "counterparty_address_confirmed"];

/**
 * For a person's payment (new payee check N4): the check when paying this counterparty would be the first payment to its
 * address; null otherwise, or when it has no address. The caller asks only where payments are real (N5).
 */
export async function firstPaymentCheck(db: OrgDb, counterparty: { id: string; address: string | null }): Promise<ReturnType<typeof newPayeeCheck>> {
  if (!counterparty.address) return null;
  const facts = await loadNewPayeeFacts(db, [counterparty.id]);
  const check = newPayeeCheck({ address: counterparty.address, paidTo: facts.paidTo, entries: facts.entries.get(counterparty.id) ?? [] });
  return check?.firstPayment ? check : null;
}

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
  const creators = await linkCreators(db.orgId, rows);
  for (const row of rows) {
    const id = row.detail.counterpartyId;
    if (typeof id !== "string") continue;
    const linkId = viaLink(row);
    const entry = linkId === null ? row : { ...row, linkCreatedBy: creators.get(linkId) ?? null };
    const list = entries.get(id);
    if (list) list.push(entry);
    else entries.set(id, [entry]);
  }
  return { paidTo, entries };
}

/** The payee link an entry's address was sent through, or null for an address given any other way. */
function viaLink(row: { action: string; detail: Record<string, unknown> }): string | null {
  return row.detail.via === "payee_link" && typeof row.detail.linkId === "string" ? row.detail.linkId : null;
}

/**
 * Who created each payee link these entries name, from the links themselves in this workspace. `payee_links` is a
 * platform table (0039): only the service role reads it, so it is read here through `platformDb`, always naming the
 * workspace. Nothing is read when no address came through a link. A link not found, or whose creator's account is gone,
 * has no creator.
 */
async function linkCreators(orgId: string, rows: ReadonlyArray<{ action: string; detail: Record<string, unknown> }>): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map(viaLink).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const links = unwrap(await platformDb().from("payee_links").select("id, created_by").eq("org_id", orgId).in("id", ids)) as Array<{
    id: string;
    created_by: string | null;
  }>;
  return new Map(links.map((link) => [link.id, link.created_by]));
}
