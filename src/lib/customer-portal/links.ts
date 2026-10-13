import { currentOrgId } from "../context";
import { db, type OrgDb } from "../dal";
import { appendLedgerEntry, assertLedgerCanSign } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { CUSTOMER_PORTAL_ACTIONS, LINK_DAYS, type LinkDays } from "./model";
import { generateCustomerPortalToken } from "./token";

/**
 * A customer's statement link, in the workspace in scope (docs/superpowers/specs/2026-10-13-customer-portal-design.md
 * P2, P9). A link is a row of `customer_portal_links` (0109) holding the SHA-256 of its secret and when it expires; the
 * link itself is returned once. One link per customer is live: making a new one stops the old one first. Each link made
 * is a signed `customer_statement_shared` entry, and a link whose entry cannot be written is stopped at once, so no link
 * stays live without its record. Stopping sets `revoked_at` first, so it takes effect even when the ledger cannot be
 * written, then records `customer_statement_unshared` best effort. Who may do either (`records.write`) is the command's
 * check.
 *
 * Until migration 0109 runs, listing answers `available: false` and making or stopping refuses with `not_ready`.
 */

export type PortalLinkErrorCode = "not_ready" | "not_found" | "not_client" | "days" | "busy" | "not_recorded" | "already_stopped";

export const PORTAL_LINK_MESSAGES: Record<PortalLinkErrorCode, string> = {
  not_ready: "Customer statements are not set up on this deployment yet.",
  not_found: "That customer is not one of this workspace's.",
  not_client: "Statement links are for customers. This counterparty is not a client.",
  days: "Choose how long the link works: 7, 30 or 90 days.",
  busy: "Someone made a link for this customer a moment ago. Reload the page to see it.",
  not_recorded: "The link could not be recorded in the ledger, so it was stopped at once. Try again in a moment.",
  already_stopped: "That link was stopped already.",
};

export class PortalLinkError extends Error {
  constructor(readonly code: PortalLinkErrorCode) {
    super(PORTAL_LINK_MESSAGES[code]);
    this.name = "PortalLinkError";
  }
}

type PostgrestError = { code?: string; message?: string } | null;

/** PostgREST's "no such table" (PGRST205) or Postgres's (42P01): migration 0109 has not run here yet. */
export function portalTableMissing(error: PostgrestError): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return error.code === "PGRST205" || error.code === "42P01" || (/customer_(portal_links|requests|request_messages)/.test(message) && /schema cache|does not exist/.test(message));
}

export interface PortalLink {
  id: string;
  counterpartyId: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** Past its day: it opens only a sentence saying so, until it is stopped or replaced. */
  expired: boolean;
}

type LinkRow = { id: string; counterparty_id: string; created_by: string | null; created_at: string; expires_at: string };

