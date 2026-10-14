import { NotSetUpError, connectionById, type Connection } from "../connectors/connections";
import { PROVIDER_LABELS, providerKind } from "../connectors/provider";
import { MAX_REVIEW, newSupplierLimit, readReview, type ReviewItem } from "../connectors/review";
import { createCounterparty } from "../counterparties/create";
import { db, unwrap } from "../dal";
import { counterpartyInputSchema } from "../intake-validation";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { Actor } from "./actor";
import { addInvoice } from "./invoices";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Adding the bills an accounting tool brought in, and dismissing them (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X3, X11): `records.write`, from the console. Every chosen bill is checked again on the server, from its kept row and
 * never from the browser, through the bill list's own check; each is claimed before it is added, so two people adding
 * it at once add it once, and put back if it could not be. A supplier no counterparty is yet is added as one with the
 * bill. Each bill goes through `addInvoice`: its gate, its insert, its signed `create_invoice` entry naming the tool's
 * ids, the cycle it starts. The bill's approval in the tool is not Vestiarion's: the agent decides it as any other.
 */

export interface BroughtInBill {
  billId: string;
  number: string | null;
  supplier: string;
  status: "added" | "duplicate" | "error";
  reason?: string;
  invoiceId?: string;
}

export interface BroughtInCounts {
  added: number;
  duplicate: number;
  error: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function openConnection(connectionId: string): Promise<{ connection: Connection } | { refusal: ReturnType<typeof refused> }> {
  if (!UUID.test(connectionId)) return { refusal: refused("not_connected", "That connection is not this workspace's.") };
  try {
    const connection = await connectionById(connectionId);
    // A CRM's connection brings no bills in (HubSpot connector H1).
    if (!connection || connection.status === "revoked" || providerKind(connection.provider) !== "accounting") {
      return { refusal: refused("not_connected", "That accounting tool is not connected to this workspace.") };
    }
    return { connection };
  } catch (error) {
    if (error instanceof NotSetUpError) return { refusal: refused("not_set_up", "Bringing bills in from an accounting tool is not set up on this deployment yet.") };
    throw error;
  }
}

/** The accounting tool a bill came from: never a CRM, which `openConnection` refuses. */
function accountingProviderOf(connection: Connection): "xero" | "quickbooks" {
  if (connection.provider === "hubspot" || connection.provider === "asana") throw new Error("Only an accounting tool brings bills in");
  return connection.provider;
}

/** Claims a bill in review for this person: false when someone else added or dismissed it first. */
async function claimBill(billId: string, by: string): Promise<boolean> {
  const rows = unwrap(
    await db()
      .from("accounting_bills")
      .update({ review_state: "added", decided_by: by, decided_at: new Date().toISOString() })
      .eq("id", billId)
      .eq("review_state", "review")
      .eq("source_status", "open")
      .select("id")
  ) as Array<{ id: string }>;
  return rows.length === 1;
}

async function releaseBill(billId: string): Promise<void> {
  const result = await db().from("accounting_bills").update({ review_state: "review", decided_by: null, decided_at: null }).eq("id", billId).eq("review_state", "added");
  if (result.error) console.error("an accounting bill was not put back for review", billId, result.error.message);
}

/** Links an external object to its local row, best effort: the bill or supplier is added either way. */
async function link(connection: Connection, object: { type: "contact" | "bill"; externalId: string; localId: string; label: string | null }): Promise<void> {
  const now = new Date().toISOString();
  const result = await db()
    .from("external_links")
    .upsert(
      {
        connection_id: connection.id,
        provider: connection.provider,
        external_org_id: connection.externalOrgId,
        object_type: object.type,
        external_id: object.externalId,
        local_id: object.localId,
        linked_at: now,
        label: object.label ? object.label.slice(0, 200) : null,
        updated_at: now,
      },
      { onConflict: "org_id,provider,external_org_id,object_type,external_id" }
    );
  if (result.error) console.error("an accounting link was not kept", connection.id, object.type, result.error.message);
}

/** Adds a supplier no counterparty is yet: a vendor, no address, a limit of its largest bill here, purchase orders needed. */
async function addSupplier(actor: Actor, connection: Connection, item: ReviewItem, paymentLimit: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const parsed = counterpartyInputSchema.safeParse({ name: item.supplier.name, role: "vendor", address: "", jurisdiction: "", paymentLimit });
  if (!parsed.success) return { ok: false, reason: `The supplier “${item.supplier.name}” could not be added: ${parsed.error.issues[0]?.message ?? "its details do not read"}.` };
  const created = await createCounterparty({
    actorId: actor.userId,
    counterparty: parsed.data,
    external: { provider: accountingProviderOf(connection), ids: { tenantId: connection.externalOrgId, contactId: item.bill.contactExternalId } },
  });
  if (item.bill.contactExternalId) await link(connection, { type: "contact", externalId: item.bill.contactExternalId, localId: created.id, label: item.bill.contactName });
  return { ok: true, id: created.id };
}

function message(label: string, counts: BroughtInCounts): string {
  const parts = [counts.added === 0 ? `Added no bills from ${label}.` : `Added ${plural(counts.added, "bill", "bills")} from ${label}.`];
  if (counts.duplicate > 0) parts.push(`${counts.duplicate} ${counts.duplicate === 1 ? "was" : "were"} already in Vestiarion.`);
  if (counts.error > 0) parts.push(`${counts.error} can't be added.`);
  return parts.join(" ");
}

export async function addAccountingBills(
  actor: Actor,
  input: { connectionId: string; billIds: readonly string[]; goodsReceived: boolean }
): Promise<CommandOutcome<{ bills: BroughtInBill[]; counts: BroughtInCounts }>> {
  const refusal = gate(actor, "accounting.add_bills");
  if (refusal) return refusal;
  const ids = [...new Set(input.billIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return refused("invalid", "Choose the bills to add.");
  if (ids.length > MAX_REVIEW) return refused("invalid", `Add at most ${MAX_REVIEW} bills at a time.`);
  let items: ReviewItem[];
  let connection: Connection;
  try {
    const opened = await openConnection(input.connectionId);
    if ("refusal" in opened) return opened.refusal;
    connection = opened.connection;
    items = await readReview(connection, { ids, goodsReceived: input.goodsReceived });
  } catch (error) {
    console.error("checking bills from an accounting tool failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
  if (items.length === 0) return refused("not_found", "These bills were already added or dismissed, or closed in the accounting tool.");
  const label = PROVIDER_LABELS[connection.provider];

  const fates = items.map((item) => item.fate);
  const suppliers = new Map<string, string>();
  const bills: BroughtInBill[] = [];
  for (const item of items) {
    const base = { billId: item.bill.id, number: item.bill.number, supplier: item.supplier.name };
    const fate = item.fate;
    if (fate.status !== "add") {
      bills.push({ ...base, status: fate.status, reason: fate.reason });
      continue;
    }
    if (!(await claimBill(item.bill.id, actor.userId))) {
      bills.push({ ...base, status: "error", reason: "Someone else added or dismissed this bill a moment ago." });
      continue;
    }
    let counterpartyId = fate.counterpartyId;
    try {
      if (item.supplier.kind === "new") {
        const known = suppliers.get(item.supplier.counterpartyId);
        if (known) {
          counterpartyId = known;
        } else {
          const added = await addSupplier(actor, connection, item, newSupplierLimit(fates, item.supplier.counterpartyId));
          if (!added.ok) {
            await releaseBill(item.bill.id);
            bills.push({ ...base, status: "error", reason: added.reason });
            continue;
          }
          suppliers.set(item.supplier.counterpartyId, added.id);
          counterpartyId = added.id;
        }
      } else if (item.supplier.kind === "matched" && item.bill.contactExternalId) {
        await link(connection, { type: "contact", externalId: item.bill.contactExternalId, localId: counterpartyId, label: item.bill.contactName });
      }
    } catch (error) {
      console.error("adding a supplier from an accounting tool failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
      await releaseBill(item.bill.id);
      bills.push({ ...base, status: "error", reason: "The supplier could not be added. Try again in a moment." });
      continue;
    }
    const added = await addInvoice(actor, {
      invoice: { ...fate.invoice, counterpartyId },
      document: null,
      ...(fate.original ? { original: fate.original } : {}),
      external: {
        provider: accountingProviderOf(connection),
        ids: { tenantId: connection.externalOrgId, billId: item.bill.externalId, contactId: item.bill.contactExternalId, invoiceNumber: item.bill.number },
      },
    });
    if (!added.ok) {
      await releaseBill(item.bill.id);
      bills.push({ ...base, status: "error", reason: added.message });
      continue;
    }
    await link(connection, { type: "bill", externalId: item.bill.externalId, localId: added.invoiceId, label: item.bill.number });
    bills.push({ ...base, status: "added", invoiceId: added.invoiceId });
  }
  const counts: BroughtInCounts = {
    added: bills.filter((bill) => bill.status === "added").length,
    duplicate: bills.filter((bill) => bill.status === "duplicate").length,
    error: bills.filter((bill) => bill.status === "error").length,
  };
  return done(message(label, counts), { bills, counts });
}

export async function dismissAccountingBills(actor: Actor, input: { connectionId: string; billIds: readonly string[] }): Promise<CommandOutcome<{ dismissed: number }>> {
  const refusal = gate(actor, "accounting.dismiss_bills");
  if (refusal) return refusal;
  const ids = [...new Set(input.billIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return refused("invalid", "Choose the bills to dismiss.");
  let rows: Array<{ id: string; external_id: string }>;
  let connection: Connection;
  try {
    const opened = await openConnection(input.connectionId);
    if ("refusal" in opened) return opened.refusal;
    connection = opened.connection;
    rows = unwrap(
      await db()
        .from("accounting_bills")
        .update({ review_state: "dismissed", decided_by: actor.userId, decided_at: new Date().toISOString() })
        .eq("connection_id", connection.id)
        .in("id", ids)
        .eq("review_state", "review")
        .select("id, external_id")
    ) as Array<{ id: string; external_id: string }>;
  } catch (error) {
    console.error("dismissing bills from an accounting tool failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
  if (rows.length === 0) return refused("not_found", "These bills were already added or dismissed.");
  const label = PROVIDER_LABELS[connection.provider];
  await appendLedgerEntryBestEffort(actor.orgId, {
    actor: "human",
    domain: "ap",
    action: "accounting_bills_dismissed",
    summary: `Dismissed ${plural(rows.length, "bill", "bills")} brought in from ${label}`,
    detail: { by: actor.userId, provider: connection.provider, connectionId: connection.id, billIds: rows.map((row) => row.external_id) },
  });
  return done(`Dismissed ${plural(rows.length, "bill", "bills")}. ${rows.length === 1 ? "It stays" : "They stay"} in ${label}.`, { dismissed: rows.length });
}
