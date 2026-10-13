import { currentOrgId } from "../context";
import { db } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { isNotSetUp, NotSetUpError, type Connection } from "./connections";
import { conflictKey } from "./crm-receipts-run";
import { receiptStore, toWrite, WRITE_COLUMNS, type WriteDbRow } from "./crm-receipts-store";
import { seenOf } from "./crm-receipts";
import { PROVIDER_LABELS } from "./provider";

/**
 * What a person does about receipts written to a CRM, written (docs/superpowers/specs/2026-10-13-crm-receipts-design.md
 * R3, R5): writing turned on or off for a connection, and Vestiarion's figures written over a field someone changed in
 * the CRM. The commands in `src/lib/commands/crm.ts` gate them; these run in the workspace's scope and trust nothing
 * from the browser.
 */

function raise(error: { code?: string | null; message: string }): never {
  if (isNotSetUp(error) || error.code === "42703" || error.code === "PGRST204") throw new NotSetUpError();
  throw new Error(error.message);
}

/**
 * Turns writing on or off for a connected CRM (R3), with a signed entry when it changed. On only while the connection
 * is connected; off whatever its state. False when nothing changed.
 */
export async function setReceiptWrites(input: { connection: Connection; on: boolean; by: string; nowMs?: number }): Promise<boolean> {
  const { connection } = input;
  let query = db()
    .from("accounting_connections")
    .update({ writes_on: input.on, writes_by: input.by, writes_at: new Date(input.nowMs ?? Date.now()).toISOString() })
    .eq("id", connection.id)
    .eq("writes_on", !input.on);
  if (input.on) query = query.eq("status", "connected");
  const updated = await query.select("id");
  if (updated.error) raise(updated.error);
  if ((updated.data ?? []).length === 0) return false;
  const label = PROVIDER_LABELS[connection.provider];
  await appendLedgerEntryBestEffort(connection.orgId, {
    actor: "human",
    domain: "system",
    action: "crm_receipt_writes_changed",
    summary: input.on
      ? `Turned on writing receipts to ${label}: each deal planned from ${label} gets what it collected, from payments confirmed on Arc`
      : `Turned off writing receipts to ${label}: nothing more is written`,
    detail: { by: input.by, provider: connection.provider, connectionId: connection.id, externalOrgId: connection.externalOrgId, on: input.on, scopes: connection.scopes },
  });
  return true;
}

/** The write of a deal waiting on a person because of a conflict, or null. */
export async function conflictOf(dealId: string) {
  const found = await db().from("crm_receipt_writes").select(WRITE_COLUMNS).eq("deal_id", dealId).eq("state", "conflict").limit(1);
  if (found.error) raise(found.error);
  const row = ((found.data ?? []) as unknown as WriteDbRow[])[0];
  return row ? toWrite(row) : null;
}

export type OverwriteOutcome = { ok: true } | { ok: false; reason: "none" | "changed" };

/**
 * Writes Vestiarion's figures over what someone changed in the CRM (R5), only over the fields the page showed, as the
 * CRM held them then (`seen`, their `conflictKey`): the write is queued again carrying those values, and the next run
 * writes only while the CRM still holds exactly them. A conflict that changed since is refused before anything is
 * written.
 */
export async function chooseOverwrite(input: { dealId: string; seen: string; by: string; label: string; nowMs?: number }): Promise<OverwriteOutcome> {
  const row = await conflictOf(input.dealId);
  if (!row) return { ok: false, reason: "none" };
  if (conflictKey(row.conflicts) !== input.seen) return { ok: false, reason: "changed" };
  const at = new Date(input.nowMs ?? Date.now()).toISOString();
  const seen = seenOf(row.conflicts);
  const moved = await receiptStore.move(row, ["conflict"], "queued", { overwrite: seen, overwriteBy: input.by, overwriteAt: at, reason: null, message: null, nextAttemptAt: null });
  if (!moved) return { ok: false, reason: "changed" };
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: "crm_receipt_overwrite_chosen",
    summary: `Chose to write Vestiarion's figures over what someone changed in ${input.label}`,
    detail: { by: input.by, writeId: row.id, dealId: row.dealId, crmDealId: row.externalDealId, connectionId: row.connectionId, seen },
  });
  return { ok: true };
}
