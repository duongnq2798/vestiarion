import { currentOrgId } from "../context";
import { db, type OrgDb } from "../dal";
import { appendLedgerEntry, assertLedgerCanSign } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { readShadowMode } from "../shadow-mode";
import { LINK_DAYS, SUPPLIER_STATUS_ACTIONS, type LinkDays } from "./model";
import { generateSupplierStatusToken } from "./token";

/**
 * A supplier's payment status link, in the workspace in scope (docs/superpowers/specs/2026-10-18-supplier-status-design.md
 * V1, V6). A link is a row of `supplier_status_links` (0131) holding the SHA-256 of its secret and when it expires; the
 * link itself is returned once. One link per supplier is live: making a new one stops the old one first. Each link made
 * is a signed `supplier_status_shared` entry, and a link whose entry cannot be written is stopped at once, so no link
 * stays live without its record. Stopping sets `revoked_at` first, so it takes effect even when the ledger cannot be
 * written, then records `supplier_status_unshared` best effort. Who may do either (`records.write`) is the command's
 * check.
 *
 * Until migration 0131 runs, listing answers `available: false` and making or stopping refuses with `not_ready`.
 */

export type SupplierLinkErrorCode = "not_ready" | "not_found" | "not_supplier" | "shadow" | "days" | "busy" | "not_recorded" | "already_stopped";

export const SUPPLIER_LINK_MESSAGES: Record<SupplierLinkErrorCode, string> = {
  not_ready: "Supplier payment status is not set up on this deployment yet.",
  not_found: "That supplier is not one of this workspace's.",
  not_supplier: "Payment status links are for vendors. A customer gets a statement link, and a contractor follows its payments through its payee link.",
  shadow: "In shadow mode you pay your bills your own way, so a supplier's payment status would show only the payments mirrored on Arc testnet. Turn shadow mode off first.",
  days: "Choose how long the link works: 7, 30 or 90 days.",
  busy: "Someone made a link for this supplier a moment ago. Reload the page to see it.",
  not_recorded: "The link could not be recorded in the ledger, so it was stopped at once. Try again in a moment.",
  already_stopped: "That link was stopped already.",
};

export class SupplierLinkError extends Error {
  constructor(readonly code: SupplierLinkErrorCode) {
    super(SUPPLIER_LINK_MESSAGES[code]);
    this.name = "SupplierLinkError";
  }
}

type PostgrestError = { code?: string; message?: string } | null;

/** PostgREST's "no such table" (PGRST205) or Postgres's (42P01): migration 0131 has not run here yet. */
export function supplierLinksTableMissing(error: PostgrestError): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return error.code === "PGRST205" || error.code === "42P01" || (/supplier_status_links/.test(message) && /schema cache|does not exist/.test(message));
}

export interface SupplierLink {
  id: string;
  counterpartyId: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** Past its day: it opens only a sentence saying so, until it is stopped or replaced. */
  expired: boolean;
}

type LinkRow = { id: string; counterparty_id: string; created_by: string | null; created_at: string; expires_at: string };

/** The workspace's links not stopped, expired ones included, newest first. `available: false` before migration 0131. */
export async function listSupplierLinks(orgDb: OrgDb, now: number = Date.now()): Promise<{ available: false } | { available: true; links: SupplierLink[] }> {
  const read = await orgDb.from("supplier_status_links").select("id, counterparty_id, created_by, created_at, expires_at").is("revoked_at", null).order("created_at", { ascending: false });
  if (read.error) {
    if (supplierLinksTableMissing(read.error)) return { available: false };
    throw new Error(read.error.message);
  }
  return {
    available: true,
    links: ((read.data ?? []) as LinkRow[]).map((row) => ({
      id: row.id,
      counterpartyId: row.counterparty_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      expired: Date.parse(row.expires_at) <= now,
    })),
  };
}