/** The workspace's links not stopped, expired ones included, newest first. `available: false` before migration 0109. */
export async function listPortalLinks(orgDb: OrgDb, now: number = Date.now()): Promise<{ available: false } | { available: true; links: PortalLink[] }> {
  const read = await orgDb.from("customer_portal_links").select("id, counterparty_id, created_by, created_at, expires_at").is("revoked_at", null).order("created_at", { ascending: false });
  if (read.error) {
    if (portalTableMissing(read.error)) return { available: false };
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

export async function createPortalLink(input: { actorId: string; counterpartyId: string; days: number; now?: number }): Promise<{ token: string; linkId: string; expiresAt: string; customerName: string; replaced: number }> {
  if (!(LINK_DAYS as readonly number[]).includes(input.days)) throw new PortalLinkError("days");
  // An unreadable signing key refuses the link before its row is written, rather than leave a link unrecorded.
  assertLedgerCanSign();

  const found = await db().from("counterparties").select("id, name, role").eq("id", input.counterpartyId).limit(1);
  if (found.error) {
    if (found.error.code === "22P02") throw new PortalLinkError("not_found");
    throw new Error(found.error.message);
  }
  const customer = ((found.data ?? []) as Array<{ id: string; name: string; role: string }>)[0];
  if (!customer) throw new PortalLinkError("not_found");
  if (customer.role !== "client") throw new PortalLinkError("not_client");

  const now = input.now ?? Date.now();
  const stoppedAt = new Date(now).toISOString();
  // The customer's live link, expired or not, stops first: one link per customer is live (0109's index).
  const replaced = await db()
    .from("customer_portal_links")
    .update({ revoked_at: stoppedAt, revoked_by: input.actorId })
    .eq("counterparty_id", customer.id)
    .is("revoked_at", null)
    .select("id");
  if (replaced.error) {
    if (portalTableMissing(replaced.error)) throw new PortalLinkError("not_ready");
    throw new Error(replaced.error.message);
  }
  const replacedIds = ((replaced.data ?? []) as Array<{ id: string }>).map((row) => row.id);

  const { token, secretHash } = generateCustomerPortalToken();
  const expiresAt = new Date(now + (input.days as LinkDays) * 86_400_000).toISOString();
  const stored = await db()
    .from("customer_portal_links")
    .insert({ counterparty_id: customer.id, token_hash: secretHash, created_by: input.actorId, expires_at: expiresAt })
    .select("id")
    .single<{ id: string }>();
  if (stored.error) {
    if (portalTableMissing(stored.error)) throw new PortalLinkError("not_ready");
    // Another person's link for the same customer went in between the stop and this insert.
    if (stored.error.code === "23505") throw new PortalLinkError("busy");
    throw new Error(stored.error.message);
  }
  const linkId = stored.data.id;

  try {
    await appendLedgerEntry({
      actor: "human",
      domain: "ar",
      action: CUSTOMER_PORTAL_ACTIONS.shared,
      summary: `Shared a statement link with ${customer.name}, working for ${input.days} days`,
      detail: { by: input.actorId, linkId, counterpartyId: customer.id, expiresAt, days: input.days, replaced: replacedIds },
    });
  } catch {
    // A link with no entry never stays live: stop it now, and ask the person to try again.
    console.error("statement link not recorded; stopping it", currentOrgId());
    const revoked = await db().from("customer_portal_links").update({ revoked_at: new Date().toISOString(), revoked_by: input.actorId }).eq("id", linkId);
    if (revoked.error) console.error("statement link could not be stopped after its entry failed", currentOrgId(), revoked.error.message);
    throw new PortalLinkError("not_recorded");
  }
  return { token, linkId, expiresAt, customerName: customer.name, replaced: replacedIds.length };
}

export async function stopPortalLink(input: { actorId: string; linkId: string }): Promise<{ counterpartyId: string }> {
  const found = await db().from("customer_portal_links").select("id, counterparty_id, revoked_at").eq("id", input.linkId).limit(1);
  if (found.error) {
    if (portalTableMissing(found.error)) throw new PortalLinkError("not_ready");
    if (found.error.code === "22P02") throw new PortalLinkError("not_found");
    throw new Error(found.error.message);
  }
  const link = ((found.data ?? []) as Array<{ id: string; counterparty_id: string; revoked_at: string | null }>)[0];
  if (!link) throw new PortalLinkError("not_found");
  if (link.revoked_at) throw new PortalLinkError("already_stopped");

  // Stopped first: it takes effect even when the ledger cannot be written.
  const revoked = await db()
    .from("customer_portal_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.actorId })
    .eq("id", link.id)
    .is("revoked_at", null)
    .select("id");
  if (revoked.error) {
    if (/customer_portal_link_revoked/.test(revoked.error.message ?? "")) throw new PortalLinkError("already_stopped");
    throw new Error(revoked.error.message);
  }
  if ((revoked.data ?? []).length === 0) throw new PortalLinkError("already_stopped");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: CUSTOMER_PORTAL_ACTIONS.unshared,
    summary: "Stopped a customer's statement link",
    detail: { by: input.actorId, linkId: link.id, counterpartyId: link.counterparty_id },
  });
  return { counterpartyId: link.counterparty_id };
}