export async function createSupplierLink(input: {
  actorId: string;
  counterpartyId: string;
  days: number;
  now?: number;
}): Promise<{ token: string; linkId: string; expiresAt: string; supplierName: string; replaced: number }> {
  if (!(LINK_DAYS as readonly number[]).includes(input.days)) throw new SupplierLinkError("days");
  // An unreadable signing key refuses the link before its row is written, rather than leave a link unrecorded.
  assertLedgerCanSign();

  const found = await db().from("counterparties").select("id, name, role").eq("id", input.counterpartyId).limit(1);
  if (found.error) {
    if (found.error.code === "22P02") throw new SupplierLinkError("not_found");
    throw new Error(found.error.message);
  }
  const supplier = ((found.data ?? []) as Array<{ id: string; name: string; role: string }>)[0];
  if (!supplier) throw new SupplierLinkError("not_found");
  if (supplier.role !== "vendor") throw new SupplierLinkError("not_supplier");
  // In shadow mode Arc testnet only mirrors the business's bills: a supplier must never read those as its payments
  // (V8).
  if (await readShadowMode(db())) throw new SupplierLinkError("shadow");

  const now = input.now ?? Date.now();
  const stoppedAt = new Date(now).toISOString();
  // The supplier's live link, expired or not, stops first: one link per supplier is live (0131's index).
  const replaced = await db()
    .from("supplier_status_links")
    .update({ revoked_at: stoppedAt, revoked_by: input.actorId })
    .eq("counterparty_id", supplier.id)
    .is("revoked_at", null)
    .select("id");
  if (replaced.error) {
    if (supplierLinksTableMissing(replaced.error)) throw new SupplierLinkError("not_ready");
    throw new Error(replaced.error.message);
  }
  const replacedIds = ((replaced.data ?? []) as Array<{ id: string }>).map((row) => row.id);

  // The links stopped here are recorded as stopped, best effort, when no new link replaces them after all.
  const recordStopped = () =>
    Promise.all(
      replacedIds.map((linkId) =>
        appendLedgerEntryBestEffort(currentOrgId(), {
          actor: "human",
          domain: "ap",
          action: SUPPLIER_STATUS_ACTIONS.unshared,
          summary: "Stopped a supplier's payment status link",
          detail: { by: input.actorId, linkId, counterpartyId: supplier.id },
        })
      )
    );

  const { token, secretHash } = generateSupplierStatusToken();
  const expiresAt = new Date(now + (input.days as LinkDays) * 86_400_000).toISOString();
  const stored = await db()
    .from("supplier_status_links")
    .insert({ counterparty_id: supplier.id, token_hash: secretHash, created_by: input.actorId, expires_at: expiresAt })
    .select("id")
    .single<{ id: string }>();
  if (stored.error) {
    await recordStopped();
    if (supplierLinksTableMissing(stored.error)) throw new SupplierLinkError("not_ready");
    // Another person's link for the same supplier went in between the stop and this insert.
    if (stored.error.code === "23505") throw new SupplierLinkError("busy");
    throw new Error(stored.error.message);
  }
  const linkId = stored.data.id;

  try {
    await appendLedgerEntry({
      actor: "human",
      domain: "ap",
      action: SUPPLIER_STATUS_ACTIONS.shared,
      summary: `Shared a payment status link with ${supplier.name}, working for ${input.days} days`,
      detail: { by: input.actorId, linkId, counterpartyId: supplier.id, expiresAt, days: input.days, replaced: replacedIds },
    });
  } catch {
    // A link with no entry never stays live: stop it now, and ask the person to try again.
    console.error("payment status link not recorded; stopping it", currentOrgId());
    const revoked = await db().from("supplier_status_links").update({ revoked_at: new Date().toISOString(), revoked_by: input.actorId }).eq("id", linkId);
    if (revoked.error) console.error("payment status link could not be stopped after its entry failed", currentOrgId(), revoked.error.message);
    await recordStopped();
    throw new SupplierLinkError("not_recorded");
  }
  return { token, linkId, expiresAt, supplierName: supplier.name, replaced: replacedIds.length };
}

export async function stopSupplierLink(input: { actorId: string; linkId: string }): Promise<{ counterpartyId: string }> {
  const found = await db().from("supplier_status_links").select("id, counterparty_id, revoked_at").eq("id", input.linkId).limit(1);
  if (found.error) {
    if (supplierLinksTableMissing(found.error)) throw new SupplierLinkError("not_ready");
    if (found.error.code === "22P02") throw new SupplierLinkError("not_found");
    throw new Error(found.error.message);
  }
  const link = ((found.data ?? []) as Array<{ id: string; counterparty_id: string; revoked_at: string | null }>)[0];
  if (!link) throw new SupplierLinkError("not_found");
  if (link.revoked_at) throw new SupplierLinkError("already_stopped");

  // Stopped first: it takes effect even when the ledger cannot be written.
  const revoked = await db()
    .from("supplier_status_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.actorId })
    .eq("id", link.id)
    .is("revoked_at", null)
    .select("id");
  if (revoked.error) {
    if (/supplier_status_link_revoked/.test(revoked.error.message ?? "")) throw new SupplierLinkError("already_stopped");
    throw new Error(revoked.error.message);
  }
  if ((revoked.data ?? []).length === 0) throw new SupplierLinkError("already_stopped");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: SUPPLIER_STATUS_ACTIONS.unshared,
    summary: "Stopped a supplier's payment status link",
    detail: { by: input.actorId, linkId: link.id, counterpartyId: link.counterparty_id },
  });
  return { counterpartyId: link.counterparty_id };
}
